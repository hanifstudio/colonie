// Creating a bot: its name and profile fields, where it works, which engine it
// starts on, the team and defaults it inherits, and the skills and memory it is
// born with. The desktop (loopback) is allowed the wider set of fields.
import { applyPresetToBot, PRESET_UNAVAILABLE_MESSAGE, type PresetStore } from "../colonie/bots/presets.ts";
import { parseBotProfilePatch } from "../colonie/bots/bot-profile.ts";
import { validateBotCwd } from "../colonie/bots/bot-cwd.ts";
import { resolveBotCreationDefaults } from "../colonie/bots/new-bot-defaults.ts";
import { parseVisibility } from "../colonie/bots/bot-visibility.ts";
import { MAX_MCP_SERVERS, mcpServerNameError } from "../colonie/mcp/mcp-registry.ts";
import { installOrgSkill, installSkill, parseSkillMd, setSkillEnabled } from "../colonie/skills/skills.ts";
import { journalMemoryWrite } from "../colonie/memory/memory-journal.ts";
import { writeMemoryFile, writeMemoryTopic } from "../colonie/workspace/workspace.ts";
import type { ModelSelection, WireBot } from "../../shared/wire.ts";
import type { RoutineManager } from "../colonie/routines/routines.ts";
import type { AppConfig } from "../config.ts";
import type { BotRecord, Store } from "../persistence/store.ts";
import { clientBotPatchViolation } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotCreateRouteDeps {
  store: Store;
  cfg: AppConfig;
  presetStore: PresetStore;
  routines: () => RoutineManager | null;
  desktopManaged: boolean;
  maxWorkspaceBots: number;
  wireBot: (bot: BotRecord) => WireBot;
  storedAvatarExists: (avatarUrl: string) => boolean;
  defaultSelection: (saved?: ModelSelection | null) => Promise<ModelSelection>;
  checkedModelSelection: (
    raw: unknown,
    current?: { selection: ModelSelection; busy: boolean },
    requireAvailableModel?: boolean,
  ) => { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string };
}

export function createBotCreateRoutes(deps: BotCreateRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const {
      store, cfg, presetStore, routines, wireBot, storedAvatarExists,
      defaultSelection, checkedModelSelection,
    } = deps;
    const DESKTOP_MANAGED = deps.desktopManaged;
    const MAX_WORKSPACE_BOTS = deps.maxWorkspaceBots;
    if (method === "POST" && path === "/api/bots") {
      let body = (await readBody(req)) as Record<string, any>;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "bot must be a JSON object" });
      }
      if (body.computer !== undefined && body.computer !== null) {
        return json(res, 400, { error: "Desktop computer selection has been removed. Use the browser switch." });
      }
      const template = resolveBotCreationDefaults(cfg.newBotDefaults, body);
      const settings = template.profile;
      if (auth.kind === "session" && !auth.scopes.includes("admin")) {
        const field = clientBotPatchViolation(settings);
        if (field || body.preset !== undefined || template.skills.length || template.routines.length || Object.keys(template.memory).length) {
          return json(res, 403, { error: "Creating a bot with these defaults needs the admin scope" });
        }
      }
      // A preset (presets.ts) supplies content: playbooks, skills and
      // starter notes. Name, look and instructions stay the request's own.
      if (body.preset !== undefined && (typeof body.preset !== "string" || !/^[\w-]{1,64}$/.test(body.preset))) {
        return json(res, 400, { error: "preset must be a preset id from New bot" });
      }
      const resolvedPreset = typeof body.preset === "string" ? presetStore.resolve(body.preset) : null;
      const preset = resolvedPreset;
      if (body.preset !== undefined && !preset) return json(res, 404, { error: PRESET_UNAVAILABLE_MESSAGE });
      body = { ...body, ...settings, name: settings.name };
      if (settings.approvalMode === "full" || settings.approvalMode === "custom") {
        return json(res, 403, { error: "This approval level requires the desktop permission flow. Use the bot creation dialog or explicitly choose Ask/Auto for API creation." });
      }

      if (settings.avatarUrl && !storedAvatarExists(settings.avatarUrl)) {
        return json(res, 400, { error: "avatarUrl must reference an existing stored image" });
      }
      if (settings.browserProfile && settings.browserProfile !== "guest" && !(cfg.browserProfiles ?? []).some(profile => profile.id === settings.browserProfile)) {
        return json(res, 400, { error: "browserProfile must name an existing browser profile" });
      }
      if (settings.mcpServers?.some(name => mcpServerNameError(name) !== null) || (settings.mcpServers?.length ?? 0) > MAX_MCP_SERVERS) {
        return json(res, 400, { error: "Invalid MCP server selection" });
      }
      if (settings.managedSections?.length) {
        if (!settings.chiefOfStaff || settings.managedSections.some(name => name !== "" && !store.sections.includes(name))) {
          return json(res, 400, { error: "Only a Chief may manage existing additional teams" });
        }
        if (body.acknowledgePeerScope !== true) return json(res, 400, { error: "Confirm additional team access (acknowledgePeerScope)" });
        if (auth.kind === "loopback" && !DESKTOP_MANAGED && store.bots.some(bot => bot.busy)) {
          return json(res, 409, { error: "Stop running bots before granting access to another team" });
        }
      }
      const checkedCwd = validateBotCwd(settings.cwd ?? null);
      if (!checkedCwd.ok) return json(res, 400, { error: checkedCwd.error });
      if (body.requireAvailableModel !== undefined && typeof body.requireAvailableModel !== "boolean") {
        return json(res, 400, { error: "requireAvailableModel must be true or false" });
      }
      if (body.requireAvailableModel === true && body.modelSelection === undefined) {
        return json(res, 400, { error: "requireAvailableModel requires modelSelection" });
      }
      const profileInput = Object.fromEntries(
        ["name", "title", "description"]
          .filter((key) => body[key] !== undefined)
          .map((key) => [key, body[key]]),
      );
      const profile = parseBotProfilePatch(profileInput, true);
      if (!profile.ok) return json(res, 400, { error: profile.error });
      let section: string | undefined;
      if (body.section !== undefined && body.section !== null) {
        if (typeof body.section !== "string") return json(res, 400, { error: "section must be a string" });
        section = body.section.trim() || undefined;
        if (section && section.length > 60) {
          return json(res, 400, { error: "section must be at most 60 characters" });
        }
      }
      let selection: ModelSelection;
      if (body.modelSelection === undefined) {
        selection = await defaultSelection();
      } else {
        const checked = checkedModelSelection(body.modelSelection, undefined, body.requireAvailableModel === true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        selection = checked.selection;
      }
      // Keep the capacity check immediately beside the synchronous write.
      // Awaiting provider discovery before this point cannot race the cap.
      if (store.bots.length >= MAX_WORKSPACE_BOTS) {
        return json(res, 409, { error: `this workspace is limited to ${MAX_WORKSPACE_BOTS} bots` });
      }
      // Apply the audience before creation can announce the bot to members.
      const created = body.visibility === undefined ? null : parseVisibility(body.visibility);
      if (created && !created.ok) return json(res, 400, { error: created.error });
      const bot = store.createBot({ ...profile.patch, soul: settings.soul, section, modelSelection: selection,
        toolScope: settings.toolScope ?? undefined,
        ...(created?.ok ? { visibility: created.visibility } : {}) });
      const createdRoutines: Array<{ id: string; enabled: boolean }> = [];
      try {
        const { chiefOfStaff: _chief, managedSections: _managed, toolScope: _toolScope, ...ordinary } = settings;
        store.patchBot(bot.id, {
          // Store creation completes workspace defaults (including effort).
          // Applying the rest of the template must not undo that selection.
          ...ordinary, name: bot.name, section, modelSelection: bot.modelSelection,
          mascotExpression: ordinary.mascotExpression ?? undefined,
          avatarUrl: ordinary.avatarUrl || undefined,
          cwd: checkedCwd.cwd ?? undefined,
          peers: ordinary.peers ?? undefined, mcpServers: ordinary.mcpServers ?? undefined,
          browserProfile: ordinary.browserProfile || undefined,
          autoApprove: ordinary.approvalMode === "auto",
        });
        // What the preset brings wins over the saved defaults for the same
        // skill name or note file.
        const presetSkills = new Set(preset?.preset.skills ?? []);
        const presetNotes = new Set(Object.keys(preset?.preset.seed?.memory ?? {}));
        for (const [file, text] of Object.entries(template.memory)) {
          if (presetNotes.has(file)) continue;
          journalMemoryWrite(bot.id, file, text, { actor: "person", via: "api" });
        }
        if (preset) {
          applyPresetToBot(bot.id, preset, {
            store,
            skills: { install: installSkill, setEnabled: setSkillEnabled, installOrg: installOrgSkill },
            memory: { writeIndex: writeMemoryFile, writeTopic: writeMemoryTopic },
          });
        }
        for (const skill of template.skills) {
          if (presetSkills.has(skill.name)) continue;
          const parsed = parseSkillMd(skill.text);
          if ("error" in parsed || parsed.name !== skill.name) throw Object.assign(new Error("Skill name does not match its contents"), { status: 400 });
          const installed = installSkill(bot.id, skill.source, [{ path: "SKILL.md", content: skill.text }]);
          if ("error" in installed) throw Object.assign(new Error(installed.error), { status: 422 });
          if (skill.enabled) {
            const enabled = setSkillEnabled(bot.id, skill.name, true);
            if ("error" in enabled) throw Object.assign(new Error(enabled.error), { status: 422 });
          }
        }
        for (const routine of template.routines) {
          const created = routines()!.create({ ...routine, botId: bot.id, enabled: false });
          createdRoutines.push({ id: created.id, enabled: routine.enabled !== false });
        }
      } catch (error) {
        for (const routine of createdRoutines) routines()!.remove(routine.id);
        store.deleteBot(bot.id);
        throw error;
      }
      // Creation is complete. Activation errors must not invite a duplicate
      // creation retry or delete a bot whose routine may already have run.
      const warnings: string[] = [];
      if (settings.chiefOfStaff) {
        try {
          store.patchBot(bot.id, { managedSections: settings.managedSections ?? [] });
          store.setChiefOfStaff(bot.id);
        } catch {
          warnings.push("Bot created; review its Chief of Staff setting before delegating work.");
        }
      }
      for (const routine of createdRoutines) if (routine.enabled) {
        try { routines()!.update(routine.id, { enabled: true }); }
        catch { warnings.push(`Bot created; routine ${routine.id} could not be activated.`); }
      }
      return json(res, 201, {
        ...(warnings.length ? { warnings } : {}),
        bot: {
          ...wireBot(bot),
          messages: store.messagesFor(bot.threadId),
          activeLeafId: store.activeLeaf(bot.threadId),
        },
      });
    }
    return PASS;
  };
}
