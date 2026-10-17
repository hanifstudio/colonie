// The ACP fixture's turn controls, driven over its real stdio surface: keyed
// gates across concurrent sessions, session/cancel on a waiting turn,
// scripted usage, and the deterministic failing turn.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./cleanup.ts";
import { gateEvents, gateMarker, releaseAllGates, releaseGate, waitForGates, waitingGates } from "./fake-acp-gates.ts";

const FAKE_ACP = fileURLToPath(new URL("./fake-acp-cli.ts", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "colonie-fake-acp-turns-"));
  cleanups.push(() => removeTempDir(dir));
  return dir;
}

/** One fake ACP process, initialized and holding one session opened in `cwd`. */
async function startFake(env: Record<string, string>, cwd: string) {
  const child = spawn(process.execPath, [FAKE_ACP], {
    env: { ...process.env, FAKE_ACP_MODE: "happy", FAKE_CLAUDE_ROOM_PLAN: "", FAKE_ACP_TOOL_PLAN: "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanups.push(() => waitForExit(child, { signal: "SIGTERM", graceMs: 500 }));
  const updates: any[] = [];
  const waiting = new Map<number, (frame: any) => void>();
  let serial = 0;
  child.stderr.resume();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line);
    if (frame.method === "session/update") updates.push(frame.params);
    else if (frame.id !== undefined) waiting.get(frame.id)?.(frame);
  });
  const request = (method: string, params: unknown) => new Promise<any>((resolve) => {
    const id = ++serial;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method: string, params: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  await request("initialize", { protocolVersion: 1 });
  const { result: { sessionId } } = await request("session/new", { cwd, mcpServers: [] });
  const prompt = (text: string) => request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  const texts = () => updates.filter((entry) => entry.update.sessionUpdate === "agent_message_chunk").map((entry) => entry.update.content.text);
  return { sessionId, request, notify, prompt, texts, cancel: () => notify("session/cancel", { sessionId }) };
}

/** Track whether a pending answer has arrived yet. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => { state.settled = true; state.value = value; });
  return state;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("FAKE_ACP_GATE_DIR", () => {
  it("holds each concurrent session at its own gate until that key is released", { timeout: 20_000 }, async () => {
    const dir = tempDir();
    const gates = join(dir, "gates");
    const [cwdA, cwdB, cwdC] = ["a", "b", "c"].map((name) => { const path = join(dir, name); mkdirSync(path); return path; });
    const env = { FAKE_ACP_GATE_DIR: gates };
    const [a, b, c] = await Promise.all([startFake(env, cwdA), startFake(env, cwdB), startFake(env, cwdC)]);

    const answerA = track(a.prompt(`first thread ${gateMarker("alpha")}`));
    const answerB = b.prompt(`second thread ${gateMarker("beta")}`);
    const answerC = track(c.prompt("unmarked thread"));
    const held = await waitForGates(gates, (list) => list.length === 3);
    const byKey = Object.fromEntries(held.map((gate) => [gate.key, gate]));
    expect(byKey.alpha).toMatchObject({ cwd: cwdA, sessionId: a.sessionId, turn: 1 });
    expect(byKey.alpha.text).toContain("first thread");
    expect(byKey.beta).toMatchObject({ cwd: cwdB });
    // An unmarked prompt is keyed by its process and turn number.
    const unmarked = held.find((gate) => gate.cwd === cwdC)!;
    expect(unmarked.key).toBe(`${unmarked.pid}-1`);

    releaseGate(gates, "beta");
    expect((await answerB).result?.stopReason).toBe("end_turn");
    expect(b.texts()).toEqual(["hello from fake acp"]);
    await pause(100);
    expect(answerA.settled).toBe(false);
    expect(waitingGates(gates).map((gate) => gate.key).sort()).toEqual(["alpha", unmarked.key].sort());

    // Cancel answers the held turn at once; the mode never plays it.
    a.cancel();
    await waitForGates(gates, (list) => !list.some((gate) => gate.key === "alpha"));
    await pause(50);
    expect(answerA.value?.result).toEqual({ stopReason: "cancelled", _meta: {} });
    releaseGate(gates, "alpha");
    await pause(100);
    expect(a.texts()).toEqual([]);

    releaseAllGates(gates);
    await waitForGates(gates, (list) => list.length === 0);
    await pause(50);
    expect(answerC.value?.result?.stopReason).toBe("end_turn");
    expect(gateEvents(gates).map((entry) => [entry.key, entry.event])).toEqual(expect.arrayContaining([
      ["alpha", "waiting"], ["beta", "waiting"], ["beta", "released"], ["alpha", "cancelled"], [unmarked.key, "released"],
    ]));
  });

  it("keys turns by a custom FAKE_ACP_GATE_MARKER", { timeout: 15_000 }, async () => {
    const dir = tempDir();
    const gates = join(dir, "gates");
    const fake = await startFake({ FAKE_ACP_GATE_DIR: gates, FAKE_ACP_GATE_MARKER: "THREAD=(\\w+)" }, dir);
    const answer = fake.prompt("work for THREAD=t42 please");
    await waitForGates(gates, (list) => list.some((gate) => gate.key === "t42"));
    releaseGate(gates, "t42");
    expect((await answer).result?.stopReason).toBe("end_turn");
  });
});

describe("session/cancel on a waiting turn", () => {
  it("ends a running tool plan promptly and drops its later output", { timeout: 15_000 }, async () => {
    const dir = tempDir();
    const plan = join(dir, "plan.json");
    const ready = join(dir, "ready");
    const gate = join(dir, "plan-gate");
    writeFileSync(plan, JSON.stringify({ "bot-1": { readyFile: ready, gateFile: gate, reply: "too late" } }));
    const fake = await startFake({ FAKE_ACP_TOOL_PLAN: plan, FAKE_ACP_PLAN_BOT: "bot-1" }, dir);
    const answer = fake.prompt("run the plan");
    while (!existsSync(ready)) await pause(10);
    const cancelledAt = Date.now();
    fake.cancel();
    expect((await answer).result).toEqual({ stopReason: "cancelled", _meta: {} });
    expect(Date.now() - cancelledAt).toBeLessThan(1_000);
    writeFileSync(gate, "open");
    await pause(150);
    expect(fake.texts()).toEqual([]);
  });

  it("ends an echo-gated turn held on FAKE_ACP_GATE_FILE", { timeout: 15_000 }, async () => {
    const dir = tempDir();
    const started = join(dir, "started");
    const fake = await startFake({ FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: join(dir, "never"), FAKE_ACP_STARTED_FILE: started }, dir);
    const answer = fake.prompt("hold me");
    while (!existsSync(started)) await pause(10);
    fake.cancel();
    expect((await answer).result?.stopReason).toBe("cancelled");
    expect(fake.texts()).toEqual([]);
  });
});

describe("scripted usage", () => {
  const meta = async (env: Record<string, string>, text = "hello") => {
    const fake = await startFake(env, tempDir());
    return (await fake.prompt(text)).result;
  };

  it("reports the default, a configured object, zero, and missing usage", { timeout: 20_000 }, async () => {
    expect(await meta({})).toEqual({ stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } });
    expect(await meta({ FAKE_ACP_USAGE: JSON.stringify({ inputTokens: 1200, outputTokens: 300, cachedReadTokens: 200 }) }))
      .toEqual({ stopReason: "end_turn", _meta: { inputTokens: 1200, outputTokens: 300, cachedReadTokens: 200 } });
    expect(await meta({ FAKE_ACP_USAGE: "zero" })).toEqual({ stopReason: "end_turn", _meta: { inputTokens: 0, outputTokens: 0 } });
    expect(await meta({ FAKE_ACP_USAGE: "missing" })).toEqual({ stopReason: "end_turn", _meta: {} });
    expect(await meta({ FAKE_ACP_USAGE: "zero", FAKE_ACP_USAGE_ROOT: "1" }))
      .toEqual({ stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, _meta: {} });
  });

  it("picks usage by prompt text first, then by turn, and re-reads the usage file", { timeout: 20_000 }, async () => {
    const dir = tempDir();
    const file = join(dir, "usage.json");
    writeFileSync(file, JSON.stringify([
      { when: "MEMORY_HELPER", inputTokens: 7, outputTokens: 1 },
      { inputTokens: 100, outputTokens: 10 },
      "missing",
    ]));
    const fake = await startFake({ FAKE_ACP_USAGE_FILE: file }, dir);
    expect((await fake.prompt("turn one")).result._meta).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect((await fake.prompt("MEMORY_HELPER summary")).result._meta).toEqual({ inputTokens: 7, outputTokens: 1 });
    expect((await fake.prompt("turn three")).result._meta).toEqual({});
    writeFileSync(file, JSON.stringify({ inputTokens: 5, outputTokens: 2 }));
    expect((await fake.prompt("turn four")).result._meta).toEqual({ inputTokens: 5, outputTokens: 2 });
  });
});

describe("failing turns", () => {
  it("fail-turn answers a JSON-RPC error with no output", { timeout: 15_000 }, async () => {
    const fake = await startFake({ FAKE_ACP_MODE: "fail-turn", FAKE_ACP_FAIL_MESSAGE: "routine broke" }, tempDir());
    const answer = await fake.prompt("run the routine");
    expect(answer.error).toEqual({ code: -32000, message: "routine broke" });
    expect(fake.texts()).toEqual([]);
  });

  it("FAKE_ACP_FAIL_WHEN fails only matching prompts, optionally as a non-end_turn stop", { timeout: 15_000 }, async () => {
    const fake = await startFake({ FAKE_ACP_FAIL_WHEN: "ROUTINE_FAIL" }, tempDir());
    expect((await fake.prompt("ordinary chat")).result?.stopReason).toBe("end_turn");
    expect((await fake.prompt("ROUTINE_FAIL now")).error?.message).toBe("fake acp: turn failed");

    const refusing = await startFake({ FAKE_ACP_FAIL_WHEN: "ROUTINE_FAIL", FAKE_ACP_FAIL_STOP_REASON: "refusal", FAKE_ACP_USAGE: "zero" }, tempDir());
    expect((await refusing.prompt("ROUTINE_FAIL now")).result).toEqual({ stopReason: "refusal", _meta: { inputTokens: 0, outputTokens: 0 } });
    expect(refusing.texts()).toEqual([]);
  });
});
