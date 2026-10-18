// The automatic-recall block a turn is prefixed with: autoRecallPrompt builds it from the bot's notes and (only for a conversation the person started) its other chats via buildRecall, returning "" whenever memory is off; withRecalled joins it to the message.
import { type BotRecord } from "../../persistence/store.ts";
import { buildRecall } from "../../colonie/memory/recall.ts";
import { autoRecallEnabled } from "../../config.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface RecallPromptDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createRecallPrompt(deps: RecallPromptDeps) {
  const {
    cfg, store
  } = deps;
/** The automatic-recall block for a turn (server/colonie/memory/recall.ts), or "". Notes
 * always; the bot's other conversations only when `conversations` — a 1:1
 * turn the person started — because a message from another bot, a webhook
 * or a room must not be able to pull a private chat into its reply. The
 * conversations are the ones session_search would search, minus this one. */
function autoRecallPrompt(bot: BotRecord, threadId: string, message: string, opts: { conversations: boolean; userName: string }): string {
  if (bot.memoryEnabled === false || !autoRecallEnabled(cfg)) return "";
  const threadIds = opts.conversations
    ? [...new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)])]
      .filter((id) => id !== threadId)
    : [];
  try {
    const recalled = buildRecall({
      botId: bot.id,
      message,
      threadIds,
      label: (id) => {
        const task = store().taskByThread(bot.id, id);
        if (task) return `chat ${JSON.stringify(task.title)}`;
        return id === bot.threadId ? "your main chat" : "an earlier chat";
      },
      author: (hit) => (hit.role === "user" ? hit.peer ?? opts.userName : hit.from ?? bot.name),
    });
    if (recalled) console.log(`auto-recall: ${bot.name} (${bot.id}) got ${recalled.notes} note and ${recalled.conversations} conversation passage(s) in ${threadId}`);
    return recalled?.text ?? "";
  } catch (err) {
    console.warn(`auto-recall failed for ${bot.id}: ${(err as Error).message}`);
    return "";
  }
}

/** The recalled block in front of a turn's message, or the message alone. */
function withRecalled(recalled: string, text: string): string {
  return recalled ? `${recalled}\n\n${text}` : text;
}

  return {
    autoRecallPrompt,
    withRecalled,
  };
}
