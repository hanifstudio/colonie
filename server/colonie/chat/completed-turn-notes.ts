// What a finished turn writes down: one capture-queue entry for the memory
// upkeep pass, and one line in the bot's daily log.
//
// Both are turn.completed folds that run under the person's own words only —
// never an ignored provider event, a room, a turn another bot or the harness
// started, or a failed turn — and both must never fail the turn: a missing
// note is swallowed with a warning.
import { isColonieAcpDriver } from "../../../shared/acp.ts";
import type { RuntimeEvent } from "../../contracts.ts";
import type { Message } from "../../persistence/store.ts";
import { turnOutcomeLine } from "../../recent-work.ts";
import { extractTurnImages } from "./turn-images.ts";
import { upkeepEnabled } from "../memory/memory-upkeep.ts";
import { appendMemoryLog, memorySourceLabel } from "../workspace/workspace.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface CompletedTurnNotesDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

/** Register the two folds, in the order they have always run. */
export function registerCompletedTurnNotes(deps: CompletedTurnNotesDeps): void {
  const {
    bus, isInternalTurn, isUnattended, memoryUpkeep, routines, shouldIgnoreProviderEvent, store
  } = deps;

// A finished 1:1 turn of an upkeep bot waits for capture. Only the person's
// own conversation: not a room, not a turn another bot or the harness
// started (its "user" line is not the person), not a failed turn.
bus.subscribe((event: RuntimeEvent) => {
  if (shouldIgnoreProviderEvent(event)) return;
  if (event.type !== "turn.completed" || !event.turnId || !event.ok) return;
  try {
    const bot = store.botByThread(event.threadId);
    if (!bot || isColonieAcpDriver(event.provider) || !upkeepEnabled(bot) || isInternalTurn(event.threadId)
      || isUnattended(bot.id, event.threadId) || routines()?.runForThread(event.threadId)) return;
    const path = store.activePath(event.threadId);
    const replyAt = path.findLastIndex((message: Message) => message.role === "bot" && message.kind === "text" && message.turnId === event.turnId);
    if (replyAt < 0) return;
    const asked = path.slice(0, replyAt).findLast((message: Message) => message.role === "user" && message.kind === "text");
    if (!asked || asked.peerAsk) return;
    memoryUpkeep().noteTurn(bot.id, event.threadId, {
      person: extractTurnImages(asked.text ?? "").text,
      bot: path[replyAt]!.text ?? "",
      owner: !asked.sender,
    });
  } catch (error) {
    console.warn(`memory upkeep: could not queue a turn for capture: ${(error as Error).message}`);
  }
});

// One line per finished turn in the bot's daily log (server/recent-work.ts):
// what it said last, the tools it used, whether the turn failed. What a bot
// did in one conversation was invisible from every other; the log is where
// session_search finds it later, and it is never loaded whole into a
// prompt. In a room the reply names its speaker; a room turn that never
// replied has no one to credit and leaves no line.
bus.subscribe((event: RuntimeEvent) => {
  if (shouldIgnoreProviderEvent(event)) return;
  if (event.type !== "turn.completed" || !event.turnId) return;
  try {
    const messages = store.messagesFor(event.threadId);
    const reply = messages.findLast((message: Message) => message.role === "bot" && message.kind === "text" && message.turnId === event.turnId);
    const bot = store.botByThread(event.threadId) ?? (reply?.from ? store.bot(reply.from.botId) : undefined);
    if (!bot || isColonieAcpDriver(event.provider) || bot.memoryEnabled === false) return;
    const tools = messages
      .filter((message: Message) => message.kind === "activity" && message.turnId === event.turnId && message.tool?.name)
      .map((message: Message) => message.tool!.name);
    const line = turnOutcomeLine({ ok: event.ok, reply: reply?.text, stopReason: event.stopReason, tools });
    if (!line) return;
    const writeLine = () => appendMemoryLog(bot.id, line, {
      source: memorySourceLabel({
        task: store.taskByThread(bot.id, event.threadId),
        threadId: event.threadId,
      }),
    });
    writeLine();
  } catch {
    // a missing note never fails a turn
  }
});
}
