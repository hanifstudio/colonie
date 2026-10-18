// The webhook manager this installation serves. Definitions are independent
// from calendar schedules, but every delivery joins the same RoutineManager
// queue, so unattended work stays ordered behind a busy MAUS and webhook runs
// get the same durable receipts. A delivery:"post" webhook lands in a dedicated
// "Updates" task, never the bot's currently-selected thread.
import type { Store } from "../../persistence/store.ts";
import { WebhookManager } from "./webhooks.ts";

export interface WebhookWiringDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // the store is typed because the messages it appends must stay messages.
  [name: string]: any;
  store: Store;
}

export function createWebhookManager(deps: WebhookWiringDeps) {
  const { botState, emit, routines, store } = deps;
  return new WebhookManager({
    emit,
    botState,
    enqueue: (input) => routines()!.enqueueWebhook(input),
    findRun: (webhookId, deliveryId) => routines()!.webhookRunReceipt(webhookId, deliveryId),
    cancelQueued: (webhookId, message) => routines()!.cancelQueuedWebhook(webhookId, message),
    pendingRuns: (webhookId) => routines()!.activeWebhookRunCount(webhookId),
    // delivery:"post" webhooks land in a dedicated "Updates" task, never
    // bot.threadId (the bot's currently-selected task) -- see
    // resolvePostThread below. Fixes
    // https://github.com/hanifstudio/colonie/issues/2071: a post used to
    // land wherever the owner (or another automation) had last switched
    // that bot's selection, including a live conversation.
    post: (botId, threadId, text) => {
      if (!store.bot(botId)) return;
      store.appendMessage(threadId, { role: "bot", kind: "text", text, webhookPost: true });
    },
    // Create-on-first-use, never activated (so it never steals the bot's
    // live selection the way POST /api/bots/:id/tasks does), reused forever
    // after via trigger.resultsThreadId.
    resolvePostThread: (trigger, forceNew) => {
      if (!forceNew && trigger.resultsThreadId) return trigger.resultsThreadId;
      return store.createTask(trigger.botId, "Updates", false)?.threadId;
    },
  });
}
