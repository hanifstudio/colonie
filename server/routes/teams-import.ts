// Importing a team from a file: a team package, a library package, a bot
// package or a whole-workspace backup, added to the workspace next to what is
// already there or replacing it. The counterpart of teams-export.ts.
import { MAX_TEAM_BACKUP_BYTES } from "../../shared/team-backup.ts";
import type { BotVisibility, ModelSelection } from "../../shared/wire.ts";
import { isBotPackage, parsePackageDocument, type PackageDocument } from "../colonie/bots/bot-package.ts";
import { parseVisibility } from "../colonie/bots/bot-visibility.ts";
import { validateBotCwd } from "../colonie/bots/bot-cwd.ts";
import { importPackageDocument, importTeamManifest, PackageImportError, type PackageImportDeps, type PackageImportResult } from "../colonie/teams/package-import.ts";
import { parseTeamManifest } from "../colonie/teams/team-manifest.ts";
import { importTeamBackup } from "../colonie/workspace/team-backup.ts";
import type { RoutineManager } from "../colonie/routines/routines.ts";
import type { BotRecord, Store } from "../persistence/store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TeamsImportRouteDeps {
  store: Store;
  routines: () => RoutineManager | null;
  broadcast: (payload: Record<string, unknown>) => void;
  publicBot: (bot: BotRecord) => Record<string, unknown>;
  defaultSelection: () => Promise<ModelSelection>;
  packageImportDeps: (selection: ModelSelection) => PackageImportDeps;
}

export function createTeamsImportRoutes(deps: TeamsImportRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, json, readBody }) => {
    const { store, routines, broadcast, publicBot, defaultSelection, packageImportDeps } = deps;
    if (method === "POST" && path === "/api/teams/import") {
      // Import is additive-only. A manifest is untrusted input (catalog,
      // GitHub, a shared file), so it must be structurally unable to reach
      // records the user already has: every member becomes a NEW bot with a
      // fresh id — a manifest cannot name, update, or merge into an existing
      // bot or room. Repeated imports create freshly numbered copies.
      const importMode = url.searchParams.get("mode") ?? "add";
      if (importMode === "replace") {
        return json(res, 400, { error: "Replacing your team is no longer supported. Reopen Import in the updated app to add bots alongside your existing conversations." });
      }
      if (importMode !== "add" && importMode !== "project") {
        return json(res, 400, { error: "Team import mode must be add or project" });
      }
      // `project` once also opened a room on a caller-chosen folder. Rooms are
      // retired: both formats add bots only, and a project room or a
      // package's rooms come back in `skipped`. Neither format can point at
      // an existing record or choose a local folder; the folder stays an
      // explicit caller parameter, validated here.
      let projectCwd: string | null = null;
      if (importMode === "project") {
        const requested = url.searchParams.get("cwd");
        if (requested !== null) {
          const validated = validateBotCwd(requested);
          if (!validated.ok) return json(res, 400, { error: validated.error });
          projectCwd = validated.cwd;
        }
      }
      // Who may see the imported bots, from their first moment: the admin's
      // choice (?visibility=admins, or a JSON value), never the file's.
      const rawVisibility = url.searchParams.get("visibility");
      let importVisibility: BotVisibility | undefined;
      if (rawVisibility !== null) {
        let value: unknown = rawVisibility;
        if (rawVisibility.trim().startsWith("{")) {
          try {
            value = JSON.parse(rawVisibility);
          } catch {
            /* parseVisibility refuses the raw text with a plain sentence */
          }
        }
        const parsed = parseVisibility(value);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        importVisibility = parsed.visibility;
      }
      const body = await readBody(req, MAX_TEAM_BACKUP_BYTES);
      if (body?.format === "colonie.backup") {
        if (importMode !== "add") return json(res, 400, { error: "Import backups alongside your existing bots; project mode is only for templates" });
        try {
          const imported = importTeamBackup(store, routines()!, body, await defaultSelection(), { visibility: importVisibility });
          // A restore writes its transcripts without store events, after the
          // store's own frames announced each bot, so these frames are what
          // carries the restored pages to other clients. Rooms are skipped
          // and named in `warnings`.
          const bots = imported.bots.map((bot) => publicBot(bot));
          for (const bot of bots) broadcast({ kind: "bot", bot });
          return json(res, 201, { ...imported, bots });
        } catch (error) {
          return json(res, 400, { error: error instanceof Error ? error.message : "Backup could not be imported" });
        }
      }
      // Every package (v1 JSON, BotMRR Markdown, v2) is read by the one shared
      // parser as a FILE: it cannot claim a publisher, and its skills and
      // routines arrive off. A body field such as `trust` is just an unknown
      // field of the document and is stripped; only the organization library
      // module ever imports with trust "org".
      let packageDocument: PackageDocument | null = null;
      let manifest: ReturnType<typeof parseTeamManifest> | null = null;
      try {
        if (isBotPackage(body)) packageDocument = parsePackageDocument(body, { trust: "file" });
        else manifest = parseTeamManifest(body);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Invalid bot package" });
      }
      const deps = packageImportDeps(await defaultSelection());
      const options = {
        mode: importMode as "add" | "project",
        cwd: projectCwd,
        room: url.searchParams.get("room") ?? undefined,
        ...(importVisibility ? { visibility: importVisibility } : {}),
      };
      let imported: PackageImportResult;
      try {
        const result = packageDocument
          ? importPackageDocument(packageDocument, { ...options, trust: "file" }, deps)
          : importTeamManifest(manifest!, options, deps);
        // A file import always gets a fresh install id, so it never reports
        // "already added"; that answer belongs to the organization library.
        if (result.alreadyAdded) return json(res, 200, result);
        imported = result;
      } catch (error) {
        if (error instanceof PackageImportError) return json(res, error.status, { error: error.message, code: error.code });
        throw error;
      }
      return json(res, 201, {
        name: imported.name,
        section: imported.section,
        bots: imported.bots.map((bot) => publicBot(store.bot(bot.id) ?? bot)),
        routines: imported.routines,
        offeredSkills: imported.offeredSkills,
        connections: imported.connections,
        skipped: imported.skipped,
        brief: imported.brief,
        notes: imported.notes,
        presets: imported.presets ?? [],
      });
    }
    return PASS;
  };
}
