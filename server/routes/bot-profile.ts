// One bot's standing instructions and the history of editing them: SOUL.md as
// the record holds it, the file beside it on disk (which a person or another
// tool may have changed), and the rollback.
//
// Every write here is optimistic: the client sends the revision it read, and a
// mismatch is a 409 with "reload and look again" rather than a guess. Writes
// queue in profile-versions.ts and land asynchronously, so a client reading
// history right after causing a change sees its own row (flushProfileHistory).
import type { Store } from "../persistence/store.ts";
import type { BotRecord } from "../persistence/store.ts";
import type { WireBot } from "../../shared/wire.ts";
import { readSoulDrift, soulFile, writeSoulMirror } from "../colonie/bots/bot-folder.ts";
import { parseBotProfilePatch } from "../colonie/bots/bot-profile.ts";
import { profileRevision, profileSnapshot } from "../profile-revision.ts";
import { flushProfileHistory, readHistory, recordProfileChange } from "../profile-versions.ts";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotProfileRouteDeps {
  store: Store;
  wireBot: (bot: BotRecord) => WireBot;
  broadcast: (event: { kind: "bot"; bot: WireBot }) => void;
  previewSystemPrompt: (bot: BotRecord) => unknown;
  botOverview: (bot: BotRecord) => Promise<unknown>;
}

export function createBotProfileRoutes(deps: BotProfileRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, json, readBody }) => {
    const soul = /^\/api\/bots\/([\w-]+)\/soul$/.exec(path);
    if (soul && method === "GET") {
      const bot = deps.store.bot(soul[1]!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = bot.soul ?? "";
      const drift = readSoulDrift(bot.id, body, bot.soulHash ?? "");
      return json(res, 200, {
        soul: body,
        revision: profileRevision(bot),
        bytes: Buffer.byteLength(body, "utf8"),
        limit: BOT_PROFILE_LIMITS.soul,
        file: soulFile(bot.id),
        drift: drift.drift,
        ...(drift.drift ? { fileText: drift.fileText } : {}),
      });
    }

    const applyFile = /^\/api\/bots\/([\w-]+)\/soul\/apply-file$/.exec(path);
    if (applyFile && method === "POST") {
      const body = await readBody(req);
      const bot = deps.store.bot(applyFile[1]!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (body?.expectedRevision !== profileRevision(bot)) {
        return json(res, 409, { error: "This bot's profile changed; reload and look again" });
      }
      const drift = readSoulDrift(bot.id, bot.soul ?? "", bot.soulHash ?? "");
      if (!drift.drift) return json(res, 409, { error: "SOUL.md matches the record; nothing to apply" });
      if (typeof body?.fileText !== "string" || body.fileText !== drift.fileText) {
        return json(res, 409, { error: "SOUL.md changed since you read it; reload and look again" });
      }
      // The file is user input like any other: same cap, same error copy.
      const parsed = parseBotProfilePatch({ soul: drift.fileText });
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      // store.bot() returns the live record and setSoul mutates it in place,
      // so the snapshot must be taken before the call — after, `bot` and
      // `updated` are the same object and the diff would always be empty.
      const beforeProfile = profileSnapshot(bot);
      const updated = deps.store.setSoul(bot.id, parsed.patch.soul ?? "");
      if (!updated) return json(res, 404, { error: "no such bot" });
      recordProfileChange(bot.id, "file", "ui", beforeProfile, profileSnapshot(updated));
      const visible = deps.wireBot(updated);
      deps.broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }

    const discardFile = /^\/api\/bots\/([\w-]+)\/soul\/discard-file$/.exec(path);
    if (discardFile && method === "POST") {
      const body = await readBody(req);
      const bot = deps.store.bot(discardFile[1]!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (body?.expectedRevision !== profileRevision(bot)) {
        return json(res, 409, { error: "This bot's profile changed; reload and look again" });
      }
      const drift = readSoulDrift(bot.id, bot.soul ?? "", bot.soulHash ?? "");
      if (!drift.drift || typeof body?.fileText !== "string" || body.fileText !== drift.fileText) {
        return json(res, 409, { error: "SOUL.md changed since you read it; reload and look again" });
      }
      writeSoulMirror(bot.id, bot.soul ?? "");
      const updated = deps.store.patchBot(bot.id, { soulDrift: false }) ?? bot;
      const visible = deps.wireBot(updated);
      deps.broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }

    const systemPrompt = /^\/api\/bots\/([\w-]+)\/system-prompt$/.exec(path);
    if (systemPrompt && method === "GET") {
      const bot = deps.store.bot(systemPrompt[1]!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, deps.previewSystemPrompt(bot));
    }

    const overview = /^\/api\/bots\/([\w-]+)\/overview$/.exec(path);
    if (overview && method === "GET") {
      const bot = deps.store.bot(overview[1]!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, await deps.botOverview(bot));
    }

    const history = /^\/api\/bots\/([\w-]+)\/history$/.exec(path);
    if (history && method === "GET") {
      if (!deps.store.bot(history[1]!)) return json(res, 404, { error: "no such bot" });
      const id = history[1]!;
      // Writes queue in profile-versions.ts and land asynchronously; a client
      // reading history right after causing a change must see its own row.
      await flushProfileHistory(id);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      // A soul row's full before/after can be the entire standing
      // instructions (up to 24,000 bytes) — fine for a rollback, which
      // reads the file server-side, but not for a client that only asked
      // to see what changed. Strip the bodies (keep the byte-count
      // summary) unless the caller explicitly wants them.
      const full = url.searchParams.get("full") === "1";
      const rows = readHistory(id, limit).map((row) => {
        if (full || row.field !== "soul") return row;
        const rest: typeof row = { ...row };
        delete rest.before;
        delete rest.after;
        return rest;
      });
      const bot = deps.store.bot(id);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { rows, revision: profileRevision(bot) });
    }

    const rollback = /^\/api\/bots\/([\w-]+)\/history\/rollback$/.exec(path);
    if (rollback && method === "POST") {
      const body = await readBody(req);
      const id = rollback[1]!;
      // Same flush as the GET route: the row this rollback targets may have
      // been recorded moments ago and not yet reached disk.
      await flushProfileHistory(id);
      const bot = deps.store.bot(id);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (body?.expectedRevision !== profileRevision(bot)) {
        return json(res, 409, { error: "This bot's profile changed; reload history before undoing" });
      }
      const row = typeof body?.id === "string"
        ? readHistory(bot.id, Number.MAX_SAFE_INTEGER).find((r) => r.id === body.id && r.field === "soul")
        : undefined;
      if (!row || row.field !== "soul" || typeof row.before !== "string") {
        return json(res, 400, { error: "rollback is available for SOUL.md entries only" });
      }
      if (!row.canRestore) {
        return json(res, 400, { error: row.restoreUnavailableReason });
      }
      const parsed = parseBotProfilePatch({ soul: row.before });
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      const before = profileSnapshot(bot);
      const updated = deps.store.setSoul(bot.id, parsed.patch.soul ?? "");
      if (!updated) return json(res, 404, { error: "no such bot" });
      recordProfileChange(bot.id, "user", "rollback", before, profileSnapshot(updated));
      const visible = deps.wireBot(updated);
      deps.broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }
    return PASS;
  };
}