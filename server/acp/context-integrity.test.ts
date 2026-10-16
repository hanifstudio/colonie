import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAcpDriver } from "./codex-acp.ts";
import { AcpRuntime } from "./acp-runtime.ts";
import { appContextView, changeContextPreferences, contextCandidate, contextPin, contextView } from "./context.ts";
import { inputReceipts } from "./receipts.ts";
import { DATA_DIR } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";

let instance: ProviderInstance | undefined;
let directory: string;
beforeEach(() => {
  rmSync(join(DATA_DIR, "acp-context"), { recursive: true, force: true });
  rmSync(join(DATA_DIR, "acp-inputs"), { recursive: true, force: true });
});
afterEach(async () => { await instance?.dispose(); if (directory) await removeTempDir(directory); });

it("refuses cross-bot, damaged and missing snapshots without sending or silently replacing pinned context", async () => {
  directory = mkdtempSync(join(tmpdir(), "colonie-context-integrity-"));
  const file = join(directory, "state.json");
  instance = await CodexAcpDriver.create({ instanceId: "context-integrity", enabled: true, displayName: "Fixture",
    config: CodexAcpDriver.decodeConfig({ cli: process.execPath, args: [join(import.meta.dirname, "testing/fake-agent.ts")] }), environment: { COLONIE_FAKE_STATE: file } });
  const adapter = instance.adapter as AcpRuntime;
  const events: RuntimeEvent[] = []; adapter.onEvent((event) => events.push(event));
  const profile = { id: "alpha", name: "Alpha", title: "Verifier", description: "", soul: "" };
  changeContextPreferences("app", "", appContextView().revision, { enabled: false, instructions: "" });
  changeContextPreferences("bot", "alpha", contextView(profile, "integrity", instance.instanceId, "", false).bot.revision, { persona: false, soul: false });
  const candidate = contextCandidate(profile, instance.instanceId, "EXPLICIT_INSTANCE_CONTEXT");
  const input = { botId: "alpha", threadId: "integrity", text: "first", cwd: directory, acpContext: candidate };
  await expect(adapter.sendTurn({ ...input, botId: "beta" })).rejects.toThrow("another bot");
  expect(adapter.hasSession(input.threadId)).toBe(false);
  const native = await adapter.prepareSettings(input);
  expect(contextPin(input.threadId)).toBeNull();
  const first = await adapter.sendTurn(input);
  await expect.poll(() => events.some((event) => event.type === "turn.completed" && event.turnId === first.turnId)).toBe(true);
  const pinFile = join(DATA_DIR, "acp-context", "threads", "integrity.json");
  const original = readFileSync(pinFile, "utf8");
  const damaged = JSON.parse(original);
  damaged.snapshot.sections.find((section: any) => section.id === "instance.instructions").text = "UNEXPECTED_REPLACEMENT";
  writeFileSync(pinFile, JSON.stringify(damaged));
  await expect(adapter.sendTurn({ ...input, text: "damaged", resumeCursor: native.sessionId })).rejects.toThrow("damaged");
  expect(inputReceipts(input.threadId)).toHaveLength(1);
  unlinkSync(pinFile);
  await expect(adapter.sendTurn({ ...input, text: "missing", resumeCursor: native.sessionId })).rejects.toThrow("snapshot is missing");
  expect(inputReceipts(input.threadId)).toHaveLength(1);
  writeFileSync(pinFile, original);
  const resumed = await adapter.sendTurn({ ...input, text: "restored", resumeCursor: native.sessionId });
  await expect.poll(() => events.some((event) => event.type === "turn.completed" && event.turnId === resumed.turnId)).toBe(true);
  const state = JSON.parse(readFileSync(file, "utf8"));
  expect(state.sessions[native.sessionId].prompts).toEqual(["EXPLICIT_INSTANCE_CONTEXT\nfirst", "EXPLICIT_INSTANCE_CONTEXT\nrestored"]);
  expect(inputReceipts(input.threadId).map((receipt) => receipt.context?.snapshotHash)).toEqual([candidate.hash, candidate.hash]);
});
