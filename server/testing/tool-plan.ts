// Scripted tool plans shared by the fake engines. A plan file maps a bot id to
// what that bot's engine does on a turn: which mounted MCP tools it calls, in
// order, and what it answers. Every finished turn appends one evidence row to
// `${planPath}.evidence.jsonl`, which is also how a multi-turn plan
// (`{ turns: [...] }`) knows which turn comes next.
//
// Plan entry (per bot id):
//   steps            [{ tool, arguments?, server?, expectError? }] tools to call
//   reply            the final agent text (default "Result from <bot>")
//   turns            [{ steps, reply, ... }] one entry per turn, in order
//   resumeSteps / resumeReply  used instead on a resumed room turn
//   expectSystemIncludes / expectContextIncludes  context the turn must carry
//   progress / progressAfterGate  text streamed before / after the gate
//   readyFile        written once the steps have run
//   gateFile         hold the turn until this file exists
//   delayMs          wait before answering
//   fail / failResumed  fail the turn instead of answering
// ACP-only selectors (the ACP fixture has no per-bot argv or env):
//   promptIncludes   pick this entry when the prompt contains the text
//   botName          pick this entry when the prompt's persona reads
//                    "Name: <botName>" (the key itself is also tried)
// A "*" entry applies to any ACP turn no other entry claims.
//
// The ACP fixture loads this file only while a plan is set: it is copied out
// of the repo by some tests, where a relative import cannot resolve.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { waitForExit } from "./cleanup.ts";

export type PlanStep = { tool?: string; server?: string; arguments?: unknown; expectError?: boolean };
type PlanTurn = {
  steps?: PlanStep[]; resumeSteps?: PlanStep[]; reply?: string; resumeReply?: string;
  expectSystemIncludes?: string[]; expectContextIncludes?: string[];
  progress?: string; progressAfterGate?: string; readyFile?: string; gateFile?: string; delayMs?: number;
  fail?: boolean; failResumed?: boolean;
};
type PlanEntry = PlanTurn & { turns?: PlanTurn[]; promptIncludes?: string; botName?: string };
export type SelectedTurn = { botId: string; basePlan: PlanEntry; plan: PlanTurn; turnIndex: number; resumed: boolean; steps: PlanStep[] };

/** One MCP connection: `call` resolves with the whole JSON-RPC response frame. */
export type McpSession = {
  call(method: string, params?: unknown): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  /** Rejects when the transport fails; race it against the turn. */
  failed: Promise<never>;
  fail(error: Error): void;
  close(): Promise<void>;
};

const readPlan = (planPath: string) => JSON.parse(readFileSync(planPath, "utf8")) as Record<string, PlanEntry>;
const readEvidence = (planPath: string): Array<Record<string, unknown>> =>
  existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    : [];
export const appendPlanEvidence = (planPath: string, row: Record<string, unknown>) =>
  appendFileSync(`${planPath}.evidence.jsonl`, JSON.stringify(row) + "\n");

/** The plan turn this bot runs now, checked against the context it was given. */
export function selectPlanTurn(planPath: string, botId: string, system: string, turnContext: string): SelectedTurn {
  const resumed = turnContext.includes("Your delegated requests have settled.");
  const basePlan = readPlan(planPath)[botId] ?? {};
  const turnIndex = readEvidence(planPath).filter(p => p.botId === botId).length;
  const plan = basePlan.turns ? basePlan.turns[turnIndex] : basePlan;
  if (!plan) throw new Error(`Unexpected extra fixture turn ${turnIndex} for ${botId}`);
  for (const expected of plan.expectSystemIncludes ?? []) if (!system.includes(expected)) throw new Error(`Missing discussion context: ${expected}`);
  for (const expected of plan.expectContextIncludes ?? []) if (!turnContext.includes(expected)) throw new Error(`Missing conversation context: ${expected}`);
  const steps = basePlan.turns ? plan.steps ?? [] : resumed ? plan.resumeSteps ?? [] : plan.steps ?? [];
  return { botId, basePlan, plan, turnIndex, resumed, steps };
}

/** Call each step's tool through `invoke`, recording `{ step, response }`. */
export async function runPlanSteps(steps: PlanStep[], evidence: unknown[], invoke: (step: PlanStep) => Promise<any>) {
  for (const step of steps) {
    const response = await invoke(step);
    evidence.push({ step, response });
    if (Boolean(response.error || response.result?.isError) !== Boolean(step.expectError)) throw new Error(`Unexpected tool outcome: ${JSON.stringify(response)}`);
  }
}

const waitForFile = (path: string, signal: AbortSignal) => new Promise<void>(resolve => {
  if (existsSync(path)) { resolve(); return; }
  const timer = setInterval(() => {
    if (!existsSync(path)) return;
    clearInterval(timer);
    resolve();
  }, 10);
  // An aborted turn has already settled elsewhere; just stop polling.
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
});

/** Everything after the steps: progress, gate, delay, scripted failure, reply.
 * `onGate` fires before an explicit test gate, whose wait is owned by the
 * parent test's timeout rather than the transport deadline: long conversation
 * fixtures may deliberately keep a teammate waiting across many turns. */
export async function settlePlanTurn(turn: SelectedTurn, signal: AbortSignal,
  hooks: { progress?: (text: string) => void; onGate?: () => void } = {}): Promise<string> {
  const { plan, basePlan, resumed, botId } = turn;
  if (typeof plan.progress === "string") hooks.progress?.(plan.progress);
  if (plan.readyFile) writeFileSync(plan.readyFile, "ready");
  if (plan.gateFile) { hooks.onGate?.(); await waitForFile(plan.gateFile, signal); }
  if (typeof plan.progressAfterGate === "string") hooks.progress?.(plan.progressAfterGate);
  if (plan.delayMs) await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, plan.delayMs);
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  });
  if (plan.fail && !resumed) throw new Error("Scripted addressed agent failure");
  if (plan.failResumed && resumed) throw new Error("Scripted failure of a resumed turn");
  return basePlan.turns ? plan.reply as string : resumed ? plan.resumeReply ?? `Summary from ${botId}` : plan.reply ?? `Result from ${botId}`;
}

/** A newline-delimited JSON-RPC MCP server on a child's stdio. */
export function openStdioMcp(server: { command: string; args?: string[]; env?: Record<string, string> }): McpSession {
  const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let serial = 0;
  let closing = false;
  let failure: Error | undefined;
  let rejectRun!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => { rejectRun = reject; });
  failed.catch(() => {});
  const fail = (error: Error) => {
    if (closing || failure) return;
    failure = error;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    rejectRun(error);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const data = JSON.parse(line);
      const waiter = pending.get(data.id);
      if (waiter) { pending.delete(data.id); waiter.resolve(data); }
    } catch { fail(new Error("Fixture MCP returned malformed JSON")); }
  });
  child.on("error", fail);
  child.on("exit", (code, signal) => fail(new Error(`Fixture MCP exited unexpectedly: ${signal ?? code}`)));
  child.stdin.on("error", fail);
  child.stderr.resume();
  return {
    call: (method, params = {}) => new Promise<any>((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const id = ++serial; pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    }),
    notify: async (method, params) => { if (!failure) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }) + "\n"); },
    failed,
    fail,
    async close() {
      closing = true;
      lines.close(); child.stdin.destroy();
      await waitForExit(child, { signal: "SIGTERM", graceMs: 500 });
    },
  };
}

/** A streamable-HTTP MCP server: one POST per frame, JSON or SSE answers. */
export function openHttpMcp(url: string, headerList: Array<{ name: string; value: string }> = []): McpSession {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  for (const { name, value } of headerList) headers[name] = value;
  const controller = new AbortController();
  let serial = 0;
  let rejectRun!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => { rejectRun = reject; });
  failed.catch(() => {});
  const post = async (frame: Record<string, unknown>) => {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...frame }), signal: controller.signal });
    const session = response.headers.get("mcp-session-id");
    if (session) headers["mcp-session-id"] = session;
    const text = await response.text();
    if (frame.id === undefined) return undefined;
    const body = text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim())
      .map(line => { try { return JSON.parse(line); } catch { return undefined; } })
      .find(message => message?.id === frame.id) ?? (text.trim().startsWith("{") ? JSON.parse(text) : undefined);
    if (!body) throw new Error(`Fixture MCP HTTP ${response.status} returned no response`);
    return body;
  };
  return {
    call: (method, params = {}) => post({ id: ++serial, method, params }),
    notify: async (method, params) => { await post({ method, ...(params === undefined ? {} : { params }) }); },
    failed,
    fail: error => { controller.abort(); rejectRun(error); },
    async close() {
      controller.abort();
      if (headers["mcp-session-id"]) await fetch(url, { method: "DELETE", headers, signal: AbortSignal.timeout(2_000) }).catch(() => {});
    },
  };
}

// --- ACP ----------------------------------------------------------------------

/** An `mcpServers` entry from ACP session/new or session/load. */
export type AcpMcpServer = {
  name: string; type?: string; command?: string; args?: string[]; env?: Array<{ name: string; value: string }>;
  url?: string; headers?: Array<{ name: string; value: string }>;
};

const promptText = (prompt: unknown) => (Array.isArray(prompt) ? prompt : [])
  .flatMap(block => block?.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
const mountEnv = (server: AcpMcpServer) => Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value]));

/** The plan entry an ACP turn plays, or null when no entry claims it (the
 * fixture then runs its ordinary mode). ACP carries no per-bot argv, so the
 * bot is named by `hint` (FAKE_ACP_PLAN_BOT), a mounted server's
 * COLONIE_BOT_ID, an entry's `promptIncludes`, the persona "Name:" line, or
 * the "*" entry, in that order. */
export function acpPlanBot(planPath: string, servers: AcpMcpServer[], prompt: unknown, hint?: string): string | null {
  if (!existsSync(planPath)) return null;
  const plan = readPlan(planPath);
  for (const id of [hint, ...servers.map(server => mountEnv(server).COLONIE_BOT_ID)]) if (id && plan[id]) return id;
  const text = promptText(prompt);
  for (const [id, entry] of Object.entries(plan)) if (entry?.promptIncludes && text.includes(entry.promptIncludes)) return id;
  const names = new Set(text.split("\n").flatMap(line => line.startsWith("Name: ") ? [line.slice(6).trim()] : []));
  for (const [id, entry] of Object.entries(plan)) if (names.has(id) || (entry?.botName && names.has(entry.botName))) return id;
  return plan["*"] ? "*" : null;
}

/** Play one ACP turn's plan against the servers the app mounted: connect
 * each, call the scripted tools, stream them back as native ACP tool calls
 * through `update`, and resolve with the final agent text. */
export async function runAcpToolPlan(options: {
  planPath: string; botId: string; servers: AcpMcpServer[]; prompt: unknown; sessionId?: string;
  /** session/cancel: stop the run and close its MCP sessions */
  signal?: AbortSignal;
  update: (update: Record<string, unknown>) => void;
}): Promise<string> {
  const { planPath, botId, servers, prompt, update } = options;
  const text = promptText(prompt);
  const evidence: unknown[] = [];
  const sessions = new Map<string, { session: McpSession; tools: string[] }>();
  const controller = new AbortController();
  let rejectRun!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => { rejectRun = reject; });
  failed.catch(() => {});
  const turn = selectPlanTurn(planPath, botId, text, text);
  const timer = setTimeout(() => rejectRun(new Error("Fixture MCP run timed out")), 20_000);
  options.signal?.addEventListener("abort", () => rejectRun(new Error("Turn cancelled")), { once: true });
  try {
    return await Promise.race([failed, (async () => {
      if (turn.steps.length) {
        for (const server of servers) {
          const session = typeof server.url === "string" ? openHttpMcp(server.url, server.headers)
            : openStdioMcp({ command: server.command ?? "", args: server.args, env: mountEnv(server) });
          session.failed.catch(rejectRun);
          sessions.set(server.name, { session, tools: [] });
          const init = await session.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-acp-plan", version: "1" } });
          if (init.error) throw new Error(`Fixture MCP ${server.name} refused initialize: ${JSON.stringify(init.error)}`);
          await session.notify("notifications/initialized");
          const listed = await session.call("tools/list");
          sessions.get(server.name)!.tools = (listed.result?.tools ?? []).map((tool: { name: string }) => tool.name);
          evidence.push({ server: server.name, tools: listed });
        }
      }
      let index = 0;
      await runPlanSteps(turn.steps, evidence, async step => {
        if (!step.tool) throw new Error("A tool plan step names no tool");
        const target = step.server ? sessions.get(step.server) : [...sessions.values()].find(entry => entry.tools.includes(step.tool!));
        if (!target) throw new Error(`No mounted MCP server ${step.server ? `named ${step.server}` : `offers ${step.tool}`}`);
        const toolCallId = `plan-${turn.turnIndex}-${index++}`;
        update({ sessionUpdate: "tool_call", toolCallId, title: step.tool, kind: "other", status: "in_progress", rawInput: step.arguments ?? {} });
        const response = await target.session.call("tools/call", { name: step.tool, arguments: step.arguments ?? {} });
        const failedCall = Boolean(response.error || response.result?.isError);
        const output = response.error?.message ?? (response.result?.content ?? []).flatMap((block: any) => block?.type === "text" ? [block.text] : []).join("\n");
        update({ sessionUpdate: "tool_call_update", toolCallId, status: failedCall ? "failed" : "completed",
          rawOutput: response.result ?? response.error, content: [{ type: "content", content: { type: "text", text: String(output ?? "") } }] });
        return response;
      });
      return settlePlanTurn(turn, controller.signal, {
        progress: chunk => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } }),
        onGate: () => clearTimeout(timer),
      });
    })()]);
  } finally {
    clearTimeout(timer); controller.abort();
    await Promise.all([...sessions.values()].map(entry => entry.session.close()));
    appendPlanEvidence(planPath, { botId, turnIndex: turn.turnIndex, engine: "acp", sessionId: options.sessionId,
      threadId: servers.map(server => mountEnv(server).COLONIE_THREAD_ID).find(Boolean),
      servers: servers.map(server => server.name), resumed: turn.resumed, system: text, prompt, evidence });
  }
}
