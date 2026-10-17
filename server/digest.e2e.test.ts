// The work digest, end to end and across engines (Phase 0, item 0.1 with
// the standing "every engine" rule): colonie is ACP-only, so "every engine"
// is the two maintained adapters, and the scripted ACP fake stands behind
// both. Runs one turn on each and asserts that exactly one `digest` row lands
// after the reply, naming the tools that engine's protocol exposed. Then the
// "done when" of the phase: a turn on one engine that changes a project file
// yields a digest naming the file, and the conversation stays with the engine
// that did the work — another engine cannot take over its native history.
//
// Same POSIX gating as branching.test.ts (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

interface Msg {
  id: string;
  role: string;
  kind: string;
  text?: string;
  turnId?: string;
  tool?: { name: string };
  digest?: { turnId: string; tools: Array<{ name: string; count: number }>; files?: { added: string[]; changed: string[] }; hookCoverage: string };
}

/** The scripted ACP engine, spawned exactly as the runtime spawns a real
 * adapter: the same stdio boundary, a different program. */
const FAKE_ACP = fake("fake-acp-cli.ts");
const ACP_CONFIG = { cli: process.execPath, args: [FAKE_ACP] };
/** The model the fake advertises, so a bot can select `fake-model`. */
const ACP_ENV = { FAKE_ACP_MODELS: "fake-model" };
/** The Claude adapter's own approval vocabulary, for the gated instance. */
const CLAUDE_MODES = { FAKE_ACP_MODES: "default,bypassPermissions,acceptEdits,auto" };
/** The Codex adapter's own approval vocabulary, for the echo instance. */
const CODEX_MODES = { FAKE_ACP_MODES: "read-only,agent-full-access,workspace-write,agent" };

/** One row per maintained adapter (the ACP pair is the whole fleet). `modes`
 * is the adapter's own approval vocabulary, which the scripted engine has to
 * advertise for the session mode to be settable; `tools` is what the fake's
 * default turn is known to emit through that protocol. */
const ENGINES = [
  { id: "claude-acp", driver: "claude-acp", modes: "default,bypassPermissions,acceptEdits,auto", tools: ["run"] },
  { id: "codex-acp", driver: "codex-acp", modes: "read-only,agent-full-access,workspace-write,agent", tools: ["run"] },
] as const;

posixOnly("work digest e2e (both maintained adapters)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  const gate = () => join(home, "acp.gate");
  const started = () => join(home, "acp.started");

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-3000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const settled = async (id: string) => {
    const b = await getBot(id);
    return !!b && !b.busy && b.messages.some((m: Msg) => m.role === "bot" && m.kind === "text" && m.text);
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "colonie-digest-e2e-"));
    mkdirSync(join(home, ".colonie"), { recursive: true });
    const instances: Record<string, unknown> = {};
    for (const e of ENGINES) {
      instances[e.id] = { driver: e.driver, environment: { ...ACP_ENV, FAKE_ACP_MODES: e.modes }, config: ACP_CONFIG };
    }
    // a gated ACP instance for the file-change test, and a second plain ACP
    // instance that echoes its prompt so the replay can be read back
    instances.gated = {
      driver: "claude-acp",
      environment: { ...ACP_ENV, ...CLAUDE_MODES, FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gate(), FAKE_ACP_STARTED_FILE: started() },
      config: ACP_CONFIG,
    };
    instances.echo = {
      // The other maintained adapter, so "another engine cannot take over this
      // native history" is exercised across adapters, not just across ids.
      driver: "codex-acp",
      environment: { ...ACP_ENV, ...CODEX_MODES, FAKE_ACP_MODE: "echo-gated" },
      config: ACP_CONFIG,
    };
    writeFileSync(join(home, ".colonie", "config.json"), JSON.stringify({ instances }));

    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, COLONIE_PORT: String(PORT) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it.each(ENGINES)("$id: one settled turn yields exactly one digest naming its tools", async (engine) => {
    const created = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: engine.id, model: "fake-model" } })).status).toBe(200);
    const sent = await api("POST", `/api/bots/${created.id}/messages`, { text: "do one thing" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await waitFor(() => settled(created.id), `${engine.id} to settle`);
    await waitFor(async () => (await getBot(created.id)).messages.some((m: Msg) => m.kind === "digest"), `${engine.id} digest`);

    const bot = await getBot(created.id);
    const digests: Msg[] = bot.messages.filter((m: Msg) => m.kind === "digest");
    const reply: Msg = bot.messages.find((m: Msg) => m.role === "bot" && m.kind === "text" && m.text);
    expect(digests).toHaveLength(1);
    const [d] = digests;
    expect(d!.role).toBe("bot");
    expect(d!.text).toMatch(/^\[digest\]/);
    expect(d!.digest?.turnId).toBeTruthy();
    if (reply.turnId) expect(d!.digest?.turnId).toBe(reply.turnId);
    const names = d!.digest!.tools.map((t) => t.name);
    for (const name of engine.tools) expect(names).toContain(name);
    // every activity row of the turn is attributed to it
    const activities: Msg[] = bot.messages.filter((m: Msg) => m.kind === "activity" && m.tool);
    for (const a of activities) expect(a.turnId).toBe(d!.digest?.turnId);
    expect(d!.digest!.tools.reduce((n, t) => n + t.count, 0)).toBe(activities.length);
  }, 45_000);

  it("names the project files a turn changed, and refuses another engine taking over that conversation", async () => {
    const project = mkdtempSync(join(tmpdir(), "colonie-digest-project-"));
    writeFileSync(join(project, "README.md"), "hello");
    const created = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${created.id}`, { cwd: project })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "gated", model: "fake-model" } })).status).toBe(200);

    // the turn is held open by the gate; "the engine" changes a file meanwhile
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "raise the retry limit" })).status).toBe(202);
    // busy flips at claim, BEFORE the pre-turn checkpoint; the fake's
    // started marker is written when the prompt reaches it, after that
    await waitFor(async () => existsSync(started()), "the gated turn to reach the engine");
    writeFileSync(join(project, "retry.ts"), "export const RETRY_LIMIT = 5;");
    writeFileSync(gate(), "go");
    await waitFor(() => settled(created.id), "the gated turn to settle");
    // the digest row lands first; the file list is patched onto it once the
    // workspace diff is ready, so wait for the state under test, not just the row
    await waitFor(async () => (await getBot(created.id)).messages.some((m: Msg) => m.kind === "digest" && m.digest?.files), "digest with files");
    const digest: Msg = (await getBot(created.id)).messages.find((m: Msg) => m.kind === "digest");
    expect(digest.digest?.files?.added).toEqual(["retry.ts"]);

    // switch engines: colonie is ACP-only, so the session and its digest
    // belong to the adapter that ran the turn. Handing the conversation to
    // another engine mid-history is refused — the words stay with the engine
    // that did the work — and this thread keeps the digest naming its file.
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "echo", model: "fake-model" } })).status).toBe(200);
    const refused = await api("POST", `/api/bots/${created.id}/messages`, { text: "what did you change?" });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toContain("belongs to another agent's native history");
    const kept: Msg = (await getBot(created.id)).messages.find((m: Msg) => m.kind === "digest");
    expect(kept.digest?.files?.added).toEqual(["retry.ts"]);
    await removeTempDir(project);
  }, 60_000);
});
