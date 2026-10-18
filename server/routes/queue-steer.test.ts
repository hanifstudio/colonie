// Steering folds words that are already queued into the turn running now. The
// queue itself is real here (the module imports it), so these tests use it the
// way the app does — with a thread of their own each, because the queue is
// per-thread — and check the two ways this can go wrong: words that were never
// there, and words that must go back to the queue untouched.
import { expect, test } from "vitest";
import { queueSteeredMessage } from "../colonie/chat/steer-queue.ts";
import { callRoute } from "../testing/route-context.ts";
import { PASS } from "./table.ts";
import { createQueueSteerRoutes, type QueueSteerRouteDeps } from "./queue-steer.ts";

let threads = 0;
const freshThread = () => `steer-test-${++threads}`;

const deps = (thread: string, over: Partial<Record<string, unknown>> = {}) => {
  const calls = { drain: 0, steered: 0, appended: 0 };
  const task = { id: thread, threadId: thread, busy: false, modelSelection: { instanceId: "codex-acp", model: "gpt" } };
  const fake = {
    store: {
      projectBotForTask: () => ({ ...task, busy: over.busy === true }),
      taskByThread: () => task,
      appendMessage: () => {
        calls.appended += 1;
        return { id: "m-appended" };
      },
    },
    desktopManaged: false,
    handoffs: { current: () => ({ kind: "none" }), steered: () => { calls.steered += 1; } },
    requestedTaskBot: (botId: string) => ({ id: botId, threadId: thread, modelSelection: { instanceId: "codex-acp", model: "gpt" } }),
    runningTurnInstance: () => ({
      instanceId: "i1",
      adapter: { capabilities: { queueing: true }, steer: async () => (over.steer as string) ?? "steered" },
    }),
    clearUnattended: () => {},
    drainQueuedSends: () => { calls.drain += 1; },
  } as unknown as QueueSteerRouteDeps;
  return { deps: fake, calls };
};

const call = async (handler: ReturnType<typeof createQueueSteerRoutes>, path: string, body: unknown) => {
  const { ctx, sent } = callRoute(path, "POST", body);
  return { out: await handler(ctx), sent };
};

const steer = (thread: string, queueId: string) => call(
  createQueueSteerRoutes(deps(thread).deps),
  `/api/bots/b1/queue/${queueId}/steer`,
  { threadId: thread },
);

test("another route, or another verb, is left to the next handler", async () => {
  const thread = freshThread();
  const handler = createQueueSteerRoutes(deps(thread).deps);
  const { ctx: healthCtx } = callRoute("/api/health", "POST", {});
  const elsewhere = await handler(healthCtx);
  const { ctx, sent } = callRoute(`/api/bots/b1/queue/q1/steer`, "GET", {});
  const wrongVerb = await handler(ctx);

  expect(elsewhere).toBe(PASS);
  expect(wrongVerb).toBe(PASS);
  expect(sent).toEqual([]);
});

test("a queued message that is not there is a 404", async () => {
  const thread = freshThread();
  const { deps: fake, calls } = deps(thread);
  const { sent } = await call(createQueueSteerRoutes(fake), `/api/bots/b1/queue/nope/steer`, { threadId: thread });

  expect(sent).toEqual([{ status: 404, body: { error: "no such queued message" } }]);
  expect(calls.drain).toBe(0);
  expect(calls.steered).toBe(0);
});

test("words that cannot be steered go back to the queue", async () => {
  const thread = freshThread();
  const queued = queueSteeredMessage("b1", thread, "halo");
  const { calls } = deps(thread);
  const { sent } = await steer(thread, queued.id);

  expect(sent).toEqual([{ status: 200, body: { ok: true, queued: true, threadId: thread } }]);
  expect(calls.steered).toBe(0);

  // They are queued again: the next press of Steer finds them.
  const again = await steer(thread, queued.id);
  expect(again.sent[0]?.body).toMatchObject({ queued: true });
});

test("words folded into a live turn are booked as steered", async () => {
  const thread = freshThread();
  const queued = queueSteeredMessage("b1", thread, "halo");
  const { deps: fake, calls } = deps(thread, { busy: true });
  const { sent } = await call(createQueueSteerRoutes(fake), `/api/bots/b1/queue/${queued.id}/steer`, { threadId: thread });

  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toMatchObject({ ok: true, steered: true, threadId: thread, queueIds: [queued.id] });
  expect(calls.appended).toBe(1);
  expect(calls.steered).toBe(1);
});