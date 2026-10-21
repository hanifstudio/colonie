// Steering: pressing Steer folds the words already queued for a bot into the
// turn that is running now, so they land in the middle of its work instead of
// starting a second one. A turn that cannot take them hands the queue straight
// back, and anything with a picture in it is never steered — a queued message
// keeps its images only as a message.
import { extractTurnImages } from "../colonie/chat/turn-images.ts";
import { holdSteeredQueue, restoreHeldSteeredQueue, settleHeldSteeredQueue } from "../colonie/chat/steer-queue.ts";
import type { SteerOutcome } from "../contracts.ts";
import type { Handoffs } from "../colonie/chat/delta-context.ts";
import type { BotRecord, Store } from "../persistence/store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { pinnedClientThread } from "./pinned-client.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface QueueSteerRouteDeps {
  store: Store;
  desktopManaged: boolean;
  handoffs: Pick<Handoffs, "current" | "steered">;
  requestedTaskBot: (botId: string, rawThreadId: unknown, auth: RequestAuth) => BotRecord;
  /** The live provider turn for a thread, when there is one. */
  runningTurnInstance: (bot: BotRecord | null | undefined, threadId: string) => any;
  clearUnattended: (threadId: string) => void;
  drainQueuedSends: () => void;
  /** Whether this is a Shared workspace, where the pin rule does not apply. */
  shared?: () => boolean;
}

export function createQueueSteerRoutes(deps: QueueSteerRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const { store, handoffs, requestedTaskBot, runningTurnInstance, clearUnattended, drainQueuedSends } = deps;
    const DESKTOP_MANAGED = deps.desktopManaged;
    const requirePinnedClientThread = pinnedClientThread({ auth, store, shared: deps.shared });
    let m: RegExpMatchArray | null = null;
    m = path.match(/^\/api\/bots\/([\w-]+)\/queue\/([\w-]+)\/steer$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body?.threadId, auth);
      // Pressing Steer folds the queued words into the running turn. It does
      // not re-book that turn to whoever pressed it, and the words keep the
      // sender they were queued with.
      // Lift the whole queue atomically: a settle racing this request can
      // drain it as a follow-up, or this request can steer it into the live
      // turn — never both for the same words.
      const held = holdSteeredQueue(bot.id, bot.threadId, m[2]);
      if (!held) return json(res, 404, { error: "no such queued message" });
      // A live steer has no image side channel. Attachment words wait for a
      // real turn where central admission can hand the images to the engine.
      if (held.items.some((item) => extractTurnImages(item.text).images.length > 0)) {
        restoreHeldSteeredQueue(held);
        return json(res, 200, { ok: true, queued: true, threadId: bot.threadId });
      }
      const currentAtStart = store.projectBotForTask(bot.id, bot.threadId);
      const instance = currentAtStart?.busy ? runningTurnInstance(currentAtStart, bot.threadId) : undefined;
      const prompt = held.items.map((item) => item.prompt).join("\n\n");
      const steerTarget = handoffs.current(bot.threadId);
      let steered: SteerOutcome = "refused";
      if (currentAtStart?.busy && instance?.adapter.capabilities.queueing && instance.adapter.steer) {
        steered = await instance.adapter
          .steer(bot.threadId, prompt)
          .catch((): SteerOutcome => "indeterminate");
      }
      // The steer was awaited adapter work: re-read every ownership
      // invariant before writing anything, exactly like the live-send path.
      const current = store.projectBotForTask(bot.id, bot.threadId);
      // "indeterminate" never restores: the words may already be folded into
      // the turn that was live when they were sent, and replaying them into
      // a fresh follow-up turn would run them twice. Record them whenever
      // the destination still exists, busy or not.
      if (
        (steered === "steered" && current?.busy ||
          steered === "indeterminate" && current) &&
        store.taskByThread(bot.id, bot.threadId)
      ) {
        if (auth.kind === "session" || DESKTOP_MANAGED) clearUnattended(bot.threadId);
        const messages = held.items.map((item) => store.appendMessage(bot.threadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          sendId: item.sendId,
          queueId: item.messageId,
          peerAsk: item.peerAsk,
          steered: true,
          sender: item.sender,
          ...(item.via ? { via: item.via } : {}),
        }));
        // Offered to the next turn again unless the person stops this one.
        for (const message of messages) handoffs.steered(bot.threadId, steerTarget, instance?.instanceId, message.id);
        const queueIds = held.items.map((item) => item.messageId);
        settleHeldSteeredQueue(held);
        return json(res, 200, { ok: true, steered: true, threadId: bot.threadId, messages, queueIds });
      }
      if (steered === "indeterminate") {
        // No destination is left: settle so a restart cannot replay words a
        // dead turn may already have run.
        settleHeldSteeredQueue(held);
        if (!store.taskByThread(bot.id, bot.threadId)) {
          throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
        }
        throw Object.assign(new Error("no such bot"), { status: 404 });
      }
      restoreHeldSteeredQueue(held);
      // The turn may have settled while the steer was refused; a queue that
      // is now drainable must not strand behind a missed settle.
      if (current && !current.busy) drainQueuedSends();
      return json(res, 200, { ok: true, queued: true, threadId: bot.threadId });
    }
    return PASS;
  };
}
