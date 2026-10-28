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
 * (owner, October 29, as in OpenMausBot): the Computer tab is always there,
 * where a person gives the bot one (Works on) or watches its desktop. A bot
 * with a desktop browses on it, so its Browser view opens the desktop; a bot
 * without one also has the separate Browser tab. Advanced keeps Computer |
 * Routines | Android | Browser. A view stored by the other mode reads as the
 * Computer tab instead of an empty pane. */
export function shownComputerPanelView(stored: ComputerPanelView, options: { advanced: boolean; hasDesktop: boolean }): ComputerPanelView {
  if (options.advanced) return stored === "files" ? "computer" : stored;
  const simple = stored === "routines" || stored === "android" ? "computer" : stored;
  return options.hasDesktop && simple === "browser" ? "computer" : simple;
}

/** Whether Simple mode offers the Browser tab: only to a bot without a desktop. */
export function offersBrowserTab(options: { advanced: boolean; hasDesktop: boolean }): boolean {
  return options.advanced || !options.hasDesktop;
}
