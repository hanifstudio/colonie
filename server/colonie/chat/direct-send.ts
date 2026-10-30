// Accepting a message a person aimed straight at one bot: the one path that
// decides whether the turn starts now, waits in the thread's queue, or is
// refused outright. It is shared by the HTTP send routes and by the desktop and
// connector callers, so the ordering rules — claim the send id first, never
// steer under a stale permission, hold the queue rather than lose the words —
// live here instead of in each caller.
import { admit } from "../../admission.ts";
import { acceptedSendMatch, sendFingerprint } from "../../send-idempotency.ts";
import { DATA_DIR, type AppConfig } from "../../config.ts";
import type { SteerOutcome } from "../../contracts.ts";
import type { Handoffs } from "./delta-context.ts";
import { cancelledChatFollowup } from "../../persistence/message-db.ts";
import type { BotRecord, Message, Store } from "../../persistence/store.ts";
import type { ResolvedSender, SteerQueueReason } from "../../../shared/wire.ts";
import { assertWithinBudget } from "../../spend.ts";
import type { UsageTrigger } from "../providers/usage-ledger.ts";
import { promptWithReply } from "../../replies.ts";
import { queueSteeredMessage, queuedSteeredMessage } from "./steer-queue.ts";
import { extractTurnImages } from "./turn-images.ts";

/** Helpers whose own signatures are wide; the module only forwards to them. */
type Helper = (...args: any[]) => any;

export interface DirectSendDeps {
  store: Store;
  cfg: AppConfig;
  handoffs: Pick<Handoffs, "current" | "steered">;
  /** Threads whose computer the person chose by hand, not by default. */
  computerSelectionTurns?: Map<string, any>;
  sendSequencer: { run: Helper };
  startOrQueueDirectMessage: Helper;
  clearUnattended: (threadId: string) => void;
  runningTurnInstance: (bot: BotRecord | null | undefined, threadId: string) => any;
}

/** What a person's direct message became: a line in the transcript (a new
 * turn, or words steered into the running one), or a place in the queue. */
export type DirectSendReceipt =
  | { ok: true; threadId: string; message: Message; steered?: true }
  | { ok: true; queued: true; queueId: string; threadId: string; reason?: SteerQueueReason };

/** Refusal from acceptDirectSend: the route turns it into its HTTP answer. */
export class DirectSendRefused extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : "send refused");
    this.status = status;
    this.body = body;
  }
}

export function createDirectSend(deps: DirectSendDeps) {
  const {
    store, cfg, handoffs, sendSequencer, startOrQueueDirectMessage,
    clearUnattended, runningTurnInstance,
  } = deps;
/** The refusals a direct send meets before it is sequenced, or null. */
function directSendRefusal(botId: string, threadId: string): DirectSendRefused | null {
  // The send is acknowledged before the turn starts, so a workspace at its
  // spend limit is refused here, where the person can see it.
  try {
    assertWithinBudget(cfg, DATA_DIR);
  } catch (error) {
    return new DirectSendRefused(409, { error: error instanceof Error ? error.message : String(error), code: "spend_cap" });
  }
  if (!store.taskByThread(botId, threadId)) {
    return new DirectSendRefused(409, { error: "the bot switched tasks before it could receive the message" });
  }
  return null;
}

/** The one path a person's direct message takes into a bot turn: spend cap,
 * idempotency, steer into a running turn, queue, or start. Used by
 * POST /api/bots/:id/messages and by Live calls (via "call").
 * `guardedStart` is POST /api/bots/:id/messages/guarded's own start, in
 * place of steer, queue or start: it checks its preconditions against the
 * task as it stands, then starts a turn or refuses. */
async function acceptDirectSend(
  input: {
    botId: string;
    threadId: string;
    text: string;
    sendId?: string;
    replyTo?: Message;
    sender?: ResolvedSender;
    trigger: UsageTrigger;
    via?: "call";
    /** A person is proven present (a paired session, or the desktop's owner
     * capability): steering their words in clears the unattended mark. */
    personPresent: boolean;
  },
  guardedStart?: (currentAtStart: BotRecord) => Promise<DirectSendReceipt>,
): Promise<DirectSendReceipt> {
  const { botId, threadId, text, sendId, replyTo, sender, trigger, via, personPresent } = input;
  const refused = directSendRefusal(botId, threadId);
  if (refused) throw refused;
  return sendSequencer.run(
    sendId ? `bot:${botId}:${threadId}:${sendId}` : undefined,
    sendFingerprint(text, replyTo?.id),
    async (): Promise<DirectSendReceipt> => {
      if (sendId) {
        if (cancelledChatFollowup("bot", botId, threadId, sendId)) {
          throw Object.assign(new Error("this queued sendId was cancelled; send a new message to try again"), { status: 409 });
        }
        const accepted = acceptedSendMatch(store.messagesFor(threadId), sendId, text, replyTo?.id);
        if (accepted.kind === "conflict") {
          throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
        }
        if (accepted.kind === "match") {
          const canonical = {
            ok: true as const,
            threadId,
            message: accepted.message,
          };
          return accepted.message.steered
            ? { ...canonical, steered: true as const }
            : canonical;
        }
        const queued = queuedSteeredMessage(botId, threadId, sendId);
        if (queued) {
          if (queued.text !== text || queued.replyToId !== replyTo?.id) {
            throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
          }
          return { ok: true as const, queued: true as const, queueId: queued.id, threadId, reason: queued.reason };
        }
      }

      const currentAtStart = store.projectBotForTask(botId, threadId);
      if (!currentAtStart) throw Object.assign(new Error("no such bot"), { status: 404 });
      if (store.taskByThread(botId, threadId)?.forConversation) throw Object.assign(new Error("Send this message in the group, not in the bot's personal chat."), { status: 409 });
      if (!store.taskByThread(currentAtStart.id, threadId)) {
        throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
      }

      if (guardedStart) return guardedStart(currentAtStart);

      // Claude can accept the message inside its live turn. If the write
      // loses a race with turn settlement, or the engine cannot steer, the
      // existing server-side queue records it atomically for the next turn.
      if (currentAtStart.busy) {
        const instance = runningTurnInstance(currentAtStart, threadId);
        let steered: SteerOutcome = "refused";
        // A live text steer has no image side channel. Keep an attachment
        // message intact for the next ordinary turn, where central image
        // admission can hand it to the provider natively.
        const carriesImages = extractTurnImages(text).images.length > 0;
        const steerTarget = handoffs.current(threadId);
        const busyAdmission = admit("direct-busy", {
          carriesImages,
          pendingComputerSelection: false,
          engineCanSteer: Boolean(instance?.adapter.capabilities.queueing && instance.adapter.steer),
        });
        // steer was offered only when a live instance could take it;
        // the second check carries that fact to the type system.
        if (busyAdmission.action === "steer" && instance?.adapter.steer) {
          steered = await instance.adapter
            .steer(threadId, promptWithReply(text, replyTo, cfg.profile?.name?.trim() || "User"))
            .catch((): SteerOutcome => "indeterminate");
        }
        // steer() is awaited adapter work. The turn can settle, the task can
        // switch, or the whole bot can be deleted before its acknowledgement
        // arrives. Re-read every ownership invariant before appending even a
        // successful steer; otherwise that late acknowledgement writes a user
        // message into a task the bot no longer owns. A conflict leaves the
        // text in the client's composer/outbox to resend deliberately.
        const current = store.projectBotForTask(botId, threadId);
        if (!current) throw Object.assign(new Error("no such bot"), { status: 404 });
        if (!store.taskByThread(botId, threadId)) {
          throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
        }
        const delivered = steered !== "refused";
        if (delivered) {
          if (steered === "steered" && !current.busy) {
            throw Object.assign(
              new Error("the running turn ended before the steered message could be recorded"),
              { status: 409 },
            );
          }
          // "indeterminate" falls through to the same record: the words
          // may already be folded into a turn whose acknowledgement was
          // lost, and handing them back for a resend could run them
          // twice. Recording them once is the honest outcome.
          // A person steering a webhook turn is present, and auto mode may
          // follow them again; words that do not prove a person never lift it.
          if (personPresent) clearUnattended(threadId);
          const message = store.appendMessage(threadId, {
            role: "user",
            kind: "text",
            text,
            replyToId: replyTo?.id,
            sendId,
            steered: true,
            sender,
            ...(via ? { via } : {}),
          });
          // Offered to the next turn again unless the person stops this one.
          handoffs.steered(threadId, steerTarget, instance?.instanceId, message.id);
          return { ok: true as const, steered: true as const, threadId, message };
        }
        if (!current.busy) {
          return startOrQueueDirectMessage(botId, threadId, text, replyTo, sendId, sender, trigger, via);
        }
        const queued = queueSteeredMessage(current.id, threadId, text, {
          replyToId: replyTo?.id,
          sendId,
          prompt: promptWithReply(text, replyTo, cfg.profile?.name?.trim() || "User"),
          sender,
          trigger,
          via,
        });
        return { ok: true as const, queued: true as const, queueId: queued.id, threadId };
      }
      return startOrQueueDirectMessage(botId, threadId, text, replyTo, sendId, sender, trigger, via);
    },
  );
}
  return { directSendRefusal, acceptDirectSend };
}
