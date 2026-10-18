// Card resolvers: trust/model/profile/team-setup/routine resolutions and their resume queue, plus skill-undo application.
import { json } from "../../harness/http.ts";
import { type ServerResponse } from "node:http";
import { type TeamSetupRequest } from "../../../shared/team-setup.ts";
import { isTurnAdmissionBlocked } from "../../colonie/chat/turn-dispatch-guard.ts";
import { canAccessTeam } from "../../colonie/peers/peer-roster.ts";
import { ModelRequestService } from "../../colonie/providers/model-requests.ts";
import { RoutineRequestService } from "../../colonie/routines/routine-requests.ts";
import { undoSkillWrite } from "../../colonie/skills/skills.ts";
import { readSections } from "../../colonie/teams/section-context.ts";
import { TeamSetupError, TeamSetupRequestService } from "../../colonie/teams/team-setup-requests.ts";
import { DATA_DIR } from "../../config.ts";
import { appendDecision } from "../../decision-log.ts";
import { UNDO_STALE } from "../../direct-apply.ts";
import { requestSourceForCard } from "../../guarded-requests.ts";
import { sectionKey } from "../../persistence/store.ts";
import { ProfileRequestService } from "../../profile-requests.ts";
import { redactSecretsInText } from "../../redact.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface CardResolversDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createCardResolvers(deps: CardResolversDeps) {
  const {
    MAX_WORKSPACE_BOTS, appliesDirectly, broadcast, canAdmitDirectTurn, chiefPeerTargetRule,
    connectorThread, deleteBotWithLifecycle, directTurnDispatchClaims, driverCapabilitiesFor,
    fullAccessForSource, hasDirectDispatch, outboundRequests, proposalPersistence, 
    routineRequests, routines, startTurn, store, teamMemory, threadBusy, validateModelProposal,
    wireBot
  } = deps;
function resolveAndSendTrust(res: ServerResponse, threadId: string, requestId: string, behavior: "allow" | "deny" | "answer"): boolean {
  const teamMemoryCard = store.messagesFor(threadId).find(
    (message: any) => message.card?.requestId === requestId && message.card.teamMemoryRequest,
  );
  if (teamMemoryCard?.card?.teamMemoryRequest) {
    const request = teamMemoryCard.card.teamMemoryRequest;
    const proposer = teamMemoryCard.from?.botId ? store.bot(teamMemoryCard.from.botId) : store.botByThread(threadId);
    const result = teamMemory.resolve(request.section, request.entryId, behavior === "allow" ? "accept" : "reject");
    if (!result.claimed) {
      if (!teamMemoryCard.card.answered) {
        store.patchMessage(threadId, teamMemoryCard.id, { card: { ...teamMemoryCard.card, answered: "unavailable", dismissed: true } });
      }
      json(res, 200, { ok: true, outcome: "unavailable" });
      return true;
    }
    if (result.state === "already_settled") {
      json(res, 200, { ok: true, outcome: "allowed-once", alreadySettled: true });
      return true;
    }
    store.patchMessage(threadId, teamMemoryCard.id, {
      card: { ...teamMemoryCard.card, answered: result.state === "accepted" ? "allow" : "deny" },
    });
    appendDecision(DATA_DIR, {
      threadId, requestId, botId: proposer?.id, botName: proposer?.name,
      tool: "propose_team_memory", summary: teamMemoryCard.card.subtitle,
      decision: result.state === "accepted" ? "user-approved" : "user-denied", source: "user",
    });
    json(res, 200, { ok: true, outcome: result.state === "accepted" ? "allowed-once" : "rejected" });
    return true;
  }
  const outboundCard = store.messagesFor(threadId).find(
    (message: any) => message.card?.requestId === requestId && message.card.outboundRequest,
  );
  if (outboundCard?.card?.outboundRequest) {
    const outboundBot = outboundCard.from?.botId ? store.bot(outboundCard.from.botId) : store.botByThread(threadId);
    const result = outboundRequests.resolve({ threadId, requestId, behavior });
    if (!result.claimed) {
      // The hold is memory-only: after a restart the card outlives the
      // relay that was waiting on it, so close it rather than leave an
      // approval nobody can deliver owning the composer.
      if (!outboundCard.card.answered) {
        store.patchMessage(threadId, outboundCard.id, { card: { ...outboundCard.card, answered: "unavailable", dismissed: true } });
      }
      json(res, 200, { ok: true, outcome: "unavailable" });
      return true;
    }
    if (result.state === "already_settled") {
      json(res, 200, { ok: true, outcome: result.behavior === "allow" ? "allowed-once" : "rejected", alreadySettled: true });
      return true;
    }
    store.patchMessage(threadId, outboundCard.id, {
      card: { ...outboundCard.card, answered: result.state === "allowed" ? "allow" : "deny" },
    });
    appendDecision(DATA_DIR, {
      threadId, requestId, botId: outboundBot?.id, botName: outboundBot?.name,
      tool: outboundCard.card.tool, summary: outboundCard.card.subtitle,
      decision: result.state === "allowed" ? "user-approved" : "user-denied", source: "user",
    });
    json(res, 200, { ok: true, outcome: result.state === "allowed" ? "allowed-once" : "rejected" });
    return true;
  }
  return false;
}

const profileRequests = new ProfileRequestService({
  store,
  autoApply: appliesDirectly,
  canPersist: proposalPersistence(),
  // A Chief may change a section peer; anyone else only itself. Re-checked at confirm.
  validateTarget: chiefPeerTargetRule("profile"),
});
const modelRequests = new ModelRequestService({
  store,
  autoApply: appliesDirectly,
  canPersist: proposalPersistence(),
  // Same authority rule as profile proposals: a Chief may name one section peer.
  validateTarget: chiefPeerTargetRule("default model"),
  validateModel: validateModelProposal,
  driverCapabilities: driverCapabilitiesFor,
});
const teamSetupTeams = () => [...new Set(["", ...readSections(), ...store.bots.map((bot: any) => sectionKey(bot.section)), ...store.groups.map((group: any) => sectionKey(group.section))])];
const teamSetupRequests = new TeamSetupRequestService({
  store, teams: teamSetupTeams, canAccessTeam, canPersist: proposalPersistence(), maxBots: MAX_WORKSPACE_BOTS,
  autoApply: fullAccessForSource,
  validateChange: () => {},
  ownsThread: (botId, threadId) => Boolean(connectorThread()(botId, threadId)),
  targetBusy: (botId, sourceThreadId) => {
    if (!sourceThreadId) return Boolean(store.bot(botId)?.busy || hasDirectDispatch(botId) || routines()?.activeRunForBot(botId));
    const run = routines()?.activeRunForBot(botId);
    return store.tasks(botId).some((task: any) => task.threadId !== sourceThreadId && threadBusy(botId, task.threadId)) ||
      [...directTurnDispatchClaims].some(([threadId, claim]) => threadId !== sourceThreadId && claim.botId === botId) ||
      Boolean(run && run.threadId !== sourceThreadId);
  },
  validateModel: validateModelProposal,
  // Engine-switch capability warnings come from the live registry, so a
  // card built while an instance was down never guesses.
  driverCapabilities: driverCapabilitiesFor,
  deleteBot: async (botId, revalidate, request) => {
    const result = await deleteBotWithLifecycle(botId, revalidate, request);
    if (result.status >= 400) throw new TeamSetupError(result.body.error ?? "The bot could not be deleted", result.status);
  },
});

type TeamSetupResumeEntry = { request: TeamSetupRequest; messageId: string; generation: number };
const pendingTeamSetupResumes = new Map<string, TeamSetupResumeEntry>();
const teamSetupResumeGenerations = new Map<string, number>();
function cancelTeamSetupResumesForThread(threadId: string): void {
  // Invalidate before provider teardown can synchronously drain the queue.
  // The generation also prevents an in-flight dispatch failure requeueing
  // its old entry after Stop or deletion has already cancelled it.
  teamSetupResumeGenerations.set(threadId, (teamSetupResumeGenerations.get(threadId) ?? 0) + 1);
  for (const [key, entry] of pendingTeamSetupResumes) {
    if (entry.request.threadId === threadId) pendingTeamSetupResumes.delete(key);
  }
}
function dispatchTeamSetupResume(entry: TeamSetupResumeEntry): void {
  const { request, messageId } = entry;
  const cancelled = () => entry.generation !== (teamSetupResumeGenerations.get(request.threadId) ?? 0);
  if (cancelled()) return;
  const owner = connectorThread()(request.botId, request.threadId);
  const message = store.messagesFor(request.threadId).find((item: any) => item.id === messageId);
  if (!owner || !message?.card?.teamSetupRequest?.result) return;
  if (!canAdmitDirectTurn(request.botId, request.threadId)) {
    pendingTeamSetupResumes.set(request.requestId, entry);
    return;
  }
  const prompt = `Colonie team setup decision ${request.requestId}: ${JSON.stringify(request.result)}. Report this exact result and continue the user's already requested work. Do not ask for confirmation again or repeat this setup/deletion. A denied or cancelled operation did not authorize any substitute action. Existing thread models were not changed.`;
  const failed = (error: string) => {
    if (cancelled()) return;
    const current = store.messagesFor(request.threadId).find((item: any) => item.id === messageId);
    if (current?.card) store.patchMessage(request.threadId, messageId, { card: { ...current.card, held: `The decision was recorded, but the Chief could not continue: ${redactSecretsInText(error).slice(0, 300)}` } });
  };
  void startTurn(request.botId, prompt, { threadId: request.threadId, cardContinuation: true,
    requestMessageId: requestSourceForCard(store.messagesFor(request.threadId), messageId), onDispatchError: failed }).catch((error: any) => {
    if (cancelled()) return;
    if (isTurnAdmissionBlocked(error)) pendingTeamSetupResumes.set(request.requestId, entry);
    else failed(error instanceof Error ? error.message : String(error));
  });
}
function drainTeamSetupResumes(): void {
  for (const [key, entry] of pendingTeamSetupResumes) {
    if (!canAdmitDirectTurn(entry.request.botId, entry.request.threadId)) continue;
    pendingTeamSetupResumes.delete(key);
    dispatchTeamSetupResume(entry);
  }
}
async function resolveAndSendTeamSetup(res: ServerResponse, args: { botId: string; threadId: string; requestId: string; behavior: string }, ownerReview: boolean): Promise<boolean> {
  const card = store.messagesFor(args.threadId).find((item: any) => item.card?.requestId === args.requestId && item.card.teamSetupRequest)?.card;
  if (!card) return false;
  if (args.behavior === "allow" && !ownerReview) { json(res, 403, { error: "Approve team setup or deletion from the desktop app or a paired Full-access device. In a local browser, wait until every bot is idle." }); return true; }
  const resumeGeneration = teamSetupResumeGenerations.get(args.threadId) ?? 0;
  const resolved = await teamSetupRequests.resolve(args);
  if (!resolved) return false;
  if (!resolved.duplicate) {
    appendDecision(DATA_DIR, { threadId: args.threadId, requestId: args.requestId, botId: args.botId, tool: card.tool,
      summary: card.subtitle, decision: resolved.result.state === "applied" ? "user-approved" : "user-denied", source: "user" });
  }
  const current = store.messagesFor(args.threadId).find((item: any) => item.id === resolved.messageId);
  if (current?.card?.teamSetupRequest?.result && !current.card.teamSetupRequest.resumed) {
    store.patchMessage(args.threadId, current.id, { card: { ...current.card, teamSetupRequest: { ...current.card.teamSetupRequest, resumed: true } } });
    dispatchTeamSetupResume({ request: resolved.request, messageId: resolved.messageId, generation: resumeGeneration });
  }
  json(res, 200, { ok: true, outcome: resolved.result.state === "applied" ? "allowed-once" : "rejected", result: resolved.result, alreadySettled: resolved.duplicate });
  return true;
}
function sendRoutineResolution(
  res: ServerResponse,
  result: ReturnType<RoutineRequestService["resolve"]>,
): boolean {
  if (!result.claimed) return false;
  if (result.state === "invalid") {
    json(res, result.status, { error: result.error });
    return true;
  }
  if (result.state === "already_settled") {
    json(res, 200, {
      ok: true,
      outcome: result.behavior === "allow" ? "allowed-once" : result.behavior === "deny" ? "rejected" : "unavailable",
      alreadySettled: true,
    });
    return true;
  }
  if (result.state === "denied") {
    json(res, 200, { ok: true, outcome: "rejected" });
    return true;
  }
  json(res, 200, {
    ok: true,
    outcome: "allowed-once",
    routineAction: result.action,
    resultId: result.resultId,
  });
  return true;
}
function resolveAndSendRoutine(
  res: ServerResponse,
  args: { botId: string; botName?: string; threadId: string; requestId: string; behavior: string },
): boolean {
  const card = store.messagesFor(args.threadId).find(
    (message: any) => message.card?.requestId === args.requestId && message.card.routineRequest,
  )?.card;
  const result = routineRequests.resolve(args);
  if (
    result.claimed &&
    (result.state === "applied" || result.state === "denied")
  ) {
    appendDecision(DATA_DIR, {
      threadId: args.threadId,
      requestId: args.requestId,
      botId: args.botId,
      botName: args.botName,
      tool: card?.tool,
      summary: card?.subtitle,
      decision: result.state === "applied" ? "user-approved" : "user-denied",
      source: "user",
    });
  }
  return sendRoutineResolution(res, result);
}
function resolveAndSendProfile(
  res: ServerResponse,
  args: { botId: string; botName?: string; threadId: string; requestId: string; behavior: string },
): boolean {
  const card = store.messagesFor(args.threadId).find(
    (message: any) => message.card?.requestId === args.requestId && message.card.profileRequest,
  )?.card;
  if (!card) return false;
  const result = profileRequests.resolve(args);
  if (!result.claimed) return false;
  if (result.state === "applied" || result.state === "denied") {
    appendDecision(DATA_DIR, {
      threadId: args.threadId, requestId: args.requestId, botId: args.botId, botName: args.botName,
      tool: "update_profile", summary: card.subtitle,
      decision: result.state === "applied" ? "user-approved" : "user-denied", source: "user",
    });
  }
  if (result.state === "applied") {
    const target = store.bot(result.targetBotId);
    if (target) broadcast({ kind: "bot", bot: wireBot(target) });
    json(res, 200, {
      ok: true, outcome: "allowed-once", profileFields: result.fields,
      ...(result.settlementPending ? { settlementPending: true, message: result.message } : {}),
    });
    return true;
  }
  if (result.state === "invalid") { json(res, result.status, { error: result.error }); return true; }
  if (result.state === "already_settled") {
    json(res, 200, { ok: true, outcome: result.behavior === "allow" ? "allowed-once" : "rejected", alreadySettled: true });
    return true;
  }
  json(res, 200, { ok: true, outcome: "rejected" });
  return true;
}

function resolveAndSendModel(
  res: ServerResponse,
  args: { botId: string; botName?: string; threadId: string; requestId: string; behavior: string },
): boolean {
  const card = store.messagesFor(args.threadId).find(
    (message: any) => message.card?.requestId === args.requestId && message.card.modelRequest,
  )?.card;
  if (!card) return false;
  const result = modelRequests.resolve(args);
  if (!result.claimed) return false;
  if (result.state === "applied" || result.state === "denied") {
    appendDecision(DATA_DIR, {
      threadId: args.threadId, requestId: args.requestId, botId: args.botId, botName: args.botName,
      tool: "update_model", summary: card.subtitle,
      decision: result.state === "applied" ? "user-approved" : "user-denied", source: "user",
    });
  }
  if (result.state === "applied") {
    const target = store.bot(result.targetBotId);
    if (target) broadcast({ kind: "bot", bot: wireBot(target) });
    json(res, 200, {
      ok: true, outcome: "allowed-once",
      ...(result.settlementPending ? { settlementPending: true, message: result.message } : {}),
    });
    return true;
  }
  if (result.state === "invalid") { json(res, result.status, { error: result.error }); return true; }
  if (result.state === "already_settled") {
    json(res, 200, { ok: true, outcome: result.behavior === "allow" ? "allowed-once" : "rejected", alreadySettled: true });
    return true;
  }
  json(res, 200, { ok: true, outcome: "rejected" });
  return true;
}

type UndoResult =
  | { claimed: false }
  | { claimed: true; state: "already_undone" | "undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true };

/** Undo for a learned skill a bot wrote without a person (undoSkillWrite). */
function undoSkillCard(botId: string, threadId: string, messageId: string): UndoResult {
  const message = store.messagesFor(threadId).find((candidate: any) => candidate.id === messageId);
  const card = message?.card;
  const request = card?.skillRequest;
  if (!message || !card || !request) return { claimed: false };
  if (card.undone) return { claimed: true, state: "already_undone" };
  if (!card.autoApplied || card.answered !== "allow") {
    return { claimed: true, state: "invalid", error: "Only a change that applied on its own can be undone here.", status: 409 };
  }
  if (request.botId !== botId || request.threadId !== threadId) {
    return { claimed: true, state: "invalid", error: "this skill request belongs to a different bot", status: 403 };
  }
  const undone = undoSkillWrite(botId, {
    stagedId: request.stagedId,
    name: request.name,
    action: request.action,
    ...(request.previous ? { previous: { skillMd: request.previous.preview, source: request.previous.source } } : {}),
  });
  if ("stale" in undone) return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
  if ("error" in undone) return { claimed: true, state: "invalid", error: undone.error, status: 409 };
  store.patchMessage(threadId, message.id, { card: { ...card, undone: true } });
  return { claimed: true, state: "undone" };
}

/** Undo on the one-line receipt of a change that applied without a person
 * (a bot's change to itself, or Full access). The caller authorizes it
 * exactly like answering that card; the card remembers it was undone. */
function undoAppliedChange(res: ServerResponse, threadId: string, requestId: string): void {
  const message = store.messagesFor(threadId).find((candidate: any) => candidate.card?.requestId === requestId);
  const card = message?.card;
  if (!message || !card) return json(res, 404, { error: "this change is no longer in the conversation" });
  // The proposing bot comes from the conversation (a room card's trusted
  // sender, else the thread's bot), never from the card payload.
  const botId = message.from?.botId ?? store.botByThread(threadId)?.id;
  if (!botId) return json(res, 400, { error: "this change has no valid owner" });
  let result: UndoResult = { claimed: false };
  if (card.routineRequest) {
    const undone = routineRequests.undo({ botId, threadId, requestId });
    result = undone;
  } else if (card.profileRequest) {
    const undone = profileRequests.undo({ botId, threadId, requestId });
    if (undone.claimed && undone.state === "undone") {
      const target = store.bot(undone.targetBotId);
      if (target) broadcast({ kind: "bot", bot: wireBot(target) });
    }
    result = undone;
  } else if (card.modelRequest) {
    const undone = modelRequests.undo({ botId, threadId, requestId });
    if (undone.claimed && undone.state === "undone") {
      const target = store.bot(undone.targetBotId);
      if (target) broadcast({ kind: "bot", bot: wireBot(target) });
    }
    result = undone;
  } else if (card.skillRequest) {
    result = undoSkillCard(botId, threadId, message.id);
  }
  if (!result.claimed) return json(res, 409, { error: "Only a change that applied on its own can be undone here." });
  if (result.state === "invalid") {
    return json(res, result.status, { error: result.error, ...(result.stale ? { code: "changed-since" } : {}) });
  }
  if (result.state === "undone") {
    appendDecision(DATA_DIR, {
      threadId, requestId, botId, botName: store.bot(botId)?.name,
      tool: card.tool, summary: card.subtitle, decision: "user-undone", source: "user",
    });
  }
  json(res, 200, { ok: true, undone: true, ...(result.state === "already_undone" ? { alreadyUndone: true } : {}) });
}


  return {
    resolveAndSendTrust,
    cancelTeamSetupResumesForThread,
    drainTeamSetupResumes,
    resolveAndSendTeamSetup,
    resolveAndSendRoutine,
    resolveAndSendProfile,
    resolveAndSendModel,
    undoAppliedChange,
    pendingTeamSetupResumes,
  };
}
