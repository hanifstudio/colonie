/** Deterministic ACP agent fixture using the upstream SDK, not a mock client. */
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError, type RequestPermissionRequest, type RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { readFileSync, writeFileSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import { fixtureMcpClient, type FixtureMcpClient } from "./mcp-client.ts";

const file = process.env.COLONIE_FAKE_STATE!;
type FixtureSession = { prompts: string[]; mode?: string; model?: string; effort?: string; fast?: boolean };
type State = { sessions: Record<string, FixtureSession>; permissions: string[]; loads: number; environment?: Record<string, string | null>; authenticated?: boolean };
const unauthenticatedStart = () => process.env.COLONIE_FAKE_UNAUTH === "1";
const initialState = (): State => ({ sessions: {}, permissions: [], loads: 0, authenticated: !unauthenticatedStart() });
let state: State;
/** Several adapter processes share this fixture file; serialize their updates. */
function transaction<T>(action: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  while (true) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    try { state = JSON.parse(readFileSync(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = initialState(); }
    const result = action();
    writeFileSync(file, JSON.stringify(state));
    return result;
  } finally { rmdirSync(lock); }
}
/** Read without writing: auth state is shared across the processes a probe
 * and a sign-in spawn. Missing file means the unflagged default. */
function currentState(): State {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return initialState(); }
}
const active = new Map<string, () => void>();
const mounts = new Map<string, McpServer[]>();
/** The folder each session works in, as the client opened or loaded it. */
const cwds = new Map<string, string>();
const peers = new Map<string, Promise<FixtureMcpClient>>();
const peer = (sessionId: string, name: string) => {
  const server = mounts.get(sessionId)?.find((server) => server.name === name);
  if (!server) throw new Error("Fixture MCP server is not mounted");
  const key = `${sessionId}:${name}`;
  if (!peers.has(key)) peers.set(key, fixtureMcpClient(server));
  return peers.get(key)!;
};
process.stdin.on("end", () => { void Promise.allSettled([...peers.values()].map(async (client) => (await client).close())).finally(() => process.exit(0)); });
const claude = process.env.COLONIE_FAKE_PROVIDER === "claude";
const sessionState = (id?: string) => {
  const session = id ? state.sessions[id] : undefined;
  return {
  modes: { currentModeId: session?.mode ?? (claude ? "default" : "read-only"), availableModes: [
    { id: claude ? "default" : "read-only", name: "Ask" }, { id: claude ? "acceptEdits" : "workspace-write", name: "Accept edits" },
    { id: claude ? "bypassPermissions" : "agent-full-access", name: "Full" },
    { id: "plan", name: "Plan" }, { id: claude ? "auto" : "agent", name: "Auto" },
  ] },
  configOptions: [
    { id: "model", name: "Model", category: "model", type: "select" as const,
      currentValue: session?.model ?? "fixture", options: [{ value: "fixture", name: "Fixture" }, { value: "fixture-alt", name: "Fixture alternative" }] },
    { id: "effort", name: "Reasoning effort", category: "thought_level", type: "select" as const,
      currentValue: session?.effort ?? "low", options: session?.model === "fixture-alt"
        ? [{ value: "low", name: "Low" }] : [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
    { id: "fast", name: "Fast mode", category: "model_config", type: "boolean" as const, currentValue: session?.fast ?? false },
  ],
};
};

agent({ name: "Colonie deterministic fixture" })
  .onRequest(methods.agent.initialize, ({ client }) => {
    const authed = currentState().authenticated !== false;
    void client.notify("_auth/status_update", { authStatus: authed ? { kind: "account", label: "Fixture account" } : { kind: "none", label: "Not logged in" } });
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: claude }, _meta: { authStatus: {} } }, authMethods: authed ? [] : [{ id: "fixture-login", name: "Fixture sign-in" }] };
  })
  .onRequest(methods.agent.authenticate, ({ client }) => transaction(() => {
    state.authenticated = true;
    void client.notify("_auth/status_update", { authStatus: { kind: "account", label: "Fixture account" } });
    return {};
  }))
  .onRequest(methods.agent.session.new, ({ params }) => transaction(() => {
    if (state.authenticated === false) throw RequestError.authRequired();
    const sessionId = crypto.randomUUID();
    state.sessions[sessionId] = { prompts: [] };
    // Record the config-dir env the app spawns this engine with, so a fixture
    // can prove Colonie isolates it from the user's own CLI state.
    state.environment = { CODEX_HOME: process.env.CODEX_HOME ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null };
    mounts.set(sessionId, params.mcpServers);
    cwds.set(sessionId, params.cwd);
    return { sessionId, ...sessionState(sessionId) };
  }))
  .onRequest(methods.agent.session.load, ({ params }) => transaction(() => {
    if (!state.sessions[params.sessionId]) throw RequestError.invalidParams("Unknown saved session");
    state.loads++;
    mounts.set(params.sessionId, params.mcpServers);
    cwds.set(params.sessionId, params.cwd);
    return sessionState(params.sessionId);
  }))
  .onRequest(methods.agent.session.setMode, async ({ params, client }) => {
    // Simulate an adapter whose reviewer is unavailable for the current model:
    // the client asks for Auto by the id its own flavour uses (Claude `auto`,
    // Codex `agent`) and the adapter clamps it to the Ask mode and says so.
    const reviewerIds = ["auto", "agent"];
    const mode = reviewerIds.includes(params.modeId) ? (claude ? "default" : "read-only") : params.modeId;
    transaction(() => { state.sessions[params.sessionId]!.mode = mode; });
    if (mode !== params.modeId) await client.notify(methods.client.session.update, { sessionId: params.sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: mode } });
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => transaction(() => {
    const session = state.sessions[params.sessionId]!;
    if (params.configId === "model" && typeof params.value === "string") {
      session.model = params.value;
      if (params.value === "fixture-alt") session.effort = "low";
    } else if (params.configId === "effort" && typeof params.value === "string") session.effort = params.value;
    else if (params.configId === "fast" && typeof params.value === "boolean") session.fast = params.value;
    else throw RequestError.invalidParams("Unsupported setting");
    return { configOptions: sessionState(params.sessionId).configOptions };
  }))
  .onNotification(methods.agent.session.cancel, ({ params }) => active.get(params.sessionId)?.())
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const blocks = params.prompt.filter((part) => part.type === "text");
    const text = blocks.at(-1)?.text ?? "";
    const session = transaction(() => {
      const session = state.sessions[params.sessionId]!;
      session.prompts.push(blocks.map((part) => part.text).join("\n"));
      return session;
    });
    if (text === "crash") process.exit(3);
    if (text === "hang") {
      await new Promise<void>((resolve) => active.set(params.sessionId, resolve));
      active.delete(params.sessionId);
      return { stopReason: "cancelled" };
    }
    let result = `${session.prompts.length}: ${text}`;
    // a bot in a group handing work on: its answer names the other bot only
    const handOff = /hand over to (\S+)\s*$/.exec(text)?.[1];
    if (handOff) result = `@${handOff} over to you`;
    if (text.startsWith("COLONIE_MEMORY_CAPTURE_V1") || text.includes("COLONIE_MEMORY_CAPTURE_V1\n")) {
      // Scripted judgments exercise the real SDK/background lifecycle; they
      // are intentionally not evidence of real-model extraction quality.
      let payload: unknown;
      const inputEnd = text.indexOf("\n\nAnswer with a JSON array");
      for (let at = text.indexOf("{"); at >= 0; at = text.indexOf("{", at + 1)) {
        try { payload = JSON.parse(text.slice(at, inputEnd < 0 ? undefined : inputEnd)); break; } catch { /* find the JSON input */ }
      }
      const objects: Record<string, unknown>[] = [];
      const walk = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) { value.forEach(walk); return; }
        objects.push(value as Record<string, unknown>);
        Object.values(value).forEach(walk);
      };
      walk(payload);
      const existing = objects.find((value) => value.key === "user.reply-style" && typeof value.id === "string");
      const source = objects.find((value) => typeof value.messageId === "string" && typeof value.text === "string")?.text
        ?? objects.find((value) => typeof value.userText === "string")?.userText ?? text;
      const correction = String(source).includes("I now prefer detailed replies.");
      const initial = String(source).includes("I prefer concise replies.");
      const forget = String(source).includes("Forget my reply style.");
      const project = String(source).includes("Project Nebula launches on October 20.");
      const changes: unknown[] = [];
      if (forget && existing) changes.push({ action: "forget", scope: "shared", kind: "preference", key: "user.reply-style",
        text: existing.text, evidence: "Forget my reply style.", confidence: 1, replaces: existing.id });
      else if (correction || initial) changes.push({ action: "upsert", scope: "shared", kind: "preference", key: "user.reply-style",
        text: correction ? "The user prefers detailed replies." : "The user prefers concise replies.",
        evidence: correction ? "I now prefer detailed replies." : "I prefer concise replies.", confidence: 1,
        ...(existing ? { replaces: existing.id } : {}) });
      if (project) changes.push({ action: "upsert", scope: "bot", kind: "decision", key: "project.nebula.launch",
        text: "Project Nebula launches on October 20.", evidence: "Project Nebula launches on October 20.", confidence: 1 });
      result = JSON.stringify(changes);
    }
    if (text === "mcp list") {
      const names: string[] = [];
      for (const server of mounts.get(params.sessionId) ?? []) {
        const list = await (await peer(params.sessionId, server.name)).request("tools/list", {}, AbortSignal.timeout(15_000));
        names.push(...list.tools.map((tool: { name: string }) => `${server.name}:${tool.name}`));
      }
      result = `MCP tools: ${names.join(", ") || "None"}`;
    }
    // in a group the person's words are the brief's last line, after "@Bot "
    const mcpCall = /^mcp call ([\w-]+) ([\w-]+)(?: (.*))?$/.exec(/\n@\S+ (mcp call [^\n]*)$/.exec(text)?.[1] ?? text);
    if (mcpCall) {
      const serverName = mcpCall[1]!; const name = mcpCall[2]!;
      const args = JSON.parse(mcpCall[3] ?? "{}");
      // Real adapters name an MCP tool by its server as well (Claude:
      // mcp__<server>__<tool>); the title stays the bare tool.
      const toolCall = { toolCallId: crypto.randomUUID(), title: name, name: `mcp__${serverName}__${name}`, kind: "other" as const, status: "pending" as const };
      await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "tool_call", ...toolCall } });
      const answer = await client.request<RequestPermissionResponse, RequestPermissionRequest>(methods.client.session.requestPermission, {
        sessionId: params.sessionId, toolCall, options: [{ kind: "allow_once", optionId: "yes-once", name: "Allow once" }, { kind: "reject_once", optionId: "no", name: "Deny" }],
      });
      const outcome = answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled";
      transaction(() => { state.permissions.push(outcome); });
      if (outcome === "yes-once") {
        const controller = new AbortController(); active.set(params.sessionId, () => controller.abort());
        try {
          const response = await (await peer(params.sessionId, serverName)).request("tools/call", { name, arguments: args }, AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]));
          result = response.content?.map((block: any) => block.text ?? "").join("\n") ?? JSON.stringify(response);
        } catch (error) { result = controller.signal.aborted ? "MCP cancelled" : `MCP error: ${(error as Error).message}`; }
        finally { active.delete(params.sessionId); }
      } else result = `MCP permission: ${outcome}`;
      await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId, status: outcome === "yes-once" ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: result } }] } });
    }
    // "write file NAME TEXT": a file in the session's working folder
    const write = /^write file ([\w.-]+) (.*)$/.exec(/\n@\S+ (write file [^\n]*)$/.exec(text)?.[1] ?? text);
    if (write) {
      writeFileSync(join(cwds.get(params.sessionId)!, write[1]!), write[2]!);
      result = `Wrote ${write[1]}`;
    }
    // "write file NAME TEXT then ask BOT to write file NAME TEXT": a lead doing
    // its part and handing the next to another bot, by name, in its answer
    const handing = /write file ([\w.-]+) (.*?) then ask (\S+) to (write file [^\n]*)$/.exec(text);
    if (handing) {
      writeFileSync(join(cwds.get(params.sessionId)!, handing[1]!), handing[2]!);
      result = `Wrote ${handing[1]}.\n@${handing[3]} ${handing[4]}`;
    }
    // a group mention wraps the person's words in a brief; they are its last line
    if (text.startsWith("permission") || /\n@\S+ permission[^\n]*$/.test(text)) {
      const toolCall = { toolCallId: crypto.randomUUID(), title: "Write fixture file", kind: "edit" as const, status: "pending" as const };
      await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "tool_call", ...toolCall } });
      const answer = await client.request<RequestPermissionResponse, RequestPermissionRequest>(methods.client.session.requestPermission, {
        sessionId: params.sessionId, toolCall,
        options: [{ kind: "allow_once", optionId: "yes-once", name: "Allow once" },
          { kind: "allow_always", optionId: "yes-session", name: "Allow for session" },
          { kind: "reject_once", optionId: "no", name: "Deny" }],
      });
      const outcome = answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled";
      transaction(() => { state.permissions.push(outcome); });
      result = `Permission: ${outcome}`;
      await client.notify(methods.client.session.update, { sessionId: params.sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId,
          status: outcome.startsWith("yes") ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: result } }] } });
    }
    // Delayed chunks make in-flight rendering observable in renderer/desktop fixtures.
    const split = Math.max(1, Math.floor(result.length / 2));
    for (const chunk of [result.slice(0, split), result.slice(split)]) {
      await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } } });
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.COLONIE_FAKE_DELAY_MS) || 150));
    }
    return { stopReason: "end_turn" };
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
