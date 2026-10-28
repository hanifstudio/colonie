// Starting one bot turn, end to end: the admission decision, the transcript
// append, the provider run and the computer the turn gets to use. It was the
// largest thing left inside `index.ts` and it touches nearly all of the live
// state there, so the wiring at the bottom of `index.ts` hands it that state
// explicitly instead of it reaching out of the file.
//
// Two kinds of dependency are passed as functions: the bindings that are
// reassigned while the server runs (`routines`, `colonieMemory`, ...) and the
// ones declared below the wiring point, where a plain pass would either read
// null or hit a temporal-dead-zone error. Everything else is a map, a helper or
// a constant that is by then already made.
import { type UsageTrigger } from "../../colonie/providers/usage-ledger.ts";
import { type TurnOwner } from "../../colonie/chat/turn-resources.ts";
import { type RoutineRunOn, type RoutineRunTrigger } from "../../colonie/routines/routines.ts";
import { type ResolvedSender } from "../../../shared/wire.ts";
import { isColonieAcpDriver } from "../../../shared/acp.ts";
import { describeConnectorScopes } from "../../../shared/connector-scopes.ts";
import { failedTurnTool } from "../../../shared/failed-turn.ts";
import { AcpRuntime } from "../../acp/acp-runtime.ts";
import { contextCandidate, contextPin } from "../../acp/context.ts";
import { nativeHistoryConflict } from "../../acp/native-history.ts";
import { inputReceipts } from "../../acp/receipts.ts";
import { recoveryCapabilityError } from "../../automatic-recovery.ts";
import { checkSoulDrift } from "../../colonie/bots/bot-folder.ts";
import { buildSystemPrompt, composioSystemPrompt, computerPrompt, CREDENTIAL_PROMPT, customMcpPrompt, LEARN_PROMPT, mentionPrompt, PROFILE_PROMPT, resolveComputerPromptKind, ROUTINE_EXECUTION_PROMPT, ROUTINE_PROMPT, TEAM_MEMORY_PROMPT, teamAvailabilityPart, THREADS_PROMPT, userProfileSystemPrompt, WEBHOOK_PROMPT } from "../../colonie/bots/system-prompt.ts";
import { DEFAULT_REBUILD_BYTES, selectReplay } from "../../colonie/chat/context-rebuild.ts";
import { handedStateUsable, renderUnseen, sessionStart, unseenMessages, withUnseenMessages } from "../../colonie/chat/delta-context.ts";
import { assertModelVariantSupported } from "../../colonie/chat/member-turn.ts";
import { hasQueuedSteeredMessages } from "../../colonie/chat/steer-queue.ts";
import { buildRecoveryText, buildTurnContext, engineIsFresh, NATIVELY_REPLAYING_DRIVER_KINDS } from "../../colonie/chat/turn-context.ts";
import { guardTurnDispatch } from "../../colonie/chat/turn-dispatch-guard.ts";
import * as checkpoints from "./checkpoints.ts";
import * as composio from "../mcp/composio.ts";
import { extractTurnImages } from "../../colonie/chat/turn-images.ts";
import { turnStartLogLine } from "../../colonie/chat/turn-log.ts";
import { agentBrowserFrame, browserToolMount, BUILT_IN_BROWSER_SYSTEM_PROMPT } from "../../colonie/computer/browser-engine.ts";
import { removedComputerInstanceIds } from "../../colonie/computer/computer-engine-removal.ts";
import { autoLocalVmAttachable, containerComputerFrame, containerComputerMcp, containerComputerStatus, poolLocalVmTarget, type LocalVmTarget, type Runtime} from "../../colonie/computer/container-computer.ts";
import { withMcpSignIn } from "../../colonie/mcp/mcp-oauth.ts";
import { beginMemoryTurn, endMemoryTurn } from "../../colonie/memory/memory-journal.ts";
import { peerName, peerRosterSystemPrompt, reachablePeers } from "../../colonie/peers/peer-roster.ts";
import { expandLearnTurnText } from "../../colonie/skills/skill-learn.ts";
import { renderSkillInstructions, selectBundledSkills } from "../../colonie/skills/skill-library.ts";
import { skillsSystemPrompt } from "../../colonie/skills/skills.ts";
import { chiefOfStaffSystemPrompt } from "../../colonie/teams/chief-of-staff.ts";
import { sectionContextSystemPrompt } from "../../colonie/teams/section-context.ts";
import { ensureConversationFolder, ensureTaskWorkspace, ensureWorkspace, isTaskWorkspace, memorySystemPrompt, moveIntoConversationFolder, SESSION_SEARCH_SYSTEM_PROMPT, supportsWorkspaceFiles, workspaceLocationsPrompt } from "../../colonie/workspace/workspace.ts";
import { builtInBrowserEnabled, claudeUserMcpEnabled, DATA_DIR, instanceConfigs, llmThreadTitlesEnabled, localVmMode, maxConcurrentBotThreads, mcpCallTimeoutMinutes, skillAuthoringEnabled, skillsLibraryEnabled } from "../../config.ts";
import { TurnNotStartedError } from "../../contracts.ts";
import { installedPlaybookInstructions } from "../../installed-playbooks.ts";
import { gatedLocalComputer, readCuaConnection } from "../../local-computer.ts";
import { shouldMountLocalComputer } from "../../local-routing.ts";
import { buildNotification } from "../../notify.ts";
import { mentionedBots, type Message} from "../../persistence/store.ts";
import { recentWork, recentWorkPrompt } from "../../recent-work.ts";
import { redactSecretsInText } from "../../redact.ts";
import { promptWithReply } from "../../replies.ts";
import { expandSetupTurnText, setupModeActive, setupSystemPrompt } from "../../setup-mode.ts";
import { assertWithinBudget } from "../../spend.ts";
import { PlaceUnavailableError, surfaceOfComputerKind, surfacePrompt, type PlaceSource, type Surface} from "../../surface.ts";
import { createHash, randomUUID } from "node:crypto";

/** The state and helpers a turn needs; see the header for why some are getters. */
export interface StartTurnDeps {
  // ponytail: one permissive shape instead of 121 hand-typed lines. The turn's
  // own signature is still explicit, so callers stay checked; tighten this if a
  // turn unit test ever needs the deps checked too.
  [name: string]: any;
}

export function createStartTurn(deps: StartTurnDeps) {
  const {
    ComputerWaitParked, DirectTurnSetupCancelled, MAX_COMMS_DEPTH, acpToolMount,
    activeInternalGenerationByThread, activeRoutineRunForThread, agentsIntegration,
    approvalModeForTurn, asPlaceFailure, autoRecallPrompt, autoVmClaims, availableSkills,
    beginInternalCapabilityGeneration, bindInternalCapabilityToProviderTurn, bindTurnComputer,
    botAtThreadCapacity, browserIntegration, browserRuntime, cfg, checkedTaskModelSwitch,
    claimTurnResource, clearCancelledProviderHandshake, clearDirectTurnDispatch,
    clearFailedAutoPin, clearInternalTurn, clearTurnDigestState, clearUnattended, colonieMemory,
    colonieMemorySources, colonieSkills, colonieTurnByThread, compactConversation, acpSituation, acpSecrets,
    computerSelectionTurns, connectedAppsIntegration, controlIntegration, delegationWakeBudget,
    directContext, directFollowupSettlers, directFollowupTurns, directRequestOwners,
    directTurnBots, directTurnClaimExists, directTurnClaimIsCurrent, directTurnDispatchClaims,
    directTurnGenerationByThread, drainComputerResumes, drainConnectorResumes,
    drainDelegationWakes, drainQueuedSends, drainSecretResumes, drainTeamSetupResumes,
    engineMcpServers, enginesRead, forgetTurnCheckpoint, generateThreadTitle, handoffs,
    healThreadModel, hooksEnabled, hooksIntegration, interruptDirectThread,
    isExternalContextMarker, latestCompaction, localVmActiveThreads, localVmFlags, localVmIdleFor,
    localVmLeaseFor, localVmLifecycleBusy, localVmOwnerBusy, localVmPoolSeatHolder,
    localVmSeatPool, localVmSeen, localVmTargetForThread,
    localVmThreadTargets, markDirectTurnDispatching, markInternalTurn, markUnattended, mcpOAuth,
    mountHostComputer, notify, pendingCancelledProviderHandshakes, providerFleetReloading,
    providerInstancesChanging, readyLocalVmForTurn, recentWorkSources, registerComputerResume,
    registry, releaseLocalVmThread, releaseTurnResources, reportIncident, retireProviderTurn,
    retryComputerEngineMove, retryDelegationsWaitingOn, revokeEarlierTurnCapabilities,
    revokeInternalCapabilityGeneration, routines, runningTurnEngines, screenPollers, 
    settleDirectFollowup, settlingResourceOwners, startScreenPoller, stopScreenPoller, store,
    teamMemory, threadBusy, toolScopeForTurn, turnCheckpoints, turnComputerResources, turnContext,
    turnPromptBytes, turnResourceOwners, turnResources, turnSurfacePlan, turnTriggers, turnUsage,
    watchdog, withRecalled, workspaceMaintenance
  } = deps;
async function startTurn(
  botId: string,
  text: string,
  opts?: {
    commsDepth?: number;
    userMessage?: Message;
    /** Admission must succeed before editing the active transcript branch. */
    editedMessageId?: string;
    /** The person who sent this, when not the desktop owner. */
    sender?: ResolvedSender;
    /** Who the usage ledger books this turn to: the sender of the message
     * that starts it, captured when that message was accepted. Absent on
     * continuations, which stay with the ask they continue. */
    trigger?: UsageTrigger;
    /** Extra transcript ids to omit (every drained queued line, not just the last). */
    excludeMessageIds?: string[];
    /** Routines run in detached tasks; pin the destination for the whole turn. */
    threadId?: string;
    /** Cloud routines() use the bot's Boat VM, driven by the bot's own engine
     * through its computer tools. */
    runOn?: RoutineRunOn;
    /** Lets the system prompt put externally supplied payloads behind an
     * explicit untrusted-data boundary without changing ordinary chat. */
    automationSource?: RoutineRunTrigger;
    /** the caller was already running unattended, so this turn is too */
    unattended?: boolean;
    /** Bot delivery (including self-opened jobs): whose words this line carries,
     * recorded on the message itself (Message.peerAsk). */
    peerAsk?: Message["peerAsk"];
    /** Resume an agent after the user completed an inline connection or credential card.
     * The prompt is control-plane context: it reaches the provider without
     * masquerading as another message authored by the user. */
    cardContinuation?: boolean;
    /** Harness-only provenance: an explicitly bound continuation, never a
     * client option and never inferred from the latest user on the thread. */
    requestMessageId?: string;
    /** A single tool-requested surface change continues the same human ask. */
    computerSelectionContinuation?: boolean;
    /** Earlier text message this user turn is replying to. */
    replyTo?: Message;
    /** Stable identity supplied by the composer so a network retry cannot
     * dispatch the same user action twice. */
    sendId?: string;
    /** App-authored group context; the stored user message keeps its original words. */
    providerPrompt?: string;
    /** Canonical group history for a provider that rejects its saved session. */
    providerRecoveryPrompt?: string;
    /** The words were spoken in a Live call, not typed. */
    via?: "call";
    /** An external interface relayed the words through the guarded send
     * route (Message.relayed): nobody typed them in a client here. */
    relayed?: boolean;
    onDispatchError?: (message: string) => void;
    /** Summarize this conversation without asking the agent to do more work. */
    compactOnly?: boolean;
    /** Harness-only: never follow a backup failure with another attempt. */
    automaticRecoveryAttempted?: boolean;
    /** Cursor into this bot's ordered startup-only backups. */
    automaticRecoveryIndex?: number;
    /** Queue receipts outlive the dispatch acknowledgment until this exact turn settles. */
    onTurnSettled?: () => void;
    /** A task delegated by the workspace Chief: its exact assignment ownership.
     * Not a peer ask or automation; the child gets its own fresh conversation. */
    colonieAssignment?: import("../../../shared/colonie-chief.ts").AcpAssignmentContext;
  },
) {
  workspaceMaintenance.assertAvailable();
  const profile = store.bot(botId);
  if (!profile) throw Object.assign(new Error("no such bot"), { status: 404 });
  const threadId = opts?.threadId ?? profile.threadId;
  const continuingRoutine = opts?.cardContinuation ? activeRoutineRunForThread(threadId) : null;
  if (continuingRoutine) {
    const onDispatchError = opts?.onDispatchError;
    opts = {
      ...opts,
      runOn: continuingRoutine.runOn,
      automationSource: continuingRoutine.triggerSource ?? (continuingRoutine.manual ? "manual" : "schedule"),
      onDispatchError: (message) => {
        routines()?.failThread(threadId, message);
        onDispatchError?.(message);
      },
    };
  }
  // A thread whose own model can't run runs on its bot's from now on.
  healThreadModel(botId, threadId);
  const bot = store.projectBotForTask(botId, threadId);
  if (!bot) throw Object.assign(new Error("no such task"), { status: 404 });
  // Routines and legacy peer delivery already have their own completion
  // owners; only ordinary chats are offered teammate coordination.
  const boundedCoordination = !opts?.automationSource && !opts?.commsDepth;
  if (bot.approvalGrant) {
    throw Object.assign(new Error("this bot's approval level is still being confirmed — try again"), { status: 409 });
  }
  if (providerFleetReloading()) throw Object.assign(new Error("provider settings are being updated — try again shortly"), { status: 409 });
  // A workspace at its monthly spend limit starts no turn of any kind: a
  // person's message, a routine, a peer hop or a webhook all stop here.
  assertWithinBudget(cfg, DATA_DIR);
  if (threadBusy(botId, threadId)) throw Object.assign(new Error("this thread is already working — interrupt it first"), { status: 409, code: "thread_busy" });
  if (botAtThreadCapacity(botId)) {
    throw Object.assign(new Error(`this bot has reached its limit of ${maxConcurrentBotThreads(cfg)} parallel threads — wait for one to finish`), { status: 409, code: "thread_limit" });
  }
  // Revoke anything a previous turn left behind before minting this turn's
  // integrations. Completion and interrupt paths do the same; a proxy the
  // warm engine kept is honoured again only through this turn's records.
  revokeEarlierTurnCapabilities(threadId);
  // a webhook turn, or one inherited from a bot already running unattended
  if (opts?.automationSource === "webhook" || opts?.unattended) markUnattended(bot.id, threadId);
  // a person typing into this bot ends the unattended window immediately
  else if (opts?.automationSource === undefined && !opts?.commsDepth && !opts?.cardContinuation) {
    clearUnattended(threadId);
    delegationWakeBudget.reset(threadId);
  }
  const task = store.taskByThread(bot.id, threadId);
  if (!task) throw Object.assign(new Error("no such task"), { status: 404 });
  
  const plan = turnSurfacePlan(bot, threadId);
  const instance = registry.get(bot.modelSelection.instanceId);
  if (!instance) {
    // Still on the removed Computer engine: its move failed or found no
    // engine. Try it again now, so the next message runs on the new engine.
    if (removedComputerInstanceIds(cfg.instances).has(bot.modelSelection.instanceId)) void retryComputerEngineMove();
    throw Object.assign(
      new Error(`provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`),
      { status: 409 },
    );
  }
  const toolScope = toolScopeForTurn(bot.id);
  // Resolve only transport tags from this newly submitted text. The original
  // string remains the durable message. Native-image providers get a
  // path-free prompt and bounded inputs instead of needing a Read tool;
  // path-reading drivers retain the attachment tag as their compatibility route.
  const resolvedImages = extractTurnImages(opts?.providerPrompt ?? text);
  const usesNativeImageInput = instance.adapter.capabilities.nativeImageInput === true;
  const providerText = usesNativeImageInput ? resolvedImages.text : opts?.providerPrompt ?? text;
  const turnImages = usesNativeImageInput ? resolvedImages.images : [];
  const commsDepth = opts?.commsDepth ?? 0;
  // Classify the turn where the peer paths' depth actually arrives: by the
  // time it settles, the fold has only a thread id to go on.
  if (commsDepth > 0 || opts?.colonieAssignment || task.forConversation) markInternalTurn(threadId);
  else clearInternalTurn(threadId);
  // a task takes its name from the first thing you asked it to do
  if (resolvedImages.text.trim() && !opts?.cardContinuation) {
    const titled = store.titleTaskFromFirstMessage(bot.id, resolvedImages.text, threadId);
    // The snippet is only the fallback name. A cheap one-shot may trade it
    // for a title a person would have typed, but never on a peer-opened
    // row: its title belongs to the assigned work. Everywhere else, the
    // swap happens only while the row still carries the snippet — a rename
    // by a person has already broken that equality by then.
    const snippet = titled?.title;
    if (titled && snippet && !titled.openedBy?.botId && llmThreadTitlesEnabled(cfg) && instance.generateText) {
      void generateThreadTitle(instance, resolvedImages.text)
        .then((title: any) => {
          if (title) store.retitleTask(bot.id, threadId, snippet, title);
        })
        .catch(() => undefined);
    }
  }

  // Spoken words never reach the log. A direct send says so itself; a
  // drained queue (or a continuation) carries it on the user lines it runs.
  const turnLineIds = new Set(opts?.excludeMessageIds ?? []);
  const spoken = opts?.via === "call" || opts?.userMessage?.via === "call" ||
    (turnLineIds.size > 0 && store.messagesFor(threadId).some((message: any) => turnLineIds.has(message.id) && message.via === "call"));
  console.error(turnStartLogLine({
    botId, text: resolvedImages.text, images: turnImages.length, depth: commsDepth, card: Boolean(opts?.cardContinuation), spoken,
  }));
  const instanceId = instance.instanceId;
  if (providerInstancesChanging().has(instanceId)) {
    throw Object.assign(new Error("this provider account is being updated — try again shortly"), { status: 409 });
  }
  // A turn always runs on the bot's own engine, model, effort and variant,
  // wherever it works: a computer is a tool it mounts, never a reason
  // to swap the engine (the provider_not_configured incident).
  const model = bot.modelSelection.model;
  const effort = bot.modelSelection.effort;
  const variant = bot.modelSelection.variant;
  if (instance.adapter instanceof AcpRuntime && instance.adapter.isConfiguring(threadId)) throw Object.assign(new Error("The native settings are being prepared. Wait for that operation before sending."), { status: 409 });
  // A conversation's bots all work in its one project folder (owner, October
  // 28). A bot that worked in its own folder there brings its files along and,
  // briefed from the conversation, starts a fresh session in the new folder.
  const conversationCwd = isColonieAcpDriver(instance.driverKind) && task.forConversation ? ensureConversationFolder(task.forConversation) : undefined;
  if (conversationCwd && task.cwd !== conversationCwd && opts?.providerRecoveryPrompt?.trim()) {
    if (typeof task.cwd === "string" && isTaskWorkspace(task.cwd, bot.id, threadId)) moveIntoConversationFolder(task.cwd, conversationCwd, bot.name);
    store.moveTaskFolder(bot.id, threadId, conversationCwd);
  }
  const nativeConflict = isColonieAcpDriver(instance.driverKind) && nativeHistoryConflict({ hasUserHistory: store.activePath(threadId).some((message: any) => message.role === "user" && message.kind === "text"), selectedInstanceId: instance.instanceId, lastInstanceId: task.lastInstanceId, cursors: task.resumeCursors });
  // Group history belongs to the conversation, not the selected agent. Only
  // the group's worker supplies a full briefing from that transcript; use it
  // in a fresh native session instead of resuming another agent's history.
  const rebuildGroupSession = nativeConflict && Boolean(task.forConversation && opts?.providerRecoveryPrompt?.trim());
  if (nativeConflict && !rebuildGroupSession) {
    throw Object.assign(new Error("This conversation belongs to another agent's native history. Start a new thread for the selected agent, or select the original agent to continue."), { status: 409 });
  }
  // An ACP session belongs to the adapter that opened it: Colonie cannot
  // rewind it or resume it with another adapter. A scheduled run, a webhook or
  // a teammate's handoff runs forward in the bot's own thread on the bot's own
  // engine, so it is a plain turn and is allowed — only the rewinding kinds
  // are refused.
  if (isColonieAcpDriver(instance.driverKind) && (opts?.editedMessageId || task.rewound || opts?.compactOnly)) {
    throw Object.assign(new Error("This ACP connection supports direct native sessions. Start a new thread for a different history; use /compact for native compaction."), { status: 409 });
  }
  assertModelVariantSupported({ variant, effort }, instance.adapter.capabilities);
  // A selection can be persisted while its engine is offline. Re-check when
  // the engine returns so an old or unsupported value never reaches a CLI.
  if (effort && !instance.adapter.capabilities.effortLevels?.includes(effort)) {
    throw Object.assign(
      new Error(`effort "${effort}" is not offered by this bot's engine — choose another level in settings`),
      { status: 409 },
    );
  }

  // an edit hands us its already-branched user message; a plain send appends
  // Cast: the guard below always replaces an absent message.
  let userMessage = opts?.userMessage as Message;
  if (opts?.editedMessageId) {
    const edited = store.branchMessage(threadId, opts.editedMessageId, text, opts.sendId, opts.sender);
    if (!edited) throw Object.assign(new Error("only a user text message can be edited"), { status: 400 });
    store.patchTask(bot.id, threadId, { rewound: true });
    userMessage = edited;
  }
  if (!userMessage) {
    userMessage = opts?.cardContinuation
      ? { id: `card-${randomUUID()}`, at: Date.now(), role: "user", kind: "text", text }
      : store.appendMessage(threadId, {
          role: "user",
          kind: "text",
          text,
          replyToId: opts?.replyTo?.id,
          sendId: opts?.sendId,
          peerAsk: opts?.peerAsk,
          sender: opts?.sender,
          ...(opts?.via ? { via: opts.via } : {}),
          ...(opts?.relayed ? { relayed: true } : {}),
        });
  }
  const recoveryUserMessageId = userMessage.id;
  // Admitted: every refusal above has passed and no other turn runs on this
  // thread, so this is the one moment the ledger's "who asked" may change.
  if (opts?.trigger) turnTriggers.set(threadId, opts.trigger);
  if (!opts?.cardContinuation && commsDepth === 0 && opts?.automationSource === undefined && !opts?.unattended && !userMessage.peerAsk) {
    // Continuing an old run as a normal conversation makes that task
    // visible again; these new replies are not routine report updates.
    if (task.routineRunId) store.patchTask(bot.id, threadId, { routineRunId: undefined });
  }

  const agentsMounted = commsDepth < MAX_COMMS_DEPTH && instance.adapter.capabilities.agentsMcp === true;

  // busy flips immediately so the composer locks; the dispatch itself runs
  // in the background — a Local VM setup can take a while and must never
  // hang the HTTP request
  const dispatchClaimId = randomUUID();
  const resourceOwner: TurnOwner = { threadId, generation: dispatchClaimId };
  turnResourceOwners.set(threadId, resourceOwner);
  directTurnGenerationByThread.set(threadId, dispatchClaimId);
  let requestMessageId = opts?.cardContinuation ? opts.requestMessageId : userMessage.id;
  const previousRequest = directRequestOwners.get(threadId);
  const requestGenerations = requestMessageId && previousRequest?.messageId === requestMessageId
    ? previousRequest.generations : new Set<string>();
  if (requestGenerations.size >= 500) { requestGenerations.clear(); requestMessageId = undefined; }
  requestGenerations.add(dispatchClaimId);
  directRequestOwners.set(threadId, { generation: dispatchClaimId, messageId: requestMessageId,
    generations: requestGenerations, turnId: null, ...(opts?.automationSource ? { automation: opts.automationSource } : {}) });
  // An unknown control-plane wake may invalidate a prior final, but it must
  // never acquire authority by guessing the latest user as its origin.
  const pendingSource = requestMessageId ?? store.activePath(threadId).findLast((message: any) => message.role === "user")?.id;
  if (pendingSource) store.patchMessage(threadId, pendingSource, { requestPending: true });
  // Ordinary sources need the same exact completion ownership as queued
  // follow-ups: any normal turn may ask teammates to coordinate work.
  directFollowupSettlers.set(dispatchClaimId, { threadId, settle: opts?.onTurnSettled });
  directTurnDispatchClaims.set(threadId, { id: dispatchClaimId, botId, threadId, phase: "setup" });
  directTurnBots.set(threadId, bot);
  beginInternalCapabilityGeneration(threadId, dispatchClaimId);
  if (!opts?.computerSelectionContinuation && !opts?.cardContinuation && !opts?.automationSource && !opts?.unattended &&
      !opts?.commsDepth && bot.computer !== "off" && agentsMounted) {
    const source = store.activePath(threadId).findLast((message: any) => message.id === userMessage?.id && message.role === "user" && !message.peerAsk);
    if (source) computerSelectionTurns.set(threadId, { generation: dispatchClaimId, botId: bot.id, source, text });
  }
  store.setTaskActivity(bot.id, threadId, "working");
  // Watch from admission, not dispatch: a turn can wedge in setup — context
  // compaction that never returns, a hung browser or VM mount — long before
  // any provider event exists, and a watch armed only at dispatch never saw
  // those. Every setup exit below settles or throws into the catch, which
  // settles under the same generation ownership it already enforces.
  watchdog.watch(threadId, bot.id);
  // A closed thread that gets a new turn is open again: the person (or the
  // opener) picked it back up, so its row returns to the sidebar and
  // list_threads stops calling it closed. No-op on an open thread.
  store.setTaskClosedBy(bot.id, threadId, null);
  // The badge is "this bot answered you, and you have not looked yet". A
  // person starting a turn has looked; a teammate's hop has not — the fold
  // never re-marks an internal turn, so clearing here would silently spend
  // a signal the person still owes a glance to.
  if (commsDepth === 0) store.patchTask(bot.id, threadId, { unread: false });
  turnUsage.delete(threadId);
  turnContext.delete(threadId);

  void (async () => {
    try {
      if (enginesRead()) {
        await enginesRead();
        if (!directTurnClaimIsCurrent(bot.id, dispatchClaimId, threadId)) throw new DirectTurnSetupCancelled("turn stopped while the engines were read");
      }
      if (isColonieAcpDriver(instance.driverKind)) {
        // Independent execution path: branch before compaction, persona,
        // memory, recall, setup/learn rewriting, skills, and MCP assembly.
        if (task.rewound || opts?.editedMessageId || opts?.compactOnly) {
          throw new Error("Native ACP session editing/branch replay is not available. Start a new thread for a different history; use /compact for agent-native compaction.");
        }
        // A scheduled run, a webhook and a teammate's handoff all run forward
        // in the bot's own native session like any other turn, so they take
        // this path too.
        const privateCwd = conversationCwd && task.cwd === conversationCwd ? conversationCwd : ensureTaskWorkspace(bot.id, threadId);
        const cwd = store.pinTaskCwd(bot.id, threadId, privateCwd) ?? privateCwd;
        const contextConfig = instanceConfigs(cfg)[instanceId]?.config as { instructions?: string } | undefined;
        const acpContext = contextCandidate(bot, instanceId, contextConfig?.instructions ?? "", !contextPin(threadId) && Boolean(task.lastInstanceId || inputReceipts(threadId).length));
        runningTurnEngines.set(threadId, instance);
        const mounts = await acpToolMount(bot.id, threadId, instanceId);
        if (!directTurnClaimIsCurrent(bot.id, dispatchClaimId, threadId)) { mounts.tools.deactivate(); mounts.extra?.deactivate(); throw new DirectTurnSetupCancelled("turn stopped during connected-tool setup"); }
        // Each bot browses in its own browser, with its own logins (owner,
        // October 28): the same session the Browser panel shows and a person
        // can take over. No engine installed yet means no browser tools, and a
        // browser that cannot start never stops the bot from answering.
        const browsingBot = store.bot(bot.id);
        let browserProblem = "";
        const browser = browsingBot && builtInBrowserEnabled(cfg) && browsingBot.browser !== false
          ? await browserIntegration(bot.id, browsingBot.browserProfile, { threadId, generation: dispatchClaimId }).catch((error: unknown) => {
            browserProblem = error instanceof Error ? error.message : String(error);
            console.warn(`[browser] ${bot.name}'s browser could not be prepared: ${browserProblem}`);
            return null;
          })
          : null;
        if (!directTurnClaimIsCurrent(bot.id, dispatchClaimId, threadId)) { mounts.tools.deactivate(); mounts.extra?.deactivate(); throw new DirectTurnSetupCancelled("turn stopped during browser setup"); }
        const acpBrowserTools = browser ? browserToolMount(browser.integration) : undefined;
        const acpMemory = colonieMemory().recall(bot.id, providerText) ?? undefined;
        const acpSkills = colonieSkills.context(bot.id);
        const acpAssignment = opts?.colonieAssignment ?? undefined;
        // Bot memory learns from every person; a signed message teaches this
        // bot only, under the sender's name (memory/ledger/capture.ts).
        if (!userMessage.peerAsk && !acpAssignment && !(task.forConversation && commsDepth > 0)) colonieMemorySources.set(threadId, {
          botId: bot.id, threadId, messageId: userMessage.id, text: userMessage.text ?? text, at: new Date(userMessage.at).toISOString(),
          ...(userMessage.sender?.name ? { speaker: userMessage.sender.name } : {}),
        });
        // Wait immediately before dispatch: resources are already claimed, but
        // the engine cannot edit the project until the snapshot has settled.
        // The ACP path takes the same pre-turn checkpoint the other path does,
        // or the turn's own digest has no files to name at settle time.
        // snapshot() absorbs failures, so checkpointing may delay but never
        // fail a turn.
        const checkpointCwd = cwd !== privateCwd ? cwd : undefined;
        if (checkpointCwd) {
          const before = await checkpoints.snapshot(bot.id, checkpointCwd, `turn ${threadId.slice(0, 8)}`, undefined, { pin: dispatchClaimId });
          if (!directTurnClaimIsCurrent(bot.id, dispatchClaimId, threadId)) {
            if (before) void checkpoints.release(bot.id, checkpointCwd, dispatchClaimId);
            throw new DirectTurnSetupCancelled("turn stopped during checkpoint");
          }
          forgetTurnCheckpoint(threadId);
          if (before) turnCheckpoints.set(threadId, { botId: bot.id, cwd: checkpointCwd, hash: before, pin: dispatchClaimId });
        }
        // The snapshot awaits git, so a stop can land in between: do not start
        // an engine for a turn that is already gone (the other path's guard).
        if (!directTurnClaimIsCurrent(bot.id, dispatchClaimId, threadId)) {
          throw new DirectTurnSetupCancelled("turn stopped before dispatch");
        }
        const dispatch: { cancelled: boolean; value: any } = await guardTurnDispatch(instance.adapter.sendTurn({
          threadId, botId: bot.id, text: rebuildGroupSession ? opts!.providerRecoveryPrompt! : providerText, recoveryText: opts?.providerRecoveryPrompt, images: turnImages, acpContext, acpTools: mounts.tools, acpExtraTools: mounts.extra, acpBrowserTools, acpMemory, acpSkills, acpAssignment, acpChief: Boolean(bot.chiefOfStaff),
          acpSituation: [acpSituation?.(userMessage.sender?.name), acpSecrets?.(bot.id, threadId, userMessage.sender?.id), acpBrowserTools ? BUILT_IN_BROWSER_SYSTEM_PROMPT.trim() : undefined,
            browserProblem ? `Your browser could not start for this request (${browserProblem}). If the request needs a browser, say so; do not look for another way to browse.` : undefined].filter(Boolean).join(" ") || undefined,
          cwd, model, approvalMode: approvalModeForTurn(bot, false),
          resumeCursor: rebuildGroupSession ? undefined : task.resumeCursors[instanceId],
          sessionReset: rebuildGroupSession,
        }), () => !directTurnClaimExists(bot.id, dispatchClaimId, threadId), async () => {
          await instance.adapter.interruptTurn(threadId).catch(() => {});
        });
        if (dispatch.cancelled) {
          retireProviderTurn(dispatch.value.turnId);
          throw new DirectTurnSetupCancelled("turn stopped during ACP setup");
        }
        colonieTurnByThread.set(threadId, dispatch.value.turnId);
        const requestOwner = directRequestOwners.get(threadId);
        if (requestOwner?.generation === dispatchClaimId) requestOwner.turnId = dispatch.value.turnId;
        clearDirectTurnDispatch(threadId, dispatchClaimId);
        store.markTaskDispatched(bot.id, threadId, instanceId);
        return;
      }
      // Readiness can wait on the network. Admit the task first so its busy
      // state, Stop action and watchdog own that wait just like VM setup.
      await compactConversation({ bot, threadId, generation: dispatchClaimId, instance, model,
        excludedIds: new Set([userMessage.id, ...(opts?.excludeMessageIds ?? [])]), manual: opts?.compactOnly === true });
      if (!directTurnClaimIsCurrent(bot.id, dispatchClaimId, threadId)) throw new DirectTurnSetupCancelled("turn stopped during context setup");
      if (opts?.compactOnly) {
        clearDirectTurnDispatch(threadId, dispatchClaimId);
        revokeInternalCapabilityGeneration(threadId, dispatchClaimId);
        settleDirectFollowup(dispatchClaimId);
        releaseTurnResources(resourceOwner);
        store.setTaskActivity(bot.id, threadId, "idle");
        watchdog.settle(threadId);
        directTurnBots.delete(threadId);
        retryDelegationsWaitingOn(bot.id);
        drainQueuedSends();
        drainConnectorResumes();
        drainComputerResumes();
        drainSecretResumes();
        drainTeamSetupResumes();
        drainDelegationWakes();
        return;
      }
      // Keep the full branch order for delivery bookkeeping, but select actual
      // replay entries by bytes. A compacted prefix is represented by its record.
      const skipTranscript = new Set<string>([userMessage.id, ...(opts?.excludeMessageIds ?? [])]);
      const activeMessages = store.activePath(threadId);
      const context = directContext(bot, threadId, activeMessages);
      const contextOrder = context.map((m: any) => m.id);
      const replayable = context.filter((m: any) => !skipTranscript.has(m.id));
      const record = latestCompaction(activeMessages);
      const selection = selectReplay(context, { budgetBytes: cfg.context?.rebuildBytes ?? DEFAULT_REBUILD_BYTES, excludedIds: skipTranscript, compaction: record });
      const transcript = selection.transcript.map(({ role, text }) => ({ role, text }));
      const contextReset = selection.compacted > 0 && record?.id !== task.appliedCompactionId;
      // The record is durable even if a crash occurs before this bookkeeping.
      // A retry then sees the unapplied record again and rebuilds safely.
      if (contextReset) store.patchTask(bot.id, threadId, { resumeCursors: {} });

      // After a rewind (edit / branch switch) the provider's native session
      // still contains the abandoned branch: start a fresh session instead of
      // resuming, and for cursor-resuming drivers replay the surviving path
      // inline (transcript-replay drivers get it via transcript). The flag is
      // cleared only once the turn is actually dispatched — clearing it here
      // would cost the next attempt its history if this dispatch fails.
      const rewound = Boolean(task.rewound);
      // A fresh engine — the user switched this bot's model mid-thread — has no
      // current session here either, so it gets the same replay. Distinct from
      // rewound: the OTHER instances' cursors are left alone (a rewind wipes
      // them all), and "fresh" is decided by who ran the last turn, not by
      // whether we hold a cursor — see engineIsFresh.
      const externalContextMarker = isExternalContextMarker(task.lastInstanceId)
        ? task.lastInstanceId
        : undefined;
      const fresh =
        !rewound &&
        !externalContextMarker &&
        engineIsFresh({ instanceId, lastInstanceId: task.lastInstanceId, resumeCursors: task.resumeCursors, transcript: replayable });
      // An engine that records what its session was handed resumes it with only
      // the context messages outside that record. A record of another session
      // (the one it replaced) or one that no longer lines up with the branch is
      // not trusted: the session is rebuilt by the same replay as any other.
      const strictResume = instance.adapter.capabilities.strictResume === true;
      const cursor = task.resumeCursors[instanceId];
      const handed = strictResume && !rewound && !contextReset && !fresh && !externalContextMarker && cursor !== undefined
        ? task.handedMessages?.[instanceId] : undefined;
      const unseen = handed && handedStateUsable(handed, cursor, contextOrder) ? unseenMessages(replayable, contextOrder, handed) : undefined;
      // A teammate's result or reply: without records this turn would replay.
      const externalUpdate = Boolean(unseen?.some((m) => m.keep));
      // What a resumed session keeps from its launch: the standing instructions
      // (tools, servers and — for Claude — the model are passed on every launch),
      // plus settings that a live turn cannot change. Codex now reasserts its
      // model/provider on resume, but an in-flight turn and an omitted effort
      // retain the prior selection, so both still belong to the session here. An
      // external update that finds any of it changed since the session started
      // gets the fresh session and replay it always got, rather than a resume.
      const persistentConfig = [bot.name, bot.title, bot.description, sectionContextSystemPrompt(bot.section),
        ...(instance.driverKind === "codex" ? [model, effort ?? null] : [])];
      const sessionConfig = (soul: string | undefined) =>
        createHash("sha256").update(JSON.stringify([...persistentConfig, soul])).digest("hex").slice(0, 16);
      const plannedConfig = sessionConfig(bot.soul);
      // Agent-tool gate shared by skill authoring, the /setup turn-text rewrite,
      // the setup prompt block, and the peer-comms integration below: a driver
      // that never mounts agent tools (or a turn already at the comms-depth cap)
      // must not be steered into — or told about — tools it cannot call.
      const skillAuthoring = skillAuthoringEnabled(cfg) && agentsMounted;
      // Setup mode's turn-text rewrite (parseSetupCommand/expandSetupTurnText)
      // must not run ahead of a system prompt that can't explain it: a driver
      // without agent tools sees the user's literal "/setup ..." message. The
      // gate on whether the coaching block itself is active — setupModeActive,
      // which also depends on the bot's soul/description — is decided below,
      // from the same bot snapshot the prompt's soul is built from.
      const setupText = agentsMounted ? expandSetupTurnText(providerText) : providerText;
      const userTurnText = promptWithReply(
        skillAuthoring ? expandLearnTurnText(setupText) : setupText,
        opts?.replyTo,
        cfg.profile?.name?.trim() || "User",
      );
      // Decided again at dispatch when setup outlasted a soul edit (config).
      const decideContext = (config: string) => {
        // A Codex thread keeps the last effort it was sent and no turn can clear
        // one: back on the default, a thread that holds a level is rebuilt from
        // the transcript rather than resumed on that level.
        const effortHeld = !effort && typeof handed?.effort === "string";
        const handedStale = Boolean(handed && (!unseen || effortHeld || (externalUpdate && handed.config !== config)));
        const { block: unseenBlock, placed } = unseen && !handedStale ? renderUnseen(unseen) : { block: "", placed: [] };
        const { turnText: contextTurnText, resume } = buildTurnContext({
          text: userTurnText,
          transcript,
          rewound,
          fresh: fresh || contextReset,
          externallyUpdated: Boolean(externalContextMarker) || handedStale,
          replaysNatively: NATIVELY_REPLAYING_DRIVER_KINDS.includes(instance.driverKind),
        });
        // Snapshot the cursor alongside the context decision. An external result
        // can arrive during async computer/setup work and clear the task cursor;
        // this already-built turn must either keep its old session or replay on the
        // following turn, never start a blank session with no transcript.
        const resumeCursor = resume ? task.resumeCursors[instanceId] : undefined;
        // A cursor the provider no longer honours must not brick the thread: the
        // driver may fall back to ONE fresh session, and this is what it sends
        // there, so the new session is not blank (server/resume-recovery.ts). A
        // turn carrying an external update gets the replay it would have had.
        const recoveryIsReplay = resumeCursor !== undefined && externalUpdate && transcript.length > 0;
        const recoveryText = resumeCursor === undefined ? undefined : recoveryIsReplay
          ? buildTurnContext({ text: userTurnText, transcript, rewound: false, fresh: false, externallyUpdated: true, replaysNatively: false }).turnText
          : buildRecoveryText({ text: userTurnText, transcript });
        // What this turn puts in front of the provider, for each session it can end
        // up in (server/delta-context.ts). buildTurnContext prepends a replay only
        // when it replays, so a changed text means the transcript was sent.
        const carried = [...skipTranscript];
        const windowIds = selection.representedIds;
        return {
          turnText: withUnseenMessages(unseenBlock, contextTurnText),
          resumeCursor, sessionReset: !resume, recoveryText, recoveryIsReplay,
          handoff: strictResume ? {
            botId: bot.id, instanceId, config, resumeCursor: typeof resumeCursor === "string" ? resumeCursor : undefined,
            ...(instance.driverKind === "codex" ? { effort: effort ?? null } : {}),
            started: sessionStart(contextOrder, contextTurnText !== userTurnText ? windowIds : [], carried),
            recovery: sessionStart(contextOrder, recoveryText !== undefined ? windowIds : [], carried),
            resumed: sessionStart(contextOrder, [], [...placed, ...carried]),
            placed, carried, own: [userMessage.id, ...(opts?.excludeMessageIds ?? [])],
          } : undefined,
        };
      };
      let dispatchContext = decideContext(plannedConfig);

      const persona = [
        `You are ${bot.name}, a personal bot in Colonie.`,
        bot.title && `Role: ${bot.title}.`,
        bot.description && `About: ${bot.description}`,
      ]
        .filter(Boolean)
        .join(" ");

      // The SOUL.md mirror is checked here, at dispatch, and only reported:
      // the prompt below reads bot.soul, never the file.
      {
        const drift = checkSoulDrift(bot.id, bot.soul ?? "", bot.soulHash ?? "");
        if (drift.drift !== Boolean(bot.soulDrift)) store.patchBot(bot.id, { soulDrift: drift.drift });
      }
      if (dispatchContext.handoff) handoffs.begin(threadId, dispatchClaimId, dispatchContext.handoff);

      const integrations: Record<string, any> = {};
      let browser: Awaited<ReturnType<typeof browserIntegration>> = null;
      const selectedSkills = selectBundledSkills(
        providerText,
        skillAuthoring ? ["skillAuthoring"] : [],
        availableSkills(),
      );
      // the user's connected apps, but only to a driver that can mount
      // them — a key in the config says the connections exist, not that
      // this engine can reach them — and only to a bot the user has not
      // switched off: the key is workspace-wide, the grant is per bot.
      if (bot.composio !== false && composio.configured(cfg) && instance.adapter.capabilities.composioMcp === true) {
        const connection = await connectedAppsIntegration(bot, threadId, dispatchClaimId);
        if (connection) integrations.composio = connection;
      }
      // user-configured MCP servers (config.json mcpServers): same rule as
      // composio — only to a driver that can mount them. Their tools are
      // never pre-allowed, so every call rides the normal permission flow.
      if (instance.adapter.capabilities.customMcp === true) {
        const custom = await withMcpSignIn(engineMcpServers(bot), mcpOAuth);
        if (Object.keys(custom).length) integrations.custom = custom;
      }
      // CLI engines work inside the bot's own workspace directory rather
      // than the user's home: a bot with file tools and acceptEdits gets a
      // desk, not the whole house — and the workspace is where its
      // MEMORY.md lives. API/box engines have no local filesystem story.
      const worksInWorkspace = supportsWorkspaceFiles(instance.driverKind);
      if (worksInWorkspace) {
        ensureWorkspace(bot.id);
        // baseline for the journal's turn-boundary diff (see the bus hook)
        if (bot.memoryEnabled !== false) beginMemoryTurn(bot.id, threadId);
      }
      const privateWorkspace = worksInWorkspace ? ensureTaskWorkspace(bot.id, threadId) : undefined;
      const skillInstructions = renderSkillInstructions(selectedSkills, {
        includeRoot: worksInWorkspace,
      });
      const packagePlaybooks = installedPlaybookInstructions(providerText, bot.playbooks);
      // An explicit working folder wins for new tasks; otherwise they use
      // the private bot workspace. A legacy task with an existing provider
      // session deliberately pins to null (the old home-folder behavior),
      // because moving a live session would break resume.
      // A cloud run keeps the bot's own engine on this host, with the cloud
      // computer as one more tool, so it works in the same folder as any
      // other turn.
      const pinnedCwd =
        privateWorkspace
          ? store.pinTaskCwd(bot.id, threadId, privateWorkspace)
          : null;
      // A bot's threads run side by side in one project folder, like several
      // Claude Code or Codex sessions open in one repo: the folder is never a
      // turn-long claim. What truly needs one writer queues on its own — the
      // per-turn snapshot per folder (server/checkpoints.ts), memory through
      // memory_update — and the engines key their sessions by id, not folder.
      const cwd = pinnedCwd ?? undefined;
      // Checkpoint explicit project folders, where a bot can overwrite the
      // user's work. Its private Colonie workspace is app-owned and changes
      // on nearly every ordinary chat; snapshotting it would add hidden disk
      // and process overhead without a user project to list changes for.
      const checkpointCwd = cwd && cwd !== privateWorkspace ? cwd : undefined;
      // dweb is opt-in: without an explicit daemon URL, do not advertise
      // tools that would fail on every call or spawn an unnecessary proxy.
      const dwebUrl = process.env.DWEB_URL?.trim();
      if (dwebUrl) integrations.dweb = { url: dwebUrl };
      const mountsComputerMcp = instance.adapter.capabilities.computerMcp === true;
      const mountsLocalComputer = instance.adapter.capabilities.localComputerMcp === true;
      // Where this turn's hands may land. The bot's "Works on" choice is
      // strict; a browser-only bot gets no computer at all, and a bot whose
      // browser is withheld (workspace flag, its own switch, or an engine
      // without browser tools) gets told so instead of silently falling back
      // to a desktop it was never meant to touch.
      // The conversation's own place wins over the bot default: the person
      // pinned it from the composer, or its first Auto turn recorded where it
      // landed.
      const dispatchTask = store.taskByThread(bot.id, threadId);
      const wants = plan.computer;
      // Where an explicit place came from, so its failure names the one
      // control that changes it (and a failed Auto-recorded pin is cleared).
      // Auto is nobody's per-turn choice.
      const namedPlace = wants === undefined || wants === "off" ? undefined : wants;
      const placeSource: PlaceSource | undefined = !namedPlace ? undefined
        : plan.pinned ? (dispatchTask?.surfaceSource === "auto" ? "auto-pin" : "pin")
        : "works-on";
      let previewCapture: (() => Promise<{ png: string; format: string }>) | null = null;
      let browserCapture: (() => Promise<{ png: string; format: string }>) | null = null;
      let computerKind: "vm" | "local" | null = null;
      /** The Local VM frame capture for the poller and the settled transcript
       * screenshot. The shared desktop outlives the turn: once another thread
       * owns it, a capture still in flight would picture ITS work under this
       * bot's name — live and in the settled frame, which is taken after the
       * lease is already released. No owner means the desktop is simply
       * idle: that final frame is ours to keep. */
      const localVmPreviewFor = (localVmTarget: LocalVmTarget, claimThreadId: string) => () => {
        const owner = localVmLeaseFor(localVmTarget).current(localVmOwnerBusy);
        if (owner && owner.threadId !== claimThreadId) {
          throw new Error("the Local VM moved on to another turn");
        }
        return containerComputerFrame(undefined, undefined, localVmTarget);
      };
      /** Pin the conversation at the moment its seat is actually claimed
       * (issue #1650): the same guards as the dispatch-time pin below, so
       * a claim landing later in the turn records exactly what a mount-time
       * pin would have — and a turn that never claims records nothing.
       * The guard reads live bot and task state because a claim can land
       * long after dispatch: a Works on change may have swept this
       * thread's auto pins, or a person may have pinned it meanwhile, and
       * a deferred claim must resurrect neither nor clobber either. */
      const autoPinAllowed = () => {
        const liveBot = store.bot(bot.id);
        const liveTask = store.taskByThread(bot.id, threadId);
        return liveBot?.computer === undefined && !plan.pinned &&
          Boolean(liveTask && liveTask.surfaceSource !== "user");
      };
      const pinAutoSurface = (surface: Surface) => {
        if (autoPinAllowed()) {
          store.patchTask(bot.id, threadId, { surface, surfaceSource: "auto" });
        }
      };
      /** The exclusive Local VM claim sequence, verbatim from the old inline
       * attach path, shared by dispatch (eager) and the first-screen-call
       * gate (issue #1361). Idempotent per turn: the resource claim and the
       * lease both re-assert the same owner, so a re-entrant call from the
       * gate no-ops once dispatch has already claimed. A lazy attach pins
       * the target it mounted the tools against: the claim must lease that
       * desktop, not whatever localVmTargetForBot resolves to by the time
       * the first screen call arrives. */
      const claimAutoLocalVm = async (claimThreadId: string, pinnedTarget?: LocalVmTarget): Promise<{ target: LocalVmTarget; runtime: Runtime }> => {
        const localVmTarget = pinnedTarget ?? localVmThreadTargets.get(claimThreadId) ?? { ...localVmTargetForThread(bot.id, claimThreadId) };
        await bindTurnComputer(resourceOwner, `computer:vm:${localVmTarget.key}`, true);
        if (localVmFlags.imageBusy || localVmFlags.modeChangeBusy || localVmLifecycleBusy.has(localVmTarget.key)) {
          throw new Error("this Local VM is being started, stopped, or replaced — wait for setup to finish");
        }
        // Claim before the first await. The lifecycle route performs its
        // matching check synchronously, so neither side can enter while the
        // other is between inspection and mutation.
        if (!localVmLeaseFor(localVmTarget).claim(claimThreadId, bot.id, localVmOwnerBusy)) {
          throw new Error("this Local VM is already being used by another turn — wait for that turn to finish");
        }
        // Only a turn that wins its lease extends pool affinity; a thread
        // retrying behind a stranger lets the TTL lapse and migrates.
        if (localVmMode(cfg) === "pool") localVmSeatPool.touch(claimThreadId);
        localVmThreadTargets.set(claimThreadId, localVmTarget);
        localVmActiveThreads.set(localVmTarget.key, claimThreadId);
        localVmIdleFor(localVmTarget).touch();
        // The lease is held from here. An eager attach that fails below
        // fails the turn and settle releases it; a lazy claim's rejection is
        // swallowed into the slot's failed flag and the turn carries on, so
        // without this the exclusive lease would sit held for the rest of a
        // turn that never got the VM — the very serialisation #1361 removes.
        const dropLease = () => {
          if (localVmThreadTargets.get(claimThreadId) !== localVmTarget) return;
          localVmLeaseFor(localVmTarget).release(claimThreadId);
          if (localVmActiveThreads.get(localVmTarget.key) === claimThreadId) localVmActiveThreads.delete(localVmTarget.key);
          localVmThreadTargets.delete(claimThreadId);
          // bindTurnComputer above also took the turn-level resource; a
          // later turn's exclusive bind queues behind it just the same.
          const resource = `computer:vm:${localVmTarget.key}`;
          turnResources.releaseOne(resource, resourceOwner);
          if (turnComputerResources.get(resourceOwner.threadId)?.resource === resource) turnComputerResources.delete(resourceOwner.threadId);
        };
        let localVm: Awaited<ReturnType<typeof readyLocalVmForTurn>>;
        try {
          localVm = await readyLocalVmForTurn(bot.id, localVmTarget);
        } catch (error) {
          dropLease();
          throw error;
        }
        if (!localVm.ready || !localVm.runtime) {
          dropLease();
          throw new Error(`${localVm.problem ?? "the Local VM is not ready"} (App Settings → Computers)`);
        }
        // The readiness walk can wait minutes for the desktop, and the group
        // path re-validates its lease afterwards; the direct path needs the
        // same guard so a turn never attaches MCP to a desktop another turn
        // now owns.
        const owner = localVmLeaseFor(localVmTarget).current(localVmOwnerBusy);
        if (owner?.threadId !== claimThreadId || owner.botId !== bot.id) {
          dropLease();
          throw new Error("the Local VM lease expired while preparing the turn");
        }
        // Same contract as the Boat and VPS branches below: without this the
        // poller never starts, so the Local VM publishes no `screen` events
        // and every client that only has the stream (the phone) waits
        // forever. The web panel hid the gap by polling the screenshot
        // route itself.
        previewCapture = localVmPreviewFor(localVmTarget, claimThreadId);
        // Pin on use: this runs for the dispatch-time claim of a VM created
        // for the turn and for the gate-fired claim of a lazily mounted one
        // alike — either way the conversation remembers the desktop this
        // turn actually took, not one it merely mounted (issue #1650).
        pinAutoSurface("vm");
        return { target: localVmTarget, runtime: localVm.runtime };
      };

      // Issue #1369: a lazy claim that rejects must not leave its turn busy
      // behind a gate that can only refuse. Surface the terminal
      // computer-unavailable error, then end the turn. Fenced to this
      // dispatch generation and a still-busy thread, so a rejection landing
      // after settle — or after a newer turn owns the thread — never touches
      // the newer turn. The gate's refusals stay fail-closed for any screen
      // call racing this teardown; the turn-failed buzz and incident follow
      // the dispatch-failure rules (person-started turns only).
      const surfaceLazyClaimRejection = (label: string) => (failure: string, error?: unknown) => {
        if (activeInternalGenerationByThread.get(threadId) !== resourceOwner.generation || !threadBusy(bot.id, threadId)) return;
        // The wait ceiling parked this turn (#1651): register the resume and
        // settle the live turn. No error entry, no incident — the parked chip
        // the wait appended is the whole story. The slot still fails, so the
        // gate keeps refusing screen calls for the rest of this generation
        // while the interrupt lands.
        if (resourceOwner.computerParkedOn) {
          registerComputerResume({
            botId: bot.id,
            threadId,
            resource: resourceOwner.computerParkedOn,
            generation: resourceOwner.generation,
            afterMessageId: store.activePath(threadId).findLast((entry: any) => entry.role === "user")?.id,
          });
          void interruptDirectThread(bot.id, threadId, { preserveComputerResume: true }).catch(() => {});
          return;
        }
        // A place that failed (mountBotBoat) is already read as its one line
        // and one way on, and never sticks as an Auto-recorded pin.
        const placeFailure = error instanceof PlaceUnavailableError ? error : undefined;
        if (placeFailure) clearFailedAutoPin(bot.id, threadId, placeFailure.place);
        const message = placeFailure?.message ?? `computer unavailable — ${label} could not be claimed for this turn (${failure})`;
        store.appendMessage(threadId, {
          role: "bot",
          kind: "activity",
          tool: failedTurnTool(message, placeFailure ? { place: placeFailure.row } : {}),
        });
        if (opts?.automationSource === undefined && !opts?.commsDepth && !opts?.cardContinuation) {
          notify(buildNotification("turn-failed", bot, threadId, redactSecretsInText(message), { avatarUrl: bot.avatarUrl }));
          reportIncident({ kind: "could-not-start", bot, threadId, detail: message });
          // Claude settles the interrupt below as exit_before_result; the
          // completion fold must not report this failure a second time.
          resourceOwner.lazyClaimFailureReported = true;
        }
        // A routine, a delegation or a resume reports this exactly as it
        // reports a place that failed at dispatch: with this cause, before
        // the interrupt settles the turn as merely "interrupted".
        opts?.onDispatchError?.(message);
        void interruptDirectThread(bot.id, threadId).catch(() => {});
      };

      // Explicit destinations are strict. In particular, Local VM must never
      // fall through to host CUA and accidentally click on the user's Mac.
      // The Local VM attach, shared by explicit "Local VM" and by Auto. Explicit
      // is strict and throws with the reason. Auto only reaches a VM this bot
      // already has — ready now, or one whose desktop image is prepared and can
      // be recreated on demand after idling away — and never creates a first
      // VM on its own; every failure there is a quiet "not this place".
      const attachLocalVm = async (strict: boolean): Promise<boolean> => {
        if (!mountsComputerMcp) {
          if (!strict) return false;
          throw new Error("this model cannot use the Local VM — choose Claude or an ACP model provider, or select another computer destination");
        }
        if (!strict && localVmMode(cfg) === "pool") {
          // localVmTargetForThread records pool affinity, so a turn the
          // fast path is about to skip must not reserve or refresh a seat.
          // Gate on the side-effect-free candidate assign() would pick —
          // the automationSource bypass below stays authoritative.
          const poolCandidate = poolLocalVmTarget(localVmSeatPool.candidate(threadId, localVmPoolSeatHolder));
          if (!localVmSeen.has(poolCandidate.key) && !opts?.automationSource) return false;
        }
        const localVmTarget = { ...localVmTargetForThread(bot.id, threadId) };
        let lazyReadyVm: { runtime: Runtime } | null = null;
        if (!strict) {
          // Nothing this process has ever seen for this target, and nobody is
          // relying on an unattended run: do not pay for a runtime probe.
          if (!localVmSeen.has(localVmTarget.key) && !opts?.automationSource) return false;
          const seen = await containerComputerStatus(undefined, undefined, localVmTarget).catch(() => null);
          if (!seen || !autoLocalVmAttachable(seen)) return false;
          if (localVmFlags.imageBusy || localVmFlags.modeChangeBusy || localVmLifecycleBusy.has(localVmTarget.key)) return false;
          if (seen.ready && seen.runtime) lazyReadyVm = { runtime: seen.runtime };
        }
        try {
          if (lazyReadyVm) {
            // Lazy exclusivity (issue #1361): a VM that is ready right now
            // mounts without claiming — screen-less Auto turns never touch
            // the lease, and the first screen tools/call fires the claim
            // through the computer-control gate. A VM that must be created
            // or recreated first keeps the eager claim below: the bridge
            // child needs the container to exist, and readyLocalVmForTurn
            // is what boots it.
            integrations.localComputer = containerComputerMcp(
              lazyReadyVm.runtime,
              controlIntegration(bot.id, threadId, dispatchClaimId),
              localVmTarget,
            );
            autoVmClaims.set(threadId, {
              owner: resourceOwner,
              lazy: true,
              label: "the Local VM",
              localVm: true,
              onRejected: surfaceLazyClaimRejection("the Local VM"),
              claim: async () => {
                await claimAutoLocalVm(threadId, localVmTarget);
                // The dispatch-site poller start saw a null previewCapture
                // (this lazy mount runs before any claim exists), so this
                // turn would publish no live `screen` events and settle no
                // final computer frame. Restart the poller with the now-live
                // computer capture, keeping any browser capture and whether
                // this turn already touched its screen. Same still-running
                // guard as dispatch: a poller started after its own
                // turn.completed would never be torn down.
                if (previewCapture && threadBusy(bot.id, threadId)) {
                  const touched = screenPollers.get(threadId)?.touched ?? false;
                  stopScreenPoller(bot.id, threadId);
                  startScreenPoller(
                    bot.id,
                    threadId,
                    { computer: previewCapture, ...(browserCapture ? { browser: browserCapture } : {}) },
                    { screenIsTheWork: touched },
                  );
                }
              },
            });
            return true;
          }
          const claimed = await claimAutoLocalVm(threadId);
          integrations.localComputer = containerComputerMcp(
            claimed.runtime,
            controlIntegration(bot.id, threadId, dispatchClaimId),
            claimed.target,
          );
          // Hand the same claim to the first-screen-call gate. This eager
          // path has already claimed, so the gate's fire-once call can only
          // re-assert the same owner — a no-op (issue #1361).
          autoVmClaims.set(threadId, {
            owner: resourceOwner,
            label: "the Local VM",
            claim: async () => { await claimAutoLocalVm(threadId); },
          });
          return true;
        } catch (error) {
          // A wait ceiling settled this turn as parked, not as an unavailable
          // Auto destination. Let dispatch register its resume instead of
          // continuing the provider without the requested computer.
          if (strict || error instanceof ComputerWaitParked) throw error;
          if (directTurnGenerationByThread.get(threadId) === dispatchClaimId) releaseLocalVmThread(threadId);
          return false;
        }
      };
      // An explicit place that cannot be attached fails the turn with its
      // cause and the next action; it never quietly moves the work elsewhere.
      try {
        if (wants === "vm") {
          if (await attachLocalVm(true)) computerKind = "vm";
        } else if (wants === "local") {
          integrations.localComputer = await mountHostComputer(resourceOwner, bot.id, mountsLocalComputer);
          computerKind = "local";
        }

      } catch (error) {
        // Auto and Off name no place; they fail as they are.
        if (!namedPlace || !placeSource) throw error;
        throw await asPlaceFailure(error, namedPlace, placeSource, bot);
      }

      // Auto-only host fallback. Electron owns cua-driver/TCC attribution;
      // the harness only reads its already-running connection descriptor.
      // Auto reaches a Local VM this bot already has before it ever touches the
      // host's own desktop: on a headless server that VM is the only desktop
      // there is, and a person who prepared one meant it to be used.
      if (wants === undefined && !integrations.localComputer && await attachLocalVm(false)) computerKind = "vm";
      if (
        !integrations.localComputer &&
        wants === undefined &&
        shouldMountLocalComputer({
          requested: undefined,
          hostPlatform: process.platform,
          providerSupportsLocal: mountsLocalComputer,
        })
      ) {
        const cua = readCuaConnection();
        if (cua) {
          // Lazy host claim (issue #1650): the gated integration mounts
          // now, but the exclusive computer:host seat is taken only by the
          // first screen tools/call, through the computer-control gate —
          // the same seam as the Local VM (#1361). An Auto
          // turn that never touches the screen holds no desktop seat and
          // records no pin; a claim that finds the seat held waits behind
          // the holder like every other seat instead of failing on the
          // spot.
          autoVmClaims.set(threadId, {
            owner: resourceOwner,
            lazy: true,
            label: "this computer",
            onRejected: surfaceLazyClaimRejection("this computer"),
            claim: async () => {
              await bindTurnComputer(resourceOwner, "computer:host", true);
              pinAutoSurface("local");
            },
          });
          integrations.localComputer = gatedLocalComputer(cua, controlIntegration(bot.id, threadId, dispatchClaimId, "this computer"));
          computerKind = "local";
        }
      }
      // Agent control tools include peer comms and the secure credential
      // request card. A comms-invoked turn (depth ≥ cap) gets none — hard recursion
      // stop, so the user's tokens can't be burned by a bot-to-bot loop.
      // Only drivers that mount the tools get the integration (and, via the
      // integrations.agents gate below, the prompt hint) — a bot on a driver
      // without it must not be told about tools it cannot call. Any bot can
      // still be the TARGET of ask_bot regardless of its driver.
      // One reachability rule for the roster, list_bots and @mention
      // resolution: a bot is never told about — or nudged toward — a peer
      // that ask_bot and delegate_bot would then refuse.
      const sectionPeers = reachablePeers(store.bots, bot);
      if (agentsMounted) {
        // Only a direct human request can create separate self-owned jobs.
        // Coordinated children and self-opened jobs stay inside their scope;
        // a later real user message on the same task is a fresh request.
        const origin = opts?.cardContinuation
          ? store.activePath(threadId).findLast((message: any) => message.role === "user" && message.kind === "text")
          : userMessage;
        const ownThreadCreation = boundedCoordination && Boolean(origin && !origin.peerAsk);
        integrations.agents = agentsIntegration(bot.id, threadId, commsDepth, skillAuthoring, dispatchClaimId, boundedCoordination, ownThreadCreation);
      }
      if (instance.adapter.capabilities.hooks === true && hooksEnabled()) {
        integrations.hooks = hooksIntegration(bot.id, threadId, dispatchClaimId);
      }
      // @mentions in the user's message (the composer's tagging UI) become
      // an explicit coordination nudge. The agent still chooses the matching
      // peer tool, so the harness stays the single owner of turns/permissions.
      const tagged = integrations.agents
        ? mentionedBots(
            providerText,
            sectionPeers,
          )
        : [];
      const coordinationPrompt = bot.chiefOfStaff
        ? chiefOfStaffSystemPrompt(
            bot.id,
            store.bots,
            Boolean(integrations.agents),
            boundedCoordination,
          )
        : integrations.agents && sectionPeers.length > 0
          // Ordinary bots could always CALL the peer tools; until now the
          // one generic sentence they got never named a teammate, so the
          // first move of any collaboration was a list_bots round trip the
          // model mostly did not think to make.
          ? peerRosterSystemPrompt(sectionPeers, boundedCoordination)
          : "";
      const credentialPrompt = integrations.agents ? CREDENTIAL_PROMPT + (boundedCoordination ? "" : THREADS_PROMPT) : "";
      const routinePrompt = integrations.agents ? ROUTINE_PROMPT : "";
      const profilePrompt = integrations.agents ? PROFILE_PROMPT : "";
      const recallPrompt = integrations.agents && bot.memoryEnabled !== false ? SESSION_SEARCH_SYSTEM_PROMPT : "";
      const learnPrompt = skillAuthoring ? LEARN_PROMPT : "";

      // Wait immediately before dispatch: resources are already claimed, but
      // the engine cannot edit the project until the snapshot has settled.
      // snapshot() absorbs failures, so checkpointing may delay but never fail
      // a turn.
      if (checkpointCwd) {
        // Pinned by this dispatch: a sibling thread's snapshot in the same
        // folder must not reclaim this turn's "before" state while it runs.
        const before = await checkpoints.snapshot(bot.id, checkpointCwd, `turn ${threadId.slice(0, 8)}`, undefined, { pin: dispatchClaimId });
        if (!directTurnClaimIsCurrent(bot.id, dispatchClaimId, threadId)) {
          if (before) void checkpoints.release(bot.id, checkpointCwd, dispatchClaimId);
          throw new DirectTurnSetupCancelled("turn stopped during checkpoint");
        }
        forgetTurnCheckpoint(threadId);
        if (before) turnCheckpoints.set(threadId, { botId: bot.id, cwd: checkpointCwd, hash: before, pin: dispatchClaimId });
      }
      if (!directTurnClaimIsCurrent(bot.id, dispatchClaimId, threadId)) {
        throw new DirectTurnSetupCancelled("turn stopped before dispatch");
      }
      // Mint the browser bearer at the last possible moment. The desktop
      // registration is asynchronous, so validate this exact setup claim
      // again inside browserIntegration before the capability is published.
      // Also the one bot snapshot setupModeActive and the prompt's soul
      // (below) share, so a soul saved mid-dispatch is seen by both instead
      // of the two disagreeing about whether setup mode is still active.
      const liveBot = store.bot(bot.id);
      const setupMode =
        agentsMounted &&
        setupModeActive({
          soul: liveBot?.soul ?? bot.soul,
          description: liveBot?.description ?? bot.description,
          text: providerText,
        });
      // One place per turn. On Auto the branches above may have reached a
      // computer; then the built-in browser stays unmounted and web work
      // happens in that computer's own browser, where the person can see it.
      const mountedComputer = surfaceOfComputerKind(computerKind);
      if (
        liveBot &&
        plan.browser &&
        !(plan.computer === undefined && mountedComputer) &&
        builtInBrowserEnabled(cfg) &&
        liveBot.browser !== false &&
        instance.adapter.capabilities.browserMcp === true
      ) {
        const selectedProfile = liveBot.browserProfile;
        browser = await browserIntegration(bot.id, selectedProfile, { threadId, generation: dispatchClaimId });
        if (browser) integrations.browser = browser.integration;
        // The browser lost its frame source when the Electron surface was
        // removed: previewCapture is set by the computer branches above, and
        // nothing replaced it here. A bot with only a browser was pictured
        // not at all; a bot with both was pictured on its desktop even while
        // the work was a web page, because agent-browser runs its own headless
        // Chrome on the host rather than inside that desktop.
        if (browser) {
          const frame = { binaryPath: browser.spec.command, env: browser.spec.env };
          const session = browser.session;
          // The preview shares the profile with tool calls: claim the same
          // exclusive browser:<session> resource the tools/call path claims,
          // and skip the frame while another thread holds it.
          browserCapture = async () => {
            const owner = turnResourceOwners.get(threadId);
            if (!owner || !claimTurnResource(owner, `browser:${session}`)) throw new Error("another thread is using this browser");
            return browserRuntime.withAgentAction(session, () => agentBrowserFrame(frame));
          };
        }
      }
      // An Auto conversation remembers where its first turn landed, so later
      // turns stay there and the composer can show it. Explicit settings are
      // not recorded: an auto pin yields to a later Works on change (which
      // sweeps it — store.clearAutoSurfacePins); a person's pin does not.
      // Pin on use (issue #1650): every computer that registers a claim
      // slot — a ready Local VM, the VPS, the host fallback, a VM created
      // for this turn — records its pin inside the claim itself, so a turn
      // that only mounted tools records nothing. The built-in browser (no
      // seat to claim) pins here.
      if (autoPinAllowed()) {
        const claimSlot = autoVmClaims.get(threadId);
        const pinsAtClaim = claimSlot?.owner.generation === resourceOwner.generation;
        const used = pinsAtClaim ? null : mountedComputer ?? (integrations.browser ? "browser" : null);
        if (used) store.patchTask(bot.id, threadId, { surface: used, surfaceSource: "auto" });
      }
      const computerSelection = computerSelectionTurns.get(threadId);
      if (computerSelection) computerSelection.mounted = mountedComputer ?? (integrations.browser ? "browser" : undefined);
      // A cancelled adapter can be between accepting sendTurn and revealing
      // its provider turn id. Never overlap a replacement with that ambiguous
      // pre-id window: wait for the old handshake to settle or for its bounded
      // quarantine to expire, then revalidate this exact claim before launch.
      await pendingCancelledProviderHandshakes.waitForClear(threadId);
      if (!markDirectTurnDispatching(bot.id, dispatchClaimId, threadId)) {
        throw new DirectTurnSetupCancelled("turn stopped before dispatch");
      }
      const computerPromptKind = resolveComputerPromptKind({
        kind: computerKind,
        vmPrivate: localVmMode(cfg) === "per-bot",
      });
      const prompt = buildSystemPrompt(persona, liveBot?.soul ?? bot.soul ?? "", [
        { id: "user-profile", label: "About the user", text: userProfileSystemPrompt(cfg.profile) },
        // first after the soul: the block names agent tools, so it only goes
        // to a turn whose engine actually mounted them (setupMode is already
        // false when they are not — see agentsMounted above)
        { id: "setup", label: "Setup", text: setupSystemPrompt(setupMode, { skills: skillAuthoring, cwd: liveBot?.cwd ?? bot.cwd }) },
        { id: "files", label: "File locations", text: worksInWorkspace ? workspaceLocationsPrompt(bot.id, cwd, liveBot?.cwd ?? bot.cwd) : "" },
        { id: "computer", label: "Computer", text: computerPrompt(computerPromptKind) },
        { id: "plan", label: "Surface", text: surfacePrompt({ computer: mountedComputer, browser: Boolean(integrations.browser) }, { pinned: plan.pinned, note: plan.note, canSelect: computerSelectionTurns.has(threadId) }) },
        // gated on the integration, not the key: the hint only goes to a
        // bot whose driver actually mounted the tools
        { id: "composio", label: "Connected apps", text: integrations.composio ? composioSystemPrompt(liveBot?.connectorTools ?? bot.connectorTools) + describeConnectorScopes((liveBot ?? bot).connectorScopes) : "" },
        { id: "mcp", label: "MCP servers", text: customMcpPrompt(Object.keys(integrations.custom ?? {})) },
        { id: "browser", label: "Browser", text: integrations.browser ? BUILT_IN_BROWSER_SYSTEM_PROMPT : "" },
        { id: "coordination", label: "Team", text: coordinationPrompt ? ` ${coordinationPrompt}` : "" },
        { id: "credential", label: "Credentials", text: credentialPrompt },
        { id: "recall", label: "Recall", text: recallPrompt },
        { id: "routine", label: "Routines", text: routinePrompt },
        { id: "routine-execution", label: "Routine execution", text: opts?.automationSource === "schedule" || opts?.automationSource === "manual" ? ROUTINE_EXECUTION_PROMPT : "" },
        { id: "profile", label: "Profile changes", text: profilePrompt },
        { id: "learn", label: "Skill authoring", text: learnPrompt },
        { id: "section-context", label: "Section context", text: sectionContextSystemPrompt(bot.section) },
        { id: "team-memory", label: "Team memory", text: teamMemory().systemPrompt(bot.section) + (integrations.agents ? TEAM_MEMORY_PROMPT : "") },
        // who on the team roster is busy right now; volatile, so a teammate
        // starting or finishing work never changes the stable half
        teamAvailabilityPart(coordinationPrompt ? sectionPeers : []),
        // what the bot said lately in its other conversations, so a task
        // never redoes — or forgets — what another one already did
        { id: "recent", label: "Recent work", text: recentWorkPrompt(recentWork(recentWorkSources(), bot, { userName: cfg.profile?.name?.trim() || "User", currentThreadId: threadId })) },
        { id: "memory", label: "Memory", text: memorySystemPrompt(bot.id, { managedWrites: Boolean(integrations.agents), fileTools: worksInWorkspace, enabled: bot.memoryEnabled !== false }) },
        // liveBot was captured before awaited setup work; an assignment PUT
        // in that window must still reach this turn's prompt.
        { id: "skills", label: "Skills index", text: privateWorkspace ? skillsSystemPrompt(bot.id, skillsLibraryEnabled(cfg) ? (store.bot(bot.id)?.assignedSkills ?? bot.assignedSkills) : undefined) : "" },
        { id: "skill-instructions", label: "Skill instructions", text: skillInstructions },
        { id: "playbooks", label: "Playbooks", text: packagePlaybooks },
        { id: "webhook", label: "Webhook provenance", text: opts?.automationSource === "webhook" ? WEBHOOK_PROMPT : "" },
        { id: "mentions", label: "Mentions", text: boundedCoordination && tagged.length ? `The user named these existing teammates: ${tagged.map(b => `${peerName(b.name)} (${b.id})`).join(", ")}. Use coordinate_bots when their contribution is needed; do not substitute native helper agents for these bots.` : mentionPrompt(tagged) },
      ]);
      turnPromptBytes.set(threadId, { stable: Buffer.byteLength(prompt.stable), volatile: Buffer.byteLength(prompt.volatile) });
      // Automatic recall rides in front of THIS turn's message, never in the
      // system prompt: the volatile half is re-sent whole whenever any part of
      // it changes, and recall changes nearly every turn.
      const recalled = autoRecallPrompt(bot, threadId, resolvedImages.text, {
        // a routine run starts fresh by design, and a webhook is untrusted:
        // neither pulls earlier conversations in
        conversations: commsDepth === 0 && !opts?.automationSource && !opts?.unattended,
        userName: cfg.profile?.name?.trim() || "User",
      });
      runningTurnEngines.set(threadId, instance);
      // The prompt carries the soul as saved now. If it changed during setup,
      // decide again from what is actually sent — except on a continuation
      // wake inside an automation run, where a delegated result is reviving
      // its source unattended. That turn runs
      // as the resume it planned (the new soul reaches the session through
      // system-prompt refresh), so its record keeps the config of the session
      // it resumed. The next dispatch then sees that stored config differ
      // from the soul saved now and gives the source the fresh session and
      // replay a soul change owes it. Re-deciding here instead would start a
      // new session whose record already carries the new soul, and the
      // following wake would resume it — a session started under the old soul
      // must never survive a soul change by laundering its record. A
      // person-facing delegated return still re-decides here: that turn is
      // the one the person watches.
      const dispatchedConfig = sessionConfig(liveBot?.soul ?? bot.soul);
      if (strictResume && !(opts?.cardContinuation && continuingRoutine) && dispatchedConfig !== plannedConfig) dispatchContext = decideContext(dispatchedConfig);
      // Before sendTurn: an adapter may emit the whole turn before it resolves.
      handoffs.dispatching(threadId, dispatchClaimId, dispatchContext.handoff);
      const dispatch: { cancelled: boolean; value: any } = await guardTurnDispatch(instance.adapter.sendTurn({
        threadId,
        botId: bot.id,
        startupRecovery: cfg.automaticRecovery?.enabled === true &&
          (opts?.automaticRecoveryIndex ?? 0) < ((liveBot ?? bot).fallback?.length || (cfg.automaticRecovery.backup ? 1 : 0)),
        text: withRecalled(recalled, dispatchContext.turnText),
        images: turnImages,
        approvalMode: approvalModeForTurn(bot, commsDepth > 0),
        toolScope,
        model,
        effort,
        variant,
        // a rewound thread never resumes the abandoned branch's session
        // the active task's own session — another task's cursor would
        // resume the wrong conversation and defeat the context bubble
        resumeCursor: dispatchContext.resumeCursor,
        sessionReset: dispatchContext.sessionReset,
        ...(dispatchContext.recoveryText !== undefined ? { recoveryText: dispatchContext.recoveryText } : {}),
        ...(dispatchContext.recoveryIsReplay ? { recoveryIsReplay: true } : {}),
        transcript,
        system: prompt.text,
        systemStable: prompt.stable,
        systemVolatile: prompt.volatile,
        // the mentions half describes this turn: identical consecutive tags
        // must still deliver their note (SendTurnInput.mentionTurn)
        mentionTurn: tagged.length > 0,
        integrations,
        mcpFromUserConfig: claudeUserMcpEnabled(cfg),
        mcpCallTimeoutMs: mcpCallTimeoutMinutes(cfg) * 60_000,
        cwd,
      }), () => !directTurnClaimExists(bot.id, dispatchClaimId, threadId), async () => {
        await instance.adapter.interruptTurn(threadId).catch(() => {});
      });
      if (dispatch.cancelled) {
        retireProviderTurn(dispatch.value.turnId);
        throw new DirectTurnSetupCancelled("turn stopped during provider setup");
      }
      const requestOwner = directRequestOwners.get(threadId);
      if (requestOwner?.generation === dispatchClaimId && dispatch.value.turnId) {
        if (requestOwner.turnId && requestOwner.turnId !== dispatch.value.turnId) requestOwner.messageId = undefined;
        requestOwner.turnId = dispatch.value.turnId;
      }
      bindInternalCapabilityToProviderTurn(threadId, dispatchClaimId, dispatch.value.turnId);
      handoffs.bindTurn(threadId, dispatchClaimId, dispatch.value.turnId);
      if (directFollowupSettlers.has(dispatchClaimId) && dispatch.value.turnId &&
        !directFollowupTurns.bind(threadId, dispatchClaimId, dispatch.value.turnId)) {
        // This exact queued turn completed before its dispatch ACK arrived.
        directFollowupTurns.takeEarlyCompletion(threadId, dispatch.value.turnId);
        settleDirectFollowup(dispatchClaimId);
      }
      clearDirectTurnDispatch(threadId, dispatchClaimId);
      // dispatched: the rewind is spent, and the old cursors are dead
      if (rewound) store.patchTask(bot.id, threadId, { rewound: false, resumeCursors: {} });
      if (contextReset && record) store.patchTask(bot.id, threadId, { appliedCompactionId: record.id, contextFloor: undefined });
      // and this engine now owns the thread's most recent turn
      // Consume exactly the external-update generation this turn replayed.
      // If a newer delegated result landed during setup, its unique marker
      // differs and must survive so the next turn also receives that update.
      if (!isExternalContextMarker(task.lastInstanceId) || task.lastInstanceId === externalContextMarker) {
        store.markTaskDispatched(bot.id, threadId, instanceId);
      }
      // a turn can settle before dispatch returns, and a poller started
      // after its own turn.completed would never be torn down — it would
      // keep polling the boat forever, carrying dead per-turn state. busy
      // is flipped false in the fold, so it is the honest "still running".
      if ((previewCapture || browserCapture) && threadBusy(bot.id, threadId)) {
        startScreenPoller(
          bot.id,
          threadId,
          { ...(previewCapture ? { computer: previewCapture } : {}), ...(browserCapture ? { browser: browserCapture } : {}) },
        );
      }
      // An adapter may publish completion synchronously just before its
      // dispatch promise resolves. The event could not use the turn-id map
      // above yet, so close this exact generation from durable busy state.
      if (!threadBusy(bot.id, threadId) && directTurnGenerationByThread.get(threadId) === dispatchClaimId) {
        revokeInternalCapabilityGeneration(threadId, dispatchClaimId);
        if (settlingResourceOwners.get(threadId) !== dispatchClaimId) releaseTurnResources(resourceOwner);
        retryDelegationsWaitingOn(bot.id);
        drainQueuedSends();
        drainConnectorResumes();
        drainComputerResumes();
        drainSecretResumes();
        drainTeamSetupResumes();
        drainDelegationWakes();
      }
    } catch (cause) {
      let e: any = cause;
      // Only the driver can prove that a task was never submitted and its
      // old process is gone. A timeout/error string alone is not that proof.
      const mayRecover = e instanceof TurnNotStartedError &&
        directTurnClaimIsCurrent(bot.id, dispatchClaimId, threadId);
      if (e instanceof TurnNotStartedError) {
        retireProviderTurn(e.turnId);
        if (!mayRecover) e = new DirectTurnSetupCancelled("turn stopped during provider setup");
      }
      handoffs.abandon(threadId, dispatchClaimId);
      if (computerSelectionTurns.get(threadId)?.generation === dispatchClaimId) computerSelectionTurns.delete(threadId);
      clearCancelledProviderHandshake(threadId, `direct:${dispatchClaimId}`);
      clearDirectTurnDispatch(threadId, dispatchClaimId);
      revokeInternalCapabilityGeneration(threadId, dispatchClaimId);
      const ownsLatestGeneration = directTurnGenerationByThread.get(threadId) === dispatchClaimId;
      releaseTurnResources(resourceOwner);
      if (ownsLatestGeneration) {
        if (colonieMemorySources.get(threadId)?.messageId === userMessage.id) colonieMemorySources.delete(threadId);
        runningTurnEngines.delete(threadId);
        endMemoryTurn(threadId);
        clearTurnDigestState(threadId);
        releaseLocalVmThread(threadId);
        watchdog.settle(threadId);
        turnUsage.delete(threadId);
        turnContext.delete(threadId);
      }
      if (e instanceof DirectTurnSetupCancelled) {
        settleDirectFollowup(dispatchClaimId);
        opts?.onDispatchError?.(e.message);
        if (ownsLatestGeneration && threadBusy(bot.id, threadId)) {
          store.setTaskActivity(bot.id, threadId, "idle");
          directTurnBots.delete(threadId);
          retryDelegationsWaitingOn(bot.id);
        }
        if (ownsLatestGeneration) {
          drainQueuedSends();
          drainConnectorResumes();
          drainComputerResumes();
          drainSecretResumes();
          drainTeamSetupResumes();
          drainDelegationWakes();
        }
        return;
      }
      if (!ownsLatestGeneration) {
        settleDirectFollowup(dispatchClaimId);
        return;
      }
      if (e instanceof ComputerWaitParked) {
        settleDirectFollowup(dispatchClaimId);
        registerComputerResume({
          botId: bot.id,
          threadId,
          resource: e.resource,
          generation: e.generation,
          afterMessageId: store.activePath(threadId).findLast((entry: any) => entry.role === "user")?.id,
        });
        // Settled as parked, not failed (#1651): the chip the wait appended
        // is the whole transcript story, and the registered resume owns what
        // happens next on this thread.
        if (store.taskByThread(bot.id, threadId)?.activity !== "dead") {
          store.setTaskActivity(bot.id, threadId, "parked.computer");
        }
        directTurnBots.delete(threadId);
        retryDelegationsWaitingOn(bot.id);
        drainQueuedSends();
        drainConnectorResumes();
        drainComputerResumes();
        drainSecretResumes();
        drainTeamSetupResumes();
        drainDelegationWakes();
        return;
      }
      // A failed place never sticks; a person's pin stays, and the message
      // names the composer.
      if (e instanceof PlaceUnavailableError) clearFailedAutoPin(bot.id, threadId, e.place);
      let message = e instanceof Error ? e.message : String(e);
      const current = store.projectBotForTask(bot.id, threadId);
      const backups = cfg.automaticRecovery?.enabled
        ? current?.fallback?.length ? current.fallback : cfg.automaticRecovery.backup ? [cfg.automaticRecovery.backup] : []
        : [];
      const nextIndex = backups.findIndex((candidate: any, index: any) => index >= (opts?.automaticRecoveryIndex ?? 0) &&
        registry.get(candidate.instanceId)?.enabled &&
        (candidate.instanceId !== instanceId || candidate.model !== model));
      const backup = backups[nextIndex];
      if (mayRecover && backup && current && !opts?.cardContinuation &&
          !directRequestOwners.get(threadId)?.stopped && !hasQueuedSteeredMessages(bot.id, threadId) &&
          JSON.stringify(current.modelSelection) === JSON.stringify(bot.modelSelection) &&
          (backup.instanceId !== instanceId || backup.model !== model) &&
          store.activePath(threadId).findLast((m: any) => m.role === "user" && m.kind === "text")?.id === recoveryUserMessageId) {
        // No await between releasing the failed attempt and admitting its
        // replacement: a newer send or Stop must never lose to a stale retry.
        store.setTaskActivity(bot.id, threadId, "idle");
        directTurnBots.delete(threadId);
        const checked = checkedTaskModelSwitch(current, backup, false, false, true);
        const target = checked.ok ? registry.get(checked.selection.instanceId) : null;
        const refusal = !checked.ok ? checked.error : !target || !target.enabled ? "The backup engine is unavailable."
          : !store.taskByThread(bot.id, threadId)?.cwd ? "This older thread has no pinned working folder. Choose its backup manually."
          : recoveryCapabilityError(
            { driverKind: instance.driverKind, capabilities: instance.adapter.capabilities },
            { driverKind: target.driverKind, capabilities: target.adapter.capabilities });
        if (!refusal && checked.ok && target) {
          try {
            assertWithinBudget(cfg, DATA_DIR);
            store.switchTaskModel(bot.id, threadId, checked.selection, false, false, {
              rewound: true,
            });
            store.appendMessage(threadId, { role: "bot", kind: "activity", tool: {
              name: `recovery: Automatic recovery: ${instance.displayName || instance.driverKind} could not start. Trying ${target.displayName || target.driverKind} · ${checked.selection.model} once in this thread.`, ok: true,
            } });
            await startTurn(bot.id, text, { ...opts, threadId, userMessage, editedMessageId: undefined,
              automaticRecoveryAttempted: true, automaticRecoveryIndex: nextIndex + 1 });
            // The backup now owns these callbacks; don't publish a failed
            // routine/peer result or release a queued receipt in between.
            directFollowupSettlers.delete(dispatchClaimId);
            return;
          } catch (failure) {
            message += ` Backup could not start: ${failure instanceof Error ? failure.message : String(failure)}`;
          }
        } else if (refusal) message = `Automatic recovery unavailable: ${refusal} Original error: ${message}`;
      }
      settleDirectFollowup(dispatchClaimId);
      // The wait already wrote its failure resolution; keep all dispatch
      // failure bookkeeping below without adding the same error twice.
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        turnSucceeded: false,
        tool: failedTurnTool(message, e instanceof PlaceUnavailableError ? { place: e.row } : {}),
      });
      // Worth a buzz for the same reason a routine failure is, and the rule
      // notify.ts encodes: the bot is not working, and the cause is usually
      // a setting only a person can change — an unattended user would
      // otherwise learn nothing until they next opened the thread.
      //
      // Only for a turn the person started themselves. A routine reaches
      // this same catch and then reports through onDispatchError, which
      // raises routine-failed; buzzing here too would ring twice for one
      // failure. A delegated sub-turn is reported to the bot that asked
      // for it, in its own thread, so it does not need a second channel.
      if (opts?.automationSource === undefined && !opts?.commsDepth && !opts?.cardContinuation) {
        notify(
          buildNotification("turn-failed", bot, threadId, redactSecretsInText(message), { avatarUrl: bot.avatarUrl }),
        );
        reportIncident({ kind: "could-not-start", bot, threadId, detail: message });
      }
      store.setTaskActivity(bot.id, threadId, "idle");
      directTurnBots.delete(threadId);
      retryDelegationsWaitingOn(bot.id);
      opts?.onDispatchError?.(message);
      // a dispatch failure never emits turn.completed, so the settle-driven
      // drain would strand anything queued behind this turn
      drainQueuedSends();
      drainConnectorResumes();
      drainComputerResumes();
      drainSecretResumes();
      drainTeamSetupResumes();
      drainDelegationWakes();
    }
  })();
  return userMessage;
}
  return startTurn;
}
