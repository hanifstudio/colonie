// Saved command permissions: exact command + absolute folder + engine, for one
// bot. The owner (or an admin) manages them; the engine only reports whether
// its driver supplies structured command approvals at all.
import { commandAllowlistCandidate } from "../command-allowlist.ts";
import type { BotRecord, Store } from "../persistence/store.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { CommandAllowlistCandidate, CommandAllowlistResponse } from "../../shared/command-allowlist.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface CommandAllowlistRouteDeps {
  store: Store;
  allowlist: {
    add: (botId: string, candidate: CommandAllowlistCandidate) => unknown;
    remove: (botId: string, ruleId: string) => unknown;
  };
  registry: { get: (instanceId: string) => { driverKind?: string } | null | undefined };
  canManage: (auth: RequestAuth) => boolean;
  requestedTaskBot: (botId: string, rawThreadId: unknown, auth: RequestAuth) => BotRecord;
  response: (bot: BotRecord) => CommandAllowlistResponse;
  drivers: Set<string>;
}

export function createCommandAllowlistRoutes(deps: CommandAllowlistRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    if (!path.startsWith("/api/bots/")) return PASS;
    const match = path.match(/^\/api\/bots\/([\w-]+)\/command-allowlist(?:\/([\w-]+))?$/);
    if (!match) return PASS;
    if (!deps.canManage(auth)) return json(res, 403, { error: "Only the owner or an admin can manage command permissions." });
    const bot = deps.requestedTaskBot(match[1], url.searchParams.get("threadId") ?? undefined, auth);
    if (method === "GET" && !match[2]) return json(res, 200, deps.response(bot));
    if (method === "POST" && !match[2]) {
      const candidate = commandAllowlistCandidate(await readBody(req));
      if (!candidate) return json(res, 400, { error: "Enter an exact command without secret values, an absolute working folder, and a provider." });
      const instance = deps.registry.get(candidate.providerInstanceId);
      if (!instance || !deps.drivers.has(instance.driverKind ?? "")) {
        return json(res, 400, { error: "This provider does not supply structured command approvals." });
      }
      deps.allowlist.add(bot.id, candidate);
      return json(res, 200, deps.response(bot));
    }
    if (method === "DELETE" && match[2]) {
      deps.allowlist.remove(bot.id, match[2]);
      return json(res, 200, deps.response(bot));
    }
    return json(res, 405, { error: "Unsupported command allowlist operation" });
  };
}