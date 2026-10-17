// Run with `pnpm exec electron scripts/smoke-approval-modes.cjs`.
// Exercises the real private Electron utility-process grant protocol against
// the maintained ACP boundary: claude-acp and codex-acp instances whose adapter
// is the scripted server/testing/fake-acp-cli.ts, spawned over the same stdio
// boundary a real adapter speaks. Uses only a disposable home; never the live app.
//
// Approval levels on ACP pass the adapter's own session mode through
// (AcpRuntime.modeForApproval): Ask is Claude `default` / Codex `read-only`,
// Accept edits `acceptEdits` / `workspace-write`, Auto the adapter's reviewer
// `auto` / `agent`, Full `bypassPermissions` / `agent-full-access`. A level the
// adapter does not advertise keeps Ask, and Custom is unsupported on ACP.
const { app, utilityProcess } = require("electron");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createServer } = require("node:net");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { createTrustedApprovalModeCoordinator } = require("../electron/approval-trusted-mode.cjs");

const root = resolve(__dirname, "..");
const FAKE_ACP = join(root, "server/testing/fake-acp-cli.ts");
const home = mkdtempSync(join(tmpdir(), "colonie-approval-smoke-"));
app.setPath("userData", join(home, "electron"));
let child;
let logs = "";
// The whole run is bounded; a wedged fixture fails instead of hanging CI.
const overall = setTimeout(() => {
  console.error(`Approval smoke exceeded its time budget. ${logs.slice(-2000)}`);
  process.exitCode = 1;
  void cleanup();
}, 110_000);

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function until(check) {
  const deadline = Date.now() + 30_000;
  do {
    const result = await check();
    if (result) return result;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Fixture timed out. ${logs.slice(-2000)}`);
}

// The fake adapter's append-only logs, shared by every process of an instance.
const jsonl = (path) => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];
// One line per conversation prompt across pooled processes and their
// replacements, with the mode it actually ran under. The app's own work
// (memory analysis, model discovery) is tagged `internal` and is not a turn.
const prompts = (dump) => jsonl(`${dump}.prompts.jsonl`).filter((line) => !line.internal);
// The mode the latest conversation turn ran under. The runtime sets the session
// mode before every prompt, so that session's latest session/set_mode must
// agree. With `since` (a prompts() count taken before sending), exactly one
// conversation turn must have reached the adapter since.
const lastMode = (dump, since) => {
  const turns = prompts(dump);
  if (since !== undefined) assert.equal(turns.length - since, 1, `Expected one conversation turn in ${dump}`);
  const turn = turns.at(-1);
  assert.ok(turn, `No conversation turn reached ${dump}`);
  const told = jsonl(`${dump}.config.jsonl`)
    .findLast((call) => !call.internal && call.sessionId === turn.sessionId && call.method === "session/set_mode");
  assert.equal(told?.params.modeId, turn.mode, "The turn must run under the mode its session was last set to");
  return turn.mode;
};

app.whenReady().then(async () => {
  const port = await freePort();
  let webhookPort = await freePort();
  while (webhookPort === port) webhookPort = await freePort();
  const dumps = {
    claude: join(home, "claude.json"), codex: join(home, "codex.json"),
    permission: join(home, "claude-permission.json"), codexPermission: join(home, "codex-permission.json"),
    clamped: join(home, "claude-clamped.json"), codexClamped: join(home, "codex-clamped.json"),
  };
  // The modes each maintained adapter advertises, and the clamped subsets an
  // older adapter build offers.
  const CLAUDE_MODES = "default,acceptEdits,auto,bypassPermissions";
  const CODEX_MODES = "read-only,workspace-write,agent,agent-full-access";
  // Electron's own binary runs the fake as Node (the runtime sets
  // ELECTRON_RUN_AS_NODE for every adapter it spawns).
  // Every session/new answers a distinct session id, so the same-session
  // assertions below fail when a turn opens a new session.
  const adapter = { cli: process.execPath, args: ["--experimental-strip-types", FAKE_ACP] };
  const claude = (environment, extra = {}) => ({ driver: "claude-acp", config: adapter, ...extra,
    environment: { FAKE_ACP_MODES: CLAUDE_MODES, FAKE_ACP_MODELS: "claude-sonnet-5", FAKE_ACP_UNIQUE_SESSION_IDS: "1", ...environment } });
  const codex = (environment, extra = {}) => ({ driver: "codex-acp", config: adapter, ...extra,
    environment: { FAKE_ACP_MODES: CODEX_MODES, FAKE_ACP_MODELS: "gpt-6-astra,gpt-fake-default", FAKE_ACP_UNIQUE_SESSION_IDS: "1", ...environment } });
  const modelUi = process.argv.includes("--model-ui-only");
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: {
    claude: claude({ FAKE_ACP_DUMP: dumps.claude }),
    codex: codex({ FAKE_ACP_DUMP: dumps.codex }),
    "claude-permission": claude({ FAKE_ACP_MODE: "permission", FAKE_ACP_DUMP: dumps.permission }),
    "codex-permission": codex({ FAKE_ACP_MODE: "permission", FAKE_ACP_DUMP: dumps.codexPermission }),
    "claude-question": claude({ FAKE_ACP_MODE: "question" }),
    "claude-clamped": claude({ FAKE_ACP_MODES: "default,bypassPermissions", FAKE_ACP_DUMP: dumps.clamped }),
    "codex-clamped": codex({ FAKE_ACP_MODES: "read-only,agent-full-access", FAKE_ACP_DUMP: dumps.codexClamped }),
    ...(modelUi ? {
      "claude-signed-out": claude({ FAKE_ACP_MODE: "auth-required" }, { displayName: "Signed-out fixture" }),
      "missing-codex": { driver: "codex-acp", displayName: "Missing provider fixture", config: { cli: join(home, "not-installed") } },
    } : {}),
  } }));
  const testCapabilityKey = randomUUID();
  const coordinator = createTrustedApprovalModeCoordinator({ randomId: randomUUID });
  child = utilityProcess.fork(join(root, "server/index.ts"), [], {
    cwd: root,
    execArgv: ["--experimental-strip-types"],
    env: {
      HOME: home, USERPROFILE: home, COLONIE_DATA_DIR: home, PATH: "",
      // Engine discovery stays inside this home: no developer CLI becomes an engine.
      COLONIE_TEST_SEALED_PATH: "1",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      COLONIE_PORT: String(port), COLONIE_WEBHOOK_PORT: String(webhookPort),
      COLONIE_TEST_INTERNAL_CAPABILITY_KEY: testCapabilityKey,
    },
    stdio: "pipe",
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  child.on("message", (message) => coordinator.receive(child, message));
  child.on("exit", () => coordinator.rejectProcess(child));
  const api = async (path, method = "GET", body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "content-type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  await until(() => api("/api/health").catch(() => null));
  const verifyUi = () => require("./testing/approval-ui-smoke.cjs")({ root, url: `http://127.0.0.1:${port}`, api, until,
    grant: (botId, mode, options) => coordinator.request(child, botId, mode, options),
  });
  if (process.argv.includes("--skill-ui-only")) {
    await require("./testing/skill-approval-ui-smoke.cjs")({ root, home, url: `http://127.0.0.1:${port}`, api, until,
      capability: (botId, threadId) => api("/api/testing/internal-capability", "POST", { botId, threadId, skillAuthoring: true }, { "x-colonie-test-capability": testCapabilityKey }),
    });
    return;
  }
  if (process.argv.includes("--sidebar-attention-only")) {
    await require("./testing/sidebar-attention-ui-smoke.cjs")({ root, url: `http://127.0.0.1:${port}`, api, until });
    return;
  }
  if (process.argv.includes("--ui-only")) { await verifyUi(); return; }
  if (modelUi) {
    await require("./testing/model-switch-ui-smoke.cjs")({ root, url: `http://127.0.0.1:${port}`, api, until,
      grant: (botId, mode, options) => coordinator.request(child, botId, mode, options),
    });
    return;
  }
  const readBot = async (botId) => (await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === botId);
  const readFull = async (botId) => (await api("/api/bots")).body.bots.find((bot) => bot.id === botId);
  const pendingCard = (bot) => bot.messages.find((message) => message.card?.requestId && !message.card.answered && !message.card.dismissed)?.card;
  const settled = (botId) => until(async () => !(await readBot(botId))?.busy);
  const PROVIDERS = [["claude", "claude-sonnet-5"], ["codex", "gpt-6-astra"]];

  // One explicit grant covers old, archived and future threads, even if their
  // provider differs. Use the real private bridge, not fixture state edits.
  const whole = (await api("/api/bots", "POST", { name: "All threads fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  const untouched = (await api("/api/bots", "POST", { name: "Unrelated bot" })).body.bot;
  // Memory capture keeps the app's default behaviour: its analysis runs in a
  // separate adapter process tagged `internal`, which prompts() and lastMode()
  // skip, so it cannot stand in for the turn under test.
  await coordinator.request(child, whole.id, "ask");
  const threads = [];
  for (const [instanceId, model] of PROVIDERS) {
    const task = (await api(`/api/bots/${whole.id}/tasks`, "POST", { title: `Existing ${instanceId} conversation` })).body.task;
    assert.equal((await api(`/api/bots/${whole.id}/tasks/${task.threadId}`, "PATCH", { modelSelection: { instanceId, model } })).status, 200);
    threads.push(task.threadId);
  }
  assert.equal((await api(`/api/bots/${whole.id}/tasks/${threads[0]}`, "PATCH", { archivedAt: Date.now() })).status, 200);
  const allGranted = await coordinator.request(child, whole.id, "full", { allThreads: true });
  assert.equal(allGranted.approvalMode, "full");
  assert.ok(allGranted.tasks.every(task => task.approvalMode === "full"));
  const future = (await api(`/api/bots/${whole.id}/tasks`, "POST", { title: "Future thread" })).body.task;
  assert.equal(future.approvalMode, "full");
  assert.equal((await readBot(untouched.id)).approvalMode, untouched.approvalMode);
  const persisted = JSON.parse(readFileSync(join(home, "bots.json"), "utf8")).find(bot => bot.id === whole.id);
  assert.ok(persisted.tasks.every(task => task.approvalMode === "full"));
  assert.equal(persisted.approvalGrant, undefined);
  const revoked = await coordinator.request(child, whole.id, "ask", { allThreads: true });
  assert.equal(revoked.approvalMode, "ask");
  assert.ok(revoked.tasks.every(task => task.approvalMode === "ask"));
  console.log(JSON.stringify({ allThreads: true, mixedProviders: true, archivedIncluded: true, futureInherits: true, unrelatedBotUnchanged: true, persisted: true }));
  if (process.argv.includes("--all-threads-only")) { await verifyUi(); return; }

  // Every level is the adapter's own mode, passed through on each turn of one
  // continuing conversation. HTTP cannot elevate; only the private grant can.
  const levelBots = {};
  for (const [instanceId, model, dump, native] of [
    ["claude", "claude-sonnet-5", dumps.claude, { full: "bypassPermissions", auto: "auto", edits: "acceptEdits", ask: "default" }],
    ["codex", "gpt-6-astra", dumps.codex, { full: "agent-full-access", auto: "agent", edits: "workspace-write", ask: "read-only" }],
  ]) {
    const created = await api("/api/bots", "POST", { modelSelection: { instanceId, model } });
    assert.equal(created.status, 201);
    const bot = created.body.bot;
    levelBots[instanceId] = bot;
    assert.equal((await api(`/api/bots/${bot.id}`, "PATCH", { approvalMode: "full", acknowledgeFullAccess: true })).status, 403);
    const seenBefore = prompts(dump).length;
    const levels = ["full", "auto", "edits", "ask"];
    for (const mode of levels) {
      await coordinator.request(child, bot.id, mode);
      await until(async () => (await readBot(bot.id))?.approvalMode === mode);
      const before = prompts(dump).length;
      assert.equal((await api(`/api/bots/${bot.id}/messages`, "POST", { text: `Verify ${mode}` })).status, 202);
      await settled(bot.id);
      assert.equal(lastMode(dump, before), native[mode]);
      console.log(JSON.stringify({ provider: instanceId, mode, native: native[mode], privateGrant: true, turnSettled: true }));
    }
    // A level change keeps the conversation: every turn ran in one session.
    const turns = prompts(dump).slice(seenBefore);
    assert.equal(turns.length, 4);
    assert.deepEqual(turns.map((turn) => turn.mode), levels.map((mode) => native[mode]), "Each turn must run under its own level");
    assert.equal(new Set(turns.map((turn) => turn.sessionId)).size, 1, "Level transitions must continue the same conversation");
    // Custom is a provider config of its own; an ACP adapter carries settings.
    await assert.rejects(coordinator.request(child, bot.id, "custom"), /only for Codex/);
    assert.equal((await readBot(bot.id)).approvalMode, "ask");
    console.log(JSON.stringify({ provider: instanceId, levelTransitions: true, sameSession: true, customRefused: true }));
  }

  // An adapter that does not advertise Auto or Accept edits keeps Ask: a level
  // never falls upward into more access. Full still reaches the adapter's Full.
  for (const [instanceId, model, dump, ask, full] of [
    ["claude-clamped", "claude-sonnet-5", dumps.clamped, "default", "bypassPermissions"],
    ["codex-clamped", "gpt-6-astra", dumps.codexClamped, "read-only", "agent-full-access"],
  ]) {
    const bot = (await api("/api/bots", "POST", { modelSelection: { instanceId, model } })).body.bot;
    for (const mode of ["auto", "edits", "full", "ask"]) {
      await coordinator.request(child, bot.id, mode);
      const before = prompts(dump).length;
      assert.equal((await api(`/api/bots/${bot.id}/messages`, "POST", { text: `Clamp ${mode}` })).status, 202);
      await settled(bot.id);
      assert.equal(lastMode(dump, before), mode === "full" ? full : ask);
    }
    console.log(JSON.stringify({ provider: instanceId, unadvertisedLevelsKeepAsk: true }));
  }

  // Existing conversations retain their snapshot when the bot default
  // changes. Only an explicit private desktop grant may upgrade one thread.
  for (const [instanceId, model] of PROVIDERS) {
    const scoped = (await api("/api/bots", "POST", { name: "Existing thread", modelSelection: { instanceId, model } })).body.bot;
    await coordinator.request(child, scoped.id, "ask");
    const old = (await api(`/api/bots/${scoped.id}/tasks`, "POST", { title: "Existing Ask thread" })).body.task;
    const other = (await api(`/api/bots/${scoped.id}/tasks`, "POST", { title: "Leave this thread alone" })).body.task;
    assert.ok(old?.threadId && other?.threadId);
    await assert.rejects(coordinator.request(child, scoped.id, "full", { threadId: old.threadId }), /bot settings/);
    await coordinator.request(child, scoped.id, "full");
    const readScoped = () => readBot(scoped.id);
    await until(async () => (await readScoped()).approvalMode === "full");
    if (instanceId === "claude") {
      assert.equal((await api(`/api/bots/${scoped.id}/tasks/${other.threadId}`, "PATCH", { approvalMode: "edits" })).status, 200);
      await api(`/api/bots/${scoped.id}/tasks/${other.threadId}`, "PATCH", { approvalMode: "ask", modelSelection: { instanceId: "codex", model: "gpt-6-astra" } });
      await assert.rejects(coordinator.request(child, scoped.id, "full", { threadId: other.threadId }), /bot's provider/);
      // Codex ACP offers Accept edits (`workspace-write`), but never Custom.
      assert.equal((await api(`/api/bots/${scoped.id}/tasks/${other.threadId}`, "PATCH", { approvalMode: "edits" })).status, 200);
      assert.equal((await api(`/api/bots/${scoped.id}/tasks/${other.threadId}`, "PATCH", { approvalMode: "custom" })).status, 403);
      assert.equal((await api(`/api/bots/${scoped.id}/tasks/${other.threadId}`, "PATCH", { approvalMode: "ask" })).status, 200);
    }
    assert.equal((await readScoped()).tasks.find((task) => task.threadId === old.threadId).approvalMode, "ask");
    assert.equal((await api(`/api/bots/${scoped.id}/tasks/${old.threadId}`, "PATCH", { approvalMode: "full" })).status, 403);
    await coordinator.request(child, scoped.id, "full", { threadId: old.threadId });
    await until(async () => (await readScoped()).tasks.find((task) => task.threadId === old.threadId).approvalMode === "full");
    assert.equal((await readScoped()).tasks.find((task) => task.threadId === other.threadId).approvalMode, "ask");
    await assert.rejects(coordinator.request(child, scoped.id, "full", { threadId: "missing-thread" }), /bot settings/);
    const sentBefore = prompts(dumps[instanceId]).length;
    const sent = await api(`/api/bots/${scoped.id}/messages`, "POST", { text: "Verify existing thread Full", threadId: old.threadId });
    assert.equal(sent.status, 202);
    await until(async () => !(await readScoped()).tasks.find((task) => task.threadId === old.threadId).busy);
    assert.equal(lastMode(dumps[instanceId], sentBefore), instanceId === "claude" ? "bypassPermissions" : "agent-full-access");
    console.log(JSON.stringify({ provider: instanceId, existingThread: "full", otherThread: "ask", privateGrant: true, turnSettled: true }));
  }

  // Composer grants are independent: an Ask default is not a prerequisite
  // trip through settings, and a thread may use a different provider.
  const direct = (await api("/api/bots", "POST", { name: "Composer scoped access", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  await coordinator.request(child, direct.id, "ask");
  const selected = (await api(`/api/bots/${direct.id}/tasks`, "POST", { title: "Select Full here" })).body.task;
  const sibling = (await api(`/api/bots/${direct.id}/tasks`, "POST", { title: "Keep Ask here" })).body.task;
  const committed = await coordinator.request(child, direct.id, "full", { threadId: selected.threadId, threadOnly: true });
  assert.equal(committed.approvalMode, "ask");
  assert.equal(committed.tasks.find(task => task.threadId === selected.threadId).approvalMode, "full");
  assert.equal(committed.tasks.find(task => task.threadId === sibling.threadId).approvalMode, "ask");
  await assert.rejects(coordinator.request(child, direct.id, "full", { threadId: "missing", threadOnly: true }), /existing thread/);
  await coordinator.request(child, direct.id, "ask", { threadId: selected.threadId, threadOnly: true });
  await api(`/api/bots/${direct.id}/tasks/${selected.threadId}`, "PATCH", { modelSelection: { instanceId: "codex", model: "gpt-6-astra" } });
  // A thread on another ACP provider takes that provider's levels, never Custom.
  await assert.rejects(coordinator.request(child, direct.id, "custom", { threadId: selected.threadId, threadOnly: true }), /does not support that approval level/);
  const edits = await coordinator.request(child, direct.id, "edits", { threadId: selected.threadId, threadOnly: true });
  assert.equal(edits.approvalMode, "ask");
  assert.equal(edits.tasks.find(task => task.threadId === selected.threadId).approvalMode, "edits");
  const downgraded = await coordinator.request(child, direct.id, "ask", { threadId: selected.threadId, threadOnly: true });
  assert.equal(downgraded.tasks.find(task => task.threadId === selected.threadId).approvalMode, "ask");
  assert.equal(downgraded.approvalMode, "ask");
  console.log(JSON.stringify({ composerGrant: true, defaultRemainsAsk: true, otherProviderLevels: true, customRefusedOnAcp: true }));

  const parallel = (await api("/api/bots", "POST", { name: "Parallel permission fixture", modelSelection: { instanceId: "claude-permission", model: "claude-sonnet-5" } })).body.bot;
  await coordinator.request(child, parallel.id, "ask");
  const working = (await api(`/api/bots/${parallel.id}/tasks`, "POST", { title: "Already running" })).body.task;
  const idle = (await api(`/api/bots/${parallel.id}/tasks`, "POST", { title: "Configure independently" })).body.task;
  assert.equal((await api(`/api/bots/${parallel.id}/tasks/${working.threadId}`, "POST")).status, 200);
  assert.equal((await api(`/api/bots/${parallel.id}/messages`, "POST", { text: "Hold for fixture approval", threadId: working.threadId })).status, 202);
  const held = await until(async () => pendingCard(await readFull(parallel.id)));
  const parallelModes = async () => (await readBot(parallel.id)).tasks.map(task => task.approvalMode);
  const modesBefore = await parallelModes();
  await assert.rejects(coordinator.request(child, parallel.id, "full", { allThreads: true }), /active turns/);
  assert.deepEqual(await parallelModes(), modesBefore);
  await assert.rejects(coordinator.request(child, parallel.id, "full", { threadId: working.threadId, threadOnly: true }), /Stop this thread/);
  const separate = await coordinator.request(child, parallel.id, "full", { threadId: idle.threadId, threadOnly: true });
  assert.equal(separate.tasks.find(task => task.threadId === working.threadId).busy, true);
  assert.equal(separate.tasks.find(task => task.threadId === working.threadId).approvalMode, "ask");
  assert.equal(separate.tasks.find(task => task.threadId === idle.threadId).approvalMode, "full");
  await api(`/api/bots/${parallel.id}/respond`, "POST", { requestId: held.requestId, behavior: "deny" });
  await settled(parallel.id);
  console.log(JSON.stringify({ composerGrantWhileSiblingBusy: true, siblingNotInterrupted: true }));

  // The adapter's own permission request under each level. Full answers it for
  // the person (and logs that); Auto leaves what the provider's reviewer still
  // asks to the person; Ask and Accept edits always ask. Answers reach the
  // adapter, which closes the turn.
  for (const [instanceId, dump, native] of [
    ["claude-permission", dumps.permission, { full: "bypassPermissions", auto: "auto", edits: "acceptEdits", ask: "default" }],
    ["codex-permission", dumps.codexPermission, { full: "agent-full-access", auto: "agent", edits: "workspace-write", ask: "read-only" }],
  ]) {
    const model = instanceId.startsWith("claude") ? "claude-sonnet-5" : "gpt-6-astra";
    const bot = (await api("/api/bots", "POST", { modelSelection: { instanceId, model } })).body.bot;
    let fullTurns = 0;
    for (const [turn, mode] of ["full", "full", "ask", "auto", "edits", "ask"].entries()) {
      await coordinator.request(child, bot.id, mode);
      await until(async () => (await readBot(bot.id))?.approvalMode === mode);
      const before = (await readFull(bot.id)).messages.length;
      const promptsBefore = prompts(dump).length;
      assert.equal((await api(`/api/bots/${bot.id}/messages`, "POST", { text: `Verify ${mode} turn ${turn}` })).status, 202);
      const behavior = turn === 5 ? "deny" : "allow";
      if (mode === "full") {
        fullTurns++;
        const done = await until(async () => {
          const state = await readFull(bot.id);
          assert.equal(pendingCard(state), undefined, "Full must answer residual tool permissions without a manual card");
          return !state.busy && state;
        });
        assert.ok(done.messages.slice(before).some((message) => message.tool?.name?.includes("(full access)")));
        await until(async () => (await api("/api/decisions")).body.decisions.filter((row) => row.botId === bot.id && row.source === "full-access" && row.decision === "auto-approved").length === fullTurns);
      } else {
        const card = await until(async () => pendingCard(await readFull(bot.id)));
        if (mode === "auto") assert.equal(card.held, "The provider requires your approval for this action.");
        const answered = await api(`/api/bots/${bot.id}/respond`, "POST", { requestId: card.requestId, behavior });
        assert.equal(answered.status, 200);
        await settled(bot.id);
        const row = await until(async () => (await api("/api/decisions")).body.decisions.find((entry) => entry.requestId === card.requestId && entry.decision === "card-shown"));
        assert.equal(row.source, mode === "auto" ? "native-approval" : "no-grant");
      }
      assert.equal(lastMode(dump, promptsBefore), native[mode]);
      console.log(JSON.stringify({ provider: instanceId, mode, native: native[mode], autoApproved: mode === "full", humanAnswer: mode === "full" ? null : behavior }));
    }
  }

  // A question is for a person in every level, Full included.
  const questionBot = (await api("/api/bots", "POST", { modelSelection: { instanceId: "claude-question", model: "claude-sonnet-5" } })).body.bot;
  await coordinator.request(child, questionBot.id, "full");
  assert.equal((await api(`/api/bots/${questionBot.id}/messages`, "POST", { text: "Ask me a question under Full" })).status, 202);
  const question = await until(async () => pendingCard(await readFull(questionBot.id)));
  assert.ok(question.options.includes("Blue") && question.options.includes("Green"));
  const answeredQuestion = await api(`/api/bots/${questionBot.id}/respond`, "POST", { requestId: question.requestId, behavior: "answer", message: "Green" });
  assert.equal(answeredQuestion.status, 200);
  await settled(questionBot.id);
  console.log(JSON.stringify({ provider: "claude-acp", mode: "full", questionRemainedInteractive: true }));

  // The test-only capability drives the real peer dispatch route without
  // introducing another fake-agent workflow or weakening production auth.
  const sender = levelBots.claude;
  const peerTarget = (await api("/api/bots", "POST", { modelSelection: { instanceId: "claude-permission", model: "claude-sonnet-5" } })).body.bot;
  await coordinator.request(child, peerTarget.id, "ask");
  const peerThread = (await api(`/api/bots/${peerTarget.id}/tasks`, "POST", { title: "Existing delegated conversation" })).body.task;
  await coordinator.request(child, peerTarget.id, "full");
  await coordinator.request(child, peerTarget.id, "full", { threadId: peerThread.threadId });
  assert.equal((await api(`/api/bots/${sender.id}`, "PATCH", { approvePeerComms: false })).status, 200);
  const capability = await api("/api/testing/internal-capability", "POST", { botId: sender.id, threadId: sender.threadId }, { "x-colonie-test-capability": testCapabilityKey });
  assert.equal(capability.status, 201);
  const peerPromptsBefore = prompts(dumps.permission).length;
  const peerRequest = api("/api/internal/ask-bot", "POST", { toBotId: peerTarget.id, message: "Peer-initiated permission fixture" }, { authorization: `Bearer ${capability.body.token}` });
  void peerRequest.catch(() => {});
  const peerDecisions = await until(async () => {
    const rows = (await api("/api/decisions")).body.decisions.filter((row) => row.botId === peerTarget.id);
    return rows.some((row) => row.source === "full-access") && rows;
  });
  assert.equal((await peerRequest).status, 200);
  assert.ok(!pendingCard(await readFull(peerTarget.id)));
  assert.ok(!peerDecisions.some((row) => row.decision === "card-shown"));
  assert.equal(lastMode(dumps.permission, peerPromptsBefore), "bypassPermissions");
  console.log(JSON.stringify({ provider: "claude-acp", mode: "full", peerInitiated: true, native: "bypassPermissions", autoApproved: true, humanApproved: false }));

  // Revoking the receiving thread's grant must restore prompts on the resumed
  // delegated session, even when the sender itself has Full access.
  await coordinator.request(child, sender.id, "full");
  await coordinator.request(child, peerTarget.id, "ask");
  assert.equal((await api(`/api/bots/${peerTarget.id}/tasks/${peerThread.threadId}`, "PATCH", { approvalMode: "ask" })).status, 200);
  const askPromptsBefore = prompts(dumps.permission).length;
  const askPeerRequest = api("/api/internal/ask-bot", "POST", { toBotId: peerTarget.id, message: "Ask target must not inherit sender Full" }, { authorization: `Bearer ${capability.body.token}` });
  void askPeerRequest.catch(() => {});
  const peerCard = await until(async () => pendingCard(await readFull(peerTarget.id)));
  assert.equal(lastMode(dumps.permission, askPromptsBefore), "default");
  assert.equal((await api(`/api/bots/${peerTarget.id}/respond`, "POST", { requestId: peerCard.requestId, behavior: "allow" })).status, 200);
  assert.equal((await askPeerRequest).status, 200);
  console.log(JSON.stringify({ provider: "claude-acp", mode: "ask", senderMode: "full", peerInitiated: true, native: "default", humanApproved: true }));
  // Delegated Custom no longer exists on ACP: Custom is refused for both
  // adapters above, so no delegated turn can run under it.
  if (process.argv.includes("--ui")) {
    await verifyUi();
    await require("./testing/sidebar-attention-ui-smoke.cjs")({ root, url: `http://127.0.0.1:${port}`, api, until });
  }
  console.log("Approval smoke passed; HTTP elevation rejected, private grant and ACP mode transitions verified.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(cleanup);

let cleaning;
function cleanup() {
  cleaning ??= (async () => {
    clearTimeout(overall);
    if (child?.pid) {
      const exited = once(child, "exit");
      child.kill();
      // The server stops its adapters on exit; never wait forever for it.
      await Promise.race([exited, delay(5_000)]);
    }
    rmSync(home, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  })();
  return cleaning;
}
