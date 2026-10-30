// Server status and settings: local-VM payloads and readiness, edition/settings status, access filtering, MCP server persistence, instance description/persistence and provider reload.
import * as tts from "../tts/index.ts";
import * as composio from "../colonie/mcp/composio.ts";
import { type BotRecord } from "../persistence/store.ts";
import { failedTurnTool } from "../../shared/failed-turn.ts";
import { avatarImageStatus } from "../colonie/bots/avatar-image.ts";
import { withoutPendingSignIn } from "../colonie/mcp/mcp-oauth.ts";
import { claudeAccountInfo, isClaudeAccountDriver } from "../colonie/providers/claude-accounts.ts";
import { CLAUDE_API_INSTANCE, autoRecallEnabled, builtInBrowserEnabled, claudeUserMcpEnabled, customMcpServers, instanceConfigs, liveSettingsFor, llmThreadTitlesEnabled, maxConcurrentBotThreads, mcpCallTimeoutMinutes, openCodeProviderKeys, routinesInConversationEnabled, saveConfig, showToolCallsEnabled, skillAuthoringEnabled, skillsLibraryEnabled, threadEventLogMaxBytes, threadEventLogRetentionDays, type AppConfig } from "../config.ts";
import { describeDecider } from "../decider/index.ts";
import { decisionRetentionDays } from "../decision-log.ts";
import { LICENSE_WARN_DAYS, editionStatus, workspaceMembership, type EditionStatus } from "../enterprise.ts";
import { resetPathCache } from "../runtime/env-path.ts";
import { announceWhenModelsLand } from "./model-catalogs.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface ConfigStatusDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
  setProviderFleetReloading: (value: any) => void,
}

export function createConfigStatus(deps: ConfigStatusDeps) {
  const { broadcast, browserEngineSummary, cfg, mcpOAuth, providerConfigs,
    registry, retryComputerEngineMove, store, bus,
    cancelDirectTurnDispatch, directTurnBots, drainComputerResumes, drainConnectorResumes,
    drainQueuedSends, drainSecretResumes, providerAuthSessions, 
    releaseTurnResources, revokeAllInternalCapabilities, routines, settleDirectFollowup,
    stopScreenPoller, threadBusy, turnResourceOwners,
    setProviderFleetReloading, watchdog, closeOpenApprovals,
    finalizeDelegationWatch, retryDelegationsWaitingOn, drainTeamSetupResumes
  } = deps;
/** What Settings needs about the edition: the features, and, once the key
 * is inside its warning window or grace period, when it lapses. The dates
 * reach admins only (configForAccess strips them for client sessions). */
function editionForSettings(status: EditionStatus) {
  const expiring = status.edition === "enterprise" && status.expiresAt && status.expiresInDays !== undefined &&
    (status.graceEndsAt !== undefined || status.expiresInDays <= LICENSE_WARN_DAYS);
  return {
    edition: status.edition,
    features: status.features,
    ...(expiring ? { license: { expiresAt: status.expiresAt!, expiresInDays: status.expiresInDays!, ...(status.graceEndsAt ? { graceEndsAt: status.graceEndsAt } : {}) } } : {}),
  };
}

function configStatus() {
  // off-by-default thread cleanup knobs stay absent so clients can tell
  // "unset" apart from any in-range value
  const eventLogMaxBytes = threadEventLogMaxBytes(cfg);
  const eventLogRetentionDays = threadEventLogRetentionDays(cfg);
  return {
    xai: { configured: Boolean(cfg.xai?.key) },
    mistral: { configured: Boolean(cfg.mistral?.key) },
    cerebras: { configured: Boolean(cfg.cerebras?.key) },
    anthropic: { configured: Boolean(cfg.anthropic?.key), everyClaudeBot: cfg.anthropic?.everyClaudeBot !== false },
    openai: { configured: Boolean(cfg.openai?.key) },
    openrouter: { configured: Boolean(cfg.openrouter?.key) },
    // what this build is entitled to, so Settings shows only what works here
    edition: editionForSettings(editionStatus()),
    // settings, not secrets: the cap and the operator's own price list
    budgets: {
      ...(cfg.budgets?.monthlyUsd !== undefined ? { monthlyUsd: cfg.budgets.monthlyUsd } : {}),
      ...(cfg.budgets?.warnAtPercent !== undefined ? { warnAtPercent: cfg.budgets.warnAtPercent } : {}),
    },
    billing: { currency: cfg.billing?.currency ?? "USD", prices: cfg.billing?.prices ?? {} },
    // how long the approval decision log is kept, after env and default
    decisions: { retentionDays: decisionRetentionDays(cfg.decisions?.retentionDays) },
    // the base URL is a setting, not a secret; the key stays write-only
    openaiCompat: { configured: Boolean(cfg.openaiCompat?.key), url: cfg.openaiCompat?.url ?? "" },
    composio: {
      projectKeyConfigured: Boolean(cfg.composio?.apiKey?.trim()),
      configured: composio.configured(cfg),
      mode: composio.connectionMode(cfg),
    },
    // names only: every provider key stays write-only
    opencodeGo: { configured: Boolean(cfg.opencodeGo?.apiKey), providerKeys: Object.keys(openCodeProviderKeys(cfg)) },
    // the chosen voice is a setting, not a secret; the key is reported the
    // same configured-or-not way as every other credential
    tts: tts.describeVoice(cfg),
    // the decision model: switches and configured-or-not, never the key
    decider: describeDecider(cfg),
    imageGen: avatarImageStatus(cfg),
    // Live calls: configured-or-not only; the voice name is a setting
    live: liveSettingsFor(cfg),
    // not a secret — the sidebar shows it
    profile: { name: cfg.profile?.name ?? "", email: cfg.profile?.email ?? "", aboutMe: cfg.profile?.aboutMe ?? "" },
    // not a secret — the settings picker shows it; "" = follow the system
    language: cfg.language ?? "",
    mcp: { callTimeoutMinutes: mcpCallTimeoutMinutes(cfg) },
    automaticRecovery: cfg.automaticRecovery ?? { enabled: false },
    // absent effort = no level is sent, so clients can tell it from any level
    newBots: cfg.newBots?.effort ? { effort: cfg.newBots.effort } : {},
    threads: {
      maxConcurrentPerBot: maxConcurrentBotThreads(cfg),
      ...(eventLogMaxBytes !== null ? { eventLogMaxBytes } : {}),
      ...(eventLogRetentionDays !== null ? { eventLogRetentionDays } : {}),
    },
    features: {
      skillAuthoring: skillAuthoringEnabled(cfg),
      skillsLibrary: skillsLibraryEnabled(cfg),
      showToolCalls: showToolCallsEnabled(cfg),
      routinesInConversation: routinesInConversationEnabled(cfg),
      browser: builtInBrowserEnabled(cfg),
      // Plugins → MCP servers switch: Claude bots also see this machine's
      // own Claude Code MCP servers
      claudeUserMcp: claudeUserMcpEnabled(cfg),
      autoRecall: autoRecallEnabled(cfg),
      // hand-edited config.json only; the thread menu offers Regenerate title from it
      llmThreadTitles: llmThreadTitlesEnabled(cfg),
    },
    // first-run progress — not a secret; the app decides whether to show
    // the welcome tour from this, never from browser storage
    onboarding: {
      completedAt: cfg.onboarding?.completedAt ?? "",
      version: cfg.onboarding?.version ?? 0,
      reelSeen: cfg.onboarding?.reelSeen === true,
      hintsSeen: cfg.onboarding?.hintsSeen ?? [],
    },
    // Which browser this server can give bots: the desktop app's surface,
    // the agent-browser engine, or nothing yet (with the reason).
    browserEngine: browserEngineSummary(),
    // partitionId is non-secret routing metadata. The renderer needs it to
    // show the same durable session as an agent, but config PATCH validation
    // keeps it read-only and rejects callers that try to choose it.
    browserProfiles: cfg.browserProfiles ?? [],
    // who may sign in with an emailed code (server/account-signin.ts)
    signIn: { admins: cfg.signIn?.admins ?? [], members: cfg.signIn?.members ?? [] },
    // whether that list decides anything here, or the organisation's Admin does
    membership: workspaceMembership(),
  };
}

function configForAccess(status: ReturnType<typeof configStatus>, admin: boolean) {
  if (admin) return status;
  // Configured-or-not is fine; an SSH alias, an email, a browser partition
  // id, and the sign-in list are not a client's business. Preserve the
  // source objects.
  return {
    ...status,
    edition: { edition: status.edition.edition, features: status.edition.features },
    signIn: { admins: [], members: [] },
    opencodeGo: { configured: status.opencodeGo.configured, providerKeys: [] },
    profile: { name: status.profile.name, email: "" },
    browserProfiles: status.browserProfiles.map((profile: any) => Object.fromEntries(Object.entries(profile).filter(([key]) => key !== "partitionId"))),
  };
}

/** Configured MCP servers that may reach this bot's engine. */
function engineMcpServers(bot: BotRecord) {
  return withoutPendingSignIn(customMcpServers(cfg, bot.mcpServers), mcpOAuth);
}

function persistMcpServers(next: Record<string, unknown>): void {
  saveConfig({ mcpServers: next });
  // Do not reload the provider fleet: integrations are assembled from cfg at
  // the next turn boundary. Updating this property directly also correctly
  // clears the final entry; Object.assign(loadConfig()) would leave it stale
  // when an empty section is omitted by an older config file.
  cfg.mcpServers = next;
}

async function describeInstances() {
  const configs = providerConfigs();
  // Reading the engines is where this server learns one became available
  // (an install, a sign-in, a key or a Company engine), so a bot still on the
  // removed Computer engine moves now rather than at the next start.
  void retryComputerEngineMove();
  return (await registry.describe()).map((instance: any) => {
    const entry = configs[instance.instanceId];
    const described = {
      ...instance,
      ...(entry?.icon ? { icon: entry.icon } : {}),
      ...(entry?.access ? { access: entry.access } : {}),
    };
    
    // Windows keeps what Antigravity's runtime unpacked whenever it is
    // stopped by force; its Settings card offers to clear that.
    if (instance.driverKind === "antigravityAgent" && process.platform === "win32") return { ...described, freeUpSpace: true };
    if (!isClaudeAccountDriver(entry?.driver)) return described;
    // Claude on the workspace API key has no account to sign in to.
    if (instance.instanceId === CLAUDE_API_INSTANCE) {
      return { ...described, authentication: undefined, install: { ...instance.install, signInCommand: undefined } };
    }
    try {
      const claudeAccount = claudeAccountInfo(instance.instanceId, entry, instance.cli ?? instance.cliDefault ?? "claude");
      return { ...described, claudeAccount, install: { ...instance.install, signInCommand: claudeAccount.signInCommand } };
    } catch {
      // A malformed saved config remains a repairable shadow, never takes
      // the model picker down or offers a login for the wrong directory.
      return { ...described, install: { ...instance.install, signInCommand: undefined } };
    }
  });
}

/** Set once graceful shutdown begins: startup work stops rather than racing
 * the teardown. */
async function persistProviderInstance(instanceId: string, instances: NonNullable<AppConfig["instances"]>) {
  saveConfig({ instances }, { replaceInstances: true });
  cfg.instances = instances;
  providerAuthSessions.clearInstance(instanceId);
  bus.detach(instanceId);
  // No whole-fleet reload: other bots keep their live CLI processes, event
  // subscriptions and approval capabilities while this one is replaced.
  if (Object.hasOwn(instances, instanceId)) {
    await registry.load({ [instanceId]: instanceConfigs(cfg)[instanceId] });
    const live = registry.get(instanceId);
    if (live) {
      bus.attach([live]);
      // A replaced engine learns its models in the background; tell the open
      // picker when its new list lands.
      void announceWhenModelsLand([live], () => broadcast({ kind: "config", ...configStatus() }));
    }
  } else {
    await registry.dispose(instanceId);
  }
  resetPathCache();
}

/** Rebuild the provider fleet after a config change so new keys take
 * effect without a server restart (kills any in-flight turns). */
async function reloadProviders() {
  setProviderFleetReloading(true);
  providerAuthSessions.clear();
  // Every provider process is about to die. Revoke all turn capabilities in
  // one synchronous step before the first teardown await, including room/task
  // threads that are not a bot's default DM.
  revokeAllInternalCapabilities();
  const direct = store.bots.flatMap((bot: any) => store.tasks(bot.id)
    .filter((task: any) => threadBusy(bot.id, task.threadId))
    .map((task: any) => ({ botId: bot.id, threadId: task.threadId, owner: turnResourceOwners.get(task.threadId) })));
  for (const task of direct) cancelDirectTurnDispatch(task.botId, task.threadId);
  bus.detachAll();
  try {
    await registry.disposeAll();
    await registry.load(providerConfigs());
    const instances = registry.instances();
    bus.attach(instances);
    // Every rebuilt engine learns its models in the background; tell the open
    // picker once, as each list lands.
    void announceWhenModelsLand(instances, () => broadcast({ kind: "config", ...configStatus() }));
  } finally {
    // Settle every exact conversation, not whichever one is selected now.
    // Teardown can swallow terminal events; no task may remain busy forever.
    for (const { botId, threadId, owner } of direct) {
      stopScreenPoller(botId, threadId);
      releaseTurnResources(owner);
      watchdog.settle(threadId);
      closeOpenApprovals(threadId);
      directTurnBots.delete(threadId);
      finalizeDelegationWatch(threadId, false, "", "Delegated turn did not finish — provider settings changed");
      routines()?.failThread(threadId, "Provider settings changed while this thread was running");
      if (store.taskByThread(botId, threadId)) {
        store.appendMessage(threadId, {
          role: "bot", kind: "activity",
          tool: failedTurnTool("turn interrupted — provider settings changed"),
        });
        store.setTaskActivity(botId, threadId, "idle");
      }
      settleDirectFollowup(owner?.generation);
      retryDelegationsWaitingOn(botId);
    }
    setProviderFleetReloading(false);
  }
  // killed turns settle here without a turn.completed event, so anything
  // queued behind them drains now — onto the freshly loaded fleet
  drainQueuedSends();
  drainConnectorResumes();
  drainComputerResumes();
  drainSecretResumes();
  drainTeamSetupResumes();
}


  return {
    configStatus,
    configForAccess,
    engineMcpServers,
    persistMcpServers,
    describeInstances,
    persistProviderInstance,
    reloadProviders,
  };
}
