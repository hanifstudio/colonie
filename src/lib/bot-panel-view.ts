export type BotPanelView = "browser" | "files";
const STORAGE_PREFIX = "colonie-computer-panel-view";

export function readBotPanelView(botId: string, storage: Pick<Storage, "getItem"> = localStorage): BotPanelView {
  try { if (storage.getItem(`${STORAGE_PREFIX}:${botId}`) === "files") return "files"; } catch { /* Storage may be blocked. */ }
  return "browser";
}

export function writeBotPanelView(botId: string, view: BotPanelView, storage: Pick<Storage, "setItem"> = localStorage): void {
  try { storage.setItem(`${STORAGE_PREFIX}:${botId}`, view); } catch { /* The open panel keeps its state. */ }
}
