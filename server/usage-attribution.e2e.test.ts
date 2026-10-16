// Who a turn is booked to, end to end: boots the real harness against the
// fake engines in a disposable home, sends as this machine (loopback) and as
// this machine, and reads the usage ledger file back. A turn belongs to
// the sender of the message that started it: a queued or
// steered words, or pressing Steer, never re-book it; a queued message's own
// turn is booked to its sender; a guarded relay (the Slack worker) names the
// person it acts for.
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
/** The scripted ACP engine, spawned exactly as the runtime spawns a real
 * adapter: the same stdio boundary, a different program. */
const ACP_CONFIG = { cli: process.execPath, args: [FAKE_ACP] };
// The modes the maintained Claude adapter advertises; the runtime validates
// set_mode against the session's own list.
const ACP_MODES = { FAKE_ACP_MODES: "default,bypassPermissions" };
// The models the price tests select, offered the way a real session offers
// them: the runtime refuses a selection the session does not advertise.
const ACP_MODELS = { FAKE_ACP_MODELS: "fake-model,claude-fake,grok-4.7" };
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("usage attribution e2e", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let finishGate: string;
  let acpStarted: string;
  let slowStarted: string;

  type Reply = { status: number; body: any };
  const request = async (headers: Record<string, string>, method: string, path: string, body?: unknown): Promise<Reply> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const api = (method: string, path: string, body?: unknown) => request({}, method, path, body);
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const asPerson = async () => api;
  const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  /** The ledger rows for one bot (or one room's speakers), oldest first. */
  const ledger = (botId: string) => {
    const file = join(home, ".colonie", "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.botId === botId);
  };
  const newBot = async (instanceId: string, model: string) => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId, model } });
    return created as { id: string; threadId: string };
  };
  const owner = { kind: "owner" };
  /** The engine having the prompt in hand. The busy flag flips when the turn
   * is claimed, before the engine is asked to do anything; an interrupt in
   * that window never reaches the running turn, so the tests that stop a turn
   * wait for the scripted engine to announce it started. */
  const engineStarted = async (file: string, what: string) => waitFor(() => existsSync(file), what);
  const arm = (file: string) => rmSync(file, { force: true });

  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "colonie-attribution-"));
    mkdirSync(join(home, ".colonie"), { recursive: true });
    finishGate = join(home, "finish-steered-turn.gate");
    acpStarted = join(home, "acp-started");
    slowStarted = join(home, "slow-started");
    writeFileSync(
      join(home, ".colonie", "config.json"),
      JSON.stringify({
        instances: {
          // Colonie is ACP-only: every engine here is the scripted ACP fake
          // behind the claude-acp flavor.
          claude: { driver: "claude-acp", environment: { ...ACP_MODES, ...ACP_MODELS }, config: ACP_CONFIG },
          // holds a turn open until the gate file exists: the deterministic
          // busy window the steer tests need
          claudeSlow: {
            driver: "claude-acp",
            environment: { ...ACP_MODES, ...ACP_MODELS, FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: finishGate, FAKE_ACP_STARTED_FILE: slowStarted },
            config: ACP_CONFIG,
          },
          // no live session: a message while busy waits in the server-side queue
          acp: {
            driver: "claude-acp",
            environment: { ...ACP_MODES, ...ACP_MODELS, FAKE_ACP_MODE: "hang", FAKE_ACP_STARTED_FILE: acpStarted },
            config: ACP_CONFIG,
          },
          // names the models the price tests select, and reports tokens
          // (10 in, 5 out) without a price, like every engine but Claude
          acpHappy: { driver: "claude-acp", environment: { ...ACP_MODES, ...ACP_MODELS }, config: ACP_CONFIG },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, COLONIE_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("books an engine that reports tokens but no price at an estimate, and an unlisted model as unpriced", async () => {
    const listed = await newBot("acpHappy", "grok-4.7");
    expect((await api("POST", `/api/bots/${listed.id}/messages`, { text: "priced from the list" })).status).toBe(202);
    await waitFor(() => ledger(listed.id).length === 1, "the listed model's turn to be booked");
    const row = ledger(listed.id)[0];
    expect(row).toMatchObject({ driverKind: "claude-acp", model: "grok-4.7", input: 10, output: 5, costSource: "estimated" });
    // xAI's list price for grok-4.7: $2 in, $6 out per million tokens
    expect(row.costUsd).toBeCloseTo((10 * 2 + 5 * 6) / 1_000_000, 12);

    const unlisted = await newBot("acpHappy", "fake-model");
    expect((await api("POST", `/api/bots/${unlisted.id}/messages`, { text: "no known price" })).status).toBe(202);
    await waitFor(() => ledger(unlisted.id).length === 1, "the unlisted model's turn to be booked");
    expect(ledger(unlisted.id)[0].costUsd).toBeNull();
    expect(ledger(unlisted.id)[0]).not.toHaveProperty("costSource");

    const usage = (await api("GET", "/api/usage?groupBy=bot")).body;
    const byBot = (id: string) => usage.groups.find((g: any) => g.key === `bot:${id}`);
    expect(byBot(listed.id)).toMatchObject({ unpriced: 0 });
    expect(byBot(listed.id).estimatedUsd).toBeCloseTo(row.costUsd, 12);
    expect(byBot(unlisted.id)).toMatchObject({ costUsd: null, estimatedUsd: null, unpriced: 1 });
    await waitFor(async () => (await getBot(unlisted.id)).busy === false, "the bots to go idle");
  }, 40_000);

  it("a queued message leaves the running turn with its starter, and its own turn is booked on its own", async () => {
    const bot = await newBot("acp", "fake-model");
    arm(acpStarted);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "owner's work" })).status).toBe(202);
    await engineStarted(acpStarted, "the owner's turn to reach the engine");
    arm(acpStarted);
    const asPaired = await asPerson();
    const queued = await asPaired("POST", `/api/bots/${bot.id}/messages`, { text: "person's follow-up" });
    expect(queued.body.queued).toBe(true);

    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await waitFor(() => ledger(bot.id).length === 1, "the owner's turn to be booked");
    expect(ledger(bot.id)[0].trigger).toEqual(owner);

    await engineStarted(acpStarted, "the queued turn to reach the engine");
    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await waitFor(() => ledger(bot.id).length === 2, "the queued turn to be booked");
    expect(ledger(bot.id)[1].trigger).toEqual(owner);
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the bot to go idle");
  }, 40_000);

  it("words sent into a running turn wait in the queue: an ACP engine has no live steer channel", async () => {
    arm(finishGate);
    arm(slowStarted);
    const bot = await newBot("claudeSlow", "claude-fake");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "first" })).status).toBe(202);
    await engineStarted(slowStarted, "the gated turn to reach the engine");
    const asPaired = await asPerson();
    let sent: Reply;
    try {
      sent = await asPaired("POST", `/api/bots/${bot.id}/messages`, { text: "and also this" });
    } finally {
      writeFileSync(finishGate, "finish");
    }
    // Steering is a native-driver capability; ACP has no live channel, so the
    // words queue instead of folding into the turn that is already running.
    expect(sent.body).toMatchObject({ queued: true });
    expect(sent.body).not.toHaveProperty("steered");
    // The words did not fold into the turn that was running: the ledger books
    // two of the person's turns, not one that swallowed both messages.
    await waitFor(() => ledger(bot.id).length === 2, "both turns to be booked");
    expect(ledger(bot.id).map((row) => row.trigger)).toEqual([owner, owner]);
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the queue to drain");
  }, 40_000);

  it("pressing Steer on a queued message leaves it queued: an ACP engine cannot fold it in", async () => {
    arm(finishGate);
    arm(slowStarted);
    const bot = await newBot("claudeSlow", "claude-fake");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "owner's gated turn" })).status).toBe(202);
    await engineStarted(slowStarted, "the gated turn to reach the engine");
    const asPaired = await asPerson();
    const queued = await asPaired("POST", `/api/bots/${bot.id}/messages`, { text: "steer these words" });
    expect(queued.body.queued).toBe(true);
    const steered = await asPaired("POST", `/api/bots/${bot.id}/queue/${queued.body.queueId}/steer`, { threadId: bot.threadId });
    expect(steered.body).toMatchObject({ queued: true });
    expect(steered.body).not.toHaveProperty("steered");

    writeFileSync(finishGate, "finish");
    // The words did not fold into the turn that was running: the ledger books
    // two of the person's turns, not one that swallowed both messages.
    await waitFor(() => ledger(bot.id).length === 2, "both turns to be booked");
    expect(ledger(bot.id).map((row) => row.trigger)).toEqual([owner, owner]);
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the queue to drain");
  }, 40_000);

  it("a guarded relay books the turn to the person it names; without one it is this machine's", async () => {
    const health = await api("GET", "/api/health");
    expect(health.body.capabilities.guardedOnBehalfOf).toBe(1);
    const bot = await newBot("claude", "claude-fake");
    const send = async (sendId: string, extra: Record<string, unknown> = {}) => {
      const page = await api("GET", `/api/threads/${bot.threadId}/messages?limit=0`);
      return api("POST", `/api/bots/${bot.id}/messages/guarded`, {
        threadId: bot.threadId, sendId, text: `guarded ${sendId}`, expectedActiveLeafId: page.body.activeLeafId, ...extra,
      });
    };
    const refused = await send("guarded-send-invalid-0001", { onBehalfOf: {} });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("onBehalfOf must name the person with an email address, a name, or both");

    expect((await send("guarded-send-relayed-0001", { onBehalfOf: { email: " Ada@Example.test ", name: "Ada Lovelace" } })).status).toBe(202);
    await waitFor(() => ledger(bot.id).length === 1, "the relayed turn to be booked");
    expect(ledger(bot.id)[0].trigger).toEqual({ kind: "user", email: "ada@example.test", label: "Ada Lovelace" });
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the relayed turn to settle");

    expect((await send("guarded-send-owner-00001")).status).toBe(202);
    await waitFor(() => ledger(bot.id).length === 2, "the plain guarded turn to be booked");
    expect(ledger(bot.id)[1].trigger).toEqual(owner);
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the plain guarded turn to settle");

    expect(ledger(bot.id)).toHaveLength(2);
  }, 40_000);
});
