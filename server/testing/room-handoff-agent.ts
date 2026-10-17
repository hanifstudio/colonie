// Scripted provider fixture that exercises the REAL injected agents MCP proxy.
// The plan and evidence are confined to the isolated launcher's temporary home.
import { readFileSync, existsSync } from "node:fs";
import { appendPlanEvidence, openStdioMcp, runPlanSteps, selectPlanTurn, settlePlanTurn } from "./tool-plan.ts";

type AgentsIntegration = { command: string; args: string[]; env: Record<string, string> };

// Claude reads its MCP config and system prompt files once, at launch. The
// harness removes both when the first turn settles, so a process kept warm
// for later turns must not read them again.
const launchFiles = new Map<string, string>();
const readAtLaunch = (path: string) => {
  if (!launchFiles.has(path)) launchFiles.set(path, readFileSync(path, "utf8"));
  return launchFiles.get(path)!;
};

/** `launch` replaces Claude's argv files for another fake engine: the agents
 * server it mounted, its instructions, and extra evidence fields. `progress`
 * streams a plan's `progress` text before the turn waits on its gate, and its
 * `progressAfterGate` text once the gate opens. */
export async function runRoomHandoffAgent(argv: string[], planPath: string, prompt?: unknown,
  launch?: { integration: AgentsIntegration; system: string; evidence?: Record<string, unknown> },
  progress?: (text: string) => void): Promise<string> {
  const arg = (flag: string) => argv[argv.indexOf(flag) + 1];
  const integration = launch?.integration ?? Object.values(JSON.parse(readAtLaunch(arg("--mcp-config"))).mcpServers as Record<string, AgentsIntegration>)
    .find(s => s.env?.COLONIE_BOT_ID);
  // A depth-capped delegated turn mounts no agents server: answer from the prompt alone.
  if (!integration) {
    // Nothing in such a launch's argv says which bot it is — only the task
    // text does. A test that needs a delegated reply to land at an exact
    // point (a wake it must follow) holds it here on a gate file, named by a
    // substring of the task text: `${planPath}.gates.json`, a JSON array of
    // { promptIncludes, gateFile }. The wait is unbounded like any plan
    // gate: the test that set it owns when it opens.
    const gatesPath = `${planPath}.gates.json`;
    const taskText = String((prompt as any)?.message?.content ?? "");
    for (const rule of existsSync(gatesPath) ? JSON.parse(readFileSync(gatesPath, "utf8")) as Array<{ promptIncludes: string; gateFile: string }> : []) {
      if (!taskText.includes(rule.promptIncludes) || existsSync(rule.gateFile)) continue;
      await new Promise<void>(resolve => {
        const timer = setInterval(() => {
          if (!existsSync(rule.gateFile)) return;
          clearInterval(timer);
          resolve();
        }, 10);
      });
    }
    return `Handled without teammate tools: ${taskText}`;
  }
  const botId = integration.env.COLONIE_BOT_ID;
  const system = launch?.system ?? readAtLaunch(arg("--append-system-prompt-file"));
  // Claude snapshots the launch-time system prompt for a session. A retained
  // process or --resume launch receives changed turn-scoped instructions in
  // the user message, so inspect both surfaces just as the model does.
  const turnContext = `${system}\n${JSON.stringify(prompt)}`;
  const turn = selectPlanTurn(planPath, botId, system, turnContext);
  const { resumed, turnIndex } = turn;
  const evidence: unknown[] = [];
  const controller = new AbortController();
  const session = openStdioMcp(integration);
  const timer = setTimeout(() => session.fail(new Error("Fixture MCP run timed out")), 20_000);
  try {
    return await Promise.race([session.failed, (async () => {
      await session.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "room-fixture", version: "1" } });
      evidence.push(await session.call("tools/list"));
      evidence.push(await session.call("tools/call", { name: "list_room_targets", arguments: {} }));
      await runPlanSteps(turn.steps, evidence, step => session.call("tools/call", { name: step.tool ?? "coordinate_bots", arguments: step.arguments }));
      return settlePlanTurn(turn, controller.signal, { progress, onGate: () => clearTimeout(timer) });
    })()]);
  } finally {
    clearTimeout(timer); controller.abort();
    await session.close();
    appendPlanEvidence(planPath, { botId, turnIndex, threadId: integration.env.COLONIE_THREAD_ID,
      model: argv.includes("--model") ? arg("--model") : undefined,
      permissionMode: argv.includes("--permission-mode") ? arg("--permission-mode") : undefined,
      snapshotMode: argv.includes("--system-prompt-snapshot") ? arg("--system-prompt-snapshot") : undefined,
      resumed, system, prompt, evidence, ...launch?.evidence });
  }
}
