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

/** The tab the panel shows. The Computer panel shows the bot's computer
 * (owner, October 29, as in OpenMausBot): a bot with a desktop sees
 * Desktop | Files and browses on that desktop; a bot without one sees
 * Browser | Files. Advanced keeps Desktop | Routines | Android | Browser.
 * A view stored by the other mode or for the other kind of bot reads as the
 * one this bot has (its files when it has neither) instead of an empty pane. */
export function shownComputerPanelView(stored: ComputerPanelView, options: { advanced: boolean; hasDesktop: boolean; browser: boolean }): ComputerPanelView {
  if (options.advanced) return stored === "files" ? "computer" : stored;
  const simple = stored === "routines" || stored === "android" ? "computer" : stored;
  if (options.hasDesktop) return simple === "browser" ? "computer" : simple;
  return simple === "computer" ? (options.browser ? "browser" : "files") : simple;
}

/** Whether Simple mode offers the Browser tab: only to a bot without a desktop. */
export function offersBrowserTab(options: { advanced: boolean; hasDesktop: boolean }): boolean {
  return options.advanced || !options.hasDesktop;
}
