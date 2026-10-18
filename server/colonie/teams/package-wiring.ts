// This installation's view of a team package: collectTeamSkills gathers one team's bot skills for a whole-team share ("all" skips a changed SKILL.md, an explicit list refuses instead), starterNotes reads a bot's MEMORY.md and topic files (daily logs never travel), packageImportDeps is the importer's side (pictures become local avatars, connection slots switched-off MCP servers, starter notes ordinary memory writes), and defaultsPresetFor turns a saved New-bot default into the export's preset.
import { botAvatarUrlFromStoredPath } from "../../../shared/bot-avatar.ts";
import { type ModelSelection } from "../../contracts.ts";
import { type BotRecord } from "../../persistence/store.ts";
import { DEFAULTS_PRESET_KEY, presetFromDefaults } from "../../colonie/bots/presets.ts";
import { saveImage } from "../../colonie/chat/attachments.ts";
import { type PackageImportDeps } from "../../colonie/teams/package-import.ts";
import { picture as sharedPicture, type ExportablePackageSkill, type TeamExportSkip } from "../../colonie/teams/package-export.ts";
import { installOrgSkill, installSkill, isSkillName, setSkillEnabled } from "../../colonie/skills/skills.ts";
import { writeSectionContext } from "../../colonie/teams/section-context.ts";
import { listMemoryTopics, readMemoryFile, readMemoryTopic, writeMemoryFile, writeMemoryTopic } from "../../colonie/workspace/workspace.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface TeamPackageWiringDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createTeamPackageWiring(deps: TeamPackageWiringDeps) {
  const {
    cfg, listBotSkills, persistMcpServers, presetStore, readBotSkillFile,
    routines, store
  } = deps;
/** Skills on one team's bots for a whole-team share. "all" skips a skill
 * whose stored SKILL.md changed (listed to the person); an explicit list
 * refuses instead, because the person asked for that exact skill. */
/** The team's skills for a whole-team export. `available` (every skill name
 * on the team's bots) comes back on refusals too: the Share dialog draws its
 * skill choices from it, so a refused choice can always be changed. */
function collectTeamSkills(
  bots: readonly BotRecord[],
  selection: unknown,
): { ok: true; all: boolean; skillsByBot: Map<string, ExportablePackageSkill[]>; skipped: TeamExportSkip[]; available: string[] } | { ok: false; error: string; available: string[] } {
  const all = selection === undefined || selection === "all";
  const available = [...new Set(bots.flatMap((bot) => listBotSkills(bot).map((skill: { name: string }) => skill.name)))].sort();
  if (!all && (!Array.isArray(selection) || selection.some((name) => typeof name !== "string" || !isSkillName(name)))) {
    return { ok: false, error: "skills must be \"all\" or a list of skill names", available };
  }
  const chosen = new Set(all ? available : selection as string[]);
  const unknown = [...chosen].find((name) => !available.includes(name));
  if (unknown) return { ok: false, error: `This team has no skill named "${unknown}"`, available };
  const skillsByBot = new Map<string, ExportablePackageSkill[]>();
  const skipped: TeamExportSkip[] = [];
  for (const bot of bots) {
    const assigned: ExportablePackageSkill[] = [];
    for (const listing of listBotSkills(bot)) {
      if (!chosen.has(listing.name)) continue;
      const instructions = readBotSkillFile(bot, listing.name);
      if (instructions === null) {
        if (!all) return { ok: false, error: `Skill "${listing.name}" changed or is unavailable and cannot be shared safely`, available };
        const part = `skills[${listing.name}]`;
        if (!skipped.some((skip) => skip.part === part)) skipped.push({ part, reason: "skill_changed" });
        continue;
      }
      assigned.push({
        name: listing.name,
        description: listing.description,
        ...(listing.source ? { source: listing.source } : {}),
        ...(listing.license ? { license: listing.license } : {}),
        ...(listing.compatibility ? { compatibility: listing.compatibility } : {}),
        instructions,
        enabled: listing.enabled,
      });
    }
    if (assigned.length) skillsByBot.set(bot.id, assigned);
  }
  return { ok: true, all, skillsByBot, skipped, available };
}

/** A bot's starter notes: MEMORY.md and its topic files. Daily logs never
 * travel (they are closer to chat history than to notes). */
function starterNotes(botId: string): Array<{ path: string; text: string }> {
  const notes: Array<{ path: string; text: string }> = [];
  const index = readMemoryFile(botId).text;
  if (index.trim()) notes.push({ path: "MEMORY.md", text: index });
  for (const topic of listMemoryTopics(botId).sort((a, b) => a.name.localeCompare(b.name))) {
    const text = readMemoryTopic(botId, topic.name);
    if (text?.trim()) notes.push({ path: `memory/${topic.name}`, text });
  }
  return notes;
}

/** The importer's view of this installation. Pictures become ordinary local
 * avatars, connection slots ordinary (switched-off) MCP servers, starter
 * notes ordinary memory writes. */
function packageImportDeps(selection: ModelSelection): PackageImportDeps {
  return {
    store: store(),
    routines: routines()!,
    skills: { install: installSkill, setEnabled: setSkillEnabled, installOrg: installOrgSkill },
    memory: { writeIndex: writeMemoryFile, writeTopic: writeMemoryTopic },
    mcp: { servers: () => cfg.mcpServers ?? {}, persist: persistMcpServers() },
    sections: { writeBrief: (section, text) => void writeSectionContext(section, text) },
    images: {
      save: (bytes, mime) => {
        const avatarUrl = botAvatarUrlFromStoredPath(saveImage(Buffer.from(bytes), mime).path);
        if (!avatarUrl) throw new Error("A picture in this package could not be stored");
        return avatarUrl;
      },
    },
    defaultSelection: () => selection,
    presets: presetStore(),
  };
}

/** "Include my New bot defaults as a preset" from an export body: the saved
 * defaults through the allowlist, with the picture the dialog prepared. */
function defaultsPresetFor(body: Record<string, unknown>, includeNotes: boolean) {
  const skipped: TeamExportSkip[] = [];
  let avatar: Exclude<ReturnType<typeof sharedPicture>, string> | null = null;
  if (body.presetAvatar !== undefined && body.presetAvatar !== null && body.presetAvatar !== "") {
    const offered = sharedPicture(body.presetAvatar);
    if (typeof offered === "string") skipped.push({ part: `presets[${DEFAULTS_PRESET_KEY}].bot.appearance.avatar`, reason: offered });
    else avatar = offered;
  }
  const built = presetFromDefaults(cfg.newBotDefaults, {
    name: typeof body.presetName === "string" ? body.presetName : undefined,
    description: typeof body.presetDescription === "string" ? body.presetDescription : undefined,
    includeNotes,
    avatar,
  });
  return { preset: built.value, skipped: [...skipped, ...built.skipped] };
}

  return {
    collectTeamSkills,
    starterNotes,
    packageImportDeps,
    defaultsPresetFor,
  };
}
