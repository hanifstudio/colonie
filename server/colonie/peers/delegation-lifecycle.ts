// Delegated-turn lifecycle: waiting-on-person chips, delegation wakes and their budget, incident reporting, context-marker bookkeeping, compaction and the Handoffs state, plus the delegation drain/sweep/retry subscribers.
import { type RuntimeEvent } from "../../contracts.ts";
import { type RoutineRun } from "../../colonie/routines/routines.ts";
import { type BotRecord, type Message} from "../../persistence/store.ts";
import { failedTurnTool } from "../../../shared/failed-turn.ts";
import { draftSummary, foldPoint } from "../../colonie/chat/compaction-summary.ts";
import { autoCompactWindow, compactBudget, contextWindowFor, shouldCompact } from "../../colonie/chat/context-budget.ts";
import { MAX_SUMMARY_BYTES, selectReplay } from "../../colonie/chat/context-rebuild.ts";
import { Handoffs, type ContextMessage} from "../../colonie/chat/delta-context.ts";
import { digestPromptLine } from "../../colonie/chat/digest.ts";
import { queueSteeredMessage } from "../../colonie/chat/steer-queue.ts";
import { peerMessageText } from "../../colonie/chat/turn-context.ts";
import { isTurnAdmissionBlocked } from "../../colonie/chat/turn-dispatch-guard.ts";
import { DelegationWakeBudget, buildDelegationFailurePrompt, buildDelegationRevivalPrompt, discardDelegations, drainDelegations, expireStaleDelegations, releaseDelegationsWaitingOn, type DelegationReceipt} from "../../colonie/peers/delegations.ts";
import { withPeerProvenance } from "../../colonie/peers/peer-provenance.ts";
import { INCIDENTS_THREAD_TITLE, IncidentLedger, chiefForBot, incidentChip, incidentText, type Incident, type IncidentKind} from "../../incidents.ts";
import { buildNotification } from "../../notify.ts";
import { redactSecretsInText } from "../../redact.ts";
import { callKey } from "../../repeat-detector.ts";
import { transcriptText } from "../../replies.ts";
import { randomUUID } from "node:crypto";

/** Everything this cluster reaches in the server; see the header. */
export interface DelegationLifecycleDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createDelegationLifecycle(deps: DelegationLifecycleDeps) {
  const {
    DirectTurnSetupCancelled, approvalBus, botAtThreadCapacity, botForThread, bus, cfg, commsBus,
    compactionControllers, directTurnClaimIsCurrent, isUnattended, registry, routines, 
    shouldIgnoreProviderEvent, startTurn, store, teammateReportContext, threadBusy,
    delegationWatch, finalizeDelegationWatch, notify, repeats
  } = deps;
function delegatorOf(threadId: string): { threadId: string; botId?: string } | undefined {
  const watch = delegationWatch.get(threadId);
  if (watch?.sourceThreadId) return { threadId: watch.sourceThreadId, botId: watch.sourceBotId };
  return undefined;
}

// MOCA-274: a delegated teammate's card used to live only in its own thread,
// so the person talking to the Chief never saw that work was waiting on them.
// A chip in the delegating conversation points at the card until it settles.
const waitingOnPersonChips = new Map<string, { threadId: string; messageId: string; name: string; kind: string }>();

function showWaitingOnPersonChip(threadId: string, requestId: string, asker: BotRecord, kind: "approval" | "answer") {
  const delegator = delegatorOf(threadId);
  if (!delegator || delegator.threadId === threadId) return;
  const chip = store.appendMessage(delegator.threadId, { role: "bot", kind: "activity",
    from: { botId: asker.id, name: asker.name, color: asker.color },
    tool: { name: `Waiting on your ${kind} in @${asker.name}` },
    threadRef: { botId: asker.id, threadId, title: store.taskByThread(asker.id, threadId)?.title ?? asker.name },
  });
  waitingOnPersonChips.set(`${threadId}:${requestId}`, { threadId: delegator.threadId, messageId: chip.id, name: asker.name, kind });
}

/** Settle the chip for one answered card, or every chip for this thread once
 * its turn ends (a card nobody answered can no longer be answered). */
function settleWaitingOnPersonChips(threadId: string, requestId?: string) {
  for (const [key, chip] of waitingOnPersonChips) {
    if (requestId ? key !== `${threadId}:${requestId}` : !key.startsWith(`${threadId}:`)) continue;
    waitingOnPersonChips.delete(key);
    const existing = store.messagesFor(chip.threadId).find((message: any) => message.id === chip.messageId);
    if (!existing?.tool) continue;
    store.patchMessage(chip.threadId, chip.messageId, {
      tool: { ...existing.tool, name: requestId ? `@${chip.name} got your ${chip.kind}` : `@${chip.name} is no longer waiting on your ${chip.kind}`, ok: true },
    });
  }
}

// Peer wake: when a delegated reply lands, resume the source bot so it can
// fold the result in and answer the user instead of sitting idle. Mirrors
// the cardContinuation resume pattern used for connector/credential cards.
const delegationWakeBudget = new DelegationWakeBudget();
const pendingDelegationWakes = new Map<string, { botId: string; targetName: string; failureReason?: string; routineRunId?: string; budgetAcquired?: boolean }>();

function activeRoutineRunForThread(threadId: string): RoutineRun | null {
  const run = routines()?.runForThread(threadId);
  return run && ["running", "waiting"].includes(run.status) ? run : null;
}

function routineDelegationCanResume(threadId: string, routineRunId?: string): boolean {
  return !routineRunId || activeRoutineRunForThread(threadId)?.id === routineRunId;
}

function dispatchDelegationWake(botId: string, threadId: string, targetName: string, failureReason?: string, routineRunId?: string, budgetAcquired = false): void {
  if (!store.taskByThread(botId, threadId)) return;
  if (!routineDelegationCanResume(threadId, routineRunId)) return;
  if (!budgetAcquired && !delegationWakeBudget.tryAcquire(threadId)) {
    routines()?.failThread(threadId, "Delegation follow-up limit reached; review the run before retrying");
    return;
  }
  const prompt = failureReason
    ? buildDelegationFailurePrompt(targetName, failureReason)
    : buildDelegationRevivalPrompt(targetName);
  void startTurn()(botId, prompt, {
    threadId,
    cardContinuation: true,
    unattended: isUnattended(botId, threadId),
  })
    .then(() => undefined)
    .catch((error: any) => {
      if (!store.taskByThread(botId, threadId)) return;
      const message = error instanceof Error ? error.message : String(error);
      // Raced with a user turn claiming the bot — retry once it settles.
      // This is the same logical wake, so keep its original budget charge.
      if (isTurnAdmissionBlocked(error)) {
        pendingDelegationWakes.set(threadId, { botId, targetName, failureReason, routineRunId, budgetAcquired: true });
        return;
      }
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: failedTurnTool(`could not resume after delegation — ${message}`),
      });
      routines()?.failThread(threadId, `Could not resume after delegation: ${message}`);
    });
}

function wakeDelegationSource(source: BotRecord, threadId: string, targetName: string, failureReason?: string, routineRunId?: string): void {
  if (!store.taskByThread(source.id, threadId)) return;
  if (!routineDelegationCanResume(threadId, routineRunId)) return;
  // Busy? Hold the wake until the source settles, then drain it — the
  // delegated reply is already in the thread, so nothing is lost, and the
  // source processes it the moment it is free rather than only on a later
  // user nudge.
  if (threadBusy(source.id, threadId) || botAtThreadCapacity(source.id)) {
    pendingDelegationWakes.set(threadId, { botId: source.id, targetName, failureReason, routineRunId });
    return;
  }
  dispatchDelegationWake(source.id, threadId, targetName, failureReason, routineRunId);
}

// ── incidents: a broken run reaches the Chief of Staff ──────────────────
// A failed, stalled or unstartable run used to leave one chip in the thread
// it died in and nothing anywhere else; the person found it hours later,
// from a phone, by opening the desktop and reading every thread. The team
// already has a role for this — the Chief coordinates the section — so the
// incident becomes a turn of the Chief's, in its "Team incidents" thread,
// with a link to the broken thread and retry_thread to act on it. The person
// reads one place. Policy in server/incidents.ts.
const incidentLedger = new IncidentLedger();

/** What the broken thread was about: the last line the person (or the
 * requester) sent there, and the last thing the bot said. */
function incidentContext(threadId: string): { lastRequest: string | null; lastReply: string | null } {
  const messages = [...store.messagesFor(threadId)].reverse();
  return {
    lastRequest: messages.find((message) => message.role === "user" && message.kind === "text" && message.text)?.text ?? null,
    lastReply: messages.find((message) => message.role === "bot" && message.kind === "text" && message.text)?.text ?? null,
  };
}

function reportIncident(input: { kind: IncidentKind; bot: BotRecord; threadId: string; detail: string }): void {
  const { bot, threadId } = input;
  const task = store.taskByThread(bot.id, threadId);
  // A thread another bot opened and is watching is that bot's to handle:
  // the delegator is woken with the failure already (wakeDelegationSource).
  if (task?.openedBy?.delegationId || delegationWatch.has(threadId)) return;
  const incident: Incident = {
    kind: input.kind,
    bot,
    threadId,
    title: task?.title ?? null,
    room: null,
    detail: redactSecretsInText(input.detail),
    ...incidentContext(threadId),
  };
  const count = incidentLedger.note(threadId);
  // a crash loop is one incident, not a storm
  if (count.muted) return;
  const chief = chiefForBot(store.bots, bot);
  // A run that could not start and a failed routine have already buzzed
  // the person (turn-failed, routine-failed) by the time they get here; a
  // failure or stall mid-run has not. One notification per failure, never two.
  const alreadyNotified = input.kind === "could-not-start" || input.kind === "routine-failed";
  const tellThePerson = () => {
    if (alreadyNotified) return;
    notify(buildNotification("incident", bot, threadId, incidentChip(incident), {
      avatarUrl: bot.avatarUrl,
    }));
  };
  // no Chief on duty, or the Chief itself broke: the person is next
  if (!chief) {
    tellThePerson();
    return;
  }
  const incidents = store.tasks(chief.id).find((candidate: any) => candidate.title === INCIDENTS_THREAD_TITLE && !candidate.archivedAt)
    ?? store.createTask(chief.id, INCIDENTS_THREAD_TITLE, false, undefined, { botId: chief.id, name: chief.name, at: Date.now() });
  if (!incidents || incidents.threadId === threadId) {
    tellThePerson();
    return;
  }
  store.appendMessage(incidents.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: incidentChip(incident), ok: false },
    threadRef: { botId: bot.id, threadId, title: task?.title ?? `${bot.name}'s conversation` },
  });
  const text = incidentText(incident, count);
  // the report carries the broken bot's name as its provenance: it is about
  // that bot's work and nobody was at the keyboard
  const peerAsk = { botId: bot.id, name: bot.name, unattended: true };
  if (botAtThreadCapacity(chief.id)) {
    queueSteeredMessage(chief.id, incidents.threadId, text, { reason: "capacity", unattended: true, peerAsk });
    return;
  }
  void startTurn()(chief.id, text, { threadId: incidents.threadId, unattended: true, peerAsk }).catch((error: any) => {
    const why = error instanceof Error ? error.message : String(error);
    store.appendMessage(incidents.threadId, {
      role: "bot",
      kind: "activity",
      tool: failedTurnTool(`the incident could not reach ${chief.name} — ${why}`),
    });
    tellThePerson();
  });
}

function drainDelegationWakes(): void {
  for (const [threadId, entry] of pendingDelegationWakes) {
    if (!store.taskByThread(entry.botId, threadId) || !routineDelegationCanResume(threadId, entry.routineRunId)) {
      pendingDelegationWakes.delete(threadId);
      continue;
    }
    // Completion can precede asynchronous digest/resource settlement. Keep
    // the wake parked until a slot is actually free; a rejected async start
    // could otherwise requeue after the last idle-release drain has run.
    if (threadBusy(entry.botId, threadId) || botAtThreadCapacity(entry.botId)) continue;
    pendingDelegationWakes.delete(threadId);
    dispatchDelegationWake(entry.botId, threadId, entry.targetName, entry.failureReason, entry.routineRunId, entry.budgetAcquired);
  }
}

function wakeUndispatchedDelegation(receipt: DelegationReceipt, routineRunId?: string): void {
  const source = store.botByThread(receipt.sourceThreadId);
  if (!source) return;
  markTaskContextExternallyUpdated(source, receipt.sourceThreadId);
  wakeDelegationSource(source, receipt.sourceThreadId, receipt.toBotName, receipt.result || "the handoff did not run", routineRunId);
}

// Provider-native sessions only know about messages produced inside their
// own turns. A delegated result is appended later by the harness, so mark the
// source task with a persisted, impossible-to-resume owner. Its next turn
// will replay the active branch once before replacing this marker with the
// real provider instance id. A unique suffix also closes the setup race: if
// another result arrives while that replay is launching, the newer marker is
// left intact for one more replay instead of being accidentally consumed.
const EXTERNAL_CONTEXT_MARKER_PREFIX = "__colonie_external_context__:";

function isExternalContextMarker(value: string | undefined): boolean {
  return Boolean(value?.startsWith(EXTERNAL_CONTEXT_MARKER_PREFIX));
}

function markTaskContextExternallyUpdated(bot: BotRecord, threadId: string): void {
  const task = store.taskByThread(bot.id, threadId);
  if (!task) return;
  // An engine that records which messages its current session was handed
  // keeps that session: its next turn is sent what it has not seen. Without a
  // record for that exact session (another engine, one switched in since, a
  // replaced session, or a task from before records existed) the next turn
  // replays once, as before.
  const owner = task.lastInstanceId;
  const record = owner ? task.handedMessages?.[owner] : undefined;
  if (owner && record?.session !== undefined && record.session === task.resumeCursors[owner] &&
    (botForThread(bot.id, threadId) ?? bot).modelSelection.instanceId === owner &&
    registry.get(owner)?.adapter.capabilities.strictResume) {
    store.patchTask(bot.id, threadId, { unread: true });
    return;
  }
  store.patchTask(bot.id, threadId, {
    resumeCursors: {},
    lastInstanceId: `${EXTERNAL_CONTEXT_MARKER_PREFIX}${randomUUID()}`,
    unread: true,
  });
}

/** Active-branch messages a provider reads as conversation context. */
function isContextMessage(m: Message): boolean {
  return Boolean((m.kind === "text" && m.text) || (m.kind === "digest" && m.digest) || m.kind === "compaction" || m.roomRequest?.phase === "result");
}

function latestCompaction(messages: readonly Message[]) {
  const record = messages.findLast(message => message.kind === "compaction" && message.compaction);
  return record?.compaction ? { ...record.compaction, id: record.id } : undefined;
}

function directContext(bot: BotRecord, threadId: string, messages: Message[]): ContextMessage[] {
  const messagesById = new Map<string, any>(store.messagesFor(threadId).map((message: any) => [message.id, message]));
  return messages.filter(isContextMessage).map(m => ({
    id: m.id, role: m.role === "user" ? "user" : "assistant",
    text: m.kind === "compaction" ? ""
      : m.roomRequest?.phase === "result" ? teammateReportContext()(m.roomRequest.id, bot.id)
        : m.kind === "digest" && m.digest ? digestPromptLine(m.digest, m.from?.name ?? bot.name)
          : m.peerAsk ? peerMessageText(m.peerAsk.name, m.text ?? "")
            : m.role !== "user" && m.from ? peerMessageText(m.from.name, transcriptText(m, messagesById, cfg.profile?.name?.trim() || "User"))
              : transcriptText(m, messagesById, cfg.profile?.name?.trim() || "User"),
    keep: m.roomRequest?.phase === "result" || Boolean(m.peerAsk) || (m.role !== "user" && Boolean(m.from)),
    ...(m.steered ? { steered: true } : {}),
  }));
}

/** The existing direct-turn claim owns summarization, including Stop and
 * thread deletion. A durable record is committed only to its original branch. */
async function compactConversation(input: {
  bot: BotRecord; threadId: string; generation: string;
  instance: NonNullable<ReturnType<typeof registry.get>>; model: string;
  excludedIds: ReadonlySet<string>; manual: boolean;
}): Promise<void> {
  const { bot, threadId, generation, instance, model, excludedIds, manual } = input;
  const task = store.taskByThread(bot.id, threadId);
  if (!task || (!manual && cfg.context?.autoCompact === false)) return;
  const messages = store.activePath(threadId);
  const context = directContext(bot, threadId, messages);
  const record = latestCompaction(messages);
  // A retry must apply the existing record before considering another fold.
  if (!manual && record && record.id !== task.appliedCompactionId) return;
  if (manual && record?.id === messages.at(-1)?.id && !record?.firstKeptId) return;
  const selected = selectReplay(context, {
    budgetBytes: Math.max(1_024, context.reduce((n, entry) => n + Buffer.byteLength(entry.text) + 16, 0) + 4 * MAX_SUMMARY_BYTES + 1_024),
    maxMessages: Number.MAX_SAFE_INTEGER, excludedIds, compaction: record,
  });
  const history = selected.transcript.filter(entry => entry.id);
  if (!history.length) return;
  const measurement = task.lastContextModel === `${instance.instanceId}:${model}` && !task.rewound ? task.usage?.context : undefined;
  const window = contextWindowFor(model, instance.models, measurement?.window);
  const bytes = history.reduce((n, entry) => n + Buffer.byteLength(entry.text), 0);
  let floor = task.contextFloor;
  if (record && record.id === task.appliedCompactionId && floor === undefined && measurement?.tokens) {
    floor = measurement.tokens;
    store.patchTask(bot.id, threadId, { contextFloor: floor });
  }
  // Use the selected account's launch setting. "auto" and "off" supply no
  // known numeric boundary; other providers do not inherit Claude's limit.
  const nativeCompactAt = instance.driverKind === "claudeAgent"
    ? Number(autoCompactWindow({ ...process.env, ...cfg.instances?.[instance.instanceId]?.environment })) : undefined;
  if (!manual && !shouldCompact({ contextTokens: measurement?.tokens, estimatedBytes: bytes,
    budget: compactBudget(window, cfg.context?.compactAt, nativeCompactAt), floor, window, nativeCompactAt })) return;
  const fold = manual ? { folded: history, firstKeptId: "" } : foldPoint(history);
  if (!fold) return;
  const foldedThroughId = manual
    ? context.findLast(entry => !excludedIds.has(entry.id))?.id
    : fold.folded.at(-1)?.id;
  if (!foldedThroughId) return;
  const prefix = JSON.stringify(messages);
  const controller = new AbortController();
  compactionControllers.set(threadId, { generation, controller });
  try {
    const summary = await draftSummary(fold.folded, { signal: controller.signal, generateText: instance.generateText?.bind(instance) });
    if (!directTurnClaimIsCurrent(bot.id, generation, threadId)) throw new DirectTurnSetupCancelled("context summarization stopped");
    controller.signal.throwIfAborted();
    // Appended teammate results remain after the fold. A changed prefix is
    // never summarized using stale input, even if the branch tip still exists.
    if (prefix !== JSON.stringify(store.activePath(threadId).slice(0, messages.length))) {
      if (manual) throw new Error("the conversation changed during summarization — please retry");
      return;
    }
    store.appendMessage(threadId, {
      role: "bot", kind: "compaction",
      compaction: { summary, firstKeptId: fold.firstKeptId, foldedThroughId,
        tokensBefore: measurement?.tokens ?? Math.ceil(bytes / 4), by: manual ? "person" : "harness" },
    }, { kind: "compaction.append", key: `${threadId}:${messages.at(-1)?.id}:${fold.firstKeptId}` });
  } finally {
    if (compactionControllers.get(threadId)?.generation === generation) compactionControllers.delete(threadId);
  }
}

const handoffs = new Handoffs({
  order: (threadId) => store.activePath(threadId).filter(isContextMessage).map((m: any) => m.id),
  read: (botId, threadId, instanceId) => store.taskByThread(botId, threadId)?.handedMessages?.[instanceId],
  write: (botId, threadId, instanceId, state) => store.setHandedMessages(botId, threadId, instanceId, state),
  replies: (threadId, turnId) => store.activePath(threadId)
    .filter((m: any) => m.role === "bot" && m.kind === "text" && !m.from && m.turnId === turnId).map((m: any) => m.id),
});

/** Consume one delegated-turn watch and mirror exactly one terminal state.
 * Some harness paths settle a busy bot without a provider turn.completed
 * event, so they call this same finalizer explicitly. */

// A bot going in circles — the same call with the same arguments, over and
// over in one turn — gets a chip at 5, 10 and 20 repeats. Observe and say
// so; the human has Stop. Keyed on tool + arguments, so a bare tool name
// (Claude's item.started carries only that) is never counted: five "Bash"
// may be five different commands. Arguments come from ACP item titles and
// from every permission ask's summary (the command being approved).
bus.subscribe((event: RuntimeEvent) => {
  if (shouldIgnoreProviderEvent(event)) return;
  if (event.type === "turn.completed" || event.type === "session.exited") return void repeats.settle(event.threadId);
  let key: string | null = null;
  if (event.type === "item.started" && event.itemType === "tool") {
    // a title with more than a bare identifier is a call with arguments
    // (ACP: "echo hi", "Read src/x.ts"); a bare "Bash" is not countable
    const title = event.title ?? "";
    if (/\s|\//.test(title.trim())) key = callKey("tool", title);
  } else if (event.type === "request.opened" && event.requestType === "permission") key = callKey(event.tool, event.summary);
  if (!key) return;
  const { threshold } = repeats.record(event.threadId, key);
  if (!threshold) return;
  const [tool, ...rest] = key.split(":");
  const args = rest.join(":");
  store.appendMessage(event.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Same call repeated ${threshold}× — ${tool}: ${args.slice(0, 80)}${args.length > 80 ? "…" : ""} — it may be stuck`, ok: false },
  });
});

// Drain queued delegations for a source thread after its turn settles.
// Run as a separate subscriber so the drain logic stays out of the main
// fold (which has its own switch/case noise) and its approval + startTurn
// calls never have to share locals with the fold's state machine.
/** How a drained delegation becomes a real turn on the target. Shared by
 * the settle-time drain and the boot-time drain of what a previous process
 * left queued. */
const runDelegatedTurn: Parameters<typeof drainDelegations>[3] = (toBotId, rawText, commsDepth, sourceThreadId, _channel, taskId, sourceBotId, openedThreadId, oneWay, completionOwner) => {
    // startTurn REJECTS on an ordinary condition — busy target, deleted bot,
    // unavailable provider. Unhandled, that rejection is fatal to the
    // harness (Node's default), which in the packaged app kills the server
    // child. Every delegation failure has to land as a chip instead.
    // A fresh-thread handoff runs in the thread the opener created — the
    // drain already dropped it if that thread is gone — never in whatever
    // the person is looking at.
    const targetThreadId = openedThreadId ?? store.bot(toBotId)?.threadId;
    const target = store.bot(toBotId);
    const opener = store.bot(sourceBotId);
    const unattended = isUnattended(sourceBotId, sourceThreadId);
    // The inbound line is another bot's words whichever way it arrived: an
    // opened thread's first line carries the shared provenance note, a
    // classic handoff the "[Delegated by @X" prefix from the drain. Both
    // record the author structurally (peerAsk) as well as in the text, so
    // a renderer never has to take the line for the person's own message.
    const peerAsk: Message["peerAsk"] | undefined = opener
      ? { botId: opener.id, name: opener.name, unattended: unattended || undefined }
      : undefined;
    const text = openedThreadId && opener
      ? withPeerProvenance(rawText, { botName: opener.name, delivery: oneWay ? "send_to_bot" : "start_thread", unattended })
      : rawText;
    if (targetThreadId) {
      delegationWatch.set(targetThreadId, {
        toBotId,
        toBotName: target?.name,
        taskId,
        sourceThreadId,
        sourceBotId,
        routineRunId: activeRoutineRunForThread(sourceThreadId)?.id,
        startedAtMs: Date.now(),
        ...(oneWay ? { oneWay: true } : {}),
        ...(completionOwner ? { completionOwner } : {}),
      });
    }
    let failureReported = false;
    const reportStartFailure = (error: unknown) => {
      if (failureReported) return;
      failureReported = true;
      const bot = store.bot(toBotId);
      const why = error instanceof Error ? error.message : String(error);
      if (targetThreadId) {
        const finalized = finalizeDelegationWatch(
          targetThreadId,
          false,
          "",
          `Delegated turn could not start — ${why.slice(0, 120)}`,
        );
        if (finalized) return;
      }
      const source = store.botByThread(sourceThreadId);
      if (!source) return;
      store.appendMessage(sourceThreadId, {
        role: "bot",
        kind: "activity",
        tool: failedTurnTool(`delegation to @${bot?.name ?? toBotId} could not start — ${why}`),
      });
    };
    return startTurn()(toBotId, text, {
      threadId: targetThreadId,
      commsDepth,
      unattended,
      peerAsk,
      // startTurn schedules provider/integration setup after marking the bot
      // busy. Those asynchronous setup failures do not emit turn.completed,
      // so clear the watch and report them through this callback too.
      onDispatchError: reportStartFailure,
    }).then(() => undefined).catch((err: any) => {
      reportStartFailure(err);
    });
};

function drainThreadDelegations(threadId: string): void {
  const routineRunId = activeRoutineRunForThread(threadId)?.id;
  drainDelegations(commsBus(), approvalBus(), threadId, runDelegatedTurn,
    (receipt) => wakeUndispatchedDelegation(receipt, routineRunId));
}

// Queued handoffs expire DELEGATION_TTL_MS after they were queued. A drain
// expires what it touches; this sweep covers a handoff nothing drains — a
// target that never settles while its source sits idle — and wakes each
// delegator the same way a drain-time failure does.
const DELEGATION_SWEEP_MS = 60 * 60 * 1000;
function expireDelegationsNow(): void {
  expireStaleDelegations(commsBus(), Date.now(), (receipt) =>
    wakeUndispatchedDelegation(receipt, activeRoutineRunForThread(receipt.sourceThreadId)?.id));
}

// Most waiting handoffs retry from a target's turn.completed event. Some
// setup, cancellation, room, watchdog, and provider-reload paths release a
// bot without that event, so every explicit idle release calls this same
// coalesced retry hook. The microtask lets the releasing state machine finish
// before another turn claims the bot.
const delegationRetryBots = new Set<string>();
function retryDelegationsWaitingOn(botId: string): void {
  if (delegationRetryBots.has(botId)) return;
  delegationRetryBots.add(botId);
  queueMicrotask(() => {
    delegationRetryBots.delete(botId);
    // Explicit idle releases (room/setup/reload/watchdog fallbacks) may not
    // publish turn.completed. They free a waiting source continuation too.
    drainDelegationWakes();
    // A bot still busy in one thread has nevertheless freed a slot: every
    // handoff waiting on it re-tests its own admission — a fresh-thread
    // handoff asks for any free slot, a classic one the standing thread's
    // startTurn admission — so neither waits for whole-bot idleness.
    if (store.bot(botId)?.busy === true && botAtThreadCapacity(botId)) return;
    const released = releaseDelegationsWaitingOn(botId);
    for (const waitingThread of released) {
      drainThreadDelegations(waitingThread);
    }
  });
}

bus.subscribe((event: RuntimeEvent) => {
  if (shouldIgnoreProviderEvent(event)) return;
  if (event.type !== "turn.completed") return;
  // A turn that failed or was interrupted drops its queue rather than
  // firing it later: the user who hit Stop does not expect the delegations
  // that turn queued to run anyway, minutes later, on an unrelated turn.
  if (!event.ok) discardDelegations(commsBus(), event.threadId);
  drainThreadDelegations(event.threadId);
  // A settling bot frees itself as a delegation TARGET too: handoffs that
  // found it busy earlier were kept queued — waiting until it's free or the
  // 24-hour expiry, not counting retries — on their own source threads, and
  // this is the moment they get re-evaluated.
  const settledBot = store.botByThread(event.threadId);
  if (settledBot) retryDelegationsWaitingOn(settledBot.id);
});


  return {
    showWaitingOnPersonChip,
    settleWaitingOnPersonChips,
    activeRoutineRunForThread,
    wakeDelegationSource,
    reportIncident,
    drainDelegationWakes,
    markTaskContextExternallyUpdated,
    latestCompaction,
    directContext,
    compactConversation,
    handoffs,
    drainThreadDelegations,
    expireDelegationsNow,
    retryDelegationsWaitingOn,
    delegationWakeBudget,
    pendingDelegationWakes,
    isExternalContextMarker,
    isContextMessage,
    DELEGATION_SWEEP_MS,
  };
}
