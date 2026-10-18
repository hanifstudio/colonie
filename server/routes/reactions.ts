// Emoji reactions on a message, in any thread (1:1 or room).
import type { Store } from "../persistence/store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ReactionRouteDeps {
  store: Store;
}

export function createReactionRoutes(deps: ReactionRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (!path.startsWith("/api/threads/") || !path.endsWith("/reactions")) return PASS;
    const match = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/reactions$/);
    if (match && method === "POST") {
      const body = await readBody(req);
      const emoji = String(body.emoji ?? "").slice(0, 8);
      if (!emoji) return json(res, 400, { error: "emoji required" });
      const patched = deps.store.toggleReaction(match[1], match[2], emoji, typeof body.by === "string" ? body.by : "user");
      if (!patched) return json(res, 404, { error: "no such message" });
      return json(res, 200, { message: patched });
    }
    return PASS;
  };
}