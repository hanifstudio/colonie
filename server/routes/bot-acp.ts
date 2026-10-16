// The two ACP inspector routes, moved out of server/index.ts's inline routes
// into the route table (server/routes/README.md). The table runs after the auth
// gate, so the handler is already authenticated; scope rules stay keyed by path
// in server/request-auth.ts.
//
// Both are read-only views of what a thread's ACP boundary is doing: the tool
// receipts a turn has produced, and the reply currently streaming out of the
// adapter. index.ts supplies the adapter's live reply instead of this module
// importing AcpRuntime, so the type-stripped server needs no driver import here.
import { PASS, type RouteHandler } from "./table.ts";

export interface BotAcpRouteDeps {
  /** The bot record for an id, or nothing when there is none. */
  bot(id: string): { id: string; threadId: string; modelSelection: { instanceId: string } } | null | undefined;
  /** Whether that thread is one of the bot's own. */
  hasThread(botId: string, threadId: string): boolean;
  /** The ACP tool receipts recorded for a thread. */
  inputReceipts(threadId: string): unknown[];
  /** The adapter's live reply for a thread, or null when it has none.
   * `fallbackInstanceId` is the bot's own engine selection, used when the
   * thread has no live session of its own. */
  liveReply(botId: string, threadId: string, fallbackInstanceId: string): unknown;
}

export function createBotAcpRoutes(deps: BotAcpRouteDeps): RouteHandler {
  return async ({ res, path, url, method, json }) => {
    /** scratch for route matches, shared by both guards below */
    let m: RegExpMatchArray | null = null;
    m = path.match(/^\/api\/bots\/([\w-]+)\/acp-inputs$/);
    if (m && method === "GET") {
      const bot = deps.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const threadId = url.searchParams.get("threadId") ?? bot.threadId;
      if (!deps.hasThread(bot.id, threadId)) return json(res, 404, { error: "no such thread" });
      return json(res, 200, { receipts: deps.inputReceipts(threadId) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/acp-live$/);
    if (m && method === "GET") {
      const bot = deps.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const threadId = url.searchParams.get("threadId") ?? bot.threadId;
      if (!deps.hasThread(bot.id, threadId)) return json(res, 404, { error: "no such thread" });
      return json(res, 200, { reply: deps.liveReply(bot.id, threadId, bot.modelSelection.instanceId) });
    }
    return PASS;
  };
}