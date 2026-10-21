// Exporting a team as a file the app can import elsewhere: the team manifest,
// its bots, the skills they carry and the notes they keep, either as one team
// package or as a library of packages. Export is the read half; import lives in
// teams-import.ts.
import { createBotPackageExport, createLibraryPackageExport, createTeamPackageExport, TeamExportError } from "../colonie/teams/package-export.ts";
import { packageSummary, renderBotPackageMarkdown } from "../colonie/bots/bot-package.ts";
import { createTeamBackup } from "../colonie/workspace/team-backup.ts";
import { createTeamManifest } from "../colonie/teams/team-manifest.ts";
import { readPublishedLibrary, writePublishedLibrary } from "../colonie/bots/presets.ts";
import { readPublishedTeam, writePublishedTeam } from "../colonie/teams/published-teams.ts";
import { readSectionContext } from "../colonie/teams/section-context.ts";
import { sectionKey } from "../persistence/store.ts";
import type { AppConfig } from "../config.ts";
import type { RoutineManager } from "../colonie/routines/routines.ts";
import type { Store } from "../persistence/store.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Helpers whose own signatures are wide; the module only forwards to them. */
type Helper = (...args: any[]) => any;

export interface TeamsExportRouteDeps {
  store: Store;
  cfg: AppConfig;
  /** True where several people share the workspace: a whole-workspace backup
   * carries every transcript, so signed-in sessions may not export it. */
  shared?: () => boolean;
  routines: () => RoutineManager | null;
  defaultsPresetFor: Helper;
  starterNotes: (botId: string) => Array<{ path: string; text: string }>;
  checkedExportSkillNames: Helper;
  collectExportSkills: Helper;
  collectTeamSkills: Helper;
}

export function createTeamsExportRoutes(deps: TeamsExportRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const {
      store, cfg, routines, defaultsPresetFor, starterNotes, checkedExportSkillNames,
      collectExportSkills, collectTeamSkills,
    } = deps;
    if (method === "POST" && path === "/api/teams/export") {
      // Pictures the Share dialog prepared ride this body, so it is larger
      // than the default JSON limit (the document itself is capped at 4 MB).
      const body = await readBody(req, 8 * 1024 * 1024);
      // A backup carries every conversation, so a Shared workspace refuses it
      // to a signed-in person, admins included. The owner on this machine
      // still reaches it through loopback.
      if (body.format === "backup" && deps.shared?.() === true && auth.kind === "session") {
        return json(res, 403, { error: "A backup of the whole workspace is not available while several people share it." });
      }
      const profileName = cfg.profile?.name?.trim();
      if (body.format === "package" && body.version === 2 && body.kind === "library") {
        // Preset bots and their skills, no team: my New bot defaults as a
        // preset someone else picks in New bot (presets.ts has the allowlist).
        const optional = (value: unknown) => (typeof value === "string" ? value : undefined);
        const built = defaultsPresetFor(body, body.includeMemory === true);
        try {
          const exported = createLibraryPackageExport({
            name: optional(body.name),
            tagline: optional(body.tagline),
            summary: optional(body.summary),
            release: optional(body.release),
            notes: optional(body.notes),
            authorName: profileName,
            published: readPublishedLibrary(),
            preset: built.preset,
            skipped: built.skipped,
          });
          if (body.dryRun !== true) writePublishedLibrary(exported.published);
          return json(res, 200, {
            document: exported.document,
            filename: exported.filename,
            redacted: exported.redacted,
            skipped: exported.skipped,
            summary: packageSummary(exported.document),
          });
        } catch (error) {
          if (error instanceof TeamExportError) return json(res, error.status, { error: error.message });
          throw error;
        }
      }
      if (body.format === "package" && body.version === 2) {
        // One team, whole, except its chat history (package format v2).
        if (typeof body.team !== "string") return json(res, 400, { error: "Choose a team to share." });
        const team = body.team.trim();
        if (team && !store.sections.includes(team) && !store.bots.some((bot) => sectionKey(bot.section) === team)) {
          return json(res, 404, { error: "That team no longer exists." });
        }
        const optional = (value: unknown) => (typeof value === "string" ? value : undefined);
        const teamBots = store.bots.filter((bot) => !bot.hidden && sectionKey(bot.section) === team);
        const skills = collectTeamSkills(teamBots, body.skills);
        if (!skills.ok) return json(res, 400, { error: skills.error, choices: { skills: skills.available } });
        const avatars = body.avatars && typeof body.avatars === "object" && !Array.isArray(body.avatars)
          ? body.avatars as Record<string, unknown>
          : undefined;
        // Off unless asked: New bot defaults are personal until shared.
        const defaults = body.includeDefaultsPreset === true ? defaultsPresetFor(body, body.includeMemory === true) : null;
        try {
          const exported = createTeamPackageExport({
            team,
            name: optional(body.name),
            tagline: optional(body.tagline),
            summary: optional(body.summary),
            release: optional(body.release),
            notes: optional(body.notes),
            authorName: profileName,
            bots: store.bots,
            groups: store.groups,
            routines: routines()!.listRoutines(),
            brief: readSectionContext(team)?.text,
            published: readPublishedTeam(team),
            skillsByBot: skills.skillsByBot,
            skillSelection: skills.all ? "all" : "chosen",
            memoryByBot: body.includeMemory === true ? new Map(teamBots.map((bot) => [bot.id, starterNotes(bot.id)])) : undefined,
            avatars,
            mcpServers: cfg.mcpServers ?? {},
            skipped: [...skills.skipped, ...(defaults?.skipped ?? [])],
            preset: defaults?.preset ?? null,
          });
          // A preview (the dialog's live counts) never records keys; saving
          // the file does, so renaming anything later keeps its identity.
          if (body.dryRun !== true) writePublishedTeam(team, exported.published);
          return json(res, 200, {
            document: exported.document,
            filename: exported.filename,
            redacted: exported.redacted,
            skipped: exported.skipped,
            summary: packageSummary(exported.document),
            choices: { skills: skills.available },
          });
        } catch (error) {
          if (error instanceof TeamExportError) return json(res, error.status, { error: error.message, choices: { skills: skills.available } });
          throw error;
        }
      }
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : profileName
            ? `${profileName}'s Team`
            : "My Colonie Team";
      const memberIds = store.bots.filter((bot) => !bot.hidden).map((bot) => bot.id);
      if ((body.format === "backup" ? store.bots.length : memberIds.length) === 0) return json(res, 400, { error: "Create a bot before exporting your team" });
      try {
        if (body.format === "backup") {
          return json(res, 200, createTeamBackup(store, routines()!.listRoutines(), name));
        }
        if (body.format === "package") {
          const selectedBots = store.bots.filter((bot) => !bot.hidden);
          const skillNames = checkedExportSkillNames(body.skillIds, selectedBots);
          if (!skillNames.ok) return json(res, 400, { error: skillNames.error });
          const document = createBotPackageExport({
            name,
            authorName: profileName,
            bots: selectedBots,
            groups: store.groups,
            routines: routines()!.listRoutines(),
            skillsByBot: collectExportSkills(selectedBots, skillNames.names),
          });
          return json(res, 200, {
            name: document.package.name,
            members: document.package.agents.length,
            markdown: renderBotPackageMarkdown(document),
          });
        }
        return json(
          res,
          200,
          createTeamManifest(
            {
              name,
              memberIds,
            },
            store.bots,
          ),
        );
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Team could not be exported" });
      }
    }
    return PASS;
  };
}
