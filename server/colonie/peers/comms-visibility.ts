// Bot⇄bot comms visibility: the per-thread chips that make a peer exchange
// observable. Shared by /api/internal/ask-bot and delegations (delegate_bot).
// Rooms and pair channels are retired, so no channel is created or written;
// stored channels stay on disk untouched.

import type { BotRecord, Message, Store } from "../../persistence/store.ts";

/** What a peer-exchange helper needs from the outside world:
 * the store (for persisted messages) and the SSE broadcasters
 * so chat clients see the change without waiting for a refresh. */
export interface CommsBus {
  store: Store;
  /** SSE broadcast (kind: "message" envelope). */
  broadcast: (payload: Record<string, unknown>) => void;
  /** Whether the bot can start one more direct thread right now. A bot runs
   * several threads at once, so "busy" is not "full": a fresh-thread handoff
   * asks this instead of the bot's busy flag. Absent (tests) = busy flag. */
  threadSlotFree?: (botId: string) => boolean;
  /** Whether a turn can land in the bot's standing thread right now — the
   * same admission startTurn applies to a direct thread: that thread free, a
   * free capacity slot, and no live group turn. A classic delegation asks
   * this instead of the whole-bot busy flag, which is true whenever ANY
   * thread is working. Absent (tests) = busy flag. */
  canAdmitDirectTurn?: (botId: string, threadId: string) => boolean;
}

/** Drop a chip into both bots' threads for `from`'s outgoing message. The
 * chips are what make bot-to-bot turns observable — those turns cost the user
 * tokens, and a hidden exchange is exactly the kind of mistake peer
 * coordination is supposed to avoid. */
export function mirrorExchange(
  bus: CommsBus,
  from: BotRecord,
  target: BotRecord,
  sourceThreadId = from.threadId,
): void {
  const note = (threadId: string, m: Omit<Message, "id" | "at">) => bus.store.appendMessage(threadId, m);
  note(sourceThreadId, { role: "bot", kind: "activity", tool: { name: `Messaged @${target.name}` } });
  note(target.threadId, { role: "bot", kind: "activity", tool: { name: `Message from @${from.name}` } });
}
