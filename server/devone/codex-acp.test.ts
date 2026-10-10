import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAcpDriver } from "./codex-acp.ts";
import { ClaudeAcpDriver } from "./claude-acp.ts";
import { inputReceipts } from "./receipts.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { DATA_DIR } from "../config.ts";

const instances: ProviderInstance[] = [];
const directories: string[] = [];
let selectedDriver = CodexAcpDriver;
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
  await Promise.all(directories.splice(0).map((directory) => removeTempDir(directory)));
});

async function fixture(state?: string) {
  const cwd = mkdtempSync(join(tmpdir(), "devone-acp-test-"));
  directories.push(cwd);
  const file = state ?? join(cwd, "state.json");
  const instance = await selectedDriver.create({ instanceId: selectedDriver.driverKind, enabled: true, displayName: selectedDriver.metadata.displayName,
    config: selectedDriver.decodeConfig({ cli: process.execPath, args: [join(import.meta.dirname, "testing/fake-agent.ts")] }),
    environment: { DEVONE_FAKE_STATE: file, COLONIE_FAKE_PROVIDER: selectedDriver.driverKind === "claude-acp" ? "claude" : "codex" } });
  instances.push(instance);
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  return { instance, events, cwd, file };
}

async function completed(events: RuntimeEvent[], turnId: string) {
  await expect.poll(() => events.find((event) => event.type === "turn.completed" && event.turnId === turnId)).toBeTruthy();
  return events.find((event) => event.type === "turn.completed" && event.turnId === turnId)!;
}

describe.each([["Codex", CodexAcpDriver], ["Claude", ClaudeAcpDriver]] as const)("Colonie upstream-SDK %s ACP boundary", (_name, driver) => {
  beforeEach(() => {
    selectedDriver = driver;
    // Both provider suites exercise the same thread ids in the isolated test home.
    rmSync(join(DATA_DIR, "acp-inputs"), { recursive: true, force: true });
  });
  it("sends exact input, ignores legacy context, streams, and continues the native session", async () => {
    const f = await fixture();
    const first = await f.instance.adapter.sendTurn({ threadId: "plain", text: "hello\nexact bytes", cwd: f.cwd,
      system: "UNWANTED PERSONA", systemStable: "UNWANTED MEMORY", systemVolatile: "UNWANTED RECALL",
      integrations: { agents: { command: "not-run", args: [], env: {} } } });
    await completed(f.events, first.turnId);
    const sessionId = inputReceipts("plain")[0]!.sessionId;
    const second = await f.instance.adapter.sendTurn({ threadId: "plain", text: "continue", cwd: f.cwd, resumeCursor: sessionId });
    await completed(f.events, second.turnId);
    const state = JSON.parse(readFileSync(f.file, "utf8"));
    expect(Object.keys(state.sessions)).toEqual([sessionId]);
    expect(state.sessions[sessionId].prompts).toEqual(["hello\nexact bytes", "continue"]);
    expect(f.events.filter((event) => event.type === "content.delta")).toHaveLength(4);
    expect(f.events.filter((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toHaveLength(2);
    expect(inputReceipts("plain").map((receipt) => receipt.status)).toEqual(["completed", "completed"]);
    expect(inputReceipts("plain")[0]!.prompt).toEqual([{ type: "text", text: "hello\nexact bytes" }]);
  });

  it("loads a persisted native session after the runner restarts without replaying replies", async () => {
    const first = await fixture();
    const sent = await first.instance.adapter.sendTurn({ threadId: "reload", cwd: first.cwd, text: "remember" });
    await completed(first.events, sent.turnId);
    const cursor = inputReceipts("reload")[0]!.sessionId;
    await first.instance.dispose();
    const second = await fixture(first.file);
    const resumed = await second.instance.adapter.sendTurn({ threadId: "reload", cwd: first.cwd, text: "next", resumeCursor: cursor });
    await completed(second.events, resumed.turnId);
    const state = JSON.parse(readFileSync(first.file, "utf8"));
    expect(state.loads).toBe(1);
    expect(state.sessions[cursor].prompts).toEqual(["remember", "next"]);
    expect(second.events.filter((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toHaveLength(1);
  });

  it.each(["allow", "deny"] as const)("maps %s to the agent's own permission option", async (behavior) => {
    const f = await fixture();
    const sent = await f.instance.adapter.sendTurn({ threadId: `permission-${behavior}`, text: "permission", cwd: f.cwd });
    await expect.poll(() => f.events.find((event) => event.type === "request.opened")).toBeTruthy();
    const request = f.events.find((event) => event.type === "request.opened")!;
    const result = await f.instance.adapter.respondToRequest(request.threadId, request.requestId!, { behavior });
    expect(result).toBe(behavior === "allow" ? "allowed-once" : "rejected");
    await completed(f.events, sent.turnId);
    expect(JSON.parse(readFileSync(f.file, "utf8")).permissions).toEqual([behavior === "allow" ? "yes-once" : "no"]);
    expect(await f.instance.adapter.respondToRequest(request.threadId, request.requestId!, { behavior })).toBe("unavailable");
  });

  it("cancels pending approvals and preserves the session for the next turn", async () => {
    const f = await fixture();
    const sent = await f.instance.adapter.sendTurn({ threadId: "cancel", text: "hang", cwd: f.cwd });
    await f.instance.adapter.interruptTurn("cancel", sent.turnId);
    expect(await completed(f.events, sent.turnId)).toMatchObject({ stopReason: "cancelled", ok: false });
    const next = await f.instance.adapter.sendTurn({ threadId: "cancel", text: "after stop", cwd: f.cwd });
    await completed(f.events, next.turnId);
    expect(inputReceipts("cancel").map((receipt) => receipt.status)).toEqual(["cancelled", "completed"]);
  });

  it("settles a crashed process and refuses an unknown saved session", async () => {
    const f = await fixture();
    const sent = await f.instance.adapter.sendTurn({ threadId: "crash", text: "crash", cwd: f.cwd });
    expect(await completed(f.events, sent.turnId)).toMatchObject({ ok: false });
    expect(inputReceipts("crash")[0]!.status).toBe("failed");
    await expect(f.instance.adapter.sendTurn({ threadId: "bad-cursor", text: "next", cwd: f.cwd, resumeCursor: "does-not-exist" })).rejects.toThrow("start a new conversation");
    expect(f.instance.adapter.hasSession("bad-cursor")).toBe(false);
  });

  it("cancels an open permission instead of allowing it when Stop is pressed", async () => {
    const f = await fixture();
    const sent = await f.instance.adapter.sendTurn({ threadId: "cancel-permission", text: "permission", cwd: f.cwd });
    await expect.poll(() => f.events.some((event) => event.type === "request.opened")).toBe(true);
    await f.instance.adapter.interruptTurn("cancel-permission", sent.turnId);
    await completed(f.events, sent.turnId);
    expect(JSON.parse(readFileSync(f.file, "utf8")).permissions).toEqual(["cancelled"]);
  });

  it("keeps parallel conversations independent and rejects overlapping turns", async () => {
    const f = await fixture();
    const first = await f.instance.adapter.sendTurn({ threadId: "parallel-a", text: "hang", cwd: f.cwd });
    await expect(f.instance.adapter.sendTurn({ threadId: "parallel-a", text: "overlap", cwd: f.cwd })).rejects.toThrow("active turn");
    const second = await f.instance.adapter.sendTurn({ threadId: "parallel-b", text: "independent", cwd: f.cwd });
    await completed(f.events, second.turnId);
    expect(f.events.some((event) => event.type === "turn.completed" && event.turnId === first.turnId)).toBe(false);
    await f.instance.adapter.interruptTurn("parallel-a", first.turnId);
    await completed(f.events, first.turnId);
  });

  it("does not dispatch or strand a busy session when the exact input cannot be persisted", async () => {
    const f = await fixture();
    mkdirSync(join(DATA_DIR, "acp-inputs"), { recursive: true });
    const corrupted = join(DATA_DIR, "acp-inputs", "write-failure.json");
    writeFileSync(corrupted, "{");
    await expect(f.instance.adapter.sendTurn({ threadId: "write-failure", text: "must not reach agent", cwd: f.cwd })).rejects.toThrow();
    expect(f.instance.adapter.hasSession("write-failure")).toBe(false);
    expect(Object.values(JSON.parse(readFileSync(f.file, "utf8")).sessions).every((session: any) => session.prompts.length === 0)).toBe(true);
    rmSync(corrupted);
    const retry = await f.instance.adapter.sendTurn({ threadId: "write-failure", text: "retry after repair", cwd: f.cwd });
    await completed(f.events, retry.turnId);
  });
});
