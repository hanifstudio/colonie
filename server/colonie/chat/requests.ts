// Inbound request/answer/card handling plus the shared per-thread notice state (last reply, announced model, reviewer notice, turn usage/context, repeat detector) and the stall watchdog.
import { type RequestOutcome } from "../../contracts.ts";
import { type Notification } from "../../notify.ts";
import { isPersistentQuestionCard } from "../../../shared/ask-question.ts";
import { failedTurnTool } from "../../../shared/failed-turn.ts";
import { liveDecisionRefusal } from "../../../shared/live-approval.ts";
import { TurnWatchdog } from "../../colonie/chat/turn-watchdog.ts";
import { discardDelegations } from "../../colonie/peers/delegations.ts";
import { cancelPeerApprovalsForThread, resolvePeerComms } from "../../colonie/peers/peer-approval.ts";
import { DATA_DIR } from "../../config.ts";
import { appendDecision } from "../../decision-log.ts";
import { RepeatDetector } from "../../repeat-detector.ts";
import { type RequestAuth } from "../../request-auth.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface ChatRequestsDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createChatRequests(deps: ChatRequestsDeps) {
  const {
    answeringCardAs, approvalBus, askMessageByRequest, botForThread, broadcast,
    canManageCommandAllowlist, cardAnswerRefusal, commandAllowlist, deliverLateQuestionAnswer,
    pendingCommandRules, registry, runningTurnEngines, sessions, store,
    activeRoutineRunForThread, cancelDirectTurnDispatch, commsBus, directRequestOwners,
    directTurnBots, directTurnGenerationByThread, drainComputerResumes, drainConnectorResumes,
    drainQueuedSends, drainSecretResumes, drainTeamSetupResumes, localVmThreadTargets,
    pendingDelegationWakes, releaseLocalVmThread, releaseTurnResources, reportIncident,
    retireProviderTurn, retryDelegationsWaitingOn, revokeInternalCapabilitiesForThread, routines,
    runningTurnInstance, settleDirectFollowup, stopScreenPoller, threadBusy, turnResourceOwners,
    finalizeDelegationWatch
  } = deps;
function commandRememberRefusal(auth: RequestAuth, threadId: string, requestId: string, behavior: string): string | null {
  if (!canManageCommandAllowlist(auth)) return "Only the owner or an admin can save bot-wide command permissions.";
  if (behavior !== "allow" || !pendingCommandRules.has(`${threadId}:${requestId}`)) {
    return "This live request does not contain a command that can be saved. Allow it once instead.";
  }
  return null;
}

/** Deliver a person's answer to the engine that asked, and tell the truth
 * about what happened. `unavailable` — the turn ended, the ask timed out,
 * the engine has no asks — is fail-closed: the action was never run. The
 * card is settled and a chip says so, instead of the answer vanishing into
 * a 500 while the card sits open forever. */
async function answerRequest(
  threadId: string,
  instanceId: string,
  requestId: string,
  behavior: "allow" | "deny" | "answer",
  message?: string,
  decidedFor?: { id: string; name: string },
  /** "Always allow this session": the provider keeps the allow, not the app */
  always?: boolean,
  rememberCommand?: boolean,
): Promise<RequestOutcome> {
  // Snapshot the card BEFORE delivering the answer: a delivered answer
  // resolves the request synchronously through the fold, which consumes
  // the askMessageByRequest entry — by the time the await returns, nobody
  // remembers which tool this requestId was about.
  const thread = store.messagesFor(threadId);
  const cardMessageId = askMessageByRequest.get(`${threadId}:${requestId}`);
  // The map is an in-flight optimization and disappears on restart; the
  // durable transcript still carries the request id and its audit metadata.
  const cardMessage = cardMessageId
    ? thread.find((m: any) => m.id === cardMessageId)
    : thread.find((m: any) => m.card?.requestId === requestId);
  const card = cardMessage?.card;
  const remembered = rememberCommand ? pendingCommandRules.get(`${threadId}:${requestId}`) : undefined;
  // A model change can differ from the bot's current settings. The live turn
  // owns this question, just as it owns Stop/steer.
  const instance = runningTurnEngines().get(threadId) ?? registry.get(instanceId);
  let outcome: RequestOutcome = "unavailable";
  if (instance) {
    try {
      outcome = await instance.adapter.respondToRequest(threadId, requestId, { behavior, message, always: always && behavior === "allow" });
    } catch {
      outcome = "unavailable";
    }
  }
  if (remembered && outcome === "allowed-once" && behavior === "allow" && store.bot(remembered.botId)) {
    // Persist only after the provider accepted this exact live request. A dead
    // card, denied request, failed delivery or process restart saves no grant.
    try {
      commandAllowlist.add(remembered.botId, remembered.candidate);
    } catch {
      store.appendMessage(threadId, { role: "bot", kind: "activity", tool: {
        name: "Command allowed once, but its allowlist rule could not be saved. Try again from the permissions menu.", ok: false,
      } });
    }
  }
  // An answered question keeps its words. `request.resolved` only records
  // the behavior, so without this the card reads "answer" forever and the
  // person can no longer see what they told the bot.
  if (outcome === "answered" && behavior === "answer" && message && cardMessage) {
    const settled = store.messagesFor(threadId).find((m: any) => m.id === cardMessage.id)?.card;
    if (settled) {
      store.patchMessage(threadId, cardMessage.id, { card: { ...settled, answeredText: message } });
    }
  }
  // The human's verdict, recorded only when it actually reached the engine:
  // `unavailable` means the action never ran, and a "user-approved" row
  // over a request nothing answered would be the audit log lying. A
  // question's `answer` is conversation, not authorization, so it is not a
  // decision either.
  if (outcome !== "unavailable" && behavior !== "answer") {
    appendDecision(DATA_DIR, {
      threadId,
      requestId,
      botId: decidedFor?.id,
      botName: decidedFor?.name,
      tool: card?.tool,
      summary: card?.subtitle,
      decision: behavior === "allow" ? "user-approved" : "user-denied",
      source: "user",
    });
  }
  if (outcome === "unavailable") {
    // The in-flight map is memory-only. After a restart the card is still on
    // the thread, so fall back to the request it carries — otherwise an
    // unreachable approval is never closed and keeps owning the composer.
    const messageId = askMessageByRequest.get(`${threadId}:${requestId}`);
    const thread = store.messagesFor(threadId);
    const existing = messageId
      ? thread.find((m: any) => m.id === messageId)
      : thread.find((m: any) => m.card?.requestId === requestId);
    const persistentQuestion = isPersistentQuestionCard(existing?.card);
    if (existing?.card && !existing.card.answered && !persistentQuestion) {
      store.patchMessage(threadId, existing.id, { card: { ...existing.card, answered: "unavailable", dismissed: true } });
    }
    if (messageId) askMessageByRequest.delete(`${threadId}:${requestId}`);
    // The card's own answered state gates the message too: a replayed respond
    // for a card that already settled must not read as a failed delivery —
    // nothing was lost, the earlier answer already ran.
    if (!persistentQuestion && !existing?.card?.answered) store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: "Couldn't deliver that answer — the request is no longer open, so the action was not run", ok: false },
    });
  }
  return outcome;
}

type CardRespondResult = { ok: true } | { ok: false; status: number; error: string };

/** A decision or answer on a provider/peer card, made on behalf of `auth`
 * (a Live call answers as the person who started the call). Harness-native
 * proposals (skill, routine, profile, default model, team setup)
 * are not handled here; they are reviewed on screen (liveDecisionRefusal).
 * Mirrors POST /api/threads/:id/respond. */
async function respondToCard(input: {
  auth: RequestAuth;
  threadId: string;
  requestId: string;
  behavior: "allow" | "deny" | "answer";
  message?: string;
}): Promise<CardRespondResult> {
  const { auth, threadId, requestId, behavior, message } = input;
  // A call outlives the request that started it: the session must still be valid.
  if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
    return { ok: false, status: 401, error: "The session that started this call has ended." };
  }
  const refusal = cardAnswerRefusal(auth, threadId, requestId, behavior);
  if (refusal) return { ok: false, status: 403, error: refusal };
  const bot = store.botByThread(threadId);
  if (!bot) return { ok: false, status: 404, error: "The chat is gone." };
  const cardMessage = store.messagesFor(threadId).find((candidate: any) => candidate.card?.requestId === requestId);
  const card = cardMessage?.card;
  // Refused before anything runs: answerRequest would close a proposal it
  // cannot deliver as "unavailable", and would add a false "not run" line to
  // a card someone settled on screen a moment ago.
  const refused = liveDecisionRefusal(card);
  if (refused) return { ok: false, status: 409, error: refused };
  let result: CardRespondResult = { ok: true };
  await answeringCardAs(auth, threadId, requestId, async () => {
    // peer-approval intercept, as the route: only a card on this thread
    if (card && resolvePeerComms(approvalBus(), requestId, behavior)) return;
    const outcome = await answerRequest(
      threadId, botForThread(bot.id, threadId)?.modelSelection.instanceId ?? "", requestId, behavior, message,
      { id: bot.id, name: bot.name },
    );
    if (outcome === "unavailable" && isPersistentQuestionCard(card) && behavior === "answer" && cardMessage) {
      const answer = message?.trim() ?? "";
      if (!answer) {
        result = { ok: false, status: 400, error: "A question answer is required." };
      } else if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
        result = { ok: false, status: 401, error: "The session that started this call has ended." };
      } else {
        try {
          await deliverLateQuestionAnswer()(auth, threadId, requestId, answer, cardMessage, bot, "call");
        } catch (error) {
          result = { ok: false, status: 409, error: error instanceof Error ? error.message : "The late answer could not be queued." };
        }
      }
    } else if (outcome === "unavailable") {
      result = { ok: false, status: 409, error: "The request is no longer open." };
    } else if (behavior === "answer" && outcome !== "answered") {
      result = { ok: false, status: 409, error: "The provider did not accept that answer. Try an offered option." };
    }
  }, "call");
  return result;
}

/** Close every provider-owned approval still open on a thread. Interrupting a
 * turn kills the process that raised its questions, so those cards can never
 * be answered. Routine proposals are harness-owned and durable, so they stay
 * actionable even after the proposing turn has stopped. */
function closeOpenApprovals(threadId: string): void {
  for (const key of pendingCommandRules.keys()) if (key.startsWith(`${threadId}:`)) pendingCommandRules.delete(key);
  // Peer approvals also hold an in-memory promise. Resolve those first; merely
  // patching their cards would leave the delegation queue waiting 15 minutes.
  cancelPeerApprovalsForThread(threadId);
  for (const message of store.messagesFor(threadId)) {
    const card = message.card;
    if (!card?.requestId || card.answered || card.dismissed) continue;
    if (card.routineRequest || card.skillRequest) continue;
    if (isPersistentQuestionCard(card)) {
      // Keep the durable card; its in-flight adapter mapping cannot survive
      // turn cleanup, and the response route can resume it from the transcript.
      askMessageByRequest.delete(`${threadId}:${card.requestId}`);
      continue;
    }
    store.patchMessage(threadId, message.id, { card: { ...card, answered: "unavailable", dismissed: true } });
    askMessageByRequest.delete(`${threadId}:${card.requestId}`);
  }
}

function requestBehavior(value: unknown): "allow" | "deny" | "answer" | null {
  return value === "allow" || value === "deny" || value === "answer" ? value : null;
}

// the last settled assistant text per thread, so a "finished" notification
// can carry what the bot actually said
const lastReply = new Map<string, string>();
/** the model each thread's provider session announced in session.started,
 * so a fallback notice can name the model Auto is unavailable for */
const sessionModelByThread = new Map<string, string>();
/** threads already told that the provider's reviewer never started */
const nativeReviewNoticed = new Set<string>();
/** a driver kind as the chat should name it: "claudeAgent" → "Claude" */
const providerLabel = (provider: string): string => {
  const bare = provider.replace(/Agent$/, "");
  return bare.charAt(0).toUpperCase() + bare.slice(1);
};

/** Put a notification on the wire. Clients decide what to do with it — a
 * desktop notification now, a push to a paired phone later. */
function notify(notification: Notification | null) {
  // nested rather than spread — the frame's own `kind` names the frame,
  // exactly like {kind:"message", message} and {kind:"bot", bot}
  if (notification) broadcast({ kind: "notify", notification });
}

// The latest running token totals for the turn in flight on each thread.
// Providers report cumulative-within-turn numbers; the final value is folded
// into the task's tally when the turn settles.
const turnUsage = new Map<string, { input: number; output: number; cachedInput?: number }>();
/** What the window held on the latest model call of the turn in flight, banked beside the totals at turn.completed. */
const turnContext = new Map<string, { tokens?: number; window?: number }>();

// Bounded per active turn. OpenHands uses a bounded recent-event scan for
// the same class of stuck-loop detection; retaining an unlimited set of
// unique arguments would let one pathological turn grow the server forever.
const repeats = new RepeatDetector({ thresholds: [5, 10, 20], maxKeysPerThread: 256 });
// ── stall watchdog ─────────────────────────────────────────────────────
// ask_bot has a short inline wait budget, while room turns have a separately
// configurable absolute ceiling. The main 1:1 path had none, so a wedged CLI
// left its bot busy forever. The watchdog stops a turn whose thread has emitted NOTHING for stallMs —
// activity-based, so an hour-long turn that keeps streaming is never
// touched, and turns parked on a human approval are exempt.
const TURN_STALL_MS = Math.max(60_000, Number(process.env.COLONIE_TURN_STALL_MS) || 20 * 60_000);
const watchdog = new TurnWatchdog({
  stallMs: TURN_STALL_MS,
  checkMs: 60_000,
  onStall: (turn) => {
    const stalledResourceOwner = turnResourceOwners.get(turn.threadId);
    const stalledGeneration = directTurnGenerationByThread.get(turn.threadId);
    const stalledProviderTurn = directRequestOwners.get(turn.threadId);
    cancelDirectTurnDispatch(turn.botId, turn.threadId);
    const stalledVmTarget = localVmThreadTargets().get(turn.threadId);
    revokeInternalCapabilitiesForThread(turn.threadId);
    repeats.settle(turn.threadId);
    const bot = botForThread(turn.botId, turn.threadId);
    const routineRun = activeRoutineRunForThread()(turn.threadId);
    void runningTurnInstance()(bot, turn.threadId)?.adapter.interruptTurn(turn.threadId).catch(() => {});
    const minutes = Math.round(TURN_STALL_MS / 60_000);
    if (routineRun?.target === "bot") {
      routines()?.failThread(turn.threadId, `No activity for ${minutes} minutes — the routine was stopped`);
      pendingDelegationWakes().delete(turn.threadId);
      discardDelegations(commsBus(), turn.threadId);
    }
    store.appendMessage(turn.threadId, {
      role: "bot",
      kind: "activity",
      tool: failedTurnTool(`no activity for ${minutes} minutes — the turn was stopped`),
    });
    // a routine's stall reports through its own failure path
    if (bot && routineRun?.target !== "bot") {
      reportIncident()({ kind: "stalled", bot, threadId: turn.threadId, detail: `no activity for ${minutes} minutes — the turn was stopped` });
    }
    settleDirectFollowup(stalledGeneration);
    finalizeDelegationWatch(turn.threadId, false, "", "Delegated turn stalled and was stopped");
    turnUsage.delete(turn.threadId);
    turnContext.delete(turn.threadId);
    // ACP interruption settles within five seconds; other adapters settle
    // sooner. Keep ownership during that grace period so another turn cannot
    // overlap the process we are stopping. The normal turn.completed fold
    // clears it first when the adapter responds.
    const releaseOwnership = () => {
      if (stalledGeneration && directTurnGenerationByThread.get(turn.threadId) !== stalledGeneration) return;
      if (stalledResourceOwner && turnResourceOwners.get(turn.threadId)?.generation !== stalledResourceOwner.generation) return;
      if (stalledGeneration && stalledProviderTurn?.generation === stalledGeneration && stalledProviderTurn.turnId) {
        retireProviderTurn(stalledProviderTurn.turnId);
      }

      if (stalledVmTarget && localVmThreadTargets().get(turn.threadId) === stalledVmTarget) {
        releaseLocalVmThread()(turn.threadId);
      }
      // A cleared UI busy flag must not strand this finished generation's
      // computer claim. The generation checks above protect replacements.
      releaseTurnResources(stalledResourceOwner);
      const currentBot = store.bot(turn.botId);
      if (currentBot?.busy && threadBusy(currentBot.id, turn.threadId)) {
        stopScreenPoller()(currentBot.id, turn.threadId);
        if (store.taskByThread(currentBot.id, turn.threadId)) store.setTaskActivity(currentBot.id, turn.threadId, "idle");
        else store.setActivity(currentBot.id, "idle");
        directTurnBots.delete(turn.threadId);
        retryDelegationsWaitingOn()(currentBot.id);
        // The grace fallback replaces a missing turn.completed event. Release
        // every kind of work that may have queued behind this bot, including
        // connector and credential continuations.
        drainQueuedSends()();
        drainConnectorResumes()();
        drainComputerResumes()();
        drainSecretResumes()();
        drainTeamSetupResumes()();
      }
    };
    const release = setTimeout(releaseOwnership, 6_000);
    release.unref?.();
  },
});

  return {
    commandRememberRefusal,
    answerRequest,
    respondToCard,
    closeOpenApprovals,
    requestBehavior,
    providerLabel,
    notify,
    watchdog,
    lastReply,
    sessionModelByThread,
    nativeReviewNoticed,
    turnUsage,
    turnContext,
    repeats,
  };
}
