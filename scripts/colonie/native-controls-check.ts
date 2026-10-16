/** Explicit, bounded real adapter check; discovers first without model prompts. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeEvent, SendTurnInput } from "../../server/contracts.ts";
import type { AcpRuntime } from "../../server/acp/acp-runtime.ts";

if (!process.argv.includes("--real")) throw new Error("Pass --real for one bounded request using existing CLI auth.");
const root = mkdtempSync(join(tmpdir(), "colonie-native-controls-"));
process.env.COLONIE_DATA_DIR = join(root, "app");
const cwd = join(root, "workspace"); mkdirSync(cwd);
const { CodexAcpDriver } = await import("../../server/acp/codex-acp.ts");
const { ClaudeAcpDriver } = await import("../../server/acp/claude-acp.ts");
const { inputReceipts } = await import("../../server/acp/receipts.ts");
const driver = process.argv.includes("--claude") ? ClaudeAcpDriver : CodexAcpDriver;
const instance = await driver.create({ instanceId: driver.driverKind, displayName: driver.metadata.displayName, enabled: true, environment: {}, config: driver.defaultConfig() });
const adapter = instance.adapter as AcpRuntime;
const input: SendTurnInput = { threadId: "controls", cwd, model: "agent-default", approvalMode: "ask", text: "Reply with exactly COLONIE_NATIVE_CONTROL_OK. Do not use tools." };
const evidence = resolve(".colonie-dev/evidence"); mkdirSync(evidence, { recursive: true });
const events: RuntimeEvent[] = []; adapter.onEvent((event) => events.push(event));
let result: Record<string, unknown>;
let selected: import("../../shared/acp-settings.ts").NativeSettings | undefined;
try {
  let snapshot = await adapter.prepareSettings(input);
  if (inputReceipts(input.threadId).length !== 0) throw new Error("Discovery dispatched an unintended prompt");
  const effort = snapshot.options.find((option) => option.category === "thought_level" && option.type === "select");
  const choice = effort?.options.find((option) => /^(low|minimal|none)$/i.test(option.value)) ?? effort?.options[0];
  if (effort && choice) snapshot = await adapter.changeSettings(input, { kind: "option", configId: effort.id, value: choice.value, sessionId: snapshot.sessionId, expectedRevision: snapshot.revision });
  selected = snapshot;
  const sent = await adapter.sendTurn(input);
  const deadline = Date.now() + 90_000;
  while (!events.some((event) => event.type === "turn.completed" && event.turnId === sent.turnId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  const completion = events.find((event) => event.type === "turn.completed" && event.turnId === sent.turnId);
  if (!completion || completion.type !== "turn.completed" || !completion.ok) throw new Error("Native configuration request did not complete successfully");
  const text = events.filter((event) => event.type === "item.completed" && event.itemType === "assistant_text").map((event) => event.type === "item.completed" && event.itemType === "assistant_text" ? event.text : "").join("\n");
  if (text.trim() !== "COLONIE_NATIVE_CONTROL_OK") throw new Error(`Unexpected reply: ${text}`);
  const receipts = inputReceipts(input.threadId);
  if (effort && choice && receipts[0]?.nativeSettings?.[effort.id] !== choice.value) throw new Error("Effective effort did not match the accepted native choice");
  result = { ok: true, selected, receipts, reply: text, events };
} catch (error) { result = { ok: false, error: (error as Error).message, selected, receipts: inputReceipts(input.threadId), events }; process.exitCode = 1; }
finally { await instance.dispose(); rmSync(root, { recursive: true, force: true }); }
const output = join(evidence, `${driver.driverKind}-native-controls.json`);
writeFileSync(output, JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ok: result.ok, error: result.error, evidence: output }));
