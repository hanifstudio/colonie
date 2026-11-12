import { useSyncExternalStore } from "react";

/** Which tab a bot is working in right now, from the server's "this turn started using it"
 * notice. It tells the panel where to put the live dot. It only counts while the bot is busy. */
export type Working = "screen" | "browser";
let current: Record<string, { turn: string; at: Working }> = {};
const listeners = new Set<() => void>();
const emit = () => { current = { ...current }; for (const listener of listeners) listener(); };

export function noteBotSurface(botId: string, turn: string, at: Working): void {
  if (current[botId]?.turn === turn && current[botId]?.at === at) return;
  current[botId] = { turn, at };
  emit();
}

/** The tab the bot is working in, or none when it is idle or has not used either yet this turn. */
export function useWorkingTab(botId: string, busy: boolean): Working | null {
  const at = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current[botId]?.at ?? null);
  return busy ? at : null;
}

/** Test seam. */
export function resetBotSurface(): void { current = {}; listeners.clear(); }
