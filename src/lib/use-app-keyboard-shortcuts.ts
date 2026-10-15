/** The app's one global shortcut listener, lifted out of App.tsx unchanged so
 * a second shell (the account workspace) can mount the same behavior instead
 * of re-implementing it. Bindings are exactly App's original ones:
 * ⌘/ or ? opens the cheat sheet · ⌘N new bot · ⌘1–9 jump · ⌘⇧[ / ⌘⇧] prev/next. */
import { useEffect, type Dispatch } from "react";
import type { Action, Bot } from "@/state/store";
import { shouldOpenKeyboardShortcuts } from "@/lib/keyboard-shortcuts";

export interface AppKeyboardShortcuts {
  /** Every bot; hidden ones are excluded here, as the listener always did. */
  bots: readonly Bot[];
  /** The current selection, for prev/next. */
  selectedId: string;
  /** While the cheat sheet is open, the listener stays out of the way. */
  shortcutsOpen: boolean;
  dispatch: Dispatch<Action>;
}

/** Kept deliberately small; every panel already closes on Esc. */
export function useAppKeyboardShortcuts({ bots, selectedId, shortcutsOpen, dispatch }: AppKeyboardShortcuts): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || shortcutsOpen) return;
      if (shouldOpenKeyboardShortcuts(event)) {
        event.preventDefault();
        dispatch({ type: "toggleShortcuts", open: true });
        return;
      }

      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const visible = bots.filter((bot) => !bot.hidden);
      if (event.key === "n" && !event.shiftKey) {
        event.preventDefault();
        dispatch({ type: "toggleNewBot", open: true });
      } else if (/^[1-9]$/.test(event.key)) {
        const target = visible[Number(event.key) - 1];
        if (target) {
          event.preventDefault();
          dispatch({ type: "select", id: target.id });
        }
      } else if (event.shiftKey && (event.key === "[" || event.key === "]")) {
        const index = visible.findIndex((bot) => bot.id === selectedId);
        const next = visible[(index + (event.key === "]" ? 1 : -1) + visible.length) % visible.length];
        if (next) {
          event.preventDefault();
          dispatch({ type: "select", id: next.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bots, selectedId, shortcutsOpen, dispatch]);
}