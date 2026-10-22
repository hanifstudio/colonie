// HTTP plumbing: static serving, page headers, workspace-backup access and routes, the whole ROUTES registration block, the live-route helpers, and the request handler wire plus the createServer/attach step.
import { isColonieAcpDriver } from "../../shared/acp.ts";
import { AcpRuntime } from "../acp/acp-runtime.ts";
import { createAcpContextRoutes } from "../acp/context-routes.ts";
import { contextPin } from "../acp/context.ts";
import { nativeHistoryConflict } from "../acp/native-history.ts";
import { inputReceipts } from "../acp/receipts.ts";
import { createAcpSettingsRoutes } from "../acp/settings-routes.ts";
import { flushAdminActivity } from "../admin-activity.ts";
import { DirectSendRefused } from "../colonie/chat/direct-send.ts";
import { isSteeredMessageQueued } from "../colonie/chat/steer-queue.ts";
import { readThreadEvents } from "../colonie/chat/thread-events.ts";
import { createChiefRoutes } from "../colonie/chief/routes.ts";
import { composioCredentialRoutes } from "../colonie/connections/credential-routes.ts";
import * as composio from "../colonie/mcp/composio.ts";
import { composioCredentialStatus } from "../colonie/connections/credential-status.ts";
import { connectedToolsRoutes } from "../colonie/connections/routes.ts";
import { createColonieMemoryRoutes } from "../colonie/memory/ledger/routes.ts";
import { flushAllMemoryJournals } from "../colonie/memory/memory-journal.ts";
import { pendingDelegationSnapshot } from "../colonie/peers/delegations.ts";
import { flushUsageLedger } from "../colonie/providers/usage-ledger.ts";
import { createColonieSkillsRoutes } from "../colonie/skills/routes.ts";
import { createSkillResolution } from "../colonie/skills/skill-resolution.ts";
import { createWorkspaceBackupRoutes } from "../colonie/workspace/workspace-backup-http.ts";
import { ensureTaskWorkspace } from "../colonie/workspace/workspace.ts";
import { DATA_DIR, EVENTS_DIR, NATIVE_DIR, customMcpServers, instanceConfigs, liveSettingsFor, loadConfig, saveConfig } from "../config.ts";
import { flushDecisionLog, withDecisionActor } from "../decision-log.ts";
import { findAntigravityLeftovers, removeAntigravityLeftovers } from "../drivers/antigravity-temp.ts";
import { entitled } from "../enterprise.ts";
import { readBody } from "../harness/http.ts";
import { createRequestHandler } from "../harness/request-handler.ts";
import { LiveCallController, LiveCallSignedOutError, type LiveSocket } from "../live-call-controller.ts";
import { LiveSessionError, createLiveSession, liveAttachUrl, type LiveBot, type LiveHistoryMessage } from "../live-call.ts";
import { closeMessageDb, closeMessageSearch } from "../persistence/message-db.ts";
import { flushAllProfileHistory } from "../profile-versions.ts";
import { type RequestAuth, resolveRequestAuth } from "../request-auth.ts";
import { createAdminReadRoutes } from "../routes/admin-reads.ts";
import { createAntigravityLeftoverRoutes } from "../routes/antigravity-leftovers.ts";
import { createAuthSessionRoutes } from "../routes/auth-sessions.ts";
import { createBotAcpRoutes } from "../routes/bot-acp.ts";
import { createBotActivityRoutes } from "../routes/bot-activity.ts";
import { createBotCreateRoutes } from "../routes/bot-create.ts";
import { createBotDefaultRoutes } from "../routes/bot-defaults.ts";
import { createBotMemoryRoutes } from "../routes/bot-memory.ts";
import { createBotMessagesRoutes } from "../routes/bot-messages.ts";
import { createBotPresetRoutes } from "../routes/bot-presets.ts";
import { createBotProfilePatchRoutes } from "../routes/bot-profile-patch.ts";
import { createBotProfileRoutes } from "../routes/bot-profile.ts";
import { createBotReadRoutes } from "../routes/bot-read.ts";
import { createBotTaskRoutes } from "../routes/bot-task.ts";
import { createBotUpdateRoutes } from "../routes/bot-update.ts";
import { createCalendarWebhookRoutes } from "../routes/calendar-webhooks.ts";
import { cliProbeRoutes } from "../routes/cli-probe.ts";
import { createCommandAllowlistRoutes } from "../routes/command-allowlist.ts";
import { createConfigRoutes } from "../routes/config.ts";
import { createConnectorRoutes } from "../routes/connectors.ts";
import { createDeciderRoutes } from "../routes/decider.ts";
import { createEventRoutes } from "../routes/events.ts";
import { createHostedSlackRoutes } from "../routes/hosted-slack.ts";
import { createLiveRoutes } from "../routes/live.ts";
import { createMcpServerRoutes } from "../routes/mcp-servers.ts";
import { createProviderInstanceRoutes } from "../routes/provider-instances.ts";
import { createQueueSteerRoutes } from "../routes/queue-steer.ts";
import { createReactionRoutes } from "../routes/reactions.ts";
import { createRoutineRoutes } from "../routes/routines.ts";
import { createServerInfoRoutes } from "../routes/server-info.ts";
import { createSkillsLibraryRoutes } from "../routes/skills-library.ts";
import { ROUTES } from "../routes/table.ts";
import { createTeamBriefRoutes } from "../routes/team-brief.ts";
import { teamLibraryRoutes } from "../routes/team-library.ts";
import { createTeamMapRoutes } from "../routes/team-map.ts";
import { createTeamSectionRoutes } from "../routes/team-sections.ts";
import { createTeamsExportRoutes } from "../routes/teams-export.ts";
import { createTeamsImportRoutes } from "../routes/teams-import.ts";
import { createThreadEventsRoutes } from "../routes/thread-events.ts";
import { createThreadModelRoutes } from "../routes/thread-models.ts";
import { createThreadRespondRoutes } from "../routes/thread-respond.ts";
import { createUndoRoutes } from "../routes/undo.ts";
import { createUploadRoutes } from "../routes/uploads.ts";
import { createUsageRoutes } from "../routes/usage.ts";
import { createVoiceRoutes } from "../routes/voice.ts";
import { serverVersion } from "../runtime/environment.ts";
import { spendState } from "../spend.ts";
import { toUtterances } from "../tts/speech-text.ts";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";

/** Everything this cluster reaches in the server; see the header. */
export interface ServerAssemblyDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
  setBrowserEngineInstall: (value: any) => void,
  setBrowserEngineInstallError: (value: any) => void,
  setCustomDomainRevision: (value: any) => void,
  setLocalVmProvisionBusy: (value: any) => void,
}

/** Strip any ".." so a request can never climb out of the built UI's root. */
export function staticRelativePath(path: string): string {
  return path === "/" ? "/index.html" : path.replace(/\.\./g, "");
}

export function createServerAssembly(deps: ServerAssemblyDeps) {
  const {
    COMMAND_ALLOWLIST_DRIVERS, DEFAULT_PAGE, DESKTOP_MANAGED, ENVIRONMENT_ID, FALLBACK_PUBLIC_URL,
    HOSTED_WORKSPACE, LOOPBACK, MAX_COMMS_DEPTH, MAX_WORKSPACE_BOTS, MIME, PORT, SESSION_COOKIE,
    SSE_HEARTBEAT_MS, STATIC_DIR, STREAM_ID, acpToolMount, actorKey, adminActivityRecording,
    answeringCardAs, approvalBus, approvalModeForTurn, audienceChanged, audienceChangedAt,
    beginAdminAudit, beginInternalCapabilityGeneration, botAppPolicies, botAtThreadCapacity,
    botForThread, botOverview, broadcast, browserCleanup, browserEngineInstall,
    browserEngineInstallError, browserIntegration, browserLive, browserRuntime, calendarCalls,
    canManageCommandAllowlist, cancelDirectTurnDispatch, cardAnswerRefusal, cfg,
    clearTurnDigestState, clearUnattended, collectTeamSkills, colonieChief, colonieMemory,
    colonieMemoryStore, colonieSkills, commandAllowlist, commandAllowlistResponse, computerControl,
    connectedTools, connectorMessage, controlLeaseIdSchema, currentBrowserSession,
    currentSecretState, cursorSeq, customDomainRevision, customDomainStatus, customDomainVerifier,
    decider, decisionActorFor, defaultsPresetFor, deleteBotWithLifecycle,
    deliverLateQuestionAnswer, desktopMutationToken, desktopViewer, directRequestOwners,
    directTurnBots, directTurnDispatchClaims, directTurnGenerationByThread, drainComputerResumes,
    drainConnectorResumes, drainQueuedSends, drainSecretResumes, emailSignIn,
    forgetTemporaryBrowser, generateThreadTitle, guardedRequestSnapshot, guardedSendSchema,
    interruptAllDirectThreads, interruptDirectThread, lastSeq, learnedFacts, lendingEnabled,
    listBotSkills, localVmActiveThreads, localVmFlags, localVmIdleMs, localVmIdles,
    localVmLifecycleBusy, localVmOwnerBusy, localVmProvisionBusy, localVmSeen,
    maybeResumeConnectors, mcpConfigLock, mcpOAuth, memberFrame, memoryUpkeep,
    messageFileRootsForThread, messagePage, messageSender, messageWindow, mintInternalCapability,
    operatorPrices, outboundCounts, packageImportDeps, pageSize, personKey, presetStore,
    previewSystemPrompt, providerAuthSessions, providerFleetReloading, providerInstancesChanging,
    providerWrite, publicBot, publicBotQueuedMessages, readBotSkillFile, registry,
    rejectDeletedThreadSkillStages, replayBuffer, requestedTaskBot, resolveReplyTarget,
    resumeSecretCard, revokeAllInternalCapabilities, revokeInternalCapabilitiesForThread, routines,
    savedCustomDomain, secretMessage, sessionLendingPrincipal, sessions, settleDirectFollowup,
    sharedComputerControl, sharedComputers, sharedWorkspaceFullAccessEnabled, sseClients,
    stagedSkillCleanupsForThread, stagedSkillListing, startTurn, starterNotes, store,
    storedAvatarExists, subjectVisible, supportsApprovalMode, teamComputers, teamMemory,
    threadBusy, threadStarters, titleRegenerations, usageTriggerFor, viewerFor, visibleTo, ownThreadIds, wants,
    webhookIngressStatus, webhooks, wireBot, wireTask, workspaceAccess, workspaceMaintenance,
    workspaceRestore, setBrowserEngineInstall, setBrowserEngineInstallError,
    setCustomDomainRevision, setLocalVmProvisionBusy,
    acceptDirectSend,
    answerRequest,
    botComputerControlKey,
    botComputerControlSnapshot,
    botHasActiveTurn,
    cancelTeamSetupResumesForThread,
    checkedExportSkillNames,
    checkedModelSelection,
    checkedTaskModelSwitch,
    collectExportSkills,
    commandRememberRefusal,
    computerPreviewBot,
    computerPreviewSurface,
    configForAccess,
    configStatus,
    defaultSelection,
    delegationWatch,
    describeInstances,
    directSendRefusal,
    drainDelegationWakes,
    drainTeamSetupResumes,
    existingPerBotLocalVmCount,
    handoffs,
    healThreadModel,
    localVmIdleFor,
    localVmInventoryPayload,
    localVmLeaseFor,
    localVmPayload,
    localVmTargetForBot,
    localVmTargetForStatus,
    perBotLocalVmCountForModeChange,
    persistMcpServers,
    persistProviderInstance,
    reloadProviders,
    requestBehavior,
    resolveAndSendModel,
    resolveAndSendProfile,
    resolveAndSendRoutine,
    resolveAndSendTeamSetup,
    resolveAndSendTrust,
    respondToCard,
    runningTurnInstance,
    teamComputerInUse,
    turnSelection,
    undoAppliedChange,
    watchdog,
  } = deps;


// ── HTTP plumbing ─────────────────────────────────────────────────────
/** The web UI's pages: never framed by another page (a hidden frame could
 * otherwise act on a pair or sign-in page unseen), and they send no Referer.
 * Nothing frames the web UI: the desktop app shows it in its own window. */
const PAGE_HEADERS = { "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } as const;

/** The built UI, when this process serves it (COLONIE_STATIC_DIR: set by the
 * desktop app and by the container image). Public by design: it is the same
 * bundle anyone can download, holds no secrets, and a remote browser must be
 * able to load /pair before it has a session. Returns false when there is
 * nothing to serve so the caller can answer 404. */
function serveStatic(res: ServerResponse, path: string): boolean {
  if (!STATIC_DIR) return false;
  const safe = staticRelativePath(path);
  const file = join(STATIC_DIR, safe);
  try {
    const data = readFileSync(file);
    const type = MIME[extname(file)] ?? "application/octet-stream";
    // Vite puts a content hash in the name of every file it writes under
    // /assets/, so a URL there never changes: the browser keeps it instead of
    // downloading the bundle on every load. That only holds while public/ has
    // no assets/ dir (index.test.ts checks). Pages are revalidated, so a new
    // build shows up on the next load.
    const cache = type === "text/html" ? "no-cache" : safe.startsWith("/assets/") ? "public, max-age=31536000, immutable" : null;
    res.writeHead(200, { "content-type": type, ...(type === "text/html" ? PAGE_HEADERS : {}), ...(cache ? { "cache-control": cache } : {}) });
    res.end(data);
    return true;
  } catch {
    // SPA fallback. Never immutable: a missing chunk answered with the page
    // must not stay cached under the chunk's URL.
    try {
      const data = readFileSync(join(STATIC_DIR, "index.html"));
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-cache", ...PAGE_HEADERS });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
}

// Loopback-only enforcement: the harness runs on 127.0.0.1 but accepts
// requests from any loopback connection and any web page that DNS-rebinds
// onto it. Reject non-loopback Hosts outright (defeats rebinding) and
// origins outside loopback (blocks remote-web CSRF).

const workspaceBackupAccess = {
  authorized: (req: IncomingMessage, original: RequestAuth) => {
    const current = resolveRequestAuth(req, {
      sessions, cookieName: SESSION_COOKIE, streamPath: "/api/events",
      url: new URL(req.url ?? "/", `http://localhost:${PORT}`),
      loopbackMutationToken: desktopMutationToken(), loopbackTrust: LOOPBACK.trust,
    }).auth;
    return Boolean(current?.scopes.includes("admin") && current.kind === original.kind &&
      (current.kind !== "session" || (original.kind === "session" && current.session.id === original.session.id)));
  },
  exclusive: <T>(work: () => Promise<T>, keepLocked?: boolean) => workspaceMaintenance.run(async () => {
    // Recheck inside the exclusive gate: the restore body can arrive slowly
    // while another client assigns a computer after the initial route check.
    if (keepLocked && teamComputers.list().some((computer: any) => computer.section !== null)) {
      throw Object.assign(new Error("Unassign team computers before restoring this workspace"), { status: 409 });
    }
    return work();
  }, {
    idle: () => !providerFleetReloading() && !providerAuthSessions.active && !browserEngineInstall() &&
      !routines()?.isTicking && !calendarCalls()?.isTicking &&
      !localVmFlags.imageBusy && !localVmProvisionBusy() && !localVmFlags.modeChangeBusy &&
      !localVmLifecycleBusy.size &&
      teamComputers.list().every((computer: any) => !teamComputerInUse(computer)) &&
      store.bots.every((bot: any) => !botHasActiveTurn(bot.id) && !routines()?.activeRunForBot(bot.id) && !botComputerControlSnapshot(bot.id).held),
    pause: () => { routines()?.stop(); calendarCalls()?.stop(); watchdog.stop(); memoryUpkeep.pause(); },
    resume: () => { routines()?.start(); calendarCalls()?.start(); watchdog.start(); memoryUpkeep.resume(); },
    flush: async () => {
      await Promise.all([flushAllProfileHistory(), flushAllMemoryJournals(), flushUsageLedger(DATA_DIR), flushDecisionLog(DATA_DIR), flushAdminActivity(DATA_DIR)]);
      // With writers gated and work idle, release our WAL connection for the
      // consistent snapshot. Store reopens it lazily after maintenance.
      await closeMessageSearch();
      closeMessageDb();
    },
  }, keepLocked),
  status: () => ({ busy: workspaceMaintenance.active, pendingRestore: workspaceMaintenance.pendingRestore }),
};
const workspaceBackupRoutes = createWorkspaceBackupRoutes({
  dataDir: DATA_DIR,
  appVersion: serverVersion(),
  readBody,
  restored: workspaceRestore(),
  shared: () => deps.ownThreads.shared(),
  ...workspaceBackupAccess,
});
// Route modules (server/routes/README.md). `workspaceAccess` is assigned at
// boot, after this line, so the dependency reads it per request.
const { resolveSkillRequest: resolveSkillRequestFn, sendSkillResolution: sendSkillResolutionFn } = createSkillResolution({ store });
ROUTES.push(createHostedSlackRoutes({ bot: (id) => store.bot(id), hostedReady: () => Boolean(workspaceAccess()) && entitled("admin") }));
ROUTES.push(composioCredentialRoutes(() => composioCredentialStatus(cfg)));
ROUTES.push(createColonieMemoryRoutes({ service: colonieMemory(), exists: (botId) => Boolean(store.bot(botId)),
  setBotMemoryEnabled: (botId, enabled) => {
    store.patchBot(botId, { memoryEnabled: enabled, memoryUpkeep: colonieMemoryStore()?.snapshot(botId).bot.automatic ?? true });
  },
}));
ROUTES.push(createColonieSkillsRoutes({ service: colonieSkills, exists: (botId) => Boolean(store.bot(botId)) }));
// A role transfer emits a bot change per affected bot from the store, so the
// existing broadcast already refreshes every window; no extra signal is needed.
ROUTES.push(createChiefRoutes({ chief: colonieChief, exists: (botId) => Boolean(store.bot(botId)) }));
ROUTES.push(connectedToolsRoutes({
  policies: botAppPolicies,
  exists: (botId) => Boolean(store.bot(botId)), busy: (botId) => store.tasks(botId).some((task: any) => threadBusy(botId, task.threadId)
    || registry.instances().some((instance: any) => instance.adapter instanceof AcpRuntime && instance.adapter.isConfiguring(task.threadId))),
  configured: () => Boolean(cfg.composio?.apiKey), customNames: () => Object.keys(customMcpServers(cfg)),
  invalidateBot: (botId) => connectedTools.invalidateBot(botId),
}));
// The bot's ACP inspector (server/routes/bot-acp.ts): the tool receipts a turn
// has produced, and the reply the adapter is streaming right now.
ROUTES.push(createBotAcpRoutes({
  bot: (id) => store.bot(id),
  currentThread: (bot, auth) => deps.ownThreads.currentThread(deps.personOf(auth), bot),
  hasThread: (botId, threadId) => store.tasks(botId).some((task: any) => task.threadId === threadId),
  inputReceipts,
  liveReply: (botId: string, threadId: string, fallbackInstanceId: string) => {
    const adapter = registry.get(botForThread(botId, threadId)?.modelSelection.instanceId ?? fallbackInstanceId)?.adapter;
    return adapter instanceof AcpRuntime ? adapter.liveReply(threadId) : null;
  },
}));
ROUTES.push(createAcpContextRoutes({
  resolve: (botId, threadId) => {
    const profile = store.projectBotForTask(botId, threadId);
    if (!profile) throw Object.assign(new Error("No such conversation"), { status: 404 });
    if (!isColonieAcpDriver(registry.get(profile.modelSelection.instanceId)?.driverKind)) throw Object.assign(new Error("This connection has no Colonie ACP context"), { status: 409 });
    const task = store.taskByThread(botId, threadId)!;
    const config = instanceConfigs(cfg)[profile.modelSelection.instanceId]?.config as { instructions?: string } | undefined;
    return { profile, instanceId: profile.modelSelection.instanceId, instructions: config?.instructions ?? "",
      legacyPlain: !contextPin(threadId) && Boolean(task.lastInstanceId || inputReceipts(threadId).length) };
  },
}));
ROUTES.push(createAcpSettingsRoutes({
  resolve: async (botId, threadId) => {
    const bot = store.projectBotForTask(botId, threadId);
    if (!bot) throw Object.assign(new Error("No such conversation"), { status: 404 });
    if (threadBusy(botId, threadId) || providerFleetReloading() || providerInstancesChanging.has(bot.modelSelection.instanceId)) throw Object.assign(new Error("The conversation/provider is busy. Wait before changing native settings."), { status: 409 });
    const instance = registry.get(bot.modelSelection.instanceId);
    if (!instance || !(instance.adapter instanceof AcpRuntime)) throw Object.assign(new Error("This connection has no native ACP controls"), { status: 409 });
    const task = store.taskByThread(botId, threadId)!;
    if (nativeHistoryConflict({ hasUserHistory: store.activePath(threadId).some((message: any) => message.role === "user" && message.kind === "text"), selectedInstanceId: instance.instanceId, lastInstanceId: task.lastInstanceId, cursors: task.resumeCursors })) {
      throw Object.assign(new Error("This conversation belongs to another native agent. Start a new thread before preparing this provider's settings."), { status: 409 });
    }
    const cwd = store.pinTaskCwd(botId, threadId, ensureTaskWorkspace(botId, threadId));
    const mounts = await acpToolMount(botId, threadId, instance.instanceId);
    return { adapter: instance.adapter, input: { threadId, botId, text: "", cwd: cwd ?? undefined,
      acpTools: mounts.tools, ...(mounts.extra ? { acpExtraTools: mounts.extra } : {}),
      model: bot.modelSelection.model, approvalMode: approvalModeForTurn(bot, false), resumeCursor: store.taskByThread(botId, threadId)?.resumeCursors[instance.instanceId] } };
  },
  assertCurrent: (botId, threadId, adapter, input) => {
    const bot = store.projectBotForTask(botId, threadId);
    if (!bot || registry.get(bot.modelSelection.instanceId)?.adapter !== adapter || bot.modelSelection.model !== input.model || approvalModeForTurn(bot, false) !== input.approvalMode) {
      throw Object.assign(new Error("Agent/model/permission selection changed during native configuration. Refresh the panel."), { status: 409 });
    }
  },
  recordSession: (botId, threadId, instanceId, sessionId) => { store.setResumeCursor(botId, instanceId, sessionId, threadId); },
  recordModel: (botId, threadId, model) => {
    const bot = store.projectBotForTask(botId, threadId);
    if (bot) store.patchTask(botId, threadId, { modelSelection: { instanceId: bot.modelSelection.instanceId, model } });
  },
}));
ROUTES.push(createBotPresetRoutes({ presets: presetStore }));
ROUTES.push(createVoiceRoutes({ cfg }));
ROUTES.push(createConnectorRoutes({ cfg, composio }));
ROUTES.push(createAdminReadRoutes({ cfg, adminActivityRecording, ownThreadIds }));
ROUTES.push(createBotActivityRoutes({ store, outboundCounts, ownThreadIds }));
ROUTES.push(createServerInfoRoutes({ staticDir: STATIC_DIR, sharedWorkspaceFullAccessEnabled }));
ROUTES.push(teamLibraryRoutes);
ROUTES.push(cliProbeRoutes);
ROUTES.push(createTeamMapRoutes({
  store,
  visibleFor: (auth) => visibleTo(viewerFor(auth)),
  pendingDelegationSnapshot,
  delegationWatch,
}));
ROUTES.push(createRoutineRoutes({
  routines: routines()!,
  store,
  visibleFor: (auth) => visibleTo(viewerFor(auth)),
}));
ROUTES.push(createCalendarWebhookRoutes({
  calendarCalls: () => calendarCalls()!,
  webhooks,
  webhookIngressStatus,
  store,
  visibleFor: (auth) => visibleTo(viewerFor(auth)),
}));
ROUTES.push(createReactionRoutes({ store }));
ROUTES.push(createAuthSessionRoutes({ sessions, cookieName: SESSION_COOKIE }));
ROUTES.push(createBotReadRoutes({ store, requestedTaskBot, wireBot, broadcast, shared: () => deps.ownThreads.shared() }));
ROUTES.push(createBotProfilePatchRoutes({ store, storedAvatarExists, wireBot, broadcast }));
ROUTES.push(createThreadEventsRoutes({ store, eventsDir: EVENTS_DIR, nativeDir: NATIVE_DIR, readThreadEvents }));
ROUTES.push(createCommandAllowlistRoutes({
  store,
  allowlist: commandAllowlist,
  registry,
  canManage: canManageCommandAllowlist,
  requestedTaskBot,
  response: commandAllowlistResponse,
  drivers: COMMAND_ALLOWLIST_DRIVERS,
}));
ROUTES.push(createBotUpdateRoutes({
  selectedTaskBot: deps.selectedTaskBot,
  store,
  cfg,
  registry,
  sessions,
  routines: () => routines(),
  memoryUpkeep,
  browserLive,
  browserRuntime,
  desktopManaged: DESKTOP_MANAGED,
  maxWorkspaceBots: MAX_WORKSPACE_BOTS,
  broadcast,
  wireBot,
  requestedTaskBot,
  threadBusy,
  checkedModelSelection,
  supportsApprovalMode,
  audienceChanged,
  currentBrowserSession,
  interruptAllDirectThreads,
  forgetTemporaryBrowser,
  storedAvatarExists,
  shared: () => deps.ownThreads.shared(),
}));
ROUTES.push(createBotTaskRoutes({
  ownThreads: deps.ownThreads,
  personOf: deps.personOf,
  store,
  desktopManaged: DESKTOP_MANAGED,
  handoffs,
  directTurnGenerationByThread,
  routines: () => routines(),
  wireBot,
  wireTask,
  publicBot,
  messagePage,
  pageSize,
  threadBusy,
  checkedModelSelection,
  checkedTaskModelSwitch,
  supportsApprovalMode,
  clearTurnDigestState,
  settleDirectFollowup,
  cancelTeamSetupResumesForThread,
  revokeInternalCapabilitiesForThread,
  stagedSkillCleanupsForThread,
  rejectDeletedThreadSkillStages,
}));
ROUTES.push(createBotCreateRoutes({
  store,
  cfg,
  presetStore,
  routines: () => routines(),
  desktopManaged: DESKTOP_MANAGED,
  maxWorkspaceBots: MAX_WORKSPACE_BOTS,
  wireBot,
  storedAvatarExists,
  defaultSelection,
  checkedModelSelection,
}));
ROUTES.push(createThreadRespondRoutes({
  store,
  desktopManaged: DESKTOP_MANAGED,
  approvalBus,
  botForThread,
  answerRequest,
  answeringCardAs,
  cardAnswerRefusal,
  commandRememberRefusal,
  requestBehavior,
  deliverLateQuestionAnswer,
  resolveAndSendModel,
  resolveAndSendProfile,
  resolveAndSendRoutine,
  resolveAndSendTeamSetup,
  resolveAndSendTrust,
  resolveSkillRequest: resolveSkillRequestFn,
  sendSkillResolution: sendSkillResolutionFn,
  requestedTaskBot,
}));
ROUTES.push(createTeamsExportRoutes({
  store,
  cfg,
  shared: () => deps.ownThreads.shared(),
  routines: () => routines(),
  defaultsPresetFor,
  starterNotes,
  checkedExportSkillNames,
  collectExportSkills,
  collectTeamSkills,
}));
ROUTES.push(createTeamsImportRoutes({
  store,
  routines: () => routines(),
  broadcast,
  publicBot,
  defaultSelection,
  packageImportDeps,
}));
ROUTES.push(createUploadRoutes());
ROUTES.push(createEventRoutes({
  store,
  sessions,
  sseClients,
  replayBuffer,
  lastSeq: () => lastSeq(),
  audienceChangedAt: () => audienceChangedAt(),
  streamId: STREAM_ID,
  heartbeatMs: SSE_HEARTBEAT_MS,
  cursorSeq,
  viewerFor,
  visibleTo,
  wants,
  memberFrame,
  streamFrame: deps.streamFrame,
}));
ROUTES.push(createBotMessagesRoutes({
  ownThreads: deps.ownThreads,
  personOf: deps.personOf,
  visibleFor: (auth: any) => visibleTo(viewerFor(auth)),
  store,
  desktopManaged: DESKTOP_MANAGED,
  guardedSendSchema,
  directSendRefusal,
  resolveReplyTarget,
  messageSender,
  usageTriggerFor,
  acceptDirectSend,
  startTurn,
  botAtThreadCapacity,
  threadBusy,
  DirectSendRefused,
}));
ROUTES.push(createQueueSteerRoutes({
  store,
  desktopManaged: DESKTOP_MANAGED,
  handoffs,
  requestedTaskBot,
  runningTurnInstance,
  clearUnattended,
  drainQueuedSends,
  shared: () => deps.ownThreads.shared(),
}));
ROUTES.push(createProviderInstanceRoutes({
  store,
  cfg,
  registry,
  providerAuthSessions,
  sessions,
  providerInstancesChanging,
  providerWrite,
  botForThread,
  threadBusy,
  describeInstances,
  persistProviderInstance,
  configStatus,
  broadcast,
}));
ROUTES.push(createConfigRoutes({
  store,
  cfg,
  registry,
  sessions,
  providerWrite,
  localVmFlags,
  localVmIdles,
  localVmActiveThreads,
  localVmLifecycleBusy,
  browserCleanup,
  browserLive,
  browserRuntime,
  decider,
  sharedComputers,
  sharedComputerControl,
  broadcast,
  configStatus,
  configForAccess,
  checkedModelSelection,
  lendingEnabled,
  localVmIdleMs,
  perBotLocalVmCountForModeChange,
  reloadProviders,
  revokeAllInternalCapabilities,
  drainComputerResumes,
  drainConnectorResumes,
  drainDelegationWakes,
  drainQueuedSends,
  drainSecretResumes,
  drainTeamSetupResumes,
}));
ROUTES.push(createSkillsLibraryRoutes({ cfg, store }));
ROUTES.push(createTeamSectionRoutes({ store, teamComputers, wireBot, maxWorkspaceBots: MAX_WORKSPACE_BOTS }));
ROUTES.push(createBotDefaultRoutes({ cfg, store, defaultSelection: () => defaultSelection() }));
ROUTES.push(createMcpServerRoutes({
  cfg,
  mcpOAuth,
  sessions,
  persistMcpServers,
  mcpConfigLock,
  savedCustomDomain,
  fallbackPublicUrl: FALLBACK_PUBLIC_URL,
}));
ROUTES.push(createTeamBriefRoutes({ store, teamMemory }));
ROUTES.push(createBotProfileRoutes({ store, wireBot, broadcast, previewSystemPrompt, botOverview }));
// The bot-memory panel's routes (MEMORY.md, memory/ topics, journal); the
// store lookups — the 404 precheck and journal thread titles — stay explicit.
ROUTES.push(createBotMemoryRoutes({
  learned: learnedFacts,
  bot: (id) => store.bot(id),
  taskByThread: (botId, threadId) => store.taskByThread(botId, threadId),
  upkeep: memoryUpkeep,
  aboutMe: () => cfg.profile?.aboutMe ?? "",
  saveAboutMe: (aboutMe) => {
    saveConfig({ profile: { ...cfg.profile, aboutMe } });
    Object.assign(cfg, loadConfig());
    broadcast({ kind: "config", ...configStatus() });
  },
}));
ROUTES.push(createDeciderRoutes({ decider }));
// The usage ledger (JSON and CSV). Admin scope stays in server/request-auth.ts.
ROUTES.push(createUsageRoutes({
  dataDir: DATA_DIR,
  prices: operatorPrices,
  budget: () => spendState(cfg, DATA_DIR),
  currency: () => cfg.billing?.currency ?? "USD",
}));
// "Switch them too": a bot's threads on a model of their own follow its model again.
ROUTES.push(createThreadModelRoutes({
  bot: (id) => store.bot(id),
  busy: (botId, threadId) => threadBusy(botId, threadId),
  follow: (botId, threadIds) => store.followBotModel(botId, threadIds),
  mayChangeModel: () => true,
  reply: (botId) => publicBot(store.bot(botId)!),
}));
// Undo on the one-line receipt of a change that applied without a person.
ROUTES.push(createUndoRoutes({
  refusal: (auth, threadId, requestId) => cardAnswerRefusal(auth, threadId, requestId, "allow"),
  undo: (auth, res, threadId, requestId) => withDecisionActor(decisionActorFor(auth), () => undoAppliedChange(res, threadId, requestId)),
}));
ROUTES.push(createAntigravityLeftoverRoutes({
  
  isAntigravity: (instanceId) => registry.get(instanceId)?.driverKind === "antigravityAgent",
  find: () => findAntigravityLeftovers(),
  remove: () => removeAntigravityLeftovers(),
}));

ROUTES.push(desktopViewer.route);

// Live calls (GPT-Live as the voice, the bot as the brain). A client holds
// the WebRTC audio; the harness creates the session with the key (which
// never leaves it) and runs the call in LiveCallController.
/** Who the voice speaks for, for its instructions. */
function liveBotFor(botId: string): LiveBot {
  const bot = store.bot(botId);
  if (!bot) throw new LiveSessionError("That bot no longer exists.", 404);
  return { name: bot.name, title: bot.title, description: bot.description };
}
/** The chat's text so far, so the voice can follow "and the other one?". */
function liveHistoryFor(threadId: string): LiveHistoryMessage[] {
  return store.activePath(threadId)
    .filter((message: any) => message.kind === "text" && typeof message.text === "string" && (message.role === "user" || message.role === "bot"))
    .map((message: any) => ({ role: message.role === "user" ? "user" as const : "assistant" as const, text: message.text ?? "" }));
}
/** A call outlives the request that started it: a signed-out or removed
 * person's call must not keep reaching the bot (or spending the key). */
function liveSignedIn(auth: RequestAuth): boolean {
  return auth.kind !== "session" || sessions.isLive(auth.session.id);
}
const liveCalls = new LiveCallController({
  store,
  send: async ({ auth, botId, threadId, text }) => {
    // the controller ends the call on this error
    if (!liveSignedIn(auth)) throw new LiveCallSignedOutError();
    const receipt = await acceptDirectSend({
      botId, threadId, text,
      sendId: randomUUID().replaceAll("-", ""),
      sender: messageSender(auth),
      trigger: usageTriggerFor(auth),
      via: "call",
      // a person is on the call: these are their words
      personPresent: true,
    });
    if ("queued" in receipt) return { kind: "queued", queueId: receipt.queueId };
    return { kind: receipt.steered ? "steered" : "started", messageId: receipt.message.id };
  },
  respond: async (input) => {
    const result = await respondToCard(input);
    if (result.ok) return { ok: true };
    // respondToCard's 401: the session that started the call has ended
    if (result.status === 401) throw new LiveCallSignedOutError();
    return { ok: false, error: result.error };
  },
  // send() queues through the steer queue; an edit or cancel there removes a request undelivered
  queued: isSteeredMessageQueued,
  signedIn: liveSignedIn,
  // the caller's own typed lines carry this sender (none for the owner)
  personKey: (auth) => messageSender(auth)?.id,
  activity: (botId, threadId) => {
    const task = store.taskByThread(botId, threadId);
    if (!task?.busy) return "idle";
    return task.activity === "waiting-on-you" ? "waiting" : "working";
  },
  broadcast: (frame) => broadcast(frame, { adminOnly: true }),
  settings: () => ({ key: cfg.live?.key ?? "", ...liveSettingsFor(cfg) }),
  createSession: ({ key, sdp, botId, threadId, voice }) => createLiveSession({ key, sdp, voice, bot: liveBotFor(botId), history: liveHistoryFor(threadId), }),
  // Node's WebSocket (undici) accepts headers in its second argument.
  openSocket: (url, key) => new WebSocket(url, { headers: { authorization: `Bearer ${key}` } } as unknown as string[]) as unknown as LiveSocket,
  attachUrl: (sessionId) => liveAttachUrl(sessionId),
  speakable: (text) => toUtterances(text),
  log: (line) => console.log(line),
});
// A signed-out or revoked sign-in ends the call it started at once (the idle
// check would only notice within 15 s). A paired phone's unpairing arrives
// from the companion instead (POST /api/live/device-revoked).
sessions.onSessionRevoked((sessionId: any) => liveCalls.sessionRevoked(sessionId));
ROUTES.push(createLiveRoutes({
  calls: liveCalls,
  resolveTarget: (botId, threadId) => {
    const bot = store.bot(botId);
    if (!bot) return null;
    const target = threadId ?? bot.threadId;
    if (store.botByThread(target)?.id !== bot.id) return null;
    return { botId: bot.id, botName: bot.name, threadId: target };
  },
  settings: () => liveSettingsFor(cfg),
  // Non-secret settings only, written the way PUT /api/config writes a
  // section: saveConfig merges into `live`, so the key stays where it is.
  saveSettings: async (patch) => {
    if (providerWrite.busy) throw Object.assign(new Error("Settings are already being updated. Try again in a moment."), { status: 409 });
    saveConfig({ live: patch });
    Object.assign(cfg, loadConfig());
    broadcast({ kind: "config", ...configStatus() });
    return liveSettingsFor(cfg);
  },
}));
/** The HTTP front door: see harness/request-handler.ts. Reassigned bindings
 * go over as getters and setters so the module always sees the current one. */
const handleRequest = createRequestHandler({
  colonieSignIn: deps.colonieSignIn,
  sharedServers: deps.sharedServers,
  threadPeople: deps.threadPeople,
  groupConversations: deps.groupConversations,
  conversationCaller: deps.conversationCaller,
  workspaceDirectory: deps.workspaceDirectory,
  desktopAccount: deps.desktopAccount,
  publicUrl: FALLBACK_PUBLIC_URL,
  selectedTaskBot: deps.selectedTaskBot,
  ownThreads: deps.ownThreads,
  personOf: deps.personOf,
  ownThreadIds,
  DEFAULT_PAGE,
  DESKTOP_MANAGED,
  ENVIRONMENT_ID,
  HOSTED_WORKSPACE,
  LOOPBACK,
  MAX_COMMS_DEPTH,
  PORT,
  SESSION_COOKIE,
  actorKey,
  beginAdminAudit,
  beginInternalCapabilityGeneration,
  botComputerControlKey,
  botComputerControlSnapshot,
  broadcast,
  browserEngineInstall: () => browserEngineInstall(),
  setBrowserEngineInstall: (value) => { setBrowserEngineInstall(value); },
  browserEngineInstallError: () => browserEngineInstallError(),
  setBrowserEngineInstallError: (value) => { setBrowserEngineInstallError(value); },
  browserIntegration,
  browserLive,
  cancelDirectTurnDispatch,
  cardAnswerRefusal,
  cfg,
  checkedModelSelection,
  colonieChief,
  computerControl,
  computerPreviewBot,
  computerPreviewSurface,
  configStatus,
  connectedTools,
  connectorMessage,
  controlLeaseIdSchema,
  currentBrowserSession,
  currentSecretState,
  customDomainRevision: () => customDomainRevision(),
  setCustomDomainRevision: (value) => { setCustomDomainRevision(value); },
  customDomainStatus,
  customDomainVerifier,
  deleteBotWithLifecycle,
  desktopMutationToken: () => desktopMutationToken(),
  desktopViewer,
  directRequestOwners,
  directTurnBots,
  directTurnDispatchClaims,
  emailSignIn,
  existingPerBotLocalVmCount,
  generateThreadTitle,
  guardedRequestSnapshot,
  handoffs,
  healThreadModel,
  interruptAllDirectThreads,
  interruptDirectThread,
  lendingEnabled,
  listBotSkills,
  localVmActiveThreads,
  localVmFlags,
  localVmIdleFor,
  localVmIdleMs,
  localVmInventoryPayload,
  localVmLeaseFor,
  localVmLifecycleBusy,
  localVmOwnerBusy,
  localVmPayload,
  localVmProvisionBusy: () => localVmProvisionBusy(),
  setLocalVmProvisionBusy: (value) => { setLocalVmProvisionBusy(value); },
  localVmSeen,
  localVmTargetForBot,
  localVmTargetForStatus,
  maybeResumeConnectors,
  mcpOAuth,
  messageFileRootsForThread,
  messagePage,
  messageWindow,
  mintInternalCapability,
  pageSize,
  personKey,
  publicBot,
  publicBotQueuedMessages,
  readBotSkillFile,
  registry,
  requestedTaskBot,
  resolveReplyTarget,
  resumeSecretCard,
  revokeInternalCapabilitiesForThread,
  routines: () => routines(),
  secretMessage,
  serveStatic,
  server: () => server,
  sessionLendingPrincipal,
  sessions,
  sharedComputerControl,
  sharedComputers,
  sharedWorkspaceFullAccessEnabled,
  stagedSkillListing,
  startTurn,
  store,
  subjectVisible,
  supportsApprovalMode,
  teamComputers,
  threadBusy,
  threadStarters,
  titleRegenerations,
  turnSelection,
  usageTriggerFor,
  viewerFor,
  visibleTo,
  webhooks,
  wireBot,
  wireTask,
  workspaceAccess: () => workspaceAccess(),
  workspaceBackupRoutes,
  workspaceMaintenance,
});

const server = createServer(handleRequest);
desktopViewer.attach(server, handleRequest);

calendarCalls().start();

// Resolve the edition before accepting requests so /api/edition is never a guess.

  return {
    server,
    liveCalls,
  };
}
