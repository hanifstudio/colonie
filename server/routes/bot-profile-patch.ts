// The paired-safe profile edit: the fields a phone may change about a bot's
// persona, validated and normalised exactly like the broad desktop edit.
import { parseBotProfilePatch } from "../colonie/bots/bot-profile.ts";
import type { BotRecord, Store } from "../persistence/store.ts";
import { profileSnapshot } from "../profile-revision.ts";
import { recordProfileChange } from "../profile-versions.ts";
import type { WireBot } from "../../shared/wire.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotProfilePatchRouteDeps {
  store: Store;
  storedAvatarExists: (avatarUrl: string) => boolean;
  wireBot: (bot: BotRecord) => WireBot;
  broadcast: (payload: Record<string, unknown>) => void;
}

export function createBotProfilePatchRoutes(deps: BotProfilePatchRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (!path.startsWith("/api/bots/") || !path.endsWith("/profile")) return PASS;
    const match = path.match(/^\/api\/bots\/([\w-]+)\/profile$/);
    if (match && method === "PATCH") {
      const parsed = parseBotProfilePatch(await readBody(req), true);
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      if (parsed.patch.avatarUrl && !deps.storedAvatarExists(parsed.patch.avatarUrl)) {
        return json(res, 400, { error: "avatarUrl must reference an existing stored image" });
      }
      const existingBot = deps.store.bot(match[1]);
      const beforeProfile = existingBot ? profileSnapshot(existingBot) : undefined;
      const bot = deps.store.patchBotProfile(match[1], parsed.patch);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (beforeProfile) recordProfileChange(bot.id, "user", "api", beforeProfile, profileSnapshot(bot));
      const visible = deps.wireBot(bot);
      deps.broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }
    return PASS;
  };
}