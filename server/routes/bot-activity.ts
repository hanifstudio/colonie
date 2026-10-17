// A bot's activity and its outbound allowance.
//
// Activity is read-only over the same two logs as the inspector and the
// decision route: the bot's own threads (its DM and every task) carry the tool
// runs, and the decision log carries the bot's requests wherever they happened,
// since those rows name the bot. Outbound is the policy and how much of it the
// bot has spent today.
import { DATA_DIR, EVENTS_DIR } from "../config.ts";
import { readBotActivity } from "../activity.ts";
import type { Store } from "../persistence/store.ts";
import type { OutboundCounts } from "../outbound-counts.ts";
import { DEFAULT_OUTBOUND_POLICY } from "../../shared/outbound.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotActivityRouteDeps {
  store: Store;
  outboundCounts: OutboundCounts;
}

export function createBotActivityRoutes(deps: BotActivityRouteDeps): RouteHandler {
  return async ({ res, url, path, method, json }) => {
    const activity = path.match(/^\/api\/bots\/([\w-]+)\/activity$/);
    if (activity && method === "GET") {
      const bot = deps.store.bot(activity[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        return json(res, 400, { error: "limit must be a positive whole number" });
      }
      const threadIds = [...new Set([bot.threadId, ...deps.store.tasks(bot.id).map((task) => task.threadId)])];
      return json(res, 200, {
        rows: readBotActivity({ dataDir: DATA_DIR, eventsDir: EVENTS_DIR, botId: bot.id, threadIds, limit: parsedLimit ?? 300 }),
      });
    }

    const outbound = path.match(/^\/api\/bots\/([\w-]+)\/outbound$/);
    if (outbound && method === "GET") {
      const bot = deps.store.bot(outbound[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { policy: bot.outbound ?? DEFAULT_OUTBOUND_POLICY, today: deps.outboundCounts.today(bot.id) });
    }
    return PASS;
  };
}