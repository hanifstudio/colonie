// "files" is a Simple-mode tab; Advanced mode reads it back as "computer".
export type ComputerPanelView = "computer" | "android" | "browser" | "routines" | "files";

const STORAGE_PREFIX = "colonie-computer-panel-view";

function storageKey(botId: string): string {
  return `${STORAGE_PREFIX}:${botId}`;
}

export function readComputerPanelView(
  botId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): ComputerPanelView {
  try {
    const value = storage.getItem(storageKey(botId));
    if (value === "android" || value === "browser" || value === "routines" || value === "files") return value;
  } catch {
    // Storage can be unavailable in hardened or private renderer sessions.
  }
  return "computer";
}

export function writeComputerPanelView(
  botId: string,
  view: ComputerPanelView,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(storageKey(botId), view);
  } catch {
    // The in-memory React state still preserves the choice for this mount.
  }
}

/** The tab the panel shows. One Computer panel shows what the bot uses
 * (owner, October 28): Simple mode is Browser | Files, plus Desktop only for
 * a bot that has one; Advanced keeps Desktop | Routines | Android | Browser.
 * A view stored by the other mode, or a desktop the bot does not have, reads
 * as the bot's browser (its files when it has no browser) instead of an
 * empty pane. */
export function shownComputerPanelView(stored: ComputerPanelView, options: { advanced: boolean; hasDesktop: boolean; browser: boolean }): ComputerPanelView {
  if (options.advanced) return stored === "files" ? "computer" : stored;
  const simple = stored === "routines" || stored === "android" ? "computer" : stored;
  return simple === "computer" && !options.hasDesktop ? (options.browser ? "browser" : "files") : simple;
}
