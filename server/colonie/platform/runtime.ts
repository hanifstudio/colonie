/** Cloud chat through the maintained ACP SDK and Claude adapter.
 *
 * Cloud chat is deliberately a conversation runtime: built-in filesystem,
 * terminal, browser and subagent tools are disabled by the adapter's supported
 * `tools: []` option. Connected tools must be added later as audience-checked
 * MCP leases. Native Local workspaces keep the existing full ACP runtime.
 * Nothing here reads native credentials or inherits the host's database keys.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type SessionNotification } from "@agentclientprotocol/sdk";
import type { BotRuntime, BotTurnRequest, PlatformTurnSink } from "./contracts.ts";
import type { CloudToolBroker, CloudToolLease } from "./tools.ts";

const require = createRequire(import.meta.url);
const pathPart = (id: string) => createHash("sha256").update(id).digest("hex");

export type CloudTurnState = "working" | "completed" | "cancelled" | "failed";
export interface CloudRuntimeOptions {
  root: string;
  /** Provider-owned login directory, never a renderer-supplied path. */
  claudeConfigDir: string;
  adapterEntry?: string;
  claudeExecutable?: string;
  node?: string;
  timeoutMs?: number;
  concurrency?: number;
  maxQueued?: number;
  sink: PlatformTurnSink;
  /** Recheck the initiating person's membership and conversation audience. */
  authorize(request: BotTurnRequest): Promise<boolean>;
  botProfile?(request: BotTurnRequest): Promise<{ name: string; purpose?: string }>;
  history?(request: BotTurnRequest): Promise<BotTurnRequest["history"]>;
  state?(request: BotTurnRequest, state: CloudTurnState, message?: string): Promise<void>;
  toolBroker?: Pick<CloudToolBroker, "open">;
  /** Test seam: production always uses node child_process.spawn. */
  spawn?: typeof spawn;
}

interface RunningTurn {
  request: BotTurnRequest;
  cancelled: boolean;
  child?: ChildProcessWithoutNullStreams;
  connection?: ClientConnection;
  sessionId?: string;
  tools?: CloudToolLease;
}

export function cloudRuntimeEnvironment(configDir: string, home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home,
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    LANG: "en_US.UTF-8", NODE_ENV: "production", ELECTRON_RUN_AS_NODE: "1",
    CLAUDE_CONFIG_DIR: configDir, NO_BROWSER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

export function cloudApplicationPrompt(request: BotTurnRequest, profile: { name: string; purpose?: string }, toolNames: string[] = []): string {
  return [
    `You are ${profile.name}, an AI bot member of a Colonie workspace.`,
    profile.purpose?.trim() || "Help the people in this conversation clearly and thoughtfully.",
    `${request.trigger === "dm" ? "This is a private DM" : "This is a Group conversation"} with the current participants. Use only its provided history. Never claim you checked an external app, searched files, or performed an action when no tool result supports that claim.`,
    toolNames.length ? "Approved connected-app read tools are available for this conversation. Use them when the person asks you to check their apps. Their results stay in this conversation. Sending, editing, deleting and other app actions are unavailable." : "No connected-app tools are available for this turn. Be clear that you cannot check an external app here.",
    "Respond naturally to the latest human message. Conversation data follows as JSON; its messages belong to their senders.",
    JSON.stringify(request.history.slice(-60).map((message) => ({
      id: message.id, sender: message.senderName, kind: message.senderKind,
      body: message.body,
    }))),
  ].join("\n\n");
}

export class CloudAcpRuntime implements BotRuntime {
  private readonly queue: BotTurnRequest[] = [];
  private readonly running = new Map<string, RunningTurn>();
  private disposed = false;
  private pumping = false;

  constructor(private readonly options: CloudRuntimeOptions) {}

  onTurn(request: BotTurnRequest): void {
    if (this.disposed) return;
    if (this.queue.length >= (this.options.maxQueued ?? 32)) throw new Error("The AI service is busy. Please try again shortly.");
    this.queue.push(request);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      while (this.running.size < (this.options.concurrency ?? 2)) {
        // Serialize each conversation, while separate conversations can run.
        const index = this.queue.findIndex((item) => !this.running.has(item.conversationId));
        if (index < 0) break;
        const request = this.queue.splice(index, 1)[0]!;
        const turn: RunningTurn = { request, cancelled: false };
        this.running.set(request.conversationId, turn);
        void this.run(turn).finally(() => {
          this.running.delete(request.conversationId);
          void this.pump();
        });
      }
    } finally { this.pumping = false; }
  }

  private async run(turn: RunningTurn): Promise<void> {
    const request = turn.request;
    const receiptId = randomUUID();
    const root = join(this.options.root, pathPart(request.workspaceId), pathPart(request.conversationId), pathPart(request.botId), receiptId);
    let prompt = "";
    let text = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let status: CloudTurnState = "failed";
    try {
      if (!(await this.allowed(turn))) return;
      await mkdir(join(root, "home"), { recursive: true, mode: 0o700 });
      turn.tools = await this.options.toolBroker?.open(request);
      const profile = await this.options.botProfile?.(request) ?? { name: "Colonie bot" };
      const history = await this.options.history?.(request) ?? request.history;
      prompt = cloudApplicationPrompt({ ...request, history }, profile, turn.tools?.toolNames);
      // Write the exact application-authored input BEFORE dispatch.
      await this.receipt(root, { id: receiptId, status: "prepared", request, prompt, toolNames: turn.tools?.toolNames });
      await this.options.state?.(request, "working");
      if (!(await this.allowed(turn))) { status = "cancelled"; return; }
      const child = (this.options.spawn ?? spawn)(this.options.node ?? process.execPath,
        [this.options.adapterEntry ?? require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")],
        { cwd: root, env: { ...cloudRuntimeEnvironment(this.options.claudeConfigDir, join(root, "home")),
          ...(this.options.claudeExecutable ? { CLAUDE_CODE_EXECUTABLE: this.options.claudeExecutable } : {}) },
          stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
      turn.child = child;
      // Consume stderr without logging provider internals or authentication.
      child.stderr.resume();
      const connection = client({ name: "Colonie Cloud" })
        .onNotification(methods.client.session.update, ({ params }) => {
          const value = params as SessionNotification;
          if (value.sessionId !== turn.sessionId || turn.cancelled) return;
          if (value.update.sessionUpdate === "agent_message_chunk" && value.update.content.type === "text") {
            text += value.update.content.text;
            if (text.length > 100_000) { turn.cancelled = true; connection.close(new Error("Response limit reached")); }
          }
        })
        .onRequest(methods.client.session.requestPermission, async ({ params }) => {
          if (params.sessionId === turn.sessionId && await this.allowed(turn) && await turn.tools?.authorizePermission(params)) {
            const once = params.options.find((option) => option.kind === "allow_once");
            if (once) return { outcome: { outcome: "selected" as const, optionId: once.optionId } };
          }
          return { outcome: { outcome: "cancelled" as const } };
        })
        .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
      turn.connection = connection;
      timer = setTimeout(() => { turn.cancelled = true; connection.close(new Error("Cloud turn timed out")); }, this.options.timeoutMs ?? 120_000);
      child.on("error", () => connection.close(new Error("The AI runtime could not start")));
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "Colonie Cloud", version: "0.1.101" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: root, mcpServers: turn.tools?.servers ?? [],
        _meta: { claudeCode: { options: { tools: [], settingSources: [], strictMcpConfig: true, persistSession: false } } },
      });
      turn.sessionId = session.sessionId;
      if (!(await this.allowed(turn))) { status = "cancelled"; return; }
      const result = await connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId, prompt: [{ type: "text", text: prompt }],
      });
      if (result.stopReason === "cancelled" || !(await this.allowed(turn))) { status = "cancelled"; return; }
      if (!text.trim()) throw new Error("The AI did not return a message");
      await this.options.sink.postBotMessage({ botPrincipalId: request.botPrincipalId, conversationId: request.conversationId, initiatorAccountId: request.initiatorAccountId, body: text.trim() });
      status = "completed";
    } catch {
      status = turn.cancelled ? "cancelled" : "failed";
      if (!turn.cancelled && await this.allowed(turn).catch(() => false)) {
        await this.options.state?.(request, "failed", "The bot could not reply. Try again shortly; if this continues, ask your workspace owner to check the AI service.").catch(() => {});
      }
    } finally {
      clearTimeout(timer);
      await turn.tools?.release().catch(() => {});
      turn.connection?.close();
      turn.child?.kill("SIGTERM");
      if (turn.child && turn.child.exitCode === null && turn.child.signalCode === null) {
        const child = turn.child;
        const kill = setTimeout(() => child.kill("SIGKILL"), 1500).unref();
        child.once("exit", () => clearTimeout(kill));
      }
      if (prompt) await this.receipt(root, { id: receiptId, status, request, prompt, toolNames: turn.tools?.toolNames }).catch(() => {});
      if (status !== "failed") await this.options.state?.(request, status).catch(() => {});
    }
  }

  private async allowed(turn: RunningTurn): Promise<boolean> {
    return !this.disposed && !turn.cancelled && await this.options.authorize(turn.request) &&
      await this.options.sink.canPublish({ botPrincipalId: turn.request.botPrincipalId, conversationId: turn.request.conversationId, initiatorAccountId: turn.request.initiatorAccountId });
  }

  private async receipt(root: string, input: { id: string; status: string; request: BotTurnRequest; prompt: string; toolNames?: string[] }): Promise<void> {
    await writeFile(join(root, "input-receipt.json"), JSON.stringify({
      id: input.id, status: input.status, provider: "claude-acp", providerVersion: "0.88.0",
      workspaceId: input.request.workspaceId, conversationId: input.request.conversationId,
      botId: input.request.botId, triggerMessageId: input.request.message.id,
      applicationPrompt: input.prompt, promptHash: createHash("sha256").update(input.prompt).digest("hex"),
      policy: { builtInTools: false, connectedTools: input.toolNames ?? [], nativeInstructionSources: [] },
      updatedAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
  }

  async cancelConversation(conversationId: string): Promise<void> {
    for (let index = this.queue.length - 1; index >= 0; index--) {
      if (this.queue[index]!.conversationId === conversationId) this.queue.splice(index, 1);
    }
    const turn = this.running.get(conversationId);
    if (!turn) return;
    turn.cancelled = true;
    await turn.tools?.release().catch(() => {});
    if (turn.sessionId) await turn.connection?.agent.notify(methods.agent.session.cancel, { sessionId: turn.sessionId }).catch(() => {});
    turn.connection?.close();
    turn.child?.kill("SIGTERM");
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.queue.length = 0;
    await Promise.all([...this.running.keys()].map((id) => this.cancelConversation(id)));
  }
}
