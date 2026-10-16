/** Explicit, bounded real-provider probe. No credential contents are read. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (!process.argv.includes("--real")) throw new Error("Pass --real to run three bounded requests using existing Codex authentication.");
const root = mkdtempSync(join(tmpdir(), "colonie-real-codex-"));
process.env.COLONIE_DATA_DIR = join(root, "app-data");
const workspace = join(root, "workspace");
mkdirSync(workspace);
writeFileSync(join(workspace, "fixture.txt"), "COLONIE_FILE_OK\n");
const { CodexAcpDriver } = await import("../../server/acp/codex-acp.ts");
const { ClaudeAcpDriver } = await import("../../server/acp/claude-acp.ts");
const driver = process.argv.includes("--claude") ? ClaudeAcpDriver : CodexAcpDriver;
const { inputReceipts } = await import("../../server/acp/receipts.ts");
const evidenceDir = resolve(".colonie-dev/evidence");
mkdirSync(evidenceDir, { recursive: true });
let instance = await driver.create({ instanceId: driver.driverKind, displayName: driver.metadata.displayName,
  enabled: true, environment: {}, config: driver.defaultConfig() });
const events: import("../../server/contracts.ts").RuntimeEvent[] = [];
instance.adapter.onEvent((event) => {
  events.push(event);
  if (event.type === "request.opened") void instance.adapter.respondToRequest(event.threadId, event.requestId!, { behavior: "deny" });
});

async function ask(text: string, cursor?: string): Promise<string> {
  const { turnId } = await instance.adapter.sendTurn({ threadId: "real-provider", text, cwd: workspace, resumeCursor: cursor, approvalMode: "ask" });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const completion = events.find((event) => event.type === "turn.completed" && event.turnId === turnId);
    if (completion?.type === "turn.completed") {
      if (!completion.ok) throw new Error(events.filter((event) => event.type === "runtime.error").map((event) => event.message).join("\n") || completion.stopReason || "Provider failed");
      return events.filter((event) => event.type === "item.completed" && event.itemType === "assistant_text" && event.turnId === turnId)
        .map((event) => event.type === "item.completed" && event.itemType === "assistant_text" ? event.text : "").join("\n");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await instance.adapter.interruptTurn("real-provider", turnId);
  throw new Error("Bounded provider check exceeded 90 seconds");
}

let result: Record<string, unknown>;
try {
  const first = await ask("Remember this temporary marker: COLONIE_SESSION_829. Reply with exactly COLONIE_OK. Do not use tools.");
  if (first.trim() !== "COLONIE_OK") throw new Error(`Unexpected first answer: ${first}`);
  const cursor = inputReceipts("real-provider")[0]!.sessionId;
  await instance.dispose();
  const restarted = await driver.create({ instanceId: driver.driverKind, displayName: driver.metadata.displayName, enabled: true, environment: {}, config: driver.defaultConfig() });
  instance = restarted;
  instance.adapter.onEvent((event) => events.push(event));
  const second = await ask("What temporary marker did I ask you to remember? Reply with only that marker. Do not use tools.", cursor);
  if (second.trim() !== "COLONIE_SESSION_829") throw new Error(`Session load did not preserve marker: ${second}`);
  const third = await ask("Read only ./fixture.txt in the current directory. Reply with only its contents. Do not write any files or access anything outside this workspace.", cursor);
  if (third.trim() !== "COLONIE_FILE_OK") throw new Error(`Unexpected file answer: ${third}`);
  result = { ok: true, first, second, third, receipts: inputReceipts("real-provider"), events };
} catch (error) {
  result = { ok: false, error: (error as Error).message, events, receipts: inputReceipts("real-provider") };
  process.exitCode = 1;
} finally {
  await instance.dispose();
}
const output = join(evidenceDir, `${driver.driverKind}-provider-check.json`);
writeFileSync(output, JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ok: result.ok, error: result.error, evidence: output }));
rmSync(root, { recursive: true, force: true });
