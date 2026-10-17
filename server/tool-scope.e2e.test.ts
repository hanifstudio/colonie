import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlColonie, verificationServerEnvironment } from "../scripts/control-colonie.ts";

async function withFixture(mode: "happy" | "hang", run: (helpers: {
  api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  control(args: string[]): Promise<any>;
  url: string;
  dataDir: string;
  mounts(): Promise<Array<{ name: string; command?: string; env?: Array<{ name: string; value: string }> }>>;
}) => Promise<void>) {
  // The maintained scripted ACP fixture plays the engine; its mode is a
  // per-instance FAKE_ACP_* knob passed through the launcher options.
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [],
    undefined, undefined, false, { fakeAcp: { env: { claude: { FAKE_ACP_MODE: mode } } } });
  const mountsPath = `${fixture.fixtureDumpPath}.mcp.json`;
  try {
    await run({
      url: fixture.info.url, dataDir: fixture.info.dataDir,
      api: async (method, path, body, headers = {}) => {
        const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
      },
      control: (args) => runControlColonie([...args, "--url", fixture.info.url]),
      // The MCP servers the engine was handed by the latest session/new,
      // session/load or session/resume, consumed so the next read is fresh.
      mounts: async () => {
        await expect.poll(() => existsSync(mountsPath), { timeout: 15_000 }).toBe(true);
        const value = JSON.parse(readFileSync(mountsPath, "utf8"));
        rmSync(mountsPath, { force: true });
        return value;
      },
    });
  } finally { await fixture.close(); }
}

it("validates, saves, clears and creates owner tool selections through the isolated API", async () => {
  await withFixture("happy", async ({ api, control, dataDir }) => {
    const { bot } = await control(["new-bot", "--name", "Selected tools fixture"]);
    const path = `/api/bots/${bot.id}`;
    const scope = { allow: ["native:read", "native:read"], deny: ["mcp:notes:write"] };
    expect((await api("PATCH", path, { toolScope: scope })).body.bot.toolScope).toEqual({ allow: ["native:read"], deny: ["mcp:notes:write"] });
    for (const toolScope of [false, [], { allow: "all" }, { allow: ["read"] }, { deny: ["mcp:*:read"] }, { unrecognized: true }]) {
      expect((await api("PATCH", path, { toolScope })).status).toBe(400);
    }
    expect((await api("PATCH", path, { toolScope: { allow: [] } })).body.bot.toolScope).toEqual({ allow: [] });
    const persisted = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    expect(persisted.find((row: { id: string }) => row.id === bot.id).toolScope).toEqual({ allow: [] });
    expect((await api("PATCH", path, { title: "Unrelated edit" })).body.bot.toolScope).toEqual({ allow: [] });
    expect((await api("PATCH", path, { toolScope: null })).body.bot).not.toHaveProperty("toolScope");
    expect((await api("PATCH", `${path}/profile`, { toolScope: scope })).status).toBe(400);
    expect((await api("PATCH", "/api/config", { newBotDefaults: { profile: { toolScope: { allow: [] } } } })).status).toBe(200);
    expect((await api("POST", "/api/bots", { name: "Inherited no tools" })).body.bot.toolScope).toEqual({ allow: [] });
    expect((await api("POST", "/api/bots", { name: "Explicit reset", settings: { toolScope: null } })).body.bot).not.toHaveProperty("toolScope");
  });
}, 60_000);

it.each(["explicit", "inherited"] as const)("persists the %s tool selection before creation can be interrupted", async (source) => {
  await withFixture("happy", async ({ api, dataDir }) => {
    const toolScope = { allow: [] };
    if (source === "inherited") {
      expect((await api("PATCH", "/api/config", { newBotDefaults: { profile: { toolScope } } })).status).toBe(200);
    }
    const database = new DatabaseSync(join(dataDir, "messages.db"));
    try {
      // Interrupt the real creation after its first durable record, before
      // the route can apply any remaining template settings.
      database.exec("CREATE TRIGGER reject_scope_fixture_greeting BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'fixture greeting failure'); END");
      const name = `Interrupted ${source} scope fixture`;
      const result = await api("POST", "/api/bots", { name, ...(source === "explicit" ? { settings: { toolScope } } : {}) });
      expect(result.status).toBe(500);
      const saved = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
      expect(saved.find((bot: { name: string }) => bot.name === name)?.toolScope).toEqual(toolScope);
      const live = await api("GET", "/api/bots?messages=0");
      expect(live.body.bots.find((bot: { name: string }) => bot.name === name)?.toolScope).toEqual(toolScope);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_scope_fixture_greeting");
      database.close();
    }
  });
}, 60_000);

it.each(["direct", "preview"] as const)("keeps a corrupt persisted selection fail-closed while reporting the %s result", async (surface) => {
  const fixture = await launchVerificationServer();
  let restarted: ReturnType<typeof spawn> | undefined;
  const log = openSync(fixture.info.logPath, "a", 0o600);
  try {
    const control = (args: string[]) => runControlColonie([...args, "--url", fixture.info.url]);
    const { bot } = await control(["new-bot", "--name", "Corrupt scope fixture"]) as any;
    const stopped = once(fixture.child, "close"); fixture.child.kill(); await stopped;
    const file = join(fixture.info.dataDir, "bots.json");
    const bots = JSON.parse(readFileSync(file, "utf8"));
    const storedBot = bots.find((row: { id: string }) => row.id === bot.id);
    storedBot.toolScope = { allow: "all" };
    writeFileSync(file, JSON.stringify(bots));
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      env: verificationServerEnvironment(process.env, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
      stdio: ["ignore", log, log],
    });
    await expect.poll(async () => {
      if (restarted!.exitCode !== null) throw new Error("Restarted fixture exited");
      try { return (await fetch(`${fixture.info.url}/api/health`)).ok; } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);
    const loaded = await fetch(`${fixture.info.url}/api/bots?messages=0`).then((response) => response.json()) as { bots: Array<{ id: string; toolScope?: unknown }> };
    expect(loaded.bots.find((row) => row.id === bot.id)?.toolScope).toEqual({ allow: "all" });
    if (surface === "preview") {
      const preview = await fetch(`${fixture.info.url}/api/bots/${bot.id}/local-computer?threadId=${storedBot.threadId}`);
      expect(preview.status).toBe(200);
      expect(await preview.json()).not.toHaveProperty("error");
      expect((await fetch(`${fixture.info.url}/api/bots/${bot.id}/local-computer?threadId=not-a-task`)).status).toBe(404);
    } else {
      const before = await control(["messages", "--bot", bot.id, "--limit", "10"]);
      const sent = await fetch(`${fixture.info.url}/api/bots/${bot.id}/messages`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Must not run." }) });
      expect(sent.status).toBe(409);
      expect(await sent.json()).toMatchObject({ error: expect.stringMatching(/tool selection is invalid/i) });
      expect(await control(["messages", "--bot", bot.id, "--limit", "10"])).toEqual(before);
    }
    // The app's own work (memory analysis, model discovery) also reaches the
    // fake adapter and is tagged `internal`; only a conversation prompt counts.
    const promptLog = `${fixture.fixtureDumpPath}.prompts.jsonl`;
    const conversationPrompts = existsSync(promptLog)
      ? readFileSync(promptLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => !line.internal)
      : [];
    expect(conversationPrompts).toEqual([]);
  } finally {
    if (restarted && restarted.exitCode === null && restarted.signalCode === null) {
      const stopped = once(restarted, "close"); restarted.kill(); await stopped;
    }
    closeSync(log);
    await fixture.close();
  }
}, 60_000);

it("refuses selection changes during a direct turn and requires a trusted widening path", async () => {
  await withFixture("hang", async ({ api, control, mounts, url }) => {
    const { bot } = await control(["new-bot", "--name", "Active scope fixture"]);
    const { bot: idle } = await control(["new-bot", "--name", "Idle scope fixture"]);
    const current = { allow: ["native:*"] };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { toolScope: current })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${idle.id}`, { toolScope: { allow: [] } })).status).toBe(200);
    await control(["send", "--bot", bot.id, "--text", "Stay active."]);
    // session/new has reached the hanging ACP engine: the turn is live.
    await mounts();
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((row: { id: string }) => row.id === bot.id)?.busy, { timeout: 15_000 }).toBe(true);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { toolScope: { allow: [] } }, { origin: url })).status).toBe(409);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { toolScope: { deny: ["native:bash"] } }, { origin: url })).status).toBe(409);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { toolScope: current })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${idle.id}`, { toolScope: null })).status).toBe(409);
    expect((await api("PATCH", `/api/bots/${idle.id}`, { toolScope: { allow: ["native:read"] } }, { origin: url })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${idle.id}`, { toolScope: { allow: [] } })).status).toBe(200);
    await control(["interrupt", "--bot", bot.id]); await control(["wait", "--bot", bot.id, "--timeout", "30"]);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { toolScope: { allow: [] } }, { origin: url })).status).toBe(200);
  });
}, 60_000);

it("carries the latest original tool selection into each fresh direct ACP MCP connection", async () => {
  await withFixture("happy", async ({ api, control, mounts }) => {
    const server = { name: "notes", command: process.execPath, args: ["--experimental-strip-types", fileURLToPath(new URL("./testing/fake-mcp-server.ts", import.meta.url))], enabled: true };
    expect((await api("POST", "/api/mcp/servers", server)).status).toBe(201);
    expect((await api("PATCH", "/api/mcp/servers/notes", { enabled: true })).status).toBe(200);
    const { bot } = await control(["new-bot", "--name", "Scope dispatch fixture"]);
    const policyPath = `/api/bots/${bot.id}/connected-tools`;
    const view = await api("GET", policyPath);
    expect((await api("PATCH", policyPath, { expectedRevision: view.body.revision, preferences: { toolkits: [], customServers: ["notes"] } })).status).toBe(200);
    const scopeOf = (servers: Awaited<ReturnType<typeof mounts>>) => {
      const notes = servers.find((entry) => entry.name === "notes");
      expect(notes).toBeDefined();
      const value = notes!.env?.find((entry) => entry.name === "COLONIE_GATE_TOOL_SCOPE")?.value;
      expect(value).toEqual(expect.any(String));
      return JSON.parse(value!);
    };
    const first = { allow: ["native:*", "mcp:notes:read_notes"] };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { toolScope: first })).status).toBe(200);
    await control(["send", "--bot", bot.id, "--text", "Reply once."]);
    expect(scopeOf(await mounts())).toEqual(first);
    await control(["wait", "--bot", bot.id, "--timeout", "30"]);
    const narrowed = { allow: ["native:*", "mcp:notes:read_notes"], deny: ["mcp:notes:write_notes"] };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { toolScope: narrowed })).status).toBe(200);
    await control(["send", "--bot", bot.id, "--text", "Reply once more."]);
    expect(scopeOf(await mounts())).toEqual(narrowed);
    await control(["wait", "--bot", bot.id, "--timeout", "30"]);
  });
}, 60_000);
