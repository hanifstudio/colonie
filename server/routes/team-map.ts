// The Live Team Map: who is delegating to whom, right now.
//
// Prompts and replies never leave their transcripts — this projection carries
// only ids, status relationships, optional delegation labels, and timestamps.
// A viewer only ever sees the edges between bots it is already allowed to see,
// so the map cannot leak a hidden bot's existence through its connections.
import type { VisibleSet } from "../colonie/bots/bot-visibility.ts";
import type { Store } from "../persistence/store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TeamMapRouteDeps {
  store: Store;
  visibleFor: (auth: RequestAuth) => VisibleSet;
  /** Queued handoffs, from the delegation queue that owns their TTL. */
  pendingDelegationSnapshot: () => Array<{ sourceBotId: string; toBotId: string; reason?: string }>;
  /** Live delegations by thread id — the run a recipient is working on now. */
  delegationWatch: ReadonlyMap<string, { toBotId: string; sourceBotId?: string }>;
}

export function createTeamMapRoutes(deps: TeamMapRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    if (method !== "GET" || path !== "/api/team-map") return PASS;

    const visible = deps.visibleFor(auth);
    const mapped = new Set(deps.store.bots.filter((bot) => !bot.hidden && visible.bot(bot.id)).map((bot) => bot.id));
    const queued = deps.pendingDelegationSnapshot().flatMap((item) => {
      if (!mapped.has(item.sourceBotId) || !mapped.has(item.toBotId)) return [];
      return [{ sourceBotId: item.sourceBotId, targetBotId: item.toBotId, reason: item.reason }];
    });
    const running = [...deps.delegationWatch.entries()].flatMap(([threadId, watch]) => {
      if (!mapped.has(watch.toBotId)) return [];
      const sourceBotId = watch.sourceBotId;
      if (!sourceBotId || !mapped.has(sourceBotId)) return [];
      return [{ sourceBotId, targetBotId: watch.toBotId, threadId }];
    });
    // Stored DM rooms are retired history, not live connections; the key
    // stays empty so clients that still read it draw no stale edges.
    return json(res, 200, { collaborations: [], queued, running });
  };
}