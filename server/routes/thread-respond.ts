// Answering the question a running thread is waiting on: allow it, always
// allow it, deny it, or answer with words. The same shape serves approvals,
// persistent question cards and peer requests, so the refusals live in one
// place each and this module only routes the intent to them.
import { isPersistentQuestionCard, QUESTION_DISMISS_MESSAGE } from "../../shared/ask-question.ts";
import { resolvePeerComms, type ApprovalBus } from "../colonie/peers/peer-approval.ts";
import type { BotRecord, Store } from "../persistence/store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Helpers whose own signatures are wide; the module only forwards to them. */
type Helper = (...args: any[]) => any;

export interface ThreadRespondRouteDeps {
  store: Store;
  desktopManaged: boolean;
  approvalBus: ApprovalBus;
  botForThread: (botId: string, threadId: string) => BotRecord | null;
  answerRequest: Helper;
  answeringCardAs: Helper;
  cardAnswerRefusal: (auth: RequestAuth, threadId: string, requestId: string, behavior: string) => string | null;
  commandRememberRefusal: (auth: RequestAuth, threadId: string, requestId: string, behavior: string) => string | null;
  requestBehavior: (value: unknown) => "allow" | "deny" | "answer" | null;
  deliverLateQuestionAnswer: Helper;
  resolveAndSendModel: Helper;
  resolveAndSendProfile: Helper;
  resolveAndSendRoutine: Helper;
  resolveAndSendTeamSetup: Helper;
  resolveAndSendTrust: Helper;
  resolveSkillRequest: Helper;
  sendSkillResolution: Helper;
}

export function createThreadRespondRoutes(deps: ThreadRespondRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const {
      store, approvalBus, botForThread, answerRequest, answeringCardAs, cardAnswerRefusal,
      commandRememberRefusal, requestBehavior, deliverLateQuestionAnswer, resolveAndSendModel,
      resolveAndSendProfile, resolveAndSendRoutine, resolveAndSendTeamSetup, resolveAndSendTrust,
      resolveSkillRequest, sendSkillResolution,
    } = deps;
    const DESKTOP_MANAGED = deps.desktopManaged;
    let m: RegExpMatchArray | null = null;
    m = path.match(/^\/api\/threads\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const threadId = m[1];
      const body = await readBody(req);
      const behavior = requestBehavior(body.behavior);
      const reviewedSha256 = typeof body.reviewedSha256 === "string" ? body.reviewedSha256 : undefined;
      if (!behavior) return json(res, 400, { error: "behavior must be allow, deny, or answer" });
      const requestId = String(body.requestId);
      const refusal = cardAnswerRefusal(auth, threadId, requestId, behavior);
      if (refusal) return json(res, 403, { error: refusal });
      if (body.rememberCommand === true) {
        const refusal = commandRememberRefusal(auth, threadId, requestId, behavior);
        if (refusal) return json(res, 403, { error: refusal });
      }
      return await answeringCardAs(auth, threadId, requestId, async () => {
        if (resolveAndSendTrust(res, threadId, requestId, behavior)) return;
        const skillCard = store.messagesFor(threadId).find(
          (message) => message.card?.requestId === requestId && message.card.skillRequest,
        );
        if (skillCard?.card?.skillRequest) {
          const skillBotId = skillCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!skillBotId) return json(res, 400, { error: "this skill request has no valid owner" });
          const skillOwner = store.bot(skillBotId);
          if (sendSkillResolution(res, resolveSkillRequest({
            botId: skillBotId,
            botName: skillOwner?.name,
            threadId,
            requestId,
            behavior,
            reviewedSha256,
          }))) return;
        }
        const routineCard = store.messagesFor(threadId).find(
          (message) => message.card?.requestId === requestId && message.card.routineRequest,
        );
        if (routineCard?.card?.routineRequest) {
          // Derive the owner from the conversation, not from the executable
          // payload being authorized. Room cards carry their trusted sender;
          // one-to-one tasks resolve through the store's thread ownership.
          const routineBotId = routineCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!routineBotId) return json(res, 400, { error: "this routine request has no valid owner" });
          const routineOwner = store.bot(routineBotId);
          if (resolveAndSendRoutine(res, {
            botId: routineBotId,
            botName: routineOwner?.name,
            threadId,
            requestId,
            behavior,
          })) return;
        }
        const setupCard = store.messagesFor(threadId).find((message) => message.card?.requestId === requestId && message.card.teamSetupRequest);
        if (setupCard) {
          const setupBotId = setupCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!setupBotId) return json(res, 400, { error: "This team setup has no valid owner" });
          if (await resolveAndSendTeamSetup(res, { botId: setupBotId, threadId, requestId, behavior },
            auth.kind === "loopback" ? DESKTOP_MANAGED || Boolean(req.headers.origin) && !store.bots.some((bot) => bot.busy) : auth.scopes.includes("admin"))) return;
        }
        const profileCard = store.messagesFor(threadId).find(
          (message) => message.card?.requestId === requestId && message.card.profileRequest,
        );
        if (profileCard?.card?.profileRequest) {
          const profileBotId = profileCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!profileBotId) return json(res, 400, { error: "this profile request has no valid owner" });
          const profileOwner = store.bot(profileBotId);
          if (resolveAndSendProfile(res, {
            botId: profileBotId,
            botName: profileOwner?.name,
            threadId,
            requestId,
            behavior,
          })) return;
        }
        const modelCard = store.messagesFor(threadId).find(
          (message) => message.card?.requestId === requestId && message.card.modelRequest,
        );
        if (modelCard?.card?.modelRequest) {
          const modelBotId = modelCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!modelBotId) return json(res, 400, { error: "this model request has no valid owner" });
          const modelOwner = store.bot(modelBotId);
          if (resolveAndSendModel(res, {
            botId: modelBotId,
            botName: modelOwner?.name,
            threadId,
            requestId,
            behavior,
          })) return;
        }
        // peer-approval intercept (see /api/bots/:id/respond above). A peer card
        // belongs to the bus rather than to a speaker, so resolve it before we go
        // looking for one — a room between turns has no speaker to find.
        if (store.messagesFor(threadId).some((message) => message.card?.requestId === requestId) &&
          resolvePeerComms(approvalBus, requestId, behavior)) {
          return json(res, 200, { ok: true, outcome: behavior === "allow" ? "allowed-once" : "rejected" });
        }
        const group = store.groupByThread(threadId);
        // No room turn runs, so a stored room card has no speaker behind it. Its
        // owner is the member that raised it; answer even when that member is
        // gone: answerRequest closes an unreachable card, and a pending approval
        // owns the composer, so a dead end here locks the room for good.
        const pending = store.messagesFor(threadId).find((message) => message.card?.requestId === requestId);
        if (isPersistentQuestionCard(pending?.card) && (body.dismiss === true || body.message === QUESTION_DISMISS_MESSAGE)) {
          if (!pending?.card) return json(res, 404, { error: "this question is no longer available" });
          if (pending.card.answered !== "answer" || pending.card.dismissed) {
            return json(res, 409, { error: "answer this question before dismissing it" });
          }
          store.patchMessage(threadId, pending.id, { card: { ...pending.card, dismissed: true } });
          return json(res, 200, { ok: true, dismissed: true });
        }
        const persistentQuestion = isPersistentQuestionCard(pending?.card);
        const owner = group
          ? (pending?.from ? store.bot(pending.from.botId) : undefined)
          : store.botByThread(threadId);
        // A surviving question belongs to its original asker, never a later speaker.
        if (group && persistentQuestion && !owner) {
          return json(res, 409, { error: "the bot that asked this question is no longer available" });
        }
        if (!owner && !pending) return json(res, 404, { error: "nothing is waiting on an answer in this conversation" });
        const requestOwner = owner ? botForThread(owner.id, threadId) : null;
        const outcome = await answerRequest(threadId, requestOwner?.modelSelection.instanceId ?? "", requestId, behavior, body.message, owner ? { id: owner.id, name: owner.name } : undefined, body.always === true, body.rememberCommand === true);
        if (outcome === "unavailable" && isPersistentQuestionCard(pending?.card) && behavior === "answer") {
          if (!pending?.card) return json(res, 404, { error: "this question is no longer available" });
          const answer = typeof body.message === "string" ? body.message.trim() : "";
          if (!answer) return json(res, 400, { error: "a question answer is required" });
          if (!owner) return json(res, 409, { error: "the bot that asked this question is no longer available" });
          try {
            const reply = await deliverLateQuestionAnswer(auth, threadId, requestId, answer, pending, owner);
            return json(res, 200, { ok: true, outcome: "answered", late: true, ...(reply.queued ? { queued: true } : {}) });
          } catch (error) {
            return json(res, 409, { error: error instanceof Error ? error.message : "the late answer could not be queued" });
          }
        }
        return json(res, 200, { ok: true, outcome });
      });
    }
    return PASS;
  };
}
