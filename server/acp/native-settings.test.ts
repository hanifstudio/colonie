import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAcpDriver } from "./codex-acp.ts";
import { ClaudeAcpDriver } from "./claude-acp.ts";
import { AcpRuntime } from "./acp-runtime.ts";
import { DATA_DIR } from "../config.ts";
import { inputReceipts } from "./receipts.ts";
import { nativePreferences } from "./settings.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import type { SendTurnInput, ProviderInstance, RuntimeEvent } from "../contracts.ts";
import type { NativeSettings, NativeSettingChange } from "../../shared/acp-settings.ts";

const instances: ProviderInstance[] = [];
const directories: string[] = [];
beforeEach(() => {
  rmSync(join(DATA_DIR, "acp-inputs"), { recursive: true, force: true });
  rmSync(join(DATA_DIR, "acp-settings"), { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
  await Promise.all(directories.splice(0).map(removeTempDir));
});

describe.each([["Codex", CodexAcpDriver], ["Claude", ClaudeAcpDriver]] as const)("%s native configuration", (_name, driver) => {
  const fixture = async (cwd?: string) => {
    const directory = cwd ?? mkdtempSync(join(tmpdir(), "colonie-native-settings-"));
    if (!cwd) directories.push(directory);
    const file = join(directory, "state.json");
    const instance = await driver.create({ instanceId: driver.driverKind, displayName: driver.metadata.displayName, enabled: true,
      config: driver.decodeConfig({ cli: process.execPath, args: [join(import.meta.dirname, "testing/fake-agent.ts")] }),
      environment: { COLONIE_FAKE_STATE: file, COLONIE_FAKE_PROVIDER: driver.driverKind === "claude-acp" ? "claude" : "codex" } });
    instances.push(instance);
    const adapter = instance.adapter as AcpRuntime;
    const input: SendTurnInput = { threadId: "settings", cwd: directory, text: "exact input", model: "agent-default", approvalMode: "ask" };
    const events: RuntimeEvent[] = []; adapter.onEvent((event) => events.push(event));
    return { instance, adapter, input, events, directory, file };
  };
  const change = (adapter: AcpRuntime, input: SendTurnInput, snapshot: NativeSettings, selection: { kind: "mode"; value: string } | { kind: "option"; configId: string; value: string | boolean }) =>
    adapter.changeSettings(input, { ...selection, sessionId: snapshot.sessionId, expectedRevision: snapshot.revision } as NativeSettingChange);

  it("discovers native settings without dispatching a prompt and preserves effort/mode after restart", async () => {
    const f = await fixture();
    let snapshot = await f.adapter.prepareSettings(f.input);
    expect(snapshot.options.map((option) => option.id)).toEqual(["model", "effort", "fast"]);
    expect(inputReceipts("settings")).toEqual([]);
    expect(JSON.parse(readFileSync(f.file, "utf8")).sessions[snapshot.sessionId].prompts).toEqual([]);
    snapshot = await change(f.adapter, f.input, snapshot, { kind: "option", configId: "effort", value: "high" });
    snapshot = await change(f.adapter, f.input, snapshot, { kind: "option", configId: "fast", value: true });
    snapshot = await change(f.adapter, f.input, snapshot, { kind: "mode", value: "plan" });
    const sent = await f.adapter.sendTurn(f.input);
    await expect.poll(() => f.events.find((event) => event.type === "turn.completed" && event.turnId === sent.turnId)).toBeTruthy();
    expect(inputReceipts("settings")[0]).toMatchObject({ sessionId: snapshot.sessionId, mode: "plan", nativeSettings: { effort: "high", fast: true }, prompt: [{ type: "text", text: "exact input" }] });
    await f.instance.dispose();
    const next = await fixture(f.directory);
    const state = await next.adapter.prepareSettings({ ...next.input, resumeCursor: snapshot.sessionId });
    expect(state.sessionId).toBe(snapshot.sessionId);
    expect(state.modes.currentModeId).toBe("plan");
    expect(state.options.find((option) => option.id === "effort")?.currentValue).toBe("high");
    // Changing the app-level permission baseline cancels the native mode override.
    const baseline = await next.adapter.prepareSettings({ ...next.input, resumeCursor: snapshot.sessionId, approvalMode: "full" });
    expect(baseline.modes.currentModeId).toBe(driver.driverKind === "claude-acp" ? "bypassPermissions" : "agent-full-access");
  });

  it("coalesces identical concurrent discovery and refuses changes from another app selection", async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([f.adapter.prepareSettings(f.input), f.adapter.prepareSettings(f.input)]);
    expect(first.sessionId).toBe(second.sessionId);
    expect(Object.keys(JSON.parse(readFileSync(f.file, "utf8")).sessions)).toHaveLength(1);
    await expect(change(f.adapter, { ...f.input, model: "fixture-alt" }, first, { kind: "option", configId: "effort", value: "high" })).rejects.toThrow("Application model/permission");
  });

  it("rejects stale snapshots and invalid values and records native mode fallback", async () => {
    const f = await fixture();
    const original = await f.adapter.prepareSettings(f.input);
    const current = await change(f.adapter, f.input, original, { kind: "option", configId: "effort", value: "high" });
    await expect(change(f.adapter, f.input, original, { kind: "mode", value: "plan" })).rejects.toThrow("Native settings changed");
    await expect(change(f.adapter, f.input, current, { kind: "option", configId: "effort", value: "not-offered" })).rejects.toThrow("no longer offers");
    const fallback = await change(f.adapter, f.input, current, { kind: "mode", value: "auto" });
    expect(fallback.modes.currentModeId).toBe(driver.driverKind === "claude-acp" ? "default" : "read-only");
    expect(nativePreferences("settings", driver.driverKind).mode).toBe(fallback.modes.currentModeId);
  });

  it("refuses dispatch when a saved effort is no longer supported after changing models", async () => {
    const f = await fixture();
    let snapshot = await f.adapter.prepareSettings(f.input);
    snapshot = await change(f.adapter, f.input, snapshot, { kind: "option", configId: "effort", value: "high" });
    await change(f.adapter, f.input, snapshot, { kind: "option", configId: "model", value: "fixture-alt" });
    await expect(f.adapter.sendTurn({ ...f.input, model: "fixture-alt" })).rejects.toThrow("no longer offers");
    expect(inputReceipts("settings")).toEqual([]);
    const repair = await f.adapter.prepareSettings({ ...f.input, model: "fixture-alt" });
    expect(repair.warnings.length).toBeGreaterThan(0);
    await change(f.adapter, { ...f.input, model: "fixture-alt" }, repair, { kind: "option", configId: "effort", value: "low" });
    expect(nativePreferences("settings", driver.driverKind).values.effort).toBe("low");
  });
});
