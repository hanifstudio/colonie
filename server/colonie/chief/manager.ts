// The Colonie Chief: one workspace role, its scoped model-facing tools and its
// delegated assignments. A per-conversation lease exposes a private loopback
// MCP server (`colonie_workspace`) to the active ACP turn. The current Chief
// gets management and ask tools; every other bot gets only a self-scoped
// read_skill for the exact hashes its dispatch selected. Authority is checked
// against the current Chief on every request, mutations claim a durable
// idempotency key before they run, and delegated children have their own fresh
// conversation, permissions and Stop tree.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { DATA_DIR } from "../../config.ts";
import { redactSecretsInText } from "../../redact.ts";
import type { AcpToolMount } from "../connections/contracts.ts";
import type { ConnectedToolCall, ConnectedToolsReceipt } from "../../../shared/connected-apps.ts";
import type { ChiefActor, ChiefAssignment, ChiefAssignmentStatus, ChiefBot, ChiefView } from "../../../shared/colonie-chief.ts";
import { ColonieChiefStore, MAX_CONTEXT, MAX_MESSAGE, MAX_RESULT, type ClaimResult } from "./store.ts";

const SERVER_NAME = "colonie_workspace";
const MCP_PATH = "/api/internal/colonie-workspace-mcp";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const REQUEST_ID = /^[\w.:-]{1,128}$/;
const ASSIGNMENT_TIMEOUT_MS = 120_000;

export interface CreateBotInput {
  name: string;
  title?: string;
  description?: string;
  soul?: string;
  modelSelection?: { instanceId: string; model: string };
}
export interface UpdateBotPatch {
  name?: string;
  title?: string;
  description?: string;
  soul?: string;
  modelSelection?: { instanceId: string; model: string };
}

export interface ChiefSkillsDeps {
  list(botId: string): unknown;
  readEnabled(botId: string, name: string): { text: string; sha256: string } | null;
  save(botId: string, input: unknown, actor: ChiefActor): unknown;
  setEnabled(botId: string, name: string, enabled: boolean, expectedRevision: string): unknown;
  remove(botId: string, name: string, expectedRevision: string): unknown;
}

export interface ChiefDeps {
  origin: string;
  dataDir?: string;
  bots(): ChiefBot[];
  bot(id: string): ChiefBot | undefined;
  chiefId(): string | null;
  owns(botId: string, threadId: string): boolean;
  currentTurn(botId: string, threadId: string): string | null;
  busy(botId: string): boolean;
  setChief(botId: string, expectedRevision: string): void;
  createBot(input: CreateBotInput, signal: AbortSignal): Promise<ChiefBot>;
  updateBot(botId: string, patch: UpdateBotPatch, signal: AbortSignal): Promise<ChiefBot>;
  deleteBot(botId: string, signal: AbortSignal): Promise<void>;
  createAssignmentThread(job: ChiefAssignment): string;
  runAssignment(job: ChiefAssignment, signal: AbortSignal): Promise<string>;
  skills: ChiefSkillsDeps;
}

interface Lease {
  botId: string;
  threadId: string;
  instanceId: string;
  chief: boolean;
  revision: string;
  token: string;
  active: boolean;
  released: boolean;
  skillHashes: Record<string, string>;
  controller: AbortController;
  lifetime: AbortController;
  mount: AcpToolMount;
  calls: ConnectedToolCall[];
}

interface LiveJob {
  job: ChiefAssignment;
  controller: AbortController;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: boolean };
}

const selfSkillTools: ToolDef[] = [
  { name: "read_skill", description: "Read the exact text of one of this bot's enabled guides. Only guides selected for this request can be read.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
  { name: "list_my_skills", description: "List this bot's enabled guides by name and description.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];

const chiefTools: ToolDef[] = [
  { name: "list_bots", description: "List the workspace's visible bots.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "read_bot", description: "Read one bot's name, title and description.", inputSchema: { type: "object", properties: { botId: { type: "string" } }, required: ["botId"], additionalProperties: false } },
  { name: "create_bot", description: "Create a new bot.", inputSchema: { type: "object", properties: { name: { type: "string" }, title: { type: "string" }, description: { type: "string" }, soul: { type: "string" }, modelSelection: { type: "object", properties: { instanceId: { type: "string" }, model: { type: "string" } }, required: ["instanceId", "model"] }, requestId: { type: "string" } }, required: ["name", "requestId"], additionalProperties: false } },
  { name: "update_bot", description: "Change an existing bot's profile.", inputSchema: { type: "object", properties: { botId: { type: "string" }, name: { type: "string" }, title: { type: "string" }, description: { type: "string" }, soul: { type: "string" }, modelSelection: { type: "object", properties: { instanceId: { type: "string" }, model: { type: "string" } }, required: ["instanceId", "model"] }, requestId: { type: "string" } }, required: ["botId", "requestId"], additionalProperties: false } },
  { name: "delete_bot", description: "Delete another bot. The current Chief must be transferred before it can be deleted.", inputSchema: { type: "object", properties: { botId: { type: "string" }, requestId: { type: "string" } }, required: ["botId", "requestId"], additionalProperties: false } },
  { name: "ask_bot", description: "Give another bot one task in a fresh conversation and wait for its result.", inputSchema: { type: "object", properties: { targetBotId: { type: "string" }, message: { type: "string" }, context: { type: "string" }, requestId: { type: "string" } }, required: ["targetBotId", "message", "requestId"], additionalProperties: false } },
  { name: "list_skills", description: "List a bot's guides.", inputSchema: { type: "object", properties: { botId: { type: "string" } }, additionalProperties: false } },
  { name: "save_skill", description: "Create or replace a guide on a bot.", inputSchema: { type: "object", properties: { botId: { type: "string" }, name: { type: "string" }, description: { type: "string" }, instructions: { type: "string" }, enabled: { type: "boolean" }, expectedSha256: { type: "string" }, requestId: { type: "string" } }, required: ["name", "description", "instructions", "requestId"], additionalProperties: false } },
  { name: "set_skill_enabled", description: "Turn one of a bot's guides on or off.", inputSchema: { type: "object", properties: { botId: { type: "string" }, name: { type: "string" }, enabled: { type: "boolean" }, expectedRevision: { type: "string" }, requestId: { type: "string" } }, required: ["name", "enabled", "expectedRevision", "requestId"], additionalProperties: false } },
  { name: "delete_skill", description: "Remove one of a bot's guides.", inputSchema: { type: "object", properties: { botId: { type: "string" }, name: { type: "string" }, expectedRevision: { type: "string" }, requestId: { type: "string" } }, required: ["name", "expectedRevision", "requestId"], additionalProperties: false } },
];

const rpcError = (id: unknown, message: string) => ({ jsonrpc: "2.0", id: typeof id === "number" || typeof id === "string" ? id : null, error: { code: -32000, message } });
const object = z.record(z.string(), z.unknown());
const callParams = z.object({ name: z.string(), arguments: object.optional() }).passthrough();
const modelSelectionSchema = z.object({ instanceId: z.string().min(1).max(128), model: z.string().min(1).max(256) }).strict();
const profileSchema = { name: z.string().min(1).max(200).optional(), title: z.string().max(200).optional(), description: z.string().max(2000).optional(), soul: z.string().max(20000).optional(), modelSelection: modelSelectionSchema.optional() };
const requestIdSchema = z.string().regex(REQUEST_ID, "A requestId of 1-128 letters, digits, dot, colon, dash or underscore is required.");

/** A refusal the model should see as a tool error, not a transport failure. */
class ToolError extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Deterministic argument hash: key order from a client cannot change it. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function bound(text: string): string {
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT - 1)}…` : text;
}

/** Secret-scrubbed, bounded result text. Never persisted raw. */
function safeText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return bound(redactSecretsInText(text ?? ""));
}

export class ColonieChief {
  private readonly deps: ChiefDeps;
  readonly store: ColonieChiefStore;
  private readonly leases = new Map<string, Lease>();
  private readonly tokens = new Map<string, Lease>();
  private readonly jobs = new Map<string, LiveJob>();

  constructor(deps: ChiefDeps, dataDir?: string) {
    this.deps = deps;
    this.store = new ColonieChiefStore(dataDir ?? deps.dataDir ?? DATA_DIR);
  }

  // --- role and public view -------------------------------------------------

  /** The token the renderer sends back as `expectedRevision`; it changes when
   * the Chief changes, so a competing transfer is seen as stale. */
  revision(): string {
    return this.deps.chiefId() ?? "";
  }

  view(sourceThreadId?: string): ChiefView {
    const id = this.deps.chiefId();
    return { chief: id ? this.deps.bot(id) ?? null : null, revision: this.revision(), assignments: this.store.assignments(sourceThreadId) };
  }

  assignment(id: string): ChiefAssignment | undefined {
    return this.store.assignment(id);
  }

  isAssignmentCurrent(id: string, targetBotId: string, targetThreadId: string): boolean {
    const assignment = this.store.assignment(id);
    if (!assignment || !assignment.targetThreadId) return false;
    if (assignment.targetBotId !== targetBotId || assignment.targetThreadId !== targetThreadId) return false;
    return assignment.status === "queued" || assignment.status === "running" || assignment.status === "waiting";
  }

  setAssignmentStatus(targetThreadId: string, status: ChiefAssignmentStatus): void {
    this.store.setStatusByTargetThread(targetThreadId, status);
  }

  ownsSource(threadId: string): boolean {
    const id = this.deps.chiefId();
    return id !== null && this.deps.owns(id, threadId);
  }

  /** True while the Chief is running a turn or has unfinished assignments, so
   * a role transfer is refused before the role can move out from under work. */
  chiefBusy(): boolean {
    const id = this.deps.chiefId();
    if (id && this.deps.busy(id)) return true;
    return this.jobs.size > 0;
  }

  transfer(botId: string, expectedRevision: string): void {
    if (this.revision() !== expectedRevision) throw Object.assign(new Error("The Chief changed elsewhere. Refresh and try again."), { status: 409 });
    if (this.chiefBusy()) throw Object.assign(new Error("Wait for the Chief's current work to finish before transferring the role."), { status: 409 });
    if (!this.deps.bot(botId)) throw Object.assign(new Error("No such bot"), { status: 404 });
    this.deps.setChief(botId, expectedRevision);
    this.invalidate();
  }

  // --- leases and the loopback MCP -----------------------------------------

  mount(botId: string, threadId: string, instanceId: string, skillRevision?: string, skillHashes?: Record<string, string>): AcpToolMount | null {
    const chief = this.deps.chiefId() === botId;
    const hashes: Record<string, string> = chief ? {} : { ...skillHashes };
    if (!chief && Object.keys(hashes).length === 0) return null;
    const revision = hashOf({ botId, instanceId, chief, skillRevision: skillRevision ?? "", hashes, chiefId: this.deps.chiefId() ?? "" });
    const slot = `${threadId}:${instanceId}`;
    const previous = this.leases.get(slot);
    if (previous?.revision === revision && !previous.released) return previous.mount;

    const token = randomBytes(32).toString("hex");
    const servers: McpServer[] = [{ name: SERVER_NAME, type: "http", url: `${this.deps.origin}${MCP_PATH}`, headers: [{ name: "Authorization", value: `Bearer ${token}` }] }];
    const receipt: ConnectedToolsReceipt = { policyHash: revision, composioToolkits: [], servers: [{ name: SERVER_NAME, source: "colonie", transport: "http" }] };
    let mount!: AcpToolMount;
    const lease: Lease = {
      botId, threadId, instanceId, chief, revision, token, active: false, released: false, skillHashes: hashes,
      controller: new AbortController(), lifetime: new AbortController(), calls: [],
      get mount() { return mount; },
    };
    const release = () => {
      if (lease.released) return;
      lease.released = true;
      lease.active = false;
      lease.controller.abort();
      lease.lifetime.abort();
      this.tokens.delete(token);
      if (this.leases.get(slot) === lease) this.leases.delete(slot);
    };
    mount = {
      servers,
      revision,
      receipt,
      activate: () => {
        this.assertCurrent(lease);
        if (lease.controller.signal.aborted) lease.controller = new AbortController();
        lease.active = true;
        lease.calls = [];
      },
      deactivate: () => {
        lease.active = false;
        for (const call of lease.calls) if (call.status === "started") call.status = "cancelled";
        lease.controller.abort();
        this.cancelSource(lease.threadId);
      },
      release,
      calls: () => lease.calls.map((call) => ({ ...call, targets: [...call.targets] })),
    };
    previous?.mount.release();
    this.leases.set(slot, lease);
    this.tokens.set(token, lease);
    return mount;
  }

  private assertCurrent(lease: Lease): void {
    if (lease.released || !this.deps.owns(lease.botId, lease.threadId)) throw new Error("Unauthorized MCP connection");
    if (lease.chief && this.deps.chiefId() !== lease.botId) throw new Error("The Chief role changed. Send a new message to refresh.");
  }

  async handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const token = /^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization ?? ""))?.[1];
    const lease = token ? this.tokens.get(token) : undefined;
    const remote = req.socket.remoteAddress;
    if (!lease || !LOOPBACK.has(remote ?? "") || req.headers.origin) return json(401, { error: "Unauthorized MCP connection" });
    if (req.method === "GET") {
      res.writeHead(405, { allow: "POST, DELETE" });
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "POST") return json(405, { error: "Unsupported MCP method" });
    const frame = object.safeParse(body);
    if (!frame.success) return json(400, rpcError(null, "Invalid MCP frame"));
    try {
      this.assertCurrent(lease);
    } catch {
      return json(401, { error: "Unauthorized MCP connection" });
    }
    const id = frame.data.id;
    const method = String(frame.data.method ?? "");
    if (method === "initialize") {
      return json(200, { jsonrpc: "2.0", id: id ?? null, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: "1.0.0" } } });
    }
    if (method.startsWith("notifications/")) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (method === "ping") return json(200, { jsonrpc: "2.0", id: id ?? null, result: {} });
    if (method === "tools/list") return json(200, { jsonrpc: "2.0", id: id ?? null, result: { tools: this.toolsFor(lease).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } });
    if (method === "tools/call") {
      const parsed = callParams.safeParse(frame.data.params ?? {});
      if (!parsed.success) return json(200, rpcError(id, "Invalid tool call"));
      const result = await this.call(lease, parsed.data.name, parsed.data.arguments ?? {});
      return json(200, { jsonrpc: "2.0", id: id ?? null, result });
    }
    return json(200, rpcError(id, "Unsupported MCP method"));
  }

  private toolsFor(lease: Lease): ToolDef[] {
    return lease.chief ? [...chiefTools, ...selfSkillTools] : [...selfSkillTools];
  }

  private async call(lease: Lease, name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
    const tool = this.toolsFor(lease).find((candidate) => candidate.name === name);
    if (!tool) return this.toolError(`Unknown tool: ${name}`);
    if (lease.chief && this.deps.chiefId() !== lease.botId) return this.toolError("The Chief role changed. Send a new message to refresh.");
    if (!lease.active || this.deps.currentTurn(lease.botId, lease.threadId) === null) return this.toolError("This conversation has no active request.");
    const record: ConnectedToolCall = { server: SERVER_NAME, tool: name, targets: this.targetsFor(name, args), status: "started" };
    lease.calls.push(record);
    try {
      const text = await this.dispatch(lease, name, args);
      record.status = "completed";
      return this.toolResult(text, false);
    } catch (error) {
      record.status = lease.controller.signal.aborted ? "cancelled" : "failed";
      return this.toolResult(messageOf(error), true);
    }
  }

  private targetsFor(name: string, args: Record<string, unknown>): string[] {
    const botId = typeof args.botId === "string" ? args.botId : typeof args.targetBotId === "string" ? args.targetBotId : "";
    const skill = typeof args.name === "string" && name.endsWith("skill") ? args.name : "";
    return [botId, skill].filter(Boolean);
  }

  private toolResult(text: string, isError: boolean): { content: Array<{ type: "text"; text: string }>; isError?: true } {
    return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
  }

  private toolError(message: string) {
    return this.toolResult(message, true);
  }

  private async dispatch(lease: Lease, name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "list_bots":
        return safeText(this.deps.bots().filter((bot) => !bot.hidden).map((bot) => ({ id: bot.id, name: bot.name, title: bot.title })));
      case "read_bot":
        return safeText(this.requireBot(this.requiredString(args, "botId")));
      case "create_bot": {
        const input = this.profileInput(args, true);
        return this.mutate(lease, name, args, async (signal) => safeText(await this.deps.createBot({ ...input, name: input.name ?? "" }, signal)));
      }
      case "update_bot":
        return this.mutate(lease, name, args, async (signal) => safeText(await this.deps.updateBot(this.requiredString(args, "botId"), this.profileInput(args, false), signal)));
      case "delete_bot": {
        const botId = this.requiredString(args, "botId");
        if (botId === lease.botId) throw new ToolError("The current Chief must transfer the role before it can be deleted.");
        return this.mutate(lease, name, args, async (signal) => {
          await this.deps.deleteBot(botId, signal);
          return safeText({ deleted: botId });
        });
      }
      case "ask_bot":
        return this.askBot(lease, args);
      case "list_skills": {
        const botId = typeof args.botId === "string" ? args.botId : lease.botId;
        this.requireBot(botId);
        return safeText(this.deps.skills.list(botId));
      }
      case "save_skill": {
        const botId = typeof args.botId === "string" ? args.botId : lease.botId;
        this.requireBot(botId);
        return this.mutate(lease, name, args, () => safeText(this.deps.skills.save(botId, { name: this.requiredString(args, "name"), description: this.requiredString(args, "description"), instructions: this.requiredString(args, "instructions"), enabled: args.enabled === true, ...(typeof args.expectedSha256 === "string" ? { expectedSha256: args.expectedSha256 } : {}) }, this.actor(lease))));
      }
      case "set_skill_enabled": {
        const botId = typeof args.botId === "string" ? args.botId : lease.botId;
        this.requireBot(botId);
        return this.mutate(lease, name, args, () => safeText(this.deps.skills.setEnabled(botId, this.requiredString(args, "name"), args.enabled === true, this.requiredString(args, "expectedRevision"))));
      }
      case "delete_skill": {
        const botId = typeof args.botId === "string" ? args.botId : lease.botId;
        this.requireBot(botId);
        return this.mutate(lease, name, args, () => safeText(this.deps.skills.remove(botId, this.requiredString(args, "name"), this.requiredString(args, "expectedRevision"))));
      }
      case "read_skill":
        return this.readSkill(lease, args);
      case "list_my_skills":
        return safeText(this.deps.skills.list(lease.botId));
      default:
        throw new ToolError(`Unknown tool: ${name}`);
    }
  }

  private readSkill(lease: Lease, args: Record<string, unknown>): string {
    const name = this.requiredString(args, "name");
    const boundHash = lease.chief ? undefined : lease.skillHashes?.[name];
    if (!lease.chief && !boundHash) throw new ToolError("That guide was not selected for this request.");
    const found = this.deps.skills.readEnabled(lease.botId, name);
    if (!found) throw new ToolError("That guide is not enabled or no longer matches what was selected.");
    if (boundHash && found.sha256 !== boundHash) throw new ToolError("That guide changed since this request started. Send a new message to use the new text.");
    return found.text;
  }

  private async askBot(lease: Lease, args: Record<string, unknown>): Promise<string> {
    const target = this.requireBot(this.requiredString(args, "targetBotId"));
    if (target.id === lease.botId) throw new ToolError("A bot cannot ask itself.");
    if (target.id === this.deps.chiefId()) throw new ToolError("The Chief cannot be assigned work this way.");
    const message = this.boundedString(args, "message", MAX_MESSAGE);
    const context = args.context === undefined ? undefined : this.boundedString(args, "context", MAX_CONTEXT);
    const requestId = this.requestId(args);
    const argsHash = hashOf(stableStringify({ target: target.id, message, context: context ?? "" }));
    const outcome = await this.claim(lease, "ask_bot", requestId, argsHash);
    if (outcome.kind === "replay") return outcome.text;
    const job: ChiefAssignment = {
      id: this.store.newAssignmentId(),
      chiefBotId: lease.botId,
      sourceThreadId: lease.threadId,
      sourceTurnId: this.deps.currentTurn(lease.botId, lease.threadId) ?? "",
      targetBotId: target.id,
      message,
      ...(context ? { context } : {}),
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    job.targetThreadId = this.deps.createAssignmentThread(job);
    this.store.createAssignment(job);
    const controller = new AbortController();
    this.jobs.set(job.id, { job, controller });
    const timer = setTimeout(() => controller.abort(), ASSIGNMENT_TIMEOUT_MS);
    try {
      this.store.updateAssignment(job.id, { status: "running" });
      const result = await this.deps.runAssignment({ ...job, status: "running" }, controller.signal);
      if (controller.signal.aborted) throw Object.assign(new Error("The task was stopped before it finished."), { name: "AbortError" });
      if (this.deps.chiefId() !== job.chiefBotId || !this.deps.owns(job.chiefBotId, job.sourceThreadId)) throw new ToolError("The Chief role changed before this task finished.");
      const text = safeText(result);
      this.store.updateAssignment(job.id, { status: "completed", result: text });
      this.settle(lease, requestId, { result: text });
      return text;
    } catch (error) {
      const stopped = controller.signal.aborted || (error as Error).name === "AbortError";
      const text = stopped ? "The task was stopped before it finished." : messageOf(error);
      this.store.updateAssignment(job.id, { status: stopped ? "cancelled" : "failed", error: text });
      this.store.settleOperation(this.keyFor(lease, requestId), "failed", { error: bound(redactSecretsInText(text)) });
      if (error instanceof ToolError) throw error;
      throw new ToolError(text);
    } finally {
      clearTimeout(timer);
      this.jobs.delete(job.id);
    }
  }

  private async mutate(lease: Lease, tool: string, args: Record<string, unknown>, run: (signal: AbortSignal) => Promise<string> | string): Promise<string> {
    const requestId = this.requestId(args);
    const outcome = await this.claim(lease, tool, requestId, hashOf(stableStringify(args)));
    if (outcome.kind === "replay") return outcome.text;
    try {
      const text = await run(lease.controller.signal);
      this.settle(lease, requestId, { result: text });
      return text;
    } catch (error) {
      this.store.settleOperation(this.keyFor(lease, requestId), "failed", { error: bound(redactSecretsInText(messageOf(error))) });
      throw error;
    }
  }

  private async claim(lease: Lease, tool: string, requestId: string, argsHash: string): Promise<{ kind: "fresh" } | { kind: "replay"; text: string }> {
    const claim = this.store.claim({ key: this.keyFor(lease, requestId), botId: lease.botId, threadId: lease.threadId, requestId, tool, argsHash });
    if (claim.kind === "mismatch") throw new ToolError("This requestId was already used for a different operation.");
    if (claim.kind === "claimed") return { kind: "fresh" };
    return { kind: "replay", text: this.replayText(claim) };
  }

  private replayText(claim: Extract<ClaimResult, { kind: "replay" }>): string {
    if (claim.status === "completed") return claim.result ?? "";
    if (claim.status === "failed") throw new ToolError(claim.error ?? "This operation previously failed.");
    throw new ToolError("This operation was interrupted before it finished. Use a new requestId to run it again.");
  }

  private settle(lease: Lease, requestId: string, value: { result?: string; error?: string }): void {
    this.store.settleOperation(this.keyFor(lease, requestId), "completed", value);
  }

  private keyFor(lease: Lease, requestId: string): string {
    return `${lease.botId}:${lease.threadId}:${requestId}`;
  }

  private actor(lease: Lease): ChiefActor {
    return { botId: lease.botId, threadId: lease.threadId, turnId: this.deps.currentTurn(lease.botId, lease.threadId) ?? "" };
  }

  private requestId(args: Record<string, unknown>): string {
    const parsed = requestIdSchema.safeParse(args.requestId);
    if (!parsed.success) throw new ToolError(parsed.error.issues[0]?.message ?? "A requestId is required.");
    return parsed.data;
  }

  private requiredString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== "string" || value.length === 0) throw new ToolError(`${key} is required.`);
    return value;
  }

  private boundedString(args: Record<string, unknown>, key: string, max: number): string {
    const value = this.requiredString(args, key);
    if (value.length > max) throw new ToolError(`${key} must be at most ${max} characters.`);
    return value;
  }

  private requireBot(botId: string): ChiefBot {
    const bot = this.deps.bot(botId);
    if (!bot || bot.hidden) throw new ToolError("That bot is not available.");
    return bot;
  }

  private profileInput(args: Record<string, unknown>, requireName: boolean): UpdateBotPatch {
    const parsed = z.object(profileSchema).strict().safeParse({ name: args.name, title: args.title, description: args.description, soul: args.soul, modelSelection: args.modelSelection });
    if (!parsed.success) throw new ToolError(parsed.error.issues[0]?.message ?? "Invalid profile.");
    const input = parsed.data;
    if (requireName && !input.name) throw new ToolError("name is required.");
    return input;
  }

  // --- cancellation and lifecycle ------------------------------------------

  cancelSource(threadId: string): void {
    for (const [id, live] of this.jobs) {
      if (live.job.sourceThreadId === threadId) {
        live.controller.abort();
        this.jobs.delete(id);
      }
    }
    for (const lease of this.leases.values()) if (lease.threadId === threadId) lease.active = false;
  }

  cancelBot(botId: string): void {
    for (const [id, live] of this.jobs) {
      if (live.job.chiefBotId === botId || live.job.targetBotId === botId) {
        live.controller.abort();
        this.jobs.delete(id);
      }
    }
    for (const lease of this.leases.values()) if (lease.botId === botId) lease.mount.release();
  }

  /** Role changes release every lease (its toolset may no longer be valid) and
   * abort unfinished children; completed work stays inspectable. */
  invalidate(): void {
    for (const [id, live] of this.jobs) {
      live.controller.abort();
      this.jobs.delete(id);
    }
    for (const lease of this.leases.values()) lease.mount.release();
  }

  dispose(): void {
    for (const live of this.jobs.values()) live.controller.abort();
    this.jobs.clear();
    for (const lease of this.leases.values()) lease.mount.release();
  }
}