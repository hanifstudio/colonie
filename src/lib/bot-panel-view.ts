/** The three places in a bot's panel. Screen is the bot's own screen on the workspace's
 * computer; Browser is the built-in browser. Each name always means the same thing. */
export type BotPanelView = "screen" | "browser" | "files";
const VIEWS: readonly BotPanelView[] = ["screen", "browser", "files"];
// a new key: the old panel's "browser" meant the computer, so what was stored then must not carry over
const STORAGE_PREFIX = "colonie-bot-panel-view";

/** The tab a person last chose for this bot, or none yet. */
export function readBotPanelView(botId: string, storage: Pick<Storage, "getItem"> = localStorage): BotPanelView | undefined {
  try {
    const stored = storage.getItem(`${STORAGE_PREFIX}:${botId}`);
    return VIEWS.find((entry) => entry === stored);
  } catch { return undefined; /* Storage may be blocked. */ }
}

export function writeBotPanelView(botId: string, view: BotPanelView, storage: Pick<Storage, "setItem"> = localStorage): void {
  try { storage.setItem(`${STORAGE_PREFIX}:${botId}`, view); } catch { /* The open panel keeps its state. */ }
}

/** Where a panel opens before anyone chose: the Screen, or the Browser where the server cannot run a computer
 * (Shared, for now) and the Screen would only say "not here". Choosing the Screen there still shows it. */
export const firstBotPanelView = (screenAvailable: boolean): BotPanelView => screenAvailable ? "screen" : "browser";
