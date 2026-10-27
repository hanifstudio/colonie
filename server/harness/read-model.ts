// The client-facing read models: how a bot and a task are shaped on the wire, the public bot with its newest message page, the guarded snapshot of one request, and the message-page helpers every HTTP/SSE reply uses. index.ts wires this once and destructures the names its routes still call.
import { type WireBot, type WireTask} from "../../shared/wire.ts";
import { isPersonalThread } from "../../shared/personal-thread.ts";
import { type ModelSelection } from "../contracts.ts";
import { conversationPreview } from "../acp/conversation-preview.ts";
import { colonieProfile } from "../acp/profile.ts";
import { queuedSteerSnapshot } from "../colonie/chat/steer-queue.ts";
import { guardedRequestPath, requestConflict, requestNeedsInput } from "../guarded-requests.ts";
import { toWireTask, type BotRecord, type Message, type TaskRecord} from "../persistence/store.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface ReadModelDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createReadModel(deps: ReadModelDeps) {
  const {
    store, directRequestOwners, threadBusy, pendingTeamSetupResumes
  } = deps;
/** A bot as a client may see it: no provider session bookkeeping.
 *
 * `resumeCursors` is the harness's own bookkeeping — the native session id
 * to resume, per instance, per task. No client has ever used it, and a
 * paired phone has even less business holding provider session identifiers
 * than the desktop window did. Stripped here rather than at each call site
 * so a new broadcast cannot forget. */
/** One thread as a client sees it. `botModel` is its bot's model: a thread
 * without a model of its own runs on it (toWireTask). */
const wireTask = (task: TaskRecord, botModel: ModelSelection): WireTask => {
  // Time-based snoozes heal on read against the server clock — no client
  // timer, no device skew. The 0 sentinel ("until new activity") is not a
  // time and survives reads; only a wake event in the store clears it.
  const { snoozedUntil, ...base } = toWireTask(task, botModel);
  // ACP histories do not branch; a bounded tail avoids loading idle full transcripts.
  const preview = colonieProfile() ? conversationPreview(store.messagesTail(task.threadId, 10).messages) : undefined;
  const withPreview = { ...base, ...(preview !== undefined ? { preview } : {}) };
  const asleep = snoozedUntil === 0 || (snoozedUntil !== undefined && snoozedUntil > Date.now());
  return asleep ? { ...withPreview, snoozedUntil } : withPreview;
};

const wireBot = (bot: BotRecord): WireBot => {
  const { resumeCursors: _resumeCursors, tasks, approvalGrant, lastProfileRequestId: _lastProfileRequestId, lastTeamSetupReceipt: _lastTeamSetupReceipt, packageBase: _packageBase, assignedSkills: _assignedSkills, ...rest } = bot;
  // An elevated selection is inert until the desktop confirms its exact
  // private reply. Every ordinary client sees the effective Ask state during
  // that two-phase window, never a grant that may still roll back.
  const visible = approvalGrant && !approvalGrant.threadOnly
    ? { ...rest, approvalMode: "ask" as const, autoApprove: false }
    : rest;
  const selected = tasks?.find((task) => task.threadId === bot.threadId);
  const threadId = selected && !isPersonalThread(selected) ? tasks?.find(isPersonalThread)?.threadId ?? "" : bot.threadId;
  return { ...visible, threadId,
    avatarUrl: visible.avatarUrl ?? null, ...(tasks ? { tasks: tasks.map((task) => wireTask(task, bot.modelSelection)) } : {}) };
};

const publicBot = (bot: NonNullable<ReturnType<typeof store.bot>>) => {
  const shown = wireBot(bot);
  return { ...shown, ...messagePage(shown.threadId, DEFAULT_PAGE), tasks: store.tasks(bot.id).map((task: any) => wireTask(task, bot.modelSelection)) };
};
const publicBotQueuedMessages = () => queuedSteerSnapshot((botId, threadId) => Boolean(store.taskByThread(botId, threadId)));
// ── message pages ──────────────────────────────────────────────────────
// GET /api/bots hands back every bot with its entire transcript, which is
// the right answer over loopback and the wrong one over a phone network:
// a long-running bot's thread is megabytes, and a turn-end desktop capture
// is a base64 PNG sitting inline in it.
//
// `?messages=n` opts into a slim shape — the last n messages, with screen
// captures reduced to a flag and fetched one at a time from the image
// endpoint. Omitting the parameter returns exactly what it always did.
const MESSAGE_PAGE_MAX = 200;
const DEFAULT_PAGE = 50;

/** undefined = absent, null = present but unusable (the caller answers 400). */
function pageSize(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 0) return null;
  return Math.min(size, MESSAGE_PAGE_MAX);
}

/** A screen message without its pixels, for live frames and pages alike.
 * The client fetches those from `/api/threads/:threadId/messages/:id/image`
 * when it actually shows one; `mime` stays so it can name a download. */
function slimMessage(message: Message): Message | Record<string, unknown> {
  if (message.kind !== "screen" || !message.png) return message;
  const { png: _png, ...rest } = message;
  return { ...rest, hasImage: true };
}

/** `limit === undefined` is the original, unpaginated shape. A bounded,
 * cursor-less request (the common case: startup hydrate, a fresh
 * scrollback view) goes through messagesTail(), which can read just the
 * newest rows from SQLite instead of hydrating the whole transcript first.
 * Paging further back with `before` still needs the full, cached array to
 * seek to an arbitrary point in history. */
function messagePage(threadId: string, limit: number | undefined, before?: string | null) {
  if (limit === undefined) {
    return { messages: store.messagesFor(threadId), activeLeafId: store.activeLeaf(threadId) };
  }
  if (!before) {
    const tail = store.messagesTail(threadId, limit);
    return { messages: tail.messages.map(slimMessage), hasMore: tail.hasMore, activeLeafId: tail.activeLeafId };
  }
  const all = store.messagesFor(threadId);
  const end = all.findIndex((msg: any) => msg.id === before);
  const stop = end === -1 ? all.length : end;
  const start = Math.max(0, stop - limit);
  return {
    messages: all.slice(start, stop).map(slimMessage),
    hasMore: start > 0,
    activeLeafId: store.activeLeaf(threadId),
  };
}

function guardedRequestSnapshot(botId: string, threadId: string, sendId: string) {
  if (!store.taskByThread(botId, threadId)) throw requestConflict("No such conversation for this bot");
  const activeLeafId = store.activeLeaf(threadId);
  const messages = guardedRequestPath(store.messagesFor(threadId), activeLeafId, sendId);
  const messageId = messages[0].id;
  const owner = directRequestOwners.get(threadId);
  const busy = threadBusy(botId, threadId);
  const waiting = messages.some(requestNeedsInput) ||
    [...pendingTeamSetupResumes().values()].some(entry => entry.request.threadId === threadId);
  const latestTerminal = messages.findLast(message => message.role === "bot" && message.kind === "text" && message.turnTerminal);
  const latestTurn = messages.findLast(message => message.turnId);
  const latestOutcome = messages.findLast(message => message.turnSucceeded !== undefined);
  // A restart retains proven transcript annotations, not an execution lease.
  // Unproven output or a different live owner always requires the workspace.
  const untracked = messages[0].requestCancelled || (owner && (owner.messageId !== messageId || owner.stopped)) ||
    (busy && !owner) || messages.slice(1).some(message =>
      (message.turnId || (message.role === "bot" && message.kind === "text")) && message.requestMessageId !== messageId) ||
    (!busy && !waiting && (messages[0].requestPending !== false || !latestTerminal?.turnSucceeded || latestTurn?.turnId !== latestTerminal.turnId ||
      latestOutcome?.turnSucceeded !== true || (owner && owner.turnId !== latestTerminal.turnId)));
  const snapshot = {
    messageId, activeLeafId,
    phase: untracked ? "untracked" : waiting ? "waiting" : busy ? "working" : "settled",
    activeTurnId: busy ? owner?.turnId ?? null : null,
    executionId: owner?.generation ?? null,
    messages: messages.map(slimMessage),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 1024 * 1024) {
    throw Object.assign(new Error("Open this request in the workspace; its transcript exceeds the response limit"), { status: 413 });
  }
  return snapshot;
}

/** A durable completion fence, not a replay queue. If the process dies while
 * a Chief is awaiting results, its earlier handoff must not become a final. */
function settleTrackedRequest(threadId: string): void {
  const owner = directRequestOwners.get(threadId);
  const bot = store.botByThread(threadId);
  if (!owner?.messageId || owner.stopped || !bot || threadBusy(bot.id, threadId) ||
      [...pendingTeamSetupResumes().values()].some(entry => entry.request.threadId === threadId)) return;
  const path = store.activePath(threadId);
  const source = path.findLast((message: any) => message.role === "user");
  if (source?.id !== owner.messageId || source.requestCancelled || source.requestPending !== true) return;
  const messages = path.slice(path.indexOf(source) + 1);
  const terminal = messages.findLast((message: any) => message.turnTerminal && message.role === "bot" && message.kind === "text");
  if (messages.some(requestNeedsInput) || terminal?.requestMessageId !== source.id || !terminal.turnSucceeded ||
      terminal.turnId !== owner.turnId || messages.findLast((message: any) => message.turnId)?.turnId !== terminal.turnId ||
      messages.findLast((message: any) => message.turnSucceeded !== undefined)?.turnSucceeded !== true) return;
  store.patchMessage(threadId, source.id, { requestPending: false });
}

/** A bounded page centred on a known message, used when a search result is
 * opened on a client that only hydrated the newest part of the transcript. */
function messageWindow(threadId: string, messageId: string, limit: number) {
  const all = store.messagesFor(threadId);
  const index = all.findIndex((message: any) => message.id === messageId);
  if (index < 0) return null;
  const before = Math.floor((limit - 1) / 2);
  const start = Math.max(0, Math.min(index - before, all.length - limit));
  const stop = Math.min(all.length, start + limit);
  return { messages: all.slice(start, stop).map(slimMessage), hasMore: start > 0 };
}


  return {
    DEFAULT_PAGE,
    guardedRequestSnapshot,
    messagePage,
    messageWindow,
    pageSize,
    publicBot,
    publicBotQueuedMessages,
    settleTrackedRequest,
    slimMessage,
    wireBot,
    wireTask,
  };
}
