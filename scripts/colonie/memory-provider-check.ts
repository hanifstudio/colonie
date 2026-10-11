/** Bounded synthetic memory check using inherited CLI authentication, never
 * credential contents. Seven prompts maximum; no tools or private accounts. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

if (!process.argv.includes("--real")) throw new Error("Pass --real for the bounded real-provider memory check.");
const root = mkdtempSync(join(tmpdir(), "colonie-memory-real-"));
process.env.OMB_DATA_DIR = join(root, "data");
const cwd = join(root, "workspace");
mkdirSync(cwd);
const { ClaudeAcpDriver } = await import("../../server/devone/claude-acp.ts");
const { CodexAcpDriver } = await import("../../server/devone/codex-acp.ts");
const { AcpRuntime } = await import("../../server/devone/acp-runtime.ts");
const { ColonieMemoryStore } = await import("../../server/colonie/memory/store.ts");
const { ColonieMemoryService } = await import("../../server/colonie/memory/service.ts");
const { contextCandidate } = await import("../../server/devone/context.ts");
const { inputReceipts } = await import("../../server/devone/receipts.ts");
const driver = process.argv.includes("--claude") ? ClaudeAcpDriver : CodexAcpDriver;
const instance = await driver.create({ instanceId: driver.driverKind, displayName: "Memory verification", enabled: true,
  environment: {}, config: driver.defaultConfig() });
const adapter = instance.adapter as InstanceType<typeof AcpRuntime>;
const profile = { id: "memory-verifier", name: "Memory verifier", title: "", description: "", soul: "" };
const store = new ColonieMemoryStore(process.env.OMB_DATA_DIR!);
let analysisCount = 0;
const service = new ColonieMemoryService(store, { bot: (id) => id === profile.id ? profile : undefined,
  owns: (id, thread) => id === profile.id && thread.startsWith("memory-real-"),
  analyze: (_id, prompt, signal) => {
    if (++analysisCount > 2) throw new Error("Real memory check exceeded its two-analysis request budget.");
    return adapter.analyzeMemory(prompt, { signal });
  },
});
const events: import("../../server/contracts.ts").RuntimeEvent[] = [];
adapter.onEvent((event) => {
  events.push(event);
  if (event.type === "request.opened" && event.requestId) void adapter.respondToRequest(event.threadId, event.requestId, { behavior: "deny" });
});
let promptCount = 0;
const ask = async (threadId: string, text: string, capture = false) => {
  if (++promptCount > 5) throw new Error("Real memory check exceeded its foreground request budget.");
  const before = events.length;
  const memory = service.recall(profile.id, text) ?? undefined;
  const sent = await adapter.sendTurn({ botId: profile.id, threadId, text, cwd, approvalMode: "ask",
    acpContext: contextCandidate(profile, instance.instanceId, ""), acpMemory: memory });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !events.slice(before).some((event) => event.type === "turn.completed" && event.turnId === sent.turnId)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const completed = events.slice(before).find((event) => event.type === "turn.completed" && event.turnId === sent.turnId);
  if (completed?.type !== "turn.completed" || !completed.ok) {
    await adapter.interruptTurn(threadId, sent.turnId);
    throw new Error("The bounded real memory request failed or timed out.");
  }
  assert(!events.slice(before).some((event) => event.type === "item.started" && event.itemType === "tool"), "Provider used a tool during the no-tool memory check.");
  const answer = events.slice(before).filter((event) => event.type === "item.completed" && event.itemType === "assistant_text")
    .map((event) => event.type === "item.completed" && event.itemType === "assistant_text" ? event.text : "").join("\n");
  if (capture) {
    service.noteTurn({ botId: profile.id, threadId, messageId: `request-${promptCount}`, text, at: new Date().toISOString() });
    await service.idle();
    assert(!service.view(profile.id).status.lastError, service.view(profile.id).status.lastError);
  }
  return { answer, receipt: inputReceipts(threadId).at(-1)! };
};
const result: Record<string, unknown> = { realProvider: driver.driverKind, desktop: false, renderer: false,
  isolation: "Disposable application data and workspace; inherited native CLI authentication", maxPrompts: 7 };
try {
  service.start();
  const first = await ask("memory-real-source", "For this synthetic check, my preferred project codename is Amberfinch. This is a durable preference. Reply with OK only. Do not use tools.", true);
  const captured = service.view(profile.id);
  result.captured = captured;
  const fact = captured.entries.find((entry) => /Amberfinch/i.test(entry.text));
  assert(fact, "The real analyzer did not capture the user preference.");
  const recalled = await ask("memory-real-fresh", "What is my preferred project codename? Reply with only the codename. Do not use tools.");
  assert.match(recalled.answer, /Amberfinch/);
  assert.notEqual(first.receipt.sessionId, recalled.receipt.sessionId);
  await ask("memory-real-source", "Correction: my preferred project codename is now Silverwren, replacing Amberfinch. Keep this durable preference up to date. Reply with OK only. Do not use tools.", true);
  const corrected = service.view(profile.id);
  result.corrected = corrected;
  assert(corrected.entries.some((entry) => /Silverwren/.test(entry.text)));
  assert.equal(corrected.entries.filter((entry) => /preferred.*codename|codename.*prefer/i.test(entry.text)).length, 1,
    "The correction left competing active codename preferences.");
  const correctedRecall = await ask("memory-real-corrected", "What is my preferred project codename? Reply with only the codename. Do not use tools.");
  assert.match(correctedRecall.answer, /Silverwren/);
  for (const entry of service.view(profile.id).entries) service.forgetEntry(profile.id, entry.id, service.view(profile.id).revision);
  const forgotten = await ask("memory-real-forgotten", "What is my preferred project codename? If no saved information is supplied, reply with UNKNOWN only. Do not use tools.");
  assert.equal(forgotten.answer.trim(), "UNKNOWN");
  assert(!forgotten.receipt.context?.sections.some((section) => section.id === "memory.recall"));
  result.ok = true;
  result.evidence = { first, captured, recalled, corrected, correctedRecall, forgotten };
} catch (error) {
  result.ok = false;
  result.error = (error as Error).message;
  result.memory = service.view(profile.id);
  result.foregroundPrompts = promptCount;
  result.analysisPrompts = analysisCount;
  process.exitCode = 1;
} finally {
  await service.stop();
  await instance.dispose();
  const evidence = resolve(".devone/evidence");
  mkdirSync(evidence, { recursive: true });
  const output = join(evidence, `${driver.driverKind}-memory-real-check.json`);
  writeFileSync(output, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: result.ok, error: result.error, evidence: output }));
  rmSync(root, { recursive: true, force: true });
}
