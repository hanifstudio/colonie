// What a conversation-level request may reach: which reply a composer action
// targets, which host folders a bot's own files may be read from, whether a
// thread belongs to the sender at all, and whether one more proposal card may
// be opened on it.
//
// These four answer from the same store facts (the thread's bot or room and
// its tasks), so they live together; the header of each says what it refuses.
import { ATTACHMENTS_DIR } from "../../colonie/chat/attachments.ts";
import { messageFileRoots } from "../../colonie/chat/message-file.ts";
import { workspaceDir } from "../../colonie/workspace/workspace.ts";
import type { Message } from "../../persistence/store.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface ConversationSourcesDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createConversationSources(deps: ConversationSourcesDeps) {
  const {
    fullAccessForSource, store
  } = deps;

function resolveReplyTarget(threadId: string, value: unknown): Message | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw Object.assign(new Error("replyToId must be a message id"), { status: 400 });
  const target = store.messagesFor(threadId).find((message: Message) => message.id === value);
  if (!target || target.kind !== "text" || !target.text?.trim()) {
    throw Object.assign(new Error("the message being replied to is no longer available"), { status: 404 });
  }
  return target;
}

/** The host folders a bot's own files may be read from in one conversation:
 * the conversation's pinned or configured working folder, the bot's own
 * workspace, and the private attachment store. */
function messageFileRootsForThread(senderId: string, threadId: string): string[] {
  const directBot = store.botByThread(threadId);
  const group = directBot ? undefined : store.groupByThread(threadId);
  let pinnedCwd: string | null | undefined;
  let configuredCwd: string | undefined;
  if (directBot) {
    pinnedCwd = store.taskByThread(directBot.id, threadId)?.cwd;
    configuredCwd = directBot.cwd;
  } else if (group) {
    const task = store.groupTaskByThread(group.id, threadId);
    pinnedCwd = task ? task.pinnedCwd : group.threadId === threadId ? group.pinnedCwd : undefined;
    configuredCwd = group.cwd;
  }
  return messageFileRoots({
    senderWorkspace: workspaceDir(senderId),
    attachments: ATTACHMENTS_DIR,
    pinnedCwd,
    configuredCwd,
  });
}

function connectorThread(botId: string, threadId: string) {
  const bot = store.bot(botId);
  if (!bot) return null;
  if (bot.threadId === threadId) return { bot }; // a bot's own main chat
  if (store.taskByThread(botId, threadId)) return { bot };
  // A stored room thread is read-only history: no bot tool writes into it.
  return null;
}

/** `opensCard` false for a change that applies directly: it adds no open
 * card, so the open-card budget does not hold it back. */
function proposalPersistence(botId: string, threadId: string, opensCard = true) {
  if (!store.bot(botId)) {
    return { ok: false as const, status: 403, error: "unknown sender" };
  }
  if (!connectorThread(botId, threadId)) {
    return { ok: false as const, status: 403, error: "source conversation does not belong to sender" };
  }
  if (!opensCard || fullAccessForSource(botId, threadId)) return { ok: true as const };
  // Only cards on the visible branch can be acted on from the composer.
  // Abandoned branches must not permanently consume the proposal quota.
  // Routine, profile, default-model and team-setup proposals
  // share one budget per bot per thread, so one thread cannot pile up 8 of each.
  const openRequests = store.activePath(threadId).filter(
    (message: Message) =>
      (message.card?.routineRequest?.botId === botId || message.card?.profileRequest?.botId === botId || message.card?.modelRequest?.botId === botId || message.card?.teamSetupRequest?.botId === botId) &&
      !message.card.answered &&
      !message.card.dismissed && !message.card.expired,
  ).length;
  return openRequests >= 8
    ? { ok: false as const, status: 429, error: "confirm or cancel an existing proposal first" }
    : { ok: true as const };
}

return { resolveReplyTarget, messageFileRootsForThread, connectorThread, proposalPersistence };
}
