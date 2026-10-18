// The person's direct-message path: the queued-send drain (which starts each waiting group and then runs the aside lane), the aside lane's boundary pass, and the two entry points that reuse it — start-or-queue for a new direct message, and a late answer to a mid-turn question. Queued words stay off the transcript until a slot frees, so this cluster is everything that decides when a held line becomes a turn.
import { type UsageTrigger } from "../../colonie/providers/usage-ledger.ts";
import { type SteerOutcome } from "../../contracts.ts";
import { type ResolvedSender } from "../../../shared/wire.ts";
import { type BotRecord, type Message } from "../../persistence/store.ts";
import { failedTurnTool } from "../../../shared/failed-turn.ts";
import { admit } from "../../admission.ts";
import { drainAsideMessages } from "../../colonie/chat/aside-queue.ts";
import { drainSteeredMessages, queueSteeredMessage, queuedSteeredMessage } from "../../colonie/chat/steer-queue.ts";
import { DATA_DIR } from "../../config.ts";
import { promptWithReply } from "../../replies.ts";
import { type RequestAuth } from "../../request-auth.ts";
import { acceptedSendMatch, sendFingerprint } from "../../send-idempotency.ts";
import { assertWithinBudget } from "../../spend.ts";
import { createHash } from "node:crypto";

/** Everything this cluster reaches in the server; see the header. */
export interface DirectFlowDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createDirectFlow(deps: DirectFlowDeps) {
  const {
    botAtThreadCapacity, cfg, followupsReady, queuedTurnTrigger, runningTurnInstance, startTurn,
    store, threadBusy, messageSender, sendSequencer, usageTriggerFor
  } = deps;

function drainQueuedSends() {
  if (!followupsReady()) return;
  drainSteeredMessages(store, (botId, threadId, prompt, userMessage, excludeIds, unattended, head) =>
    // A plain attended turn — no automationSource, no comms depth: exactly
    // what typing the same words into an idle bot would run. Self-opened
    // work retains `unattended` and the message's bot-origin provenance
    // through the wait for a slot.
    // Drain just appended the held lines; userMessage keeps startTurn
    // from duplicating the last one, and excludeIds drops every drained
    // line from the transcript-replay so they are not also in `prompt`.
    new Promise<void>((resolve, reject) => {
      // The drained turn is booked to whoever sent the first waiting line.
      void startTurn()(botId, prompt, {
        threadId, userMessage, excludeMessageIds: excludeIds, unattended, onTurnSettled: resolve,
        trigger: queuedTurnTrigger(head),
      }).catch((err: any) => {
        store.appendMessage(threadId, {
          role: "bot", kind: "activity",
          tool: failedTurnTool(`queued message could not start — ${err instanceof Error ? err.message : String(err)}`),
        });
        resolve();
        // M2: only this group left the queue, and a turn that never
        // started publishes no completion to wake the groups behind it.
        queueMicrotask(drainQueuedSends);
      }).catch(reject);
    }),
    // Provider completion can precede its dispatch promise: keep the queue
    // intact until that exact handshake releases its runtime-only claim.
    (botId, threadId) => threadBusy(botId, threadId) || botAtThreadCapacity(botId)
  );
  // Asides always drain after person follow-ups (see drainAsideLane): the
  // steer drain above can make a thread busy again, deferring its asides
  // to the next boundary. Every path that clears a thread's send queue
  // reaches this point, so the aside lane drains on all of them — not
  // just turn.completed.
  drainAsideLane();
}

/** The aside lane's boundary pass. Invoked at the end of drainQueuedSends, i.e. AFTER the steer drain on purpose:
 * a thread with both waiting starts its person follow-up first, and that
 * turn makes the thread busy again, so its asides defer to the next
 * boundary — the person's correction always lands ahead of peer context.
 * A thread already running a seam-capable turn gets its asides folded in
 * mid-turn instead (one batched call); an idle thread degrades them to a
 * single enveloped follow-up turn, exactly the shape the steer-queue
 * gives queued person messages. */
function drainAsideLane() {
  if (!followupsReady()) return;
  void drainAsideMessages({
    store,
    inject: async (botId, threadId, prompt) => {
      const bot = store.projectBotForTask(botId, threadId) ?? store.bot(botId);
      if (!bot?.busy) return "refused";
      const instance = runningTurnInstance(bot, threadId);
      if (!instance?.adapter.capabilities.queueing || !instance.adapter.steer) return "refused";
      return instance.adapter.steer(threadId, prompt).catch((): SteerOutcome => "indeterminate");
    },
    run: (botId, threadId, prompt, userMessage, excludeIds, head) =>
      new Promise<void>((resolve, reject) => {
        void startTurn()(botId, prompt, {
          threadId,
          userMessage,
          excludeMessageIds: excludeIds,
          commsDepth: head.aside.commsDepth + 1,
          unattended: head.aside.unattended === true,
          peerAsk: {
            botId: head.aside.fromBotId,
            name: head.aside.fromBotName,
            ...(head.aside.unattended ? { unattended: true } : {}),
          },
          onTurnSettled: resolve,
        }).catch((err: any) => {
          store.appendMessage(threadId, {
            role: "bot", kind: "activity",
            tool: failedTurnTool(`queued aside could not start — ${err instanceof Error ? err.message : String(err)}`),
          });
          resolve();
        }).catch(reject);
      }),
    isBlocked: (botId, threadId) => threadBusy(botId, threadId) || botAtThreadCapacity(botId)
  }).catch((error) => console.warn("aside-queue: drain failed", error));
}

/** Keep a person's words off the transcript until a direct-thread slot is
 * available. Reuse the existing cancellable, idempotent composer queue. */
async function startOrQueueDirectMessage(botId: string, threadId: string, text: string, replyTo?: Message, sendId?: string, sender?: ResolvedSender, trigger?: UsageTrigger, via?: "call") {
  const decision = admit("direct", {}, {
    // A room turn holds the bot exactly like the sibling opened-thread queue
    // below: the drain's own block check waits it out, so the words queue
    // here rather than bounce off startTurn's 409.
    atCapacity: botAtThreadCapacity(botId),
    threadBusy: threadBusy(botId, threadId),
  });
  if (decision.action === "queue") {
    const queued = queueSteeredMessage(botId, threadId, text, {
      replyToId: replyTo?.id,
      sendId,
      reason: decision.reason,
      prompt: promptWithReply(text, replyTo, cfg.profile?.name?.trim() || "User"),
      sender,
      trigger,
      via,
    });
    return { ok: true as const, queued: true as const, queueId: queued.id, threadId, reason: decision.reason };
  }
  const message = await startTurn()(botId, text, { threadId, replyTo, sendId, sender, trigger, via });
  return { ok: true as const, threadId, message };
}

/** A provider can finish its run before the owner answers. Persist that answer
 * as a normal reply and run/queue it against the original conversation. */
async function deliverLateQuestionAnswer(
  auth: RequestAuth,
  threadId: string,
  requestId: string,
  answer: string,
  cardMessage: Message,
  owner: BotRecord,
  via?: "call",
): Promise<{ queued: boolean }> {
  // Rooms are retired; a question asked in one can no longer be answered there.
  if (store.groupByThread(threadId)) {
    throw Object.assign(new Error("The transparent ACP connection supports direct conversations; room orchestration is not enabled."), { status: 409 });
  }
  if (!store.taskByThread(owner.id, threadId)) {
    throw Object.assign(new Error("the question's conversation no longer exists"), { status: 409 });
  }

  const text = answer;
  const sendId = `late-question-${createHash("sha256").update(`${threadId}:${requestId}`).digest("hex").slice(0, 32)}`;
  const key = `bot:${owner.id}:${threadId}:${sendId}`;
  const receipt = await sendSequencer.run(key, sendFingerprint(text, cardMessage.id), async () => {
    const accepted = acceptedSendMatch(store.messagesFor(threadId), sendId, text, cardMessage.id);
    if (accepted.kind === "conflict") throw Object.assign(new Error("this question already has a different recorded answer"), { status: 409 });
    if (accepted.kind === "match") return { queued: false };

    const queuedDirect = queuedSteeredMessage(owner.id, threadId, sendId);
    if (queuedDirect) {
      if (queuedDirect.text !== text || queuedDirect.replyToId !== cardMessage.id) {
        throw Object.assign(new Error("this question already has a different queued answer"), { status: 409 });
      }
      return { queued: true };
    }

    const latestCard = store.messagesFor(threadId).find((message: any) => message.id === cardMessage.id)?.card;
    if (!latestCard || latestCard.answered || latestCard.dismissed) {
      throw Object.assign(new Error("this question has already been answered"), { status: 409 });
    }
    assertWithinBudget(cfg, DATA_DIR);
    const sender = messageSender(auth);
    const trigger = usageTriggerFor(auth);
    const direct = await startOrQueueDirectMessage(owner.id, threadId, text, cardMessage, sendId, sender, trigger, via);
    return { queued: "queued" in direct && Boolean(direct.queued) };
  });

  const latest = store.messagesFor(threadId).find((message: any) => message.id === cardMessage.id)?.card;
  if (latest && !latest.answered && !latest.dismissed) {
    store.patchMessage(threadId, cardMessage.id, { card: { ...latest, answered: "answer", answeredText: answer, dismissed: false } });
  }
  return receipt;
}

  return {
    deliverLateQuestionAnswer,
    drainQueuedSends,
    startOrQueueDirectMessage,
  };
}
