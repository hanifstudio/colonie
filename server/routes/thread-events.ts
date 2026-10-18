// Inspector: a thread's runtime events and native protocol tee. Both logs
// already exist on disk; this only reads them back. Threads belong to bots or
// rooms — anything else is not a thread this server knows.
import type { Store } from "../persistence/store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ThreadEventsRouteDeps {
  store: Store;
  eventsDir: string;
  nativeDir: string;
  readThreadEvents: (input: { eventsDir: string; nativeDir: string; threadId: string; limit: number | undefined }) => unknown;
}

export function createThreadEventsRoutes(deps: ThreadEventsRouteDeps): RouteHandler {
  return async ({ res, path, method, url, json }) => {
    if (!path.startsWith("/api/threads/") || !path.endsWith("/events")) return PASS;
    const match = path.match(/^\/api\/threads\/([\w-]+)\/events$/);
    if (match && method === "GET") {
      const threadId = match[1];
      const known =
        deps.store.bots.some((bot) => deps.store.tasks(bot.id).some((task) => task.threadId === threadId)) ||
        Boolean(deps.store.groupByThread(threadId));
      if (!known) return json(res, 404, { error: "no such thread" });
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        return json(res, 400, { error: "limit must be a positive whole number" });
      }
      return json(res, 200, deps.readThreadEvents({
        eventsDir: deps.eventsDir,
        nativeDir: deps.nativeDir,
        threadId,
        limit: parsedLimit,
      }));
    }
    return PASS;
  };
}