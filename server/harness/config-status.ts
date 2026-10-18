// Server status and settings: local-VM payloads and readiness, edition/settings status, access filtering, MCP server persistence, instance description/persistence and provider reload.
import * as tts from "../tts/index.ts";
import * as composio from "../colonie/mcp/composio.ts";
import { type BotRecord } from "../persistence/store.ts";
import { failedTurnTool } from "../../shared/failed-turn.ts";
import { avatarImageStatus } from "../colonie/bots/avatar-image.ts";
import { containerComputerAction, containerComputerStatus, containerRuntimeStatus, localVmWakeAction, perBotLocalVmTarget, setupCommands, type ContainerComputerStatus, type LocalVmTarget, type Runtime} from "../colonie/computer/container-computer.ts";
import { localVmViewerStatus } from "../colonie/computer/desktop-viewer-targets.ts";
import { discoverExistingPerBotLocalVms } from "../colonie/computer/local-vm-inventory.ts";
import { localVmStopReason } from "../colonie/computer/local-vm-stop-reason.ts";
import { withoutPendingSignIn } from "../colonie/mcp/mcp-oauth.ts";
import { claudeAccountInfo, isClaudeAccountDriver } from "../colonie/providers/claude-accounts.ts";
import { CLAUDE_API_INSTANCE, autoRecallEnabled, builtInBrowserEnabled, claudeUserMcpEnabled, customMcpServers, instanceConfigs, liveSettingsFor, llmThreadTitlesEnabled, localVmIdleTimeoutMinutes, localVmMaxInstances, localVmMode, maxConcurrentBotThreads, mcpCallTimeoutMinutes, openCodeProviderKeys, routinesInConversationEnabled, saveConfig, sharedComputersEnabled, showToolCallsEnabled, skillAuthoringEnabled, skillsLibraryEnabled, threadEventLogMaxBytes, threadEventLogRetentionDays, type AppConfig } from "../config.ts";
import { describeDecider } from "../decider/index.ts";
import { decisionRetentionDays } from "../decision-log.ts";
import { LICENSE_WARN_DAYS, editionStatus, workspaceMembership, type EditionStatus } from "../enterprise.ts";
import { type RequestAuth } from "../request-auth.ts";
import { resetPathCache } from "../runtime/env-path.ts";
import { existsSync } from "node:fs";

/** Everything this cluster reaches in the server; see the header. */
export interface ConfigStatusDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
  setLocalVmProvisionBusy: (value: any) => void,
  setProviderFleetReloading: (value: any) => void,
}

export function createConfigStatus(deps: ConfigStatusDeps) {
  const {
    LOCAL_VM_DESKTOP_WAIT_MS, broadcast, browserEngineSummary, cfg, localVmIdleMs,
    localVmLifecycleBusy, localVmProvisionBusy, mcpOAuth, noteLocalVmSeen, providerConfigs,
    registry, retryComputerEngineMove, store, bus,
    cancelDirectTurnDispatch, directTurnBots, drainComputerResumes, drainConnectorResumes,
    drainQueuedSends, drainSecretResumes, providerAuthSessions, 
    releaseTurnResources, revokeAllInternalCapabilities, routines, settleDirectFollowup,
    stopScreenPoller, threadBusy, turnResourceOwners, setLocalVmProvisionBusy,
    setProviderFleetReloading,
    localVmIdleFor, releaseLocalVmThread, watchdog, closeOpenApprovals,
    finalizeDelegationWatch, retryDelegationsWaitingOn, drainTeamSetupResumes
  } = deps;
async function localVmPayload(target: LocalVmTarget, auth: RequestAuth) {
  const status = await containerComputerStatus(undefined, undefined, target);
  return {
    ...localVmViewerStatus(status, auth),
    stop_reason: localVmStopReason(target.key, status),
    commands: setupCommands(status.runtime, process.platform, target),
    idle_timeout_ms: localVmIdleMs(),
    mode: localVmMode(cfg),
    max_instances: localVmMaxInstances(cfg),
  };
}

/** Wake an idle desktop, or recreate a missing one from an already prepared
 * image. Incompatible or unsafe containers still require an explicit decision. */
async function readyLocalVmForTurn(botId: string, target: LocalVmTarget, isCurrent = () => true) {
  localVmLifecycleBusy.add(target.key);
  // Fence this target, and the cross-target capacity decision for creates,
  // before the first await — the same synchronous-fence-then-count shape
  // the panel route uses — so two concurrent turns cannot both pass the
  // per-bot limit between count and create.
  // Pool capacity is bounded by its seat indices. Each seat already has
  // its own lease/lifecycle fence, so independent cold seats can start
  // together without competing for the per-bot inventory's capacity gate.
  const pooled = target.key.startsWith("pool:");
  const ownsProvision = !pooled && !localVmProvisionBusy();
  if (ownsProvision) setLocalVmProvisionBusy(true);
  let status: ContainerComputerStatus;
  try {
    status = await containerComputerStatus(undefined, undefined, target);
    noteLocalVmSeen(target, status);
    if (!isCurrent()) return status;
    const action = localVmWakeAction(status);
    if (status.ready || !action || !status.runtime) return status;
    // Another creation is already mid-flight and its container is not yet
    // visible to a count, so the safe answer is the inspected status —
    // exactly what the over-cap path below returns.
    if (action === "run" && !pooled && !ownsProvision) return status;

    if (action === "run" && target.key.startsWith("bot:")) {
      const count = await existingPerBotLocalVmCount(status.runtime);
      if (!isCurrent() || count >= localVmMaxInstances(cfg)) return status;
    }

    broadcast({ kind: "computer", botId, state: "provisioning" });
    try {
      status = await containerComputerAction(action, undefined, undefined, target);
    } catch {
      // Keep the inspected status: its `problem` names the real obstacle,
      // which is more use to the person than "podman run exited non-zero".
      // `run` can throw after the container exists, so arm the idle
      // backstop anyway — expiry defers while the target is busy and its
      // remove step no-ops unless a fresh probe sees a running container.
      // The problem text stays as inspected: cheaply telling a half-created
      // container from none here would need another container probe.
      localVmIdleFor(target).touch();
      return status;
    }
  } finally {
    if (ownsProvision) setLocalVmProvisionBusy(false);
    localVmLifecycleBusy.delete(target.key);
  }
  localVmIdleFor(target).touch();

  // The container is up before Cua Driver is. Waiting here rather than failing
  // the turn is the whole point: a person who has been away eight hours should
  // not have to send their message twice.
  const deadline = Date.now() + LOCAL_VM_DESKTOP_WAIT_MS;
  while (isCurrent() && !status.ready && status.container === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (!isCurrent()) break;
    status = await containerComputerStatus(undefined, undefined, target);
  }
  return status;
}

async function existingPerBotLocalVmCount(runtime: Runtime) {
  return (await discoverExistingPerBotLocalVms(store.bots, runtime)).length;
}

async function perBotLocalVmCountForModeChange(): Promise<number | null> {
  const targets = [...new Map(store.bots.map((bot: any) => {
    const target = perBotLocalVmTarget(bot.id);
    return [target.key, target] as const;
  })).values()];
  if (targets.length === 0) return 0;
  const runtime = await containerRuntimeStatus();
  if (!runtime.runtime || !runtime.daemonUp) {
    return targets.some((target: any) => existsSync(target.workspaceDir)) ? null : 0;
  }
  return existingPerBotLocalVmCount(runtime.runtime);
}

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
    localVm: {
      mode: localVmMode(cfg),
      maxInstances: localVmMaxInstances(cfg),
      idleTimeoutMinutes: localVmIdleTimeoutMinutes(cfg),
    },
    features: {
      skillAuthoring: skillAuthoringEnabled(cfg),
      skillsLibrary: skillsLibraryEnabled(cfg),
      showToolCalls: showToolCallsEnabled(cfg),
      routinesInConversation: routinesInConversationEnabled(cfg),
      browser: builtInBrowserEnabled(cfg),
      // Maintainer-only escape hatch, not a Settings toggle: the desktop
      // shell and the Settings UI read it so they offer nothing this server
      // would refuse.
      sharedComputers: sharedComputersEnabled(cfg),
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
    if (live) bus.attach([live]);
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
    bus.attach(registry.instances());
  } finally {
    // Settle every exact conversation, not whichever one is selected now.
    // Teardown can swallow terminal events; no task may remain busy forever.
    for (const { botId, threadId, owner } of direct) {
      stopScreenPoller(botId, threadId);
      releaseLocalVmThread(threadId);
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
    localVmPayload,
    readyLocalVmForTurn,
    existingPerBotLocalVmCount,
    perBotLocalVmCountForModeChange,
    configStatus,
    configForAccess,
    engineMcpServers,
    persistMcpServers,
    describeInstances,
    persistProviderInstance,
    reloadProviders,
  };
}
