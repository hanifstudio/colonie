// Bots whose browser a person opened from a sign-in card (SignInAsk): while
// the card waits, the person keeps control of that browser instead of it
// going back to the bot after a few idle seconds, as OpenMausBot does.
import { useSyncExternalStore } from "react";

const helping = new Set<string>();
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };

export function startBrowserHelp(botId: string): void { if (!helping.has(botId)) { helping.add(botId); changed(); } }
export function endBrowserHelp(botId: string): void { if (helping.delete(botId)) changed(); }

export function useBrowserHelp(botId: string): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => helping.has(botId),
  );
}
