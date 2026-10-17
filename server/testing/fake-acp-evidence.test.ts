// The ACP fixture's evidence files, driven over its real stdio surface: the
// mode a prompt ran under, the append-only config-call log that survives
// several processes sharing one dump, opt-in unique session ids, and the
// app-internal marking derived from the session cwd.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./cleanup.ts";

const FAKE_ACP = fileURLToPath(new URL("./fake-acp-cli.ts", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "colonie-fake-acp-evidence-"));
  cleanups.push(() => removeTempDir(dir));
  return dir;
}

function subdir(parent: string, ...parts: string[]): string {
  const path = join(parent, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

const jsonLines = (file: string): any[] => existsSync(file)
  ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];

/** One initialized fake ACP process; sessions are opened on demand. */
async function startFake(env: Record<string, string>) {
  const child = spawn(process.execPath, [FAKE_ACP], {
    env: {
      ...process.env,
      FAKE_ACP_MODE: "happy", FAKE_CLAUDE_ROOM_PLAN: "", FAKE_ACP_TOOL_PLAN: "", FAKE_ACP_PROMPTS_FILE: "",
      FAKE_ACP_UNIQUE_SESSION_IDS: "", CLAUDE_CONFIG_DIR: "", CODEX_HOME: "",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanups.push(() => waitForExit(child, { signal: "SIGTERM", graceMs: 500 }));
  const waiting = new Map<number, (frame: any) => void>();
  let serial = 0;
  child.stderr.resume();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line);
    if (frame.method === undefined && frame.id !== undefined) waiting.get(frame.id)?.(frame);
  });
  const request = (method: string, params: unknown) => new Promise<any>((resolve) => {
    const id = ++serial;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await request("initialize", { protocolVersion: 1 });
  const open = async (cwd: string) => {
    const { result: { sessionId } } = await request("session/new", { cwd, mcpServers: [] });
    return {
      sessionId: sessionId as string,
      setMode: (modeId: string) => request("session/set_mode", { sessionId, modeId }),
      prompt: (text: string) => request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
    };
  };
  return { pid: child.pid!, request, open };
}

const MODES = { FAKE_ACP_MODES: "default,acceptEdits,bypassPermissions", FAKE_ACP_MODELS: "fake-model" };

describe("session/set_mode evidence", () => {
  it("records the mode each prompt actually ran under", { timeout: 15_000 }, async () => {
    const dir = tempDir();
    const dump = join(dir, "dump.json");
    const fake = await startFake({ ...MODES, FAKE_ACP_DUMP: dump });
    const session = await fake.open(subdir(dir, "work"));
    expect((await session.prompt("before any switch")).result?.stopReason).toBe("end_turn");
    for (const modeId of ["bypassPermissions", "acceptEdits", "default"]) {
      expect((await session.setMode(modeId)).result).toEqual({});
      expect((await session.prompt(`under ${modeId}`)).result?.stopReason).toBe("end_turn");
    }
    expect(jsonLines(`${dump}.prompts.jsonl`).map((line) => line.mode))
      .toEqual(["default", "bypassPermissions", "acceptEdits", "default"]);
    // A later session/load reports the mode the session is in now.
    const loaded = await fake.request("session/load", { sessionId: session.sessionId, cwd: dir, mcpServers: [] });
    expect(loaded.result.modes.currentModeId).toBe("default");
  });
});

describe("append-only config-call log", () => {
  it("keeps every process's calls where .config.json keeps only the last writer's", { timeout: 20_000 }, async () => {
    const dir = tempDir();
    const dump = join(dir, "dump.json");
    const conversation = await startFake({ ...MODES, FAKE_ACP_DUMP: dump });
    const chat = await conversation.open(subdir(dir, "chat"));
    await chat.setMode("bypassPermissions");
    // A second process of the same instance (memory analysis, a pooled
    // replacement) switches its own session afterwards.
    const other = await startFake({ ...MODES, FAKE_ACP_DUMP: dump });
    const background = await other.open(subdir(dir, "other"));
    await background.setMode("default");

    // Backward compatible: still a per-process array, overwritten by the other.
    expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8")))
      .toEqual([{ method: "session/set_mode", params: { sessionId: background.sessionId, modeId: "default" } }]);
    const calls = jsonLines(`${dump}.config.jsonl`);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(Object.keys(call).sort()).toEqual(["at", "method", "params", "pid", "sessionId"]);
      expect(typeof call.at).toBe("number");
    }
    const ownLast = calls.filter((call) => call.pid === conversation.pid && call.method === "session/set_mode").at(-1);
    expect(ownLast).toMatchObject({ sessionId: chat.sessionId, params: { modeId: "bypassPermissions" } });
    expect(calls.find((call) => call.pid === other.pid)).toMatchObject({ params: { modeId: "default" } });
  });

  it("logs model and option switches too, but not rejected calls", { timeout: 15_000 }, async () => {
    const dir = tempDir();
    const dump = join(dir, "dump.json");
    const fake = await startFake({ ...MODES, FAKE_ACP_MODELS: "fake-model,other-model", FAKE_ACP_DUMP: dump });
    const session = await fake.open(dir);
    const { sessionId } = session;
    expect((await fake.request("session/set_config_option", { sessionId, configId: "model", value: "other-model" })).result).toBeDefined();
    expect((await fake.request("session/set_config_option", { sessionId, configId: "model", value: "missing" })).error?.code).toBe(-32602);
    expect((await fake.request("session/set_model", { sessionId, modelId: "other-model" })).result).toEqual({});
    expect(jsonLines(`${dump}.config.jsonl`).map((call) => [call.method, call.params.value ?? call.params.modelId]))
      .toEqual([["session/set_config_option", "other-model"], ["session/set_model", "other-model"]]);
  });
});

describe("FAKE_ACP_UNIQUE_SESSION_IDS", () => {
  it("keeps the fixed id by default", { timeout: 15_000 }, async () => {
    const dir = tempDir();
    const fake = await startFake({});
    expect((await fake.open(dir)).sessionId).toBe("fake-acp-session");
    expect((await fake.open(dir)).sessionId).toBe("fake-acp-session");
  });

  it("issues a distinct id per session/new, so a reopened conversation shows in the prompt log", { timeout: 15_000 }, async () => {
    const dir = tempDir();
    const dump = join(dir, "dump.json");
    const fake = await startFake({ ...MODES, FAKE_ACP_DUMP: dump, FAKE_ACP_UNIQUE_SESSION_IDS: "1" });
    const first = await fake.open(dir);
    const second = await fake.open(dir);
    expect(first.sessionId).toBe(`fake-acp-session-${fake.pid}-1`);
    expect(second.sessionId).toBe(`fake-acp-session-${fake.pid}-2`);
    await first.prompt("one");
    await second.prompt("two");
    // The "one conversation across level changes" assertion now fails here.
    expect(new Set(jsonLines(`${dump}.prompts.jsonl`).map((line) => line.sessionId)).size).toBe(2);
  });
});

describe("app-internal sessions", () => {
  it("marks memory analysis prompts and calls, not the conversation's", { timeout: 20_000 }, async () => {
    const dir = tempDir();
    const dump = join(dir, "dump.json");
    const promptsFile = join(dir, "prompts.jsonl");
    const env = { ...MODES, FAKE_ACP_DUMP: dump, FAKE_ACP_PROMPTS_FILE: promptsFile, FAKE_ACP_UNIQUE_SESSION_IDS: "1" };
    const chatProcess = await startFake(env);
    const chat = await chatProcess.open(subdir(dir, "project"));
    await chat.setMode("bypassPermissions");
    await chat.prompt("owner turn");
    // analyzeMemory opens <DATA_DIR>/colonie-memory/analysis/job-* under Ask.
    const analysisProcess = await startFake(env);
    const analysis = await analysisProcess.open(subdir(dir, "data", "colonie-memory", "analysis", "job-x1Yz"));
    await analysis.setMode("default");
    await analysis.prompt("summarize the turn");

    const prompts = jsonLines(`${dump}.prompts.jsonl`);
    expect(prompts.map((line) => [line.sessionId, line.mode, line.internal])).toEqual([
      [chat.sessionId, "bypassPermissions", undefined],
      [analysis.sessionId, "default", "memory-analysis"],
    ]);
    expect(jsonLines(promptsFile).map((line) => line.internal)).toEqual([undefined, "memory-analysis"]);
    const calls = jsonLines(`${dump}.config.jsonl`);
    expect(calls.map((call) => [call.pid, call.internal])).toEqual([
      [chatProcess.pid, undefined], [analysisProcess.pid, "memory-analysis"],
    ]);
    // What a smoke reads: the conversation's own last mode, unaffected.
    expect(calls.filter((call) => !call.internal && call.sessionId === chat.sessionId).at(-1)?.params.modeId).toBe("bypassPermissions");
  });

  it("marks model discovery opened in the provider home", { timeout: 15_000 }, async () => {
    const dir = tempDir();
    const dump = join(dir, "dump.json");
    const home = subdir(dir, "claude-home");
    const fake = await startFake({ ...MODES, FAKE_ACP_DUMP: dump, CLAUDE_CONFIG_DIR: home });
    const discovery = await fake.open(`${home}/`);
    await discovery.setMode("default");
    const conversation = await fake.open(subdir(dir, "project"));
    await conversation.setMode("acceptEdits");
    expect(jsonLines(`${dump}.config.jsonl`).map((call) => call.internal)).toEqual(["model-discovery", undefined]);
  });
});
