// The webhook manager's wiring: a run delivery joins the RoutineManager queue,
// a post delivery lands in a dedicated "Updates" thread resolved once and
// reused, and a post for a bot that no longer exists writes nothing.
import { expect, test, vi } from "vitest";
import { createWebhookManager } from "./webhook-wiring.ts";

function build(options: { botExists?: boolean; botState?: "ready" | "missing" } = {}) {
  const appendMessage = vi.fn();
  const createTask = vi.fn(() => ({ threadId: "t-updates" }));
  const enqueueWebhook = vi.fn(() => ({ id: "run1" }));
  const manager = createWebhookManager({
    botState: () => options.botState ?? "ready",
    emit: () => {},
    routines: () => ({
      enqueueWebhook,
      webhookRunReceipt: () => null,
      cancelQueuedWebhook: () => {},
      activeWebhookRunCount: () => 0,
    }),
    store: {
      bot: () => (options.botExists === false ? undefined : { id: "b1" }),
      appendMessage,
      createTask,
    },
  } as never);
  return { manager, appendMessage, createTask, enqueueWebhook };
}

test("a post delivery lands in the resolved Updates thread", () => {
  const h = build();
  const created = h.manager.create({ name: "Alert", prompt: "ignore", botId: "b1", delivery: "post" });
  h.manager.test(created.webhook.id, { text: "build failed" });
  expect(h.createTask).toHaveBeenCalledWith("b1", "Updates", false);
  expect(h.appendMessage).toHaveBeenCalledWith("t-updates", expect.objectContaining({
    role: "bot", kind: "text", text: "build failed", webhookPost: true,
  }));
});

test("the post destination is resolved once and reused", () => {
  const h = build();
  const created = h.manager.create({ name: "Alert", prompt: "ignore", botId: "b1", delivery: "post" });
  h.manager.test(created.webhook.id, { text: "one" });
  h.manager.test(created.webhook.id, { text: "two" });
  // The second delivery reuses the stored resultsThreadId.
  expect(h.createTask).toHaveBeenCalledTimes(1);
  expect(h.appendMessage).toHaveBeenCalledTimes(2);
});

test("a run delivery joins the routine queue", () => {
  const h = build();
  const created = h.manager.create({ name: "Nightly", prompt: "brief", botId: "b1" });
  h.manager.test(created.webhook.id, { message: "go" });
  expect(h.enqueueWebhook).toHaveBeenCalledWith(expect.objectContaining({ botId: "b1", webhookName: "Nightly" }));
  expect(h.appendMessage).not.toHaveBeenCalled();
});

test("a post for a bot that no longer exists writes nothing", () => {
  const h = build({ botExists: false });
  const created = h.manager.create({ name: "Alert", prompt: "ignore", botId: "b1", delivery: "post" });
  h.manager.test(created.webhook.id, { text: "build failed" });
  expect(h.appendMessage).not.toHaveBeenCalled();
});

test("a webhook cannot be created for a missing MAUS", () => {
  const h = build({ botState: "missing" });
  expect(() => h.manager.create({ name: "Alert", prompt: "ignore", botId: "b1" })).toThrow();
});
