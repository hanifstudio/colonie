// The two settings-derived read models of one bot: `previewSystemPrompt`, the developer preview of the prompt a new conversation would build from current settings, and `botOverview`, the plain-language "what does this bot do" facts gathered from every server-only source and handed to the pure sentence builder. Both are computed from current settings, not from a dispatched turn.
import { isColonieAcpDriver } from "../../../shared/acp.ts";
import { describeConnectorScopes } from "../../../shared/connector-scopes.ts";
import { contextCandidate } from "../../acp/context.ts";
import { buildBotOverview, connectedAppsFacts, type BotOverview } from "../../colonie/bots/bot-overview.ts";
import { CREDENTIAL_PROMPT, PROFILE_PROMPT, ROUTINE_PROMPT, TEAM_MEMORY_PROMPT, buildSystemPrompt, composioSystemPrompt, customMcpPrompt, teamAvailabilityPart, userProfileSystemPrompt } from "../../colonie/bots/system-prompt.ts";
import { BUILT_IN_BROWSER_SYSTEM_PROMPT } from "../../colonie/computer/browser-engine.ts";
import { peerRosterSystemPrompt, reachablePeers } from "../../colonie/peers/peer-roster.ts";
import { skillsSystemPrompt } from "../../colonie/skills/skills.ts";
import { chiefOfStaffSystemPrompt } from "../../colonie/teams/chief-of-staff.ts";
import { sectionContextSystemPrompt } from "../../colonie/teams/section-context.ts";
import { memorySystemPrompt, supportsWorkspaceFiles } from "../../colonie/workspace/workspace.ts";
import { type BotRecord } from "../../persistence/store.ts";
import { builtInBrowserEnabled, instanceConfigs, skillAuthoringEnabled, skillsLibraryEnabled } from "../../config.ts";
import { flushProfileHistory, readHistory } from "../../profile-versions.ts";
import { setupModeActive, setupSystemPrompt } from "../../setup-mode.ts";
import * as composio from "../../colonie/mcp/composio.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface BotSettingsViewDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createBotSettingsView(deps: BotSettingsViewDeps) {
  const {
    approvalModeForTurn, cfg, engineMcpServers, listBotSkills, registry, routines, store,
    teamMemory, webhooks
  } = deps;
/** A settings-based preview, not a receipt of a dispatched turn. No
 * provisioning or credentials are needed to inspect it. The selected engine
 * bounds advertised tools; task-specific context is added only at dispatch. */
function previewSystemPrompt(bot: BotRecord) {
  if (isColonieAcpDriver(registry.get(bot.modelSelection.instanceId)?.driverKind)) {
    const config = instanceConfigs(cfg())[bot.modelSelection.instanceId]?.config as { instructions?: string } | undefined;
    const candidate = contextCandidate(bot, bot.modelSelection.instanceId, config?.instructions ?? "");
    const sections = candidate.sections.filter((section) => section.status === "active").map((section) => ({ ...section, bytes: Buffer.byteLength(section.text) }));
    const bytes = sections.reduce((sum, section) => sum + section.bytes, 0);
    return {
      sections,
      totalBytes: bytes, approxTokens: Math.ceil(bytes / 4),
      note: "Developer preview for a new conversation. App awareness and saved bot profiles are enabled by default. Context is pinned at first dispatch; native capabilities follow runtime settings. Native/project instructions remain provider-owned. No memory, team or automation context is added.",
    };
  }
  // `cfg` is the module-level config (`const cfg = loadConfig()` near the
  // top of index.ts), the same object the turn code reads.
  const persona = [
    `You are ${bot.name}, a personal bot in Colonie.`,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
  ]
    .filter(Boolean)
    .join(" ");
  const instance = registry.get(bot.modelSelection.instanceId);
  const caps = instance?.adapter.capabilities;
  const peers = reachablePeers(store.bots, bot);
  const coordination = bot.chiefOfStaff
    ? chiefOfStaffSystemPrompt(bot.id, store.bots, true)
    : peers.length > 0
      ? peerRosterSystemPrompt(peers)
      : "";
  // Same gate a real turn applies: the block only goes to a bot whose
  // engine actually mounts agent tools, since it names propose_profile,
  // propose_routine and request_credential.
  const agentsMounted = caps?.agentsMcp === true;
  // The preview asks the same question a dispatch asks, through the same
  // policy, so "what the model sees" cannot drift from what a turn sends.
  // Spelling the browser rule out a second time here is what let Off keep a
  // browser in one place while the preview said it had none.
  const browserOn = caps?.browserMcp === true && builtInBrowserEnabled(cfg()) && bot.browser !== false;
  const privateWorkspace = instance && supportsWorkspaceFiles(instance.driverKind);
  const built = buildSystemPrompt(persona, bot.soul ?? "", [
    { id: "user-profile", label: "About the user", text: userProfileSystemPrompt(cfg().profile) },
    {
      id: "setup",
      label: "Setup",
      text: setupSystemPrompt(agentsMounted && setupModeActive({ soul: bot.soul, description: bot.description, text: "" }), {
        skills: skillAuthoringEnabled(cfg()),
        cwd: bot.cwd,
      }),
    },
    { id: "composio", label: "Connected apps", text: caps?.composioMcp && bot.composio !== false && composio.configured(cfg()) ? composioSystemPrompt(bot.connectorTools) + describeConnectorScopes(bot.connectorScopes) : "" },
    { id: "mcp", label: "MCP servers", text: caps?.customMcp ? customMcpPrompt(Object.keys(engineMcpServers()(bot))) : "" },
    { id: "browser", label: "Browser", text: browserOn ? BUILT_IN_BROWSER_SYSTEM_PROMPT : "" },
    { id: "coordination", label: "Team", text: agentsMounted && coordination ? ` ${coordination}` : "" },
    { id: "credential", label: "Credentials", text: agentsMounted ? CREDENTIAL_PROMPT : "" },
    { id: "routine", label: "Routines", text: agentsMounted ? ROUTINE_PROMPT : "" },
    { id: "profile", label: "Profile changes", text: agentsMounted ? PROFILE_PROMPT : "" },
    { id: "section-context", label: "Section context", text: sectionContextSystemPrompt(bot.section) },
    { id: "team-memory", label: "Team memory", text: teamMemory().systemPrompt(bot.section) + (agentsMounted ? TEAM_MEMORY_PROMPT : "") },
    teamAvailabilityPart(agentsMounted && coordination ? peers : []),
    { id: "memory", label: "Memory", text: memorySystemPrompt(bot.id, { managedWrites: agentsMounted, fileTools: Boolean(privateWorkspace), enabled: bot.memoryEnabled !== false }) },
    { id: "skills", label: "Skills index", text: privateWorkspace ? skillsSystemPrompt(bot.id, skillsLibraryEnabled(cfg()) ? bot.assignedSkills : undefined) : "" },
  ]);
  const totalBytes = built.sections.reduce((n, s) => n + s.bytes, 0);
  return {
    sections: built.sections,
    totalBytes,
    approxTokens: Math.ceil(totalBytes / 4),
    note:
      "Preview from current bot settings, not the exact prompt of a running task. Task folders, notes, recall, selected skills and available connections can change the dispatched prompt. Token count is an estimate.",
  };
}

/** The plain-language "what does this bot do" facts, gathered once from
 * every server-only source (engine capabilities, connected-apps inventory,
 * routines/webhooks/skills, and recent history) and handed to the pure
 * sentence builder. The phones (step 5) and the web settings dialog both
 * read this same route, so they can never disagree about what a bot does. */
async function botOverview(bot: BotRecord): Promise<BotOverview> {
  const connectedApps = await connectedAppsFacts(
    composio.configured(cfg()),
    composio.connectorAvailability(cfg()),
    () => composio.connectedServices(cfg()),
  );
  const engine = registry.get(bot.modelSelection.instanceId)?.adapter.capabilities ?? null;
  const sectionPeers = reachablePeers(store.bots, bot).length;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Same flush as GET /history: profile-change rows queue in
  // profile-versions.ts and land asynchronously, so a client checking the
  // overview right after causing a change must see its own row.
  await flushProfileHistory(bot.id);
  const recent = readHistory(bot.id, 5).map((r) => ({ at: r.at, summary: r.summary }));
  return buildBotOverview({
    bot: {
      name: bot.name,
      title: bot.title,
      description: bot.description,
      soul: bot.soul,
      computer: bot.computer,
      cwd: bot.cwd,
      autoApprove: bot.autoApprove,
      approvalMode: approvalModeForTurn()(bot),
      approvePeerComms: bot.approvePeerComms,
      peers: bot.peers,
      composio: bot.composio,
      connectorTools: bot.connectorTools,
      browser: bot.browser,
      chiefOfStaff: bot.chiefOfStaff,
      managedSections: bot.managedSections,
    },
    routines: routines()!.listRoutines()
      .filter((routine: any) => routine.botId === bot.id)
      .map((routine: any) => ({
        id: routine.id,
        name: routine.name,
        enabled: routine.enabled,
        schedule: routine.schedule,
        nextRunAt: routine.nextRunAt,
      })),
    runs: routines()!.listRuns()
      .filter((run: any) => run.botId === bot.id)
      .map((run: any) => ({
        routineId: run.routineId,
        status: run.status,
        finishedAt: run.finishedAt,
        startedAt: run.startedAt,
        scheduledFor: run.scheduledFor,
      })),
    webhooks: webhooks().list()
      .filter((webhook: any) => webhook.botId === bot.id)
      .map((webhook: any) => ({ name: webhook.name, enabled: webhook.enabled })),
    skills: listBotSkills(bot).map((skill: any) => ({
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
    })),
    engine,
    browserEnabled: builtInBrowserEnabled(cfg()),
    connectedApps,
    sectionPeers,
    timeZone,
    recent,
  });
}

  return {
    botOverview,
    previewSystemPrompt,
  };
}
