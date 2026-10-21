// Marking a bot's conversation as read. The client says which thread it read;
// a client session that leaves that out is held to the pinned-thread rule. A
// Shared workspace names the person's own conversation when none is given.
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, Store } from "../persistence/store.ts";
import type { WireBot } from "../../shared/wire.ts";
import { pinnedClientThread } from "./pinned-client.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotReadRouteDeps {
  store: Store;
  requestedTaskBot: (botId: string, rawThreadId: unknown, auth: RequestAuth) => BotRecord;
  wireBot: (bot: BotRecord) => WireBot;
  broadcast: (payload: Record<string, unknown>) => void;
  /** Whether this is a Shared workspace, where the pin rule does not apply. */
  shared?: () => boolean;
}

export function createBotReadRoutes(deps: BotReadRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/bots/") || !path.endsWith("/read")) return PASS;
    const match = path.match(/^\/api\/bots\/([\w-]+)\/read$/);
    if (match && method === "POST") {
      const body = await readBody(req);
      pinnedClientThread({ auth, store: deps.store, shared: deps.shared })(match[1], body?.threadId);
      const current = deps.requestedTaskBot(match[1], body?.threadId, auth);
      deps.store.patchTask(current.id, current.threadId, { unread: false });
      const bot = deps.store.bot(current.id)!;
      const visible = deps.wireBot(bot);
      deps.broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }
    return PASS;
  };
}
