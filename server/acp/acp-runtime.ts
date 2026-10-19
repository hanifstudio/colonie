/** New ACP boundary. No imports from the legacy drivers/acp client or Codex driver. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client, methods, ndJsonStream, PROTOCOL_VERSION,
  type ClientCapabilities, type ClientConnection, type CreateElicitationRequest, type CreateElicitationResponse,
  type InitializeResponse, type LoadSessionResponse,
  type NewSessionResponse, type PermissionOption, type RequestPermissionRequest,
  type RequestPermissionResponse, type SessionNotification, type SessionConfigOption,
  type ToolCallUpdate, type PromptRequest, type PromptResponse, type SetSessionConfigOptionResponse, type SetSessionConfigOptionRequest,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  newEventId, newId,
  type ModelCatalog, type ProviderAdapter, type ProviderDriver,
  type RuntimeEvent, type RuntimeEventListener, type SendTurnInput,
} from "../contracts.ts";
import type { AcpInputReceipt } from "../../shared/acp.ts";
import { inputReceipts, saveInputReceipt } from "./receipts.ts";
import { composeContext, contextPin, pinContext } from "./context.ts";
import { redactSecretsInText } from "../redact.ts";
import { nativePreferences, saveNativePreferences, type NativePreferences } from "./settings.ts";
import type { NativeSettings, NativeSettingChange, NativeOption } from "../../shared/acp-settings.ts";
import type { AcpToolMount } from "../colonie/connections/contracts.ts";
import type { ConnectedToolsReceipt } from "../../shared/connected-apps.ts";
import { DATA_DIR } from "../config.ts";
import { SHELL_TOOL } from "../../shared/tool-name.ts";
import { ASK_USER_QUESTION_TOOL, askQuestionSummary, questionChoices } from "../../shared/ask-question.ts";
import { elicitationAnswerContent, parseElicitationAsk, type ElicitationAsk } from "./elicitation.ts";
import { recoveryPromptFor } from "../resume-recovery.ts";

const require = createRequire(import.meta.url);
const configSchema = z.object({
  /** Explicit executable + argv, never a shell command or automatic npm download. */
  cli: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  instructions: z.string().max(32_000).default(""),
  setupTimeoutMs: z.number().int().min(100).max(120_000).default(30_000),
}).strict();
type Config = z.infer<typeof configSchema>;
export interface AcpProvider {
  kind: "codex-acp" | "claude-acp";
  name: string;
  packageEntry: string;
  entryEnvironment: string;
  version: string;
  loginCommand: string;
  askMode: string;
  fullMode: string;
  /** The adapter's own accept-edits mode (`acceptEdits`, `workspace-write`).
   * Optional: an adapter without one keeps Ask for that level. */
  editsMode?: string;
  /** The adapter's own reviewer (`auto` — Claude "handles permission
   * decisions"; `agent` — Codex "Auto review: only ask for actions detected as
   * potentially unsafe"). Optional, same rule. */
  autoMode?: string;
}
/** Whether this connection is signed in, plus its offered sign-in methods. */
export interface AcpAuthStatus {
  authenticated: boolean;
  methods: Array<{ id: string; name: string }>;
}
/** Both maintained adapters announce the account over this `_meta` push:
 * `claude-agent-acp` and `codex-acp` send `{ authStatus: { kind } }`, where
 * `kind: "none"` means signed out. It is the reliable signal for both. */
const AUTH_STATUS_UPDATE_METHOD = "_auth/status_update";
type AuthStatusPush = { kind?: string };
/** What this client tells every agent it can present. Form elicitation is a
 * real capability and has to be advertised: the claude adapter bridges
 * `AskUserQuestion` to an ACP form elicitation only for a client that declares
 * it (`this.clientCapabilities?.elicitation?.form`), and asks any other client
 * for a plain tool permission instead — a question rendered as Allow/Deny.
 * URL elicitation is not advertised: this app has no surface that opens the
 * agent's own URL flow, and declining it is honest where a card that cannot
 * complete would not be. */
const CLIENT_CAPABILITIES: ClientCapabilities = { elicitation: { form: {} } };
const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
/** Tokens the agent reported for one turn. The maintained adapters put them
 * under `_meta` on the prompt result; some agents report at the root. `input`
 * is the whole prompt with `cachedInput` naming the cached share — cache
 * writes stay out of `input`, and an absent cache count emits no key at all
 * (absent is not zero). */
function turnUsage(result: unknown): { input: number; output: number; cachedInput?: number } | undefined {
  const payload = (result ?? {}) as { usage?: Record<string, unknown>; _meta?: Record<string, unknown> };
  const usage = payload.usage ?? payload._meta ?? {};
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  if (input === undefined && output === undefined) return undefined;
  const cachedRead = count(usage.cachedReadTokens);
  const total = count(usage.totalTokens);
  // Agents differ on whether the cached share is inside inputTokens: when
  // totalTokens says the cached count sits beside it, both are added.
  const exclusive = cachedRead !== undefined && cachedRead > 0 && (total === undefined || total >= (input ?? 0) + (output ?? 0) + cachedRead);
  return {
    input: cachedRead !== undefined && cachedRead > 0 && exclusive ? (input ?? 0) + cachedRead : input ?? 0,
    output: output ?? 0,
    ...(cachedRead !== undefined && cachedRead > 0
      ? { cachedInput: exclusive ? cachedRead : Math.min(cachedRead, input ?? 0) }
      : {}),
  };
}
type EventPayload<E = RuntimeEvent> = E extends RuntimeEvent
  ? Omit<E, "eventId" | "provider" | "threadId" | "createdAt"> : never;

type ActiveTurn = {
  id: string;
  text: string;
  item: number;
  cancelled: boolean;
  finished: boolean;
  receipt?: AcpInputReceipt;
  done: Promise<void>;
  resolveDone: () => void;
};
type PendingPermission = {
  turnId: string;
  options: PermissionOption[];
  resolve: (response: RequestPermissionResponse) => void;
};
/** A form the agent is waiting on the person to answer. */
type PendingElicitation = {
  turnId: string;
  ask: ElicitationAsk;
  resolve: (response: CreateElicitationResponse) => void;
};
type LiveSession = {
  mounts: AcpToolMount[];
  threadId: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  connection: ClientConnection;
  initialization?: InitializeResponse;
  state?: NewSessionResponse | LoadSessionResponse;
  id?: string;
  turn?: ActiveTurn;
  permissions: Map<string, PendingPermission>;
  elicitations: Map<string, PendingElicitation>;
  tools: Set<string>;
  loading: boolean;
  closed: boolean;
  stderr: string;
  idleTimer?: ReturnType<typeof setTimeout>;
  defaultModel?: string;
  modeEpoch: number;
  applicationSelection?: string;
  /** the engine refused the saved session and this one was started from the
   * turn's recovery text; belongs to the turn that caused it */
  rebuilt?: boolean;
};

function choices(option: SessionConfigOption): Array<{ value: string; name: string }> {
  return option.type === "select"
    ? option.options.flatMap((item) => "group" in item ? item.options : [item])
    : [];
}
function nativeOption(option: SessionConfigOption): NativeOption {
  return { id: option.id, name: option.name, description: option.description ?? undefined,
    category: option.category ?? undefined, type: option.type, currentValue: option.currentValue, options: choices(option) };
}
function supportedOption(option: SessionConfigOption) {
  return option.category === "model" || option.category === "thought_level" || option.category === "model_config" || option.id === "model";
}
const selectionKey = (input: SendTurnInput) => JSON.stringify([input.model ?? "agent-default", input.approvalMode ?? "ask"]);

function toolOutput(call: ToolCallUpdate): string | undefined {
  const text = call.content?.flatMap((item) => {
    if (item.type === "content" && item.content.type === "text") return [item.content.text];
    if (item.type === "diff") return [`${item.path}\n${item.newText}`];
    return [];
  }).join("\n");
  return text ? redactSecretsInText(text).slice(0, 32_000) : undefined;
}

/** ACP vendors put the actionable cause in `error.data` while keeping the
 * JSON-RPC message generic ("Internal error"). Surface only known text fields,
 * never a response body or config dump, and redact before bounding what the
 * person reads in the failed-turn row (shared/failed-turn.ts). */
function acpRequestError(value: unknown, method: string): { cause: string; sessionFailure: boolean } {
  const error = value as { message?: unknown; code?: unknown; data?: any } | null | undefined;
  const message = typeof error?.message === "string" && error.message ? error.message : "ACP request failed";
  const data = error?.data;
  const detail = typeof data === "string" ? data
    : typeof data?.details === "string" ? data.details
      : typeof data?.message === "string" ? data.message
        : typeof data?.error?.message === "string" ? data.error.message
          : "";
  const context = [method,
    typeof data?.service === "string" ? `service: ${data.service}` : "",
    typeof data?.errorName === "string" ? data.errorName : "",
  ].filter(Boolean).join(", ");
  return {
    cause: redactSecretsInText(`${detail && detail !== message ? `${message}: ${detail}` : message} (${context})`).slice(0, 1_500),
    // -32603 is JSON-RPC's internal error: evidence the process itself is
    // unwell. Invalid params, unsupported methods and auth refusals are
    // configuration issues, so their session is preserved instead.
    sessionFailure: error?.code === -32603,
  };
}

export class AcpRuntime implements ProviderAdapter {
  readonly provider: string;
  readonly capabilities = {
    sessionModelSwitch: "in-session" as const,
    images: true,
    nativeImageInput: true,
    strictResume: true,
    // Keep tools, project context and native compaction owned by Codex.
  };
  private readonly sessions = new Map<string, LiveSession>();
  private readonly listeners = new Set<RuntimeEventListener>();
  private readonly starting = new Set<string>();
  private readonly stoppedDuringSetup = new Set<string>();
  private readonly discoveries = new Map<string, { key: string; promise: Promise<NativeSettings> }>();
  private disposed = false;
  readonly instanceId: string;
  readonly models: ModelCatalog;
  private readonly config: Config;
  private readonly environment: Record<string, string>;
  private readonly flavor: AcpProvider;
  /** Signed-in state is probed over the protocol, not read from credentials.
   * Cached for a few minutes; invalidated after a sign-in. */
  private authCache: { at: number; status: AcpAuthStatus } | null = null;
  private authProbe: Promise<AcpAuthStatus> | null = null;
  private static readonly AUTH_TTL_MS = 5 * 60_000;
  /** Signed out is re-probed soon, so a login that finishes elsewhere shows up
   * quickly; signed in is the steady state and caches longer. */
  private static readonly AUTH_TTL_SIGNED_OUT_MS = 5_000;

  constructor(
    instanceId: string,
    config: Config,
    environment: Record<string, string>,
    models: ModelCatalog,
    flavor: AcpProvider,
  ) {
    this.instanceId = instanceId;
    this.config = config;
    this.environment = environment;
    this.models = models;
    this.flavor = flavor;
    this.provider = flavor.kind;
  }

  onEvent(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(session: LiveSession, event: EventPayload): void {
    const value = {
      eventId: newEventId(), provider: this.provider, providerInstanceId: this.instanceId,
      threadId: session.threadId, createdAt: new Date().toISOString(),
      turnId: session.turn?.id, ...event,
    } as RuntimeEvent;
    for (const listener of this.listeners) listener(value);
  }

  private flushText(session: LiveSession): void {
    const turn = session.turn;
    if (!turn?.text) return;
    this.emit(session, { type: "item.completed", itemType: "assistant_text", itemId: `${turn.id}-text-${turn.item++}`, text: turn.text });
    turn.text = "";
  }

  private update(session: LiveSession, notification: SessionNotification): void {
    // session/load can replay old history: never append it to our transcript again.
    if (session.loading || session.closed || notification.sessionId !== session.id) return;
    const update = notification.update;
    if (update.sessionUpdate === "config_option_update") {
      if (session.state) session.state.configOptions = update.configOptions;
      const mode = update.configOptions.find((option) => option.category === "mode" || option.id === "mode");
      if (mode?.type === "select" && session.state?.modes) { session.state.modes.currentModeId = mode.currentValue; session.modeEpoch++; }
      this.catalog(session);
      return;
    }
    if (update.sessionUpdate === "current_mode_update") {
      if (session.state?.modes) session.state.modes.currentModeId = update.currentModeId;
      session.modeEpoch++;
      return;
    }
    if (!session.turn || session.turn.finished) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          session.turn.text += update.content.text;
          this.emit(session, { type: "content.delta", streamKind: "assistant_text", delta: update.content.text,
            itemId: `${session.turn.id}-text-${session.turn.item}`, offset: session.turn.text.length - update.content.text.length });
        }
        break;
      case "agent_thought_chunk":
        if (update.content.type === "text") this.emit(session, { type: "content.delta", streamKind: "reasoning_text", delta: update.content.text });
        break;
      case "tool_call":
      case "tool_call_update": {
        this.flushText(session);
        const itemId = update.toolCallId;
        if (!session.tools.has(itemId)) {
          session.tools.add(itemId);
          this.emit(session, { type: "item.started", itemType: "tool", itemId,
            title: update.title ?? update.kind ?? "Tool", input: redactSecretsInText(JSON.stringify(update.rawInput ?? {})).slice(0, 4000) });
        }
        if (update.status === "completed" || update.status === "failed") {
          this.emit(session, { type: "item.completed", itemType: "tool", itemId,
            ok: update.status === "completed", output: toolOutput(update) });
        } else {
          this.emit(session, { type: "item.updated", itemType: "tool", itemId });
        }
        break;
      }
      default:
        break;
    }
  }

  private permission(session: LiveSession, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const turn = session.turn;
    if (session.closed || session.loading || !turn || turn.finished || turn.cancelled || request.sessionId !== session.id) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    const requestId = newId();
    // Register before emitting: a listener may answer synchronously.
    const result = new Promise<RequestPermissionResponse>((resolve) => {
      session.permissions.set(requestId, { turnId: turn.id, options: request.options, resolve });
    });
    // The tool identity the app grants and logs, not the ACP category: a shell
    // command folds to `shell` exactly as the retired native drivers folded it
    // (an always-allow key reads "shell:echo hi"), and anything else keeps the
    // tool's own programmatic name where the agent supplied one. `kind` is a UI
    // hint (execute/read/edit), never a tool the person could name.
    const rawInput = request.toolCall.rawInput as { command?: unknown } | null | undefined;
    const command = typeof rawInput?.command === "string" ? rawInput.command : undefined;
    this.emit(session, { type: "request.opened", requestId, requestType: "permission",
      tool: command ? SHELL_TOOL : request.toolCall.name ?? request.toolCall.kind ?? "tool",
      summary: command ?? request.toolCall.title ?? "Agent requests permission",
      choices: request.options.map((option) => option.name),
      allowSession: request.options.some((option) => option.kind === "allow_always"),
    });
    return result;
  }

  private elicitation(session: LiveSession, request: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const turn = session.turn;
    // A form the person cannot answer resolves the agent's own ask as
    // cancelled, exactly as a permission nobody can take does.
    const scope = request as { sessionId?: unknown; toolCallId?: unknown };
    if (session.closed || session.loading || !turn || turn.finished || turn.cancelled || scope.sessionId !== session.id) {
      return Promise.resolve({ action: "cancel" });
    }
    const ask = parseElicitationAsk(request);
    if (!ask) return Promise.resolve({ action: "cancel" });
    const requestId = newId();
    // Register before emitting: a listener may answer synchronously.
    const result = new Promise<CreateElicitationResponse>((resolve) => {
      session.elicitations.set(requestId, { turnId: turn.id, ask, resolve });
    });
    // A question, never a permission: no approval mode may answer it for the
    // person, and the card carries the model's own questions and options. The
    // tool is left as the honest constant — ACP's elicitation names no tool,
    // it only says whether a tool call is waiting on the answer.
    this.emit(session, { type: "request.opened", requestId, requestType: "question",
      tool: scope.toolCallId === undefined ? "question" : ASK_USER_QUESTION_TOOL,
      summary: askQuestionSummary(ask.questions),
      choices: questionChoices(ask.questions),
      questions: ask.questions,
    });
    return result;
  }

  private catalog(session: LiveSession): void {
    const option = session.state?.configOptions?.find((entry) => entry.category === "model" || entry.id === "model");
    if (option?.type !== "select") return;
    this.models.options = [{ id: "agent-default", label: `${this.flavor.name} default` }, ...choices(option).map((entry) => ({ id: entry.value, label: entry.name }))];
  }

  private finish(session: LiveSession, ok: boolean, stopReason: string, error?: string, usage?: { input: number; output: number; cachedInput?: number }): void {
    const turn = session.turn;
    if (!turn || turn.finished) return;
    this.flushText(session);
    turn.finished = true;
    if (turn.cancelled) { ok = false; stopReason = "cancelled"; }
    this.cancelAsks(session);
    for (const mount of session.mounts) mount.deactivate();
    if (turn.receipt) {
      turn.receipt.connectedToolCalls = session.mounts.flatMap((mount) => mount.calls());
      turn.receipt.status = turn.cancelled ? "cancelled" : ok ? "completed" : "failed";
      if (error) turn.receipt.error = error;
      try { saveInputReceipt(turn.receipt); }
      catch (cause) {
        this.emit(session, { type: "runtime.notice", message: `The provider finished, but the input receipt status could not be updated: ${(cause as Error).message}` });
      }
    }
    if (error && !turn.cancelled) this.emit(session, { type: "runtime.error", message: error, terminal: true });
    this.emit(session, { type: "turn.completed", ok, stopReason, ...(usage ? { usage } : {}) });
    turn.resolveDone();
    if (!session.closed) session.idleTimer = setTimeout(() => { void this.close(session); }, 5 * 60_000).unref();
  }

  private cancelAsks(session: LiveSession): void {
    for (const [requestId, pending] of session.permissions) {
      session.permissions.delete(requestId);
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.emit(session, { type: "request.resolved", requestId, behavior: "deny", source: "system" });
    }
    for (const [requestId, pending] of session.elicitations) {
      session.elicitations.delete(requestId);
      pending.resolve({ action: "cancel" });
      this.emit(session, { type: "request.resolved", requestId, behavior: "deny", source: "system" });
    }
  }

  private async close(session: LiveSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    for (const mount of session.mounts) mount.release();
    clearTimeout(session.idleTimer);
    this.cancelAsks(session);
    session.connection.close();
    session.child.kill("SIGTERM");
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((resolve) => {
        if (session.child.exitCode !== null || session.child.signalCode !== null) resolve();
        else session.child.once("exit", () => resolve());
      }),
      new Promise<void>((resolve) => { killTimer = setTimeout(() => { session.child.kill("SIGKILL"); resolve(); }, 1000).unref(); }),
    ]);
    clearTimeout(killTimer);
    if (this.sessions.get(session.threadId) === session) this.sessions.delete(session.threadId);
  }

  private async setup<T>(session: LiveSession, request: Promise<T>): Promise<T> {
    const timer = setTimeout(() => {
      session.connection.close(new Error("ACP setup timed out"));
    }, this.config.setupTimeoutMs);
    try { return await request; }
    finally { clearTimeout(timer); }
  }

  private spawnAdapter(cwd: string): ChildProcessWithoutNullStreams {
    const env = { ...process.env, ...this.environment };
    env.ELECTRON_RUN_AS_NODE = "1";
    // Existing CLI auth is inherited. Ambient API keys must not silently change billing.
    if (!Object.hasOwn(this.environment, "OPENAI_API_KEY")) delete env.OPENAI_API_KEY;
    if (!Object.hasOwn(this.environment, "CODEX_API_KEY")) delete env.CODEX_API_KEY;
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      if (!Object.hasOwn(this.environment, key)) delete env[key];
    }
    delete env.CLAUDECODE; // SDK child is not a nested interactive CLI session.
    delete env.COMPOSIO_API_KEY; // App credentials stay in the server-side relay.
    delete env.COLONIE_COMPOSIO_API_KEY;
    const command = this.config.cli ?? process.execPath;
    const args = this.config.cli ? this.config.args ?? [] : [process.env[this.flavor.entryEnvironment] ?? require.resolve(this.flavor.packageEntry)];
    return spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  }

  /** A short-lived adapter connection for auth, outside the session map. */
  private async withAdapter<T>(
    action: (connection: ClientConnection, init: InitializeResponse, auth: { latest: AuthStatusPush | null }) => Promise<T>,
    timeoutMs = this.config.setupTimeoutMs,
  ): Promise<T> {
    const cwd = tmpdir();
    const child = this.spawnAdapter(cwd);
    const auth: { latest: AuthStatusPush | null } = { latest: null };
    const connection = client({ name: "Colonie" })
      .onNotification(AUTH_STATUS_UPDATE_METHOD, (params: unknown) => params, (ctx) => {
        const value = (ctx?.params as { authStatus?: AuthStatusPush } | undefined)?.authStatus;
        if (value && typeof value.kind === "string") auth.latest = value;
      })
      .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
    const timer = setTimeout(() => connection.close(new Error("ACP auth request timed out")), timeoutMs);
    try {
      const init = await connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "Colonie", version: "0.1.0" }, clientCapabilities: CLIENT_CAPABILITIES });
      return await action(connection, init, auth);
    } finally {
      clearTimeout(timer);
      connection.close();
      child.kill("SIGTERM");
    }
  }

  /** Prefer the adapter's account push; fall back to session/new
   * `auth_required` for agents that do not announce auth. An agent that
   * advertises the push but never sends it is reported as unknown, never
   * optimistically signed in. */
  private async resolvedAuth(connection: ClientConnection, init: InitializeResponse, auth: { latest: AuthStatusPush | null }): Promise<AcpAuthStatus> {
    const offered = AcpRuntime.authMethods(init);
    const announces = Boolean((init.agentCapabilities as { _meta?: { authStatus?: unknown } } | undefined)?._meta?.authStatus);
    const deadline = Date.now() + (announces ? 5000 : 1500);
    while (auth.latest === null && Date.now() < deadline) await delay(50);
    if (auth.latest) return { authenticated: auth.latest.kind !== "none", methods: offered };
    if (announces) throw new Error("The engine did not report its sign-in state.");
    return this.probeConnection(connection, init);
  }

  /** Fallback for agents without the account push: initialize, then try to
   * open a session. `auth_required` — or any failure while the engine
   * advertises sign-in methods — means not signed in. */
  private probeConnection(connection: ClientConnection, init: InitializeResponse): Promise<AcpAuthStatus> {
    const offered = AcpRuntime.authMethods(init);
    return connection.agent.request(methods.agent.session.new, { cwd: tmpdir(), mcpServers: [] }).then(
      () => ({ authenticated: true, methods: offered }),
      (error: unknown) => {
        if (AcpRuntime.isAuthError(error) || offered.length) return { authenticated: false, methods: offered };
        throw error;
      },
    );
  }

  private static authMethods(init: InitializeResponse): Array<{ id: string; name: string }> {
    return (init.authMethods ?? []).map((method) => ({ id: method.id, name: method.name }));
  }

  private static isAuthError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /auth(?:entication)?\s+required|not\s+(?:signed|logged)\s+in|sign[\s-]?in|log[\s-]?in/i.test(message);
  }

  /** The terminal login command, with the isolated config dir so the login
   * lands inside Colonie. */
  signInCommand(): string {
    const dir = this.environment.CLAUDE_CONFIG_DIR ?? this.environment.CODEX_HOME;
    const key = this.environment.CLAUDE_CONFIG_DIR ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    return dir ? `${key}="${dir}" ${this.flavor.loginCommand}` : this.flavor.loginCommand;
  }

  /** Probe over the protocol, not from stored credentials. Cached briefly. */
  async authStatus(force = false): Promise<AcpAuthStatus> {
    const now = Date.now();
    const ttl = this.authCache?.status.authenticated ? AcpRuntime.AUTH_TTL_MS : AcpRuntime.AUTH_TTL_SIGNED_OUT_MS;
    if (!force && this.authCache && now - this.authCache.at < ttl) return this.authCache.status;
    if (this.authProbe) return this.authProbe;
    const probe = this.withAdapter((connection, init, auth) => this.resolvedAuth(connection, init, auth))
      .then((status) => { this.authCache = { at: Date.now(), status }; return status; })
      .finally(() => { this.authProbe = null; });
    this.authProbe = probe;
    return probe;
  }

  /** Create a throwaway session to learn the engine's model list, so the picker
   * is complete before the first message. Best effort. */
  async discoverModels(): Promise<void> {
    const cwd = this.environment.CLAUDE_CONFIG_DIR ?? this.environment.CODEX_HOME;
    const input = { threadId: "__models__", botId: "__models__", text: "", cwd, model: "agent-default" } as SendTurnInput;
    try {
      await this.prepareSettings(input);
      this.authCache = null;
    } catch {
      // The catalog keeps whatever it last knew.
    }
  }

  /** Each independent mount (connected tools, Colonie workspace tools) is a
   * separate lease; the runtime activates/releases each, so neither wrapper can
   * release a lease the other still holds. */
  private mountsOf(input: SendTurnInput): AcpToolMount[] {
    return [input.acpTools, input.acpExtraTools].filter((mount): mount is AcpToolMount => Boolean(mount));
  }
  private mountRevision(mounts: readonly AcpToolMount[]): string {
    return mounts.map((mount) => mount.revision).join("+");
  }
  private combinedReceipt(mounts: readonly AcpToolMount[]): ConnectedToolsReceipt | undefined {
    if (!mounts.length) return undefined;
    return { policyHash: this.mountRevision(mounts), composioToolkits: mounts.flatMap((mount) => mount.receipt.composioToolkits),
      servers: mounts.flatMap((mount) => mount.receipt.servers) };
  }

  private async open(input: SendTurnInput): Promise<LiveSession> {
    const cwd = resolve(input.cwd ?? process.cwd());
    let existing = this.sessions.get(input.threadId);
    const toolsChanged = existing && this.mountRevision(existing.mounts) !== this.mountRevision(this.mountsOf(input));
    if (existing && (existing.closed || existing.cwd !== cwd || input.sessionReset || toolsChanged)) {
      if (toolsChanged && !input.sessionReset && existing.cwd === cwd) input = { ...input, resumeCursor: input.resumeCursor ?? existing.id };
      // A mount reused by the next session (same revision) must not be released
      // by this teardown: release only the mounts the next turn does not carry,
      // so two independent leases never release each other.
      const keep = new Set(this.mountsOf(input).map((mount) => mount.revision));
      existing.mounts = existing.mounts.filter((mount) => !keep.has(mount.revision));
      await this.close(existing);
      existing = undefined;
    }
    if (existing) { clearTimeout(existing.idleTimer); return existing; }
    if (this.disposed || this.stoppedDuringSetup.has(input.threadId)) throw new Error("Turn cancelled during setup");
    const child = this.spawnAdapter(cwd);
    const session = { threadId: input.threadId, cwd, child, mounts: this.mountsOf(input),
      permissions: new Map(), elicitations: new Map(), tools: new Set(), loading: true, closed: false, stderr: "", modeEpoch: 0,
    } as LiveSession;
    // Bounded failure diagnostics, never protocol or prompt context.
    child.stderr.on("data", (chunk: Buffer) => { session.stderr = (session.stderr + chunk.toString()).slice(-4000); });
    session.connection = client({ name: "Colonie" })
      .onNotification(methods.client.session.update, ({ params }) => this.update(session, params))
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.permission(session, params))
      .onRequest(methods.client.elicitation.create, ({ params }) => this.elicitation(session, params))
      .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
    this.sessions.set(input.threadId, session);
    const exited = (message: string) => {
      if (!session.closed) {
        session.connection.close(new Error(message));
        this.finish(session, false, "error", message);
        this.emit(session, { type: "session.exited", reason: message });
        session.closed = true;
        for (const mount of session.mounts) mount.release();
        if (this.sessions.get(input.threadId) === session) this.sessions.delete(input.threadId);
      }
    };
    child.once("error", (error) => exited(`ACP adapter could not start: ${error.message}`));
    child.once("exit", (code, signal) => exited(`ACP adapter exited (${signal ?? code})`));
    void session.connection.closed.then(async () => {
      if (!session.closed) {
        this.finish(session, false, "error", "The ACP transport closed");
        await this.close(session);
      }
    });
    try {
      session.initialization = await this.setup(session, session.connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "Colonie", version: "0.1.0" },
        // Codex performs filesystem/shell work itself; do not advertise unimplemented host tools.
        clientCapabilities: CLIENT_CAPABILITIES,
      }));
      const mcpServers = session.mounts.flatMap((mount) => mount.servers);
      for (const server of mcpServers) {
        if ("type" in server && (server.type === "http" || server.type === "sse") && !session.initialization.agentCapabilities?.mcpCapabilities?.[server.type]) {
          throw new Error(`This ${this.flavor.name} connection does not support ${server.type.toUpperCase()} MCP. Choose a supported connection in app settings.`);
        }
      }
      const cursor = !input.sessionReset && typeof input.resumeCursor === "string" ? input.resumeCursor : undefined;
      if (cursor) {
        if (!session.initialization.agentCapabilities?.loadSession) throw new Error("Agent cannot load this saved session. Start a new conversation explicitly.");
        session.id = cursor;
        try {
          session.state = await this.setup(session, session.connection.agent.request(methods.agent.session.load,
            { sessionId: cursor, cwd, mcpServers }));
        } catch (error) {
          // The engine does not have this session any more — a config home it
          // no longer reads, a session it has pruned or expired. The rejection
          // IS the resume request, so nothing has reached the model and the turn
          // is still before the accept boundary (server/resume-recovery.ts): it
          // may run once in one fresh session, carrying the transcript the
          // harness rebuilt, instead of dying on an opaque setup error that
          // tells the person to sign in. If that fresh session cannot start
          // either, both facts are reported rather than only the second.
          session.id = undefined;
          session.rebuilt = true;
          try {
            const state = await this.setup(session, session.connection.agent.request(methods.agent.session.new,
              { cwd, mcpServers }));
            session.state = state;
            session.id = state.sessionId;
          } catch (fresh) {
            throw new Error(`This conversation's engine session is gone: ${(error as Error).message}. A new one could not be started either: ${(fresh as Error).message}`, { cause: fresh });
          }
        }
      } else {
        const state = await this.setup(session, session.connection.agent.request(methods.agent.session.new,
          { cwd, mcpServers }));
        session.state = state;
        session.id = state.sessionId;
      }
      session.loading = false;
      const defaultModel = session.state.configOptions?.find((option) => option.category === "model" || option.id === "model");
      if (defaultModel?.type === "select") session.defaultModel = defaultModel.currentValue;
      this.catalog(session);
      if (this.disposed || this.stoppedDuringSetup.has(input.threadId)) throw new Error("Turn cancelled during setup");
      return session;
    } catch (error) {
      await this.close(session);
      const diagnostic = session.stderr.trim() ? ` ${redactSecretsInText(session.stderr.trim())}` : "";
      throw new Error(`${this.flavor.name} ACP setup failed: ${(error as Error).message}.${diagnostic} Check '${this.flavor.loginCommand}' or start a new conversation.`, { cause: error });
    }
  }

  async sendTurn(input: SendTurnInput) {
    if (this.disposed) throw new Error("ACP runner is closed");
    if (input.acpContext && input.acpContext.botId !== input.botId) throw new Error("Context snapshot belongs to another bot");
    if (input.acpMemory?.entries.some((entry) => entry.scope === "bot" && entry.botId !== input.botId)) throw new Error("Memory belongs to another bot");
    if (this.starting.has(input.threadId) || this.sessions.get(input.threadId)?.turn && !this.sessions.get(input.threadId)!.turn!.finished) {
      throw new Error("This conversation already has an active turn");
    }
    this.starting.add(input.threadId);
    try {
      const session = await this.open(input);
      // A session this turn had to build because the engine no longer had the
      // saved one holds none of the conversation, so the first thing it sees is
      // the transcript the harness rebuilt, not just the new message
      // (server/resume-recovery.ts). Cleared here: the next turn resumes this
      // session like any other.
      const rebuilt = session.rebuilt === true;
      session.rebuilt = false;
      const turnText = rebuilt
        ? recoveryPromptFor({ recoveryText: input.recoveryText, currentText: input.text, failure: "before-accept" }).text
        : input.text;
      const preferences = nativePreferences(input.threadId, this.instanceId);
      await this.selectConfiguredModel(session, input.model);
      session.applicationSelection = selectionKey(input);
      await this.applyStoredOptions(session, preferences);
      const requestedMode = preferences.mode && preferences.approvalBaseline === (input.approvalMode ?? "ask")
        ? preferences.mode : this.modeForApproval(session, input.approvalMode);
      await this.setMode(session, requestedMode);
      const mode = session.state!.modes!.currentModeId;
      if (this.stoppedDuringSetup.has(input.threadId)) throw new Error("Turn cancelled during setup");
      let resolveDone!: () => void;
      const turn: ActiveTurn = { id: newId(), text: "", item: 0, cancelled: false, finished: false,
        done: new Promise<void>((resolve) => { resolveDone = resolve; }), resolveDone: () => resolveDone(),
      };
      session.turn = turn;
      session.tools.clear();
      const configuredModel = session.state?.configOptions?.find((option) => option.category === "model");
      const effectiveModel = configuredModel?.type === "select" ? configuredModel.currentValue : input.model ?? "agent-default";
      if (input.acpContext && !contextPin(input.threadId) && inputReceipts(input.threadId).some((receipt) => receipt.context?.snapshotHash)) {
        throw new Error("This conversation's context snapshot is missing. Restore it before continuing.");
      }
      const pin = input.acpContext ? pinContext(input.threadId, input.acpContext) : null;
      const combinedReceipt = this.combinedReceipt(session.mounts);
      const composed = composeContext(pin, turnText, this.instanceId, this.config.instructions, { provider: this.provider, model: effectiveModel, mode, tools: combinedReceipt, memory: input.acpMemory, skills: input.acpSkills, chief: input.acpChief, assignment: input.acpAssignment });
      const prompt = composed.prompt;
      for (const image of input.images ?? []) {
        prompt.push({ type: "image", mimeType: image.mime, data: readFileSync(image.path).toString("base64") });
      }
      turn.receipt = { id: newId(), at: new Date().toISOString(), threadId: input.threadId, turnId: turn.id,
        instanceId: this.instanceId, sessionId: session.id!, cwd: session.cwd, model: effectiveModel,
        mode, instructions: composed.instructions, prompt, context: composed.manifest, status: "dispatching",
        connectedTools: combinedReceipt,
        nativeSettings: Object.fromEntries((session.state?.configOptions ?? []).filter(supportedOption).map((option) => [option.id, option.currentValue])) };
      // Persist exact authored bytes BEFORE sending a request to the agent.
      saveInputReceipt(turn.receipt);
      for (const mount of session.mounts) mount.activate();
      this.emit(session, { type: "session.started", sessionId: session.id!, model: effectiveModel, ...(rebuilt ? { rebuilt: true } : {}) });
      if (rebuilt) this.emit(session, { type: "runtime.notice", message: "The engine no longer had this conversation's session, so it was rebuilt from this thread's history." });
      this.emit(session, { type: "turn.started" });
      void session.connection.agent.request<PromptResponse, PromptRequest>(methods.agent.session.prompt, { sessionId: session.id!, prompt })
        .then((result) => this.finish(session, result.stopReason === "end_turn", result.stopReason, undefined, turnUsage(result)))
        .catch((error: Error) => {
          const failure = acpRequestError(error, "session/prompt");
          this.finish(session, false, turn.cancelled ? "cancelled" : "error", failure.cause);
          // An internal RPC failure can leave a live child poisoned just like a
          // silent prompt: evict it before the next turn, so the next explicit
          // message resumes this recorded session on a fresh process instead of
          // failing against the same broken one. The failed prompt is never
          // replayed — it may already have executed tools. An adapter that
          // cannot load a session keeps its child: retiring it there would end
          // the conversation instead of continuing it, and a transient blip
          // may well clear on its own.
          if (failure.sessionFailure && !turn.cancelled && session.initialization?.agentCapabilities?.loadSession) void this.close(session);
        });
      return { turnId: turn.id };
    } catch (error) {
      const session = this.sessions.get(input.threadId);
      if (session) {
        if (session.turn && !session.turn.finished) {
          session.turn.finished = true;
          session.turn.resolveDone();
        }
        await this.close(session);
      }
      throw error;
    } finally {
      this.starting.delete(input.threadId);
      this.stoppedDuringSetup.delete(input.threadId);
    }
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (this.starting.has(threadId)) {
      this.stoppedDuringSetup.add(threadId);
      if (session) await this.close(session);
      return;
    }
    const turn = session?.turn;
    if (!session || !turn || turn.finished || turnId && turnId !== turn.id) return;
    turn.cancelled = true;
    for (const mount of session.mounts) mount.deactivate();
    this.cancelAsks(session);
    await session.connection.agent.notify(methods.agent.session.cancel, { sessionId: session.id! }).catch(() => {});
    await Promise.race([turn.done, new Promise<void>((resolve) => setTimeout(resolve, 1500).unref())]);
    if (!turn.finished) {
      this.finish(session, false, "cancelled");
      await this.close(session);
    }
  }

  async respondToRequest(threadId: string, requestId: string, decision: { behavior: "allow" | "deny" | "answer"; message?: string; always?: boolean }) {
    const session = this.sessions.get(threadId);
    if (!session || session.turn?.finished) return "unavailable" as const;
    // A question: the person's own words go back under the form's own keys so
    // the adapter can fold them into the tool (or MCP server) that asked. No
    // mode ever answers one, and an answer that files nothing is a decline.
    const question = session.elicitations.get(requestId);
    if (question && session.turn?.id === question.turnId) {
      session.elicitations.delete(requestId);
      const content = decision.behavior === "answer" && decision.message
        ? elicitationAnswerContent(question.ask, decision.message)
        : null;
      question.resolve(content ? { action: "accept", content } : { action: "decline" });
      this.emit(session, { type: "request.resolved", requestId, behavior: content ? "answer" : "deny", source: "user" });
      return content ? "answered" as const : "rejected" as const;
    }
    const pending = session.permissions.get(requestId);
    if (!pending || session.turn?.id !== pending.turnId) return "unavailable" as const;
    const kind = decision.behavior === "allow" ? decision.always ? "allow_always" : "allow_once" : "reject_once";
    const option = pending.options.find((entry) => entry.kind === kind)
      ?? (decision.behavior === "deny" ? pending.options.find((entry) => entry.kind === "reject_always") : undefined);
    // Never turn a one-shot allow into a broader grant just because only that option exists.
    session.permissions.delete(requestId);
    pending.resolve(option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } });
    const behavior = option && decision.behavior === "allow" ? "allow" : "deny";
    this.emit(session, { type: "request.resolved", requestId, behavior, source: "user" });
    return behavior === "allow" ? "allowed-once" as const : "rejected" as const;
  }

  hasSession(threadId: string): boolean { return Boolean(this.sessions.get(threadId)?.id); }
  isConfiguring(threadId: string): boolean { return this.starting.has(threadId); }

  /** The adapter's own session mode for a Colonie approval level. Every level
   * is a provider mode passed through, never a policy Colonie invents: `auto`
   * is the adapter's reviewer where it has one, `edits` its accept-edits mode.
   * Ask and Full keep their exact previous behaviour, including the 409 an
   * adapter that does not offer Full deserves. Auto and Accept edits are new
   * levels for ACP, so an adapter that does not advertise one keeps Ask instead
   * of failing the turn — a level never falls upward into more access. */
  private modeForApproval(session: LiveSession, approvalMode: SendTurnInput["approvalMode"]): string {
    if (approvalMode === "full") return this.flavor.fullMode;
    const wanted = approvalMode === "auto" ? this.flavor.autoMode : approvalMode === "edits" ? this.flavor.editsMode : undefined;
    if (!wanted) return this.flavor.askMode;
    return (session.state?.modes?.availableModes ?? []).some((entry) => entry.id === wanted) ? wanted : this.flavor.askMode;
  }

  private async setMode(session: LiveSession, mode: string) {
    if (!session.state?.modes?.availableModes.some((entry) => entry.id === mode)) throw Object.assign(new Error(`Agent does not support mode '${mode}'`), { status: 409 });
    const before = session.modeEpoch;
    await this.setup(session, session.connection.agent.request(methods.agent.session.setMode, { sessionId: session.id!, modeId: mode }));
    // Keep native fallback notifications authoritative when the agent clamps a mode.
    if (before === session.modeEpoch) session.state.modes.currentModeId = mode;
  }

  private async setOption(session: LiveSession, id: string, value: string | boolean) {
    const option = session.state?.configOptions?.find((entry) => entry.id === id && supportedOption(entry));
    if (!option || (option.type === "boolean" ? typeof value !== "boolean" : typeof value !== "string" || !choices(option).some((entry) => entry.value === value))) {
      throw Object.assign(new Error(`Native option '${id}' no longer offers this value. Refresh the agent settings.`), { status: 409 });
    }
    const request: SetSessionConfigOptionRequest = typeof value === "boolean"
      ? { sessionId: session.id!, configId: id, value, type: "boolean" }
      : { sessionId: session.id!, configId: id, value };
    const response = await this.setup(session, session.connection.agent.request<SetSessionConfigOptionResponse, SetSessionConfigOptionRequest>(methods.agent.session.setConfigOption, request));
    session.state!.configOptions = response.configOptions;
    this.catalog(session);
  }

  private async applyStoredOptions(session: LiveSession, preferences: NativePreferences) {
    for (const [id, value] of Object.entries(preferences.values)) await this.setOption(session, id, value);
  }

  private async selectConfiguredModel(session: LiveSession, requested?: string) {
    const model = requested && requested !== "agent-default" ? requested : session.defaultModel;
    if (!model) return;
    const option = session.state?.configOptions?.find((entry) => entry.category === "model" || entry.id === "model");
    if (!option || !choices(option).some((entry) => entry.value === model)) throw Object.assign(new Error(`Model '${model}' is not offered by this ${this.flavor.name} session`), { status: 409 });
    if (option.currentValue !== model) await this.setOption(session, option.id, model);
  }

  private settingsSnapshot(session: LiveSession, warnings: string[] = []): NativeSettings {
    const options = (session.state?.configOptions ?? []).filter(supportedOption).map(nativeOption);
    const modes = session.state?.modes;
    if (!session.id || !modes) throw new Error("The native session is not ready");
    const publicModes = { currentModeId: modes.currentModeId, availableModes: modes.availableModes.map(({ id, name, description }) => ({ id, name, description: description ?? undefined })) };
    const preferences = nativePreferences(session.threadId, this.instanceId);
    const stale = Object.entries(preferences.values).flatMap(([id, value]) => {
      const option = options.find((entry) => entry.id === id);
      const valid = option && (option.type === "boolean" ? typeof value === "boolean" : typeof value === "string" && option.options.some((entry) => entry.value === value));
      return valid ? [] : [`Override '${id}' (${String(value)}) is no longer supported. Choose or apply an available native value before sending a message.`];
    });
    const revision = createHash("sha256").update(JSON.stringify([session.id, publicModes, options, session.applicationSelection, preferences, this.mountRevision(session.mounts)])).digest("hex");
    return { sessionId: session.id, instanceId: this.instanceId, threadId: session.threadId, cwd: session.cwd, revision, modes: publicModes, options, warnings: [...new Set([...warnings, ...stale])] };
  }

  prepareSettings(input: SendTurnInput): Promise<NativeSettings> {
    const key = JSON.stringify([input.cwd, input.model, input.resumeCursor, input.approvalMode, this.mountRevision(this.mountsOf(input))]);
    const pending = this.discoveries.get(input.threadId);
    if (pending?.key === key) return pending.promise;
    if (pending) return Promise.reject(Object.assign(new Error("Another native-settings discovery is active for this thread"), { status: 409 }));
    const promise = this.discoverSettings(input).finally(() => {
      if (this.discoveries.get(input.threadId)?.promise === promise) this.discoveries.delete(input.threadId);
    });
    this.discoveries.set(input.threadId, { key, promise });
    return promise;
  }

  private async discoverSettings(input: SendTurnInput): Promise<NativeSettings> {
    if (this.disposed || this.starting.has(input.threadId) || this.sessions.get(input.threadId)?.turn && !this.sessions.get(input.threadId)!.turn!.finished) throw Object.assign(new Error("The native conversation is busy"), { status: 409 });
    this.starting.add(input.threadId);
    try {
      const session = await this.open(input);
      // Looking at native settings may also have built a session the engine no
      // longer had; it belongs to no turn, so nothing here rewrites the prompt.
      session.rebuilt = false;
      const preferences = nativePreferences(input.threadId, this.instanceId);
      const warnings: string[] = [];
      session.applicationSelection = selectionKey(input);
      try { await this.selectConfiguredModel(session, input.model); } catch (error) { warnings.push((error as Error).message); }
      try { await this.applyStoredOptions(session, preferences); } catch (error) { warnings.push((error as Error).message); }
      const mode = preferences.mode && preferences.approvalBaseline === (input.approvalMode ?? "ask") ? preferences.mode
        : this.modeForApproval(session, input.approvalMode);
      try { await this.setMode(session, mode); } catch (error) { warnings.push((error as Error).message); }
      session.idleTimer = setTimeout(() => { void this.close(session); }, 5 * 60_000).unref();
      return this.settingsSnapshot(session, warnings);
    } finally { this.starting.delete(input.threadId); }
  }

  async changeSettings(input: SendTurnInput, change: NativeSettingChange): Promise<NativeSettings> {
    const session = this.sessions.get(input.threadId);
    if (this.starting.has(input.threadId) || !session || session.closed || session.turn && !session.turn.finished) throw Object.assign(new Error("Refresh the native settings after the conversation is idle"), { status: 409 });
    if (this.mountRevision(session.mounts) !== this.mountRevision(this.mountsOf(input))) throw Object.assign(new Error("Connected tools changed. Refresh agent options before editing."), { status: 409 });
    const snapshot = this.settingsSnapshot(session);
    if (session.applicationSelection !== selectionKey(input)) throw Object.assign(new Error("Application model/permission settings changed. Refresh the native panel."), { status: 409 });
    if (change.sessionId !== snapshot.sessionId || change.expectedRevision !== snapshot.revision) throw Object.assign(new Error("Native settings changed. Refresh before choosing a value."), { status: 409 });
    this.starting.add(input.threadId); clearTimeout(session.idleTimer);
    try {
      const preferences = nativePreferences(input.threadId, this.instanceId);
      if (change.kind === "mode") {
        await this.setMode(session, change.value);
        preferences.mode = session.state!.modes!.currentModeId;
        preferences.approvalBaseline = input.approvalMode ?? "ask";
      } else {
        await this.setOption(session, change.configId, change.value);
        const option = session.state!.configOptions!.find((entry) => entry.id === change.configId)!;
        if (option.category !== "model" && option.id !== "model") preferences.values = { ...preferences.values, [option.id]: option.currentValue };
        else if (typeof option.currentValue === "string") session.applicationSelection = selectionKey({ ...input, model: option.currentValue });
      }
      saveNativePreferences(input.threadId, this.instanceId, preferences);
      return this.settingsSnapshot(session);
    } finally {
      this.starting.delete(input.threadId);
      session.idleTimer = setTimeout(() => { void this.close(session); }, 5 * 60_000).unref();
    }
  }
  liveReply(threadId: string) {
    const turn = this.sessions.get(threadId)?.turn;
    return turn && !turn.finished
      ? { turnId: turn.id, itemId: `${turn.id}-text-${turn.item}`, text: turn.text }
      : null;
  }
  /** Bounded independent memory analysis. It never shares a conversation session,
   * persona, selected MCP servers, working project or events with normal chat.
   * Native tools remain provider-owned; any observed tool activity invalidates
   * the analysis, and every permission request is denied. */
  async analyzeMemory(prompt: string, options: { model?: string; signal: AbortSignal }): Promise<string> {
    if (this.disposed || options.signal.aborted) throw new Error("Memory analysis was cancelled");
    const base = join(DATA_DIR, "colonie-memory", "analysis");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const cwd = mkdtempSync(join(base, "job-"));
    const threadId = `memory-${newId()}`;
    const analysis = new AcpRuntime(this.instanceId, { ...this.config, instructions: "" },
      this.environment, structuredClone(this.models), this.flavor);
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]);
    let answer = "";
    let settle!: (value: string) => void;
    let fail!: (error: Error) => void;
    const completed = new Promise<string>((resolve, reject) => { settle = resolve; fail = reject; });
    // A provider can settle while sendTurn is still awaiting setup/dispatch.
    void completed.catch(() => {});
    const abort = () => {
      fail(new Error("Memory analysis was cancelled or timed out"));
      void analysis.stopAll();
    };
    const unsubscribe = analysis.onEvent((event) => {
      if (event.type === "request.opened") {
        if (event.requestId) void analysis.respondToRequest(threadId, event.requestId, { behavior: "deny" });
        fail(new Error("Memory analysis requested a tool; no memory was changed"));
        void analysis.stopAll();
      } else if (event.type === "item.started" && event.itemType === "tool") {
        fail(new Error("Memory analysis used a tool; no memory was changed"));
        void analysis.stopAll();
      } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
        answer += event.text ?? "";
        if (answer.length > 32_000) { fail(new Error("Memory analysis exceeded its response limit")); void analysis.stopAll(); }
      } else if (event.type === "turn.completed") {
        if (event.ok) settle(answer);
        else fail(new Error("Memory analysis did not complete"));
      } else if (event.type === "runtime.error") fail(new Error("Memory analysis provider failed"));
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      await analysis.sendTurn({ threadId, text: prompt, cwd, model: options.model, approvalMode: "ask" });
      return await completed;
    } finally {
      signal.removeEventListener("abort", abort);
      unsubscribe();
      await analysis.stopAll();
      rmSync(cwd, { recursive: true, force: true });
    }
  }
  async stopAll(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.sessions.values()].map(async (session) => {
      if (session.turn && !session.turn.finished) { session.turn.cancelled = true; this.finish(session, false, "cancelled"); }
      await this.close(session);
    }));
  }
}

export function createAcpProvider(flavor: AcpProvider): ProviderDriver<Config> { return {
  driverKind: flavor.kind,
  metadata: { displayName: `${flavor.name} · ACP`, access: "subscription", supportsMultipleInstances: true },
  install: { signInCommand: flavor.loginCommand, docsUrl: `https://github.com/agentclientprotocol/${flavor.kind === "claude-acp" ? "claude-agent-acp" : "codex-acp"}` },
  models: { default: "agent-default", options: [{ id: "agent-default", label: `${flavor.name} default` }] },
  defaultConfig: () => configSchema.parse({}),
  decodeConfig: (raw) => {
    const config = configSchema.parse(raw ?? {});
    if (config.cli && !isAbsolute(config.cli) && /\s/.test(config.cli)) throw new Error("Use an executable path and a separate args array");
    return config;
  },
  async create(input) {
    const models = structuredClone(this.models);
    const adapter = new AcpRuntime(input.instanceId, input.config, input.environment, models, flavor);
    return {
      instanceId: input.instanceId, driverKind: flavor.kind, displayName: input.displayName,
      enabled: input.enabled, models, adapter,
      // Open a throwaway session on demand so the model picker is complete
      // before the first message (the adapter only reports models in-session).
      refreshModels: async () => { await adapter.discoverModels(); },
      // Signed-in state comes from the protocol probe, never from credentials.
      snapshot: async () => {
        const base = { state: input.enabled ? "available" : "unavailable", version: `${flavor.kind} ${flavor.version}`, reason: input.enabled ? undefined : "Disabled" } as const;
        if (!input.enabled) return { ...base };
        try {
          const auth = await adapter.authStatus();
          return { ...base, authenticated: auth.authenticated };
        } catch {
          // A probe that cannot start says nothing about sign-in; do not claim one.
          return { ...base };
        }
      },
      dispose: () => adapter.stopAll(),
    };
  },
}; }
