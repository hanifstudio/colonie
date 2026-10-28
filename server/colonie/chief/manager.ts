// The Colonie Chief: one workspace role, its scoped model-facing tools and its
// delegated assignments. A per-conversation lease exposes a private loopback
// MCP server (`colonie_workspace`) to the active ACP turn. The current Chief
// gets management and ask tools; every bot gets a self-scoped read_skill for
// the exact hashes its dispatch selected, and its own routines. Authority is checked
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
  /** Stage a bot's own guide and put a card in its conversation for the
   * person; nothing is saved until they answer. */
  propose?(botId: string, threadId: string, input: { name: string; description: string; instructions: string }): unknown;
}

/** A bot's own routines, scheduled from chat (colonie/routines). A change
 * goes through the routine request service: applied with an Undo receipt
 * for the bot's own routines, or left as a card for the person. */
export interface ChiefRoutinesDeps {
  list(botId: string): unknown;
  propose(botId: string, threadId: string, proposal: unknown, canCommit: () => boolean): Promise<unknown>;
  now(): { time: string; timeZone: string };
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
  routines?: ChiefRoutinesDeps;
  /** Ask the person for a secret: a button under the reply opens a form;
   * the value never comes back here (colonie/secrets). */
  requestSecret?(botId: string, threadId: string, input: { name: string; description: string }): unknown;
  /** The bot asks for its computer: start it and resume the request there,
   * or, with no container app installed, offer the person the free app. */
  useComputer?(botId: string, threadId: string, reason: string | undefined): unknown;
  /** A card asking the person to sign in or pass a check in the bot's browser. */
  requestSignIn?(botId: string, threadId: string, input: { site: string; reason?: string }): unknown;
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

/** How Colonie works, for a bot asked what it can do or where something is.
 * Read on demand, so it costs nothing on turns that do not need it. */
export const ABOUT_COLONIE = `Colonie is an app where people and AI bots work together. Each bot has a name, its own instructions, memory, guides and conversations, and runs on the person's own Claude or Codex subscription.

Workspaces
- Local: on the person's computer, just them and their bots. Routines run while the app is open.
- Shared: on a server. People join with an invite link (Settings, People) in the Colonie app or a browser. People and bots talk in groups and direct messages; a bot answers in a group when someone @mentions it. Routines run whenever the server is on.

What a bot can do
- Work with the engine's own tools: files in its working folder, commands, web search and reading pages, as the engine and the bot's approval level allow.
- Routines (scheduled work): list_routines, schedule_routine, change_routine. A run reports in the conversation it was set up from (a group when it came from a group), and the person is notified when it finishes. People also find routines on the Routines page (Advanced mode, foot of the sidebar).
- Guides (skills): save_my_skill proposes one and the person confirms it on a card; read_skill reads one. The person can type "/" in the message box to pick one of the bot's guides.
- Memory: Colonie keeps relevant facts from conversations by itself and supplies them when they matter. A bot cannot save a memory directly.
- Connected apps: the person adds MCP servers or Composio apps under Apps (puzzle icon by their profile), then chooses which a bot may use in that bot's settings, Access, "Connected apps and tools". When a task needs an app that is not connected, say where to connect it.
- Secrets: when a task needs a key or password, request_secret puts a button under your reply; the person saves it privately and you get it in a file on their next message, never in the chat. People also manage them in Settings, AI, Secrets.
- Approvals: risky actions wait for the person's Allow, depending on the bot's approval level (bot settings, Permissions).
- The Chief of Staff (one per workspace) can also create, change and ask other bots.

What a bot cannot do in Colonie
- Use a browser window or a desktop of its own beyond the engine's tools.
- Edit or branch earlier messages; a new conversation starts fresh.
- Message other bots, unless it is the Chief.

Where things are for the person
- New bot or new group: the + at the top of the sidebar.
- A bot's settings: click its name at the top of its chat.
- Their photo, settings and updates: the profile menu, bottom left.`;

const selfSkillTools: ToolDef[] = [
  { name: "about_colonie", description: "How Colonie works: workspaces, what you can and cannot do, where things are for the person. Read it when asked what you can do or how to do something in Colonie.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "read_skill", description: "Read the exact text of one of this bot's enabled guides. Only guides selected for this request can be read.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
  { name: "list_my_skills", description: "List this bot's enabled guides by name and description.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "request_secret", description: "Ask the person for a key, password or token a task needs (an API key, an app password). A button under your reply lets them save it privately; you never see the value. Once saved, it is in the secrets file named in your context on their next message: load it in your scripts and never print it. Never ask for a secret in the chat itself. Prefer a connected app (Apps) when one covers the service. After calling, say in one line what it is for and end your turn.", inputSchema: { type: "object", properties: { name: { type: "string", description: "An environment-variable name, e.g. GMAIL_APP_PASSWORD." }, description: { type: "string", description: "What it is and where the person finds it, in a sentence." }, requestId: { type: "string" } }, required: ["name", "description", "requestId"], additionalProperties: false } },
  { name: "use_computer", description: "Ask for your own computer (a Linux desktop with a real browser) when a task needs one: a website that refuses or breaks your simple browser, or work that needs a real screen. Do not call it for anything your other tools can do. If the result is pending, end your turn at once: Colonie starts your computer and resumes the person's request on it. If the person has not installed the free app it needs, they are offered it; then carry on without it.", inputSchema: { type: "object", properties: { reason: { type: "string", description: "One short sentence: what needs the computer." }, requestId: { type: "string" } }, required: ["requestId"], additionalProperties: false } },
  { name: "request_sign_in", description: "Ask the person to do a step only they can do in your browser: sign in where you have no login, pass a CAPTCHA or \"are you human\" check, use a passkey, enter a code you cannot read, or give consent only they can give (a box agreeing to terms or a declaration, or authorizing a submission in their name; never tick those for them). They get a card in this chat, take over your browser, do just that step, and press Done. Never try to solve a CAPTCHA yourself and never ask for a password or code in chat. After calling, say in one line what you need and end your turn; their Done or Cancel arrives as their next message, then check the page and continue.", inputSchema: { type: "object", properties: { site: { type: "string", description: "The page or domain, e.g. redbus.id." }, reason: { type: "string", description: "One short sentence on what it is for." }, requestId: { type: "string" } }, required: ["site", "requestId"], additionalProperties: false } },
  { name: "save_my_skill", description: "Save a way of working as one of your guides, when the person asks (\"save what we just did as a skill\") or agrees to your offer after a task went well. A guide says when to use it, what it needs, the steps, how to check the result and what to hand back. The person confirms it on a card in the chat; until then nothing is saved. After calling, tell the person the card is there and end your turn. To change a guide you saved before, save it again under the same name.", inputSchema: { type: "object", properties: { name: { type: "string", description: "lowercase-with-hyphens, e.g. weekly-launch-report" }, description: { type: "string", description: "When to use it, one or two sentences." }, instructions: { type: "string" }, requestId: { type: "string" } }, required: ["name", "description", "instructions", "requestId"], additionalProperties: false } },
];

const SCHEDULE = {
  type: "object",
  description: "When it runs. once: {type, at} with at an RFC3339 date-time with an explicit offset. weekly: {type, time \"HH:MM\", weekdays [\"monday\", ...]} in the timezone from list_routines; every day is all seven weekdays. interval: {type, everyMinutes 5-1440, optional weekdays, window {start, end} as HH:MM, endsAt}. cron: {type, expression (five fields), timeZone (IANA)} for monthly dates, last days or nth weekdays.",
  properties: {
    type: { type: "string", enum: ["once", "weekly", "interval", "cron"] },
    at: { type: "string" }, time: { type: "string" }, weekdays: { type: "array", items: { type: "string" } },
    everyMinutes: { type: "number" }, window: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } } },
    endsAt: { type: "string" }, expression: { type: "string" }, timeZone: { type: "string" },
  },
  required: ["type"],
};
const ROUTINE_OUTCOME = " Read the result: a change to your own routines usually applies at once and the person sees it with an Undo; otherwise it waits for the person's confirmation in the chat. Never claim it is scheduled unless the result says applied.";

const selfRoutineTools: ToolDef[] = [
  { name: "list_routines", description: "List your routines (scheduled work) with their ids, schedules, whether they are on, and when they run next, plus the current time and timezone. Call it before scheduling anything relative (\"tomorrow\", \"in an hour\") and before changing a routine.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "schedule_routine", description: "Schedule work for yourself when the person asks for recurring or future work (\"every weekday at 8 sum up the news\", \"remind me tomorrow at 3pm\"). Settle the time, timezone and what to do with the person first if anything is unclear. Each run starts fresh with only the instructions, so write them complete: what to do, where to look, what to report. Never approximate a schedule you cannot express; say so instead." + ROUTINE_OUTCOME, inputSchema: { type: "object", properties: { name: { type: "string", description: "Short name, up to 80 characters." }, instructions: { type: "string" }, schedule: SCHEDULE, continuity: { type: "boolean", description: "Carry the previous run's report into the next run." }, requestId: { type: "string" } }, required: ["name", "instructions", "schedule", "requestId"], additionalProperties: false } },
  { name: "change_routine", description: "Change one of your routines when the person asks: update its name, instructions or schedule, pause, resume, run it now, or delete it. Get the id from list_routines." + ROUTINE_OUTCOME, inputSchema: { type: "object", properties: { routineId: { type: "string" }, action: { type: "string", enum: ["update", "pause", "resume", "run_now", "delete"] }, name: { type: "string" }, instructions: { type: "string" }, schedule: SCHEDULE, continuity: { type: "boolean" }, requestId: { type: "string" } }, required: ["routineId", "action", "requestId"], additionalProperties: false } },
];

/** Only the fields a schedule of its type takes: a model often adds a
 * timezone or weekdays where they do not belong. */
function scheduleOf(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const keep: Record<string, string[]> = { once: ["at"], weekly: ["time", "weekdays"], interval: ["everyMinutes", "anchorAt", "weekdays", "window", "endsAt"], cron: ["expression", "timeZone"] };
  const fields = keep[String(input.type)];
  if (!fields) return value;
  return Object.fromEntries([["type", input.type], ...fields.filter((key) => input[key] !== undefined).map((key) => [key, input[key]])]);
}

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
    // every bot can schedule its own routines; without them, a bot with no
    // selected guide has nothing to mount
    if (!chief && Object.keys(hashes).length === 0 && !this.deps.routines) return null;
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
      // asking first (request_secret, schedule_routine, save_my_skill, ...)
      // would ask twice: each already has its own card, Undo or answer
      trustedTools: [...selfSkillTools, ...selfRoutineTools].map((tool) => tool.name),
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
    const routines = this.deps.routines ? selfRoutineTools : [];
    return lease.chief ? [...chiefTools, ...selfSkillTools, ...routines] : [...selfSkillTools, ...routines];
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
      case "about_colonie":
        return ABOUT_COLONIE;
      case "list_my_skills":
        return safeText(this.deps.skills.list(lease.botId));
      case "request_secret": {
        const requestSecret = this.deps.requestSecret;
        if (!requestSecret) throw new ToolError("Secrets are not available here.");
        const input = { name: this.requiredString(args, "name"), description: this.requiredString(args, "description") };
        return this.mutate(lease, name, args, () => safeText(requestSecret(lease.botId, lease.threadId, input)));
      }
      case "use_computer": {
        const useComputer = this.deps.useComputer;
        if (!useComputer) throw new ToolError("A computer is not available here.");
        const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : undefined;
        return this.mutate(lease, name, args, async () => safeText(await useComputer(lease.botId, lease.threadId, reason)));
      }
      case "request_sign_in": {
        const requestSignIn = this.deps.requestSignIn;
        if (!requestSignIn) throw new ToolError("Sign-in requests are not available here.");
        const input = { site: this.requiredString(args, "site"), ...(typeof args.reason === "string" && args.reason.trim() ? { reason: args.reason.trim() } : {}) };
        return this.mutate(lease, name, args, () => safeText(requestSignIn(lease.botId, lease.threadId, input)));
      }
      case "save_my_skill": {
        const propose = this.deps.skills.propose;
        if (!propose) throw new ToolError("Saving guides is not available here.");
        const input = { name: this.requiredString(args, "name"), description: this.requiredString(args, "description"), instructions: this.requiredString(args, "instructions") };
        return this.mutate(lease, name, args, () => safeText(propose(lease.botId, lease.threadId, input)));
      }
      case "list_routines":
        return safeText({ ...this.routineDeps().now(), routines: this.routineDeps().list(lease.botId) });
      case "schedule_routine": {
        const routine = { name: this.requiredString(args, "name"), instructions: this.requiredString(args, "instructions"), schedule: scheduleOf(args.schedule),
          ...(typeof args.continuity === "boolean" ? { continuity: args.continuity } : {}) };
        return this.mutate(lease, name, args, async () => safeText(await this.routineDeps().propose(lease.botId, lease.threadId, { action: "create", routine }, () => lease.active)));
      }
      case "change_routine": {
        const routineId = this.requiredString(args, "routineId");
        const action = this.requiredString(args, "action");
        const changes = Object.fromEntries(Object.entries({ name: args.name, instructions: args.instructions, schedule: args.schedule === undefined ? undefined : scheduleOf(args.schedule), continuity: args.continuity })
          .filter(([, value]) => value !== undefined));
        const proposal = action === "update" ? { action, routineId, changes } : { action, routineId };
        return this.mutate(lease, name, args, async () => safeText(await this.routineDeps().propose(lease.botId, lease.threadId, proposal, () => lease.active)));
      }
      default:
        throw new ToolError(`Unknown tool: ${name}`);
    }
  }

  private routineDeps(): ChiefRoutinesDeps {
    if (!this.deps.routines) throw new ToolError("Routines are not available here.");
    return this.deps.routines;
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