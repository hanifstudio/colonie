// When a bot starts using its browser or its computer, its panel opens by itself
// where the person is watching it work, as Hermes' "Open Screen when the bot
// uses it" does: once per turn, so a panel they closed stays closed until the
// bot's next run, and never over a panel already open.
export type BrowserUse = { botId: string; threadId: string; turn: string; conversationId?: string };

export function shouldOpenBrowserPanel(
  view: { selectedId?: string | null; selectedConversationId?: string | null; computerOpen: boolean },
  use: BrowserUse,
  lastTurn: string | undefined,
): boolean {
  const watching = use.conversationId ? view.selectedConversationId === use.conversationId
    : !view.selectedConversationId && view.selectedId === use.botId;
  return watching && !view.computerOpen && lastTurn !== use.turn;
}
