/** Two bounded native tool checks in disposable workspaces, never a user repo. */
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

if (!process.argv.includes("--real")) throw new Error("Pass --real to test two native requests with existing CLI auth.");
const root = mkdtempSync(join(tmpdir(), "colonie-native-permissions-"));
process.env.COLONIE_DATA_DIR = join(root, "app");
const { CodexAcpDriver } = await import("../../server/acp/codex-acp.ts");
const { ClaudeAcpDriver } = await import("../../server/acp/claude-acp.ts");
const driver = process.argv.includes("--claude") ? ClaudeAcpDriver : CodexAcpDriver;
const evidence = resolve(".colonie-dev/evidence"); mkdirSync(evidence, { recursive: true });
const cases: unknown[] = [];
let current: import("../../server/contracts.ts").ProviderInstance | undefined;
let ok = false;
let error: string | undefined;
try {
  for (const behavior of ["allow", "deny"] as const) {
    const cwd = join(root, behavior); mkdirSync(cwd);
    const file = join(cwd, "permission-fixture.txt");
    current = await driver.create({ instanceId: driver.driverKind, displayName: driver.metadata.displayName, enabled: true, environment: {}, config: driver.defaultConfig() });
    const events: import("../../server/contracts.ts").RuntimeEvent[] = [];
    const decisions: string[] = [];
    current.adapter.onEvent((event) => {
      events.push(event);
      if (event.type === "request.opened") {
        void current!.adapter.respondToRequest(event.threadId, event.requestId!, { behavior }).then((outcome) => decisions.push(outcome));
      }
    });
    const prompt = `This is a bounded integration fixture. Create only ./permission-fixture.txt in the current working directory with exactly COLONIE_TOOL_OK followed by a newline, using your native file editing tool. Do not inspect other directories, use the network, modify other files, or run unrelated commands. If permission is denied, stop this request without retrying or finding another way to write the file. Finish with one short sentence.`;
    const sent = await current.adapter.sendTurn({ threadId: `native-${behavior}`, cwd, text: prompt, approvalMode: "ask" });
    const until = Date.now() + 90_000;
    while (!events.some((event) => event.type === "turn.completed" && event.turnId === sent.turnId) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!events.some((event) => event.type === "turn.completed" && event.turnId === sent.turnId)) { await current.adapter.interruptTurn(`native-${behavior}`, sent.turnId); throw new Error("Native permission fixture timed out"); }
    const present = existsSync(file);
    const content = present ? readFileSync(file, "utf8") : null;
    cases.push({ behavior, decisions, present, content, events });
    if (decisions.length === 0) throw new Error("Native settings did not raise a permission request; this run cannot prove interactive Allow/Deny.");
    if (behavior === "allow" && content !== "COLONIE_TOOL_OK\n") throw new Error("Allowed native operation did not produce the fixture file");
    if (behavior === "deny" && present) throw new Error("Denied native operation still produced the fixture file");
    await current.dispose(); current = undefined;
  }
  ok = true;
} catch (cause) { error = (cause as Error).message; process.exitCode = 1; }
finally { await current?.dispose(); rmSync(root, { recursive: true, force: true }); }
const output = join(evidence, `${driver.driverKind}-native-permissions.json`);
writeFileSync(output, JSON.stringify({ ok, error, provider: driver.driverKind, cases }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ok, error, evidence: output }));
