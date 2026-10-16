// The Computer engine is gone. It ran a whole turn on a hosted agent. Every
// bot now keeps its own engine and uses a computer as a tool. This file is the
// one place that still knows the removed engine's names, so settings saved
// before the removal can be moved off it, once, on every kind of server
// (moveOffComputerEngine in index.ts, Store.retireInstances).
import type { InstanceConfigMap } from "./contracts.ts";

/** The removed engine's driver kind ("boxAgent" was Boat's historical name). */
export const REMOVED_COMPUTER_DRIVER = "boxAgent";
/** The instance id every default fleet gave it. */
const REMOVED_COMPUTER_INSTANCE = "computer";

/** Instance ids that named the Computer engine. A saved fleet may hold the
 * default id or one of its own; an id the person reused for another engine
 * is theirs and stays. */
export function removedComputerInstanceIds(saved: InstanceConfigMap | undefined): Set<string> {
  const ids = new Set<string>();
  const reused = saved && Object.hasOwn(saved, REMOVED_COMPUTER_INSTANCE) &&
    saved[REMOVED_COMPUTER_INSTANCE]!.driver !== REMOVED_COMPUTER_DRIVER;
  if (!reused) ids.add(REMOVED_COMPUTER_INSTANCE);
  for (const [id, entry] of Object.entries(saved ?? {})) {
    if (entry.driver === REMOVED_COMPUTER_DRIVER) ids.add(id);
  }
  return ids;
}

/** A fleet without the removed engine: a saved entry for it is dropped, so
 * it is never offered and the next save leaves it off disk. */
export function withoutComputerEngine(map: InstanceConfigMap): InstanceConfigMap {
  for (const [id, entry] of Object.entries(map)) {
    if (entry.driver === REMOVED_COMPUTER_DRIVER) delete map[id];
  }
  return map;
}

/** One conversation told about the move (Store.retireInstances): its engine, or its bot's, was the removed one. */
export interface ComputerEngineMove {
  botId: string;
  threadId: string;
  /** "bot": the bot's own engine moved, told in its open conversation;
   * "conversation": only this conversation's engine did; "bot-only": the
   * bot's own engine moved, told in its open conversation, which has an
   * engine of its own and keeps it. */
  scope: "bot" | "conversation" | "bot-only";
  /** Its permissions went back to Ask, as on any switch to another engine
   * ("bot-only": the bot's own did; the conversation keeps its level). */
  askNow: boolean;
}

/** The line a moved conversation shows, in plain words. It names the removed
 * choice as people saw it in the model list ("Computer", not the panel's
 * Computer tab) and says when the permissions went back to Ask. */
export function computerEngineMoveText(
  move: Pick<ComputerEngineMove, "scope" | "askNow">,
  botName: string,
  engine: string,
): string {
  const removed = "The Computer choice in the model list was removed.";
  const head = move.scope === "conversation" ? `This conversation now uses ${engine}.`
    : move.scope === "bot-only" ? `${botName} now uses ${engine}; this conversation keeps its own model.`
    : `${botName} now uses ${engine}.`;
  const ask = !move.askNow ? ""
    : move.scope === "bot-only" ? ` ${botName}'s permissions are now Ask, but this conversation's stay as they were.`
    : " Its permissions are now Ask.";
  return `${head} ${removed}${ask}`;
}

/** Writes each moved conversation's line. The move is saved by then, so a
 * later try never finds these conversations again: a line that fails is
 * logged, and every other line is still written. */
export function writeComputerEngineMoveLines(moves: readonly ComputerEngineMove[], write: (move: ComputerEngineMove) => void): void {
  for (const move of moves) {
    try {
      write(move);
    } catch (error) {
      console.warn(`[engines] the Computer engine move line for ${move.threadId} was not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
