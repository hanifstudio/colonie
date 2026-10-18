// The direct-message path decides when a held line becomes a turn, so the
// cases here pin the three cheap decisions it makes before any provider runs:
// the queue-vs-start branch, the drain's readiness gate, and the late-answer
// refusals (a retired room, an unknown conversation).
import { expect, test } from "vitest";
import { createDirectFlow } from "./direct-flow.ts";

const deps = (over: Record<string, unknown> = {}) => {
  const started: any[] = [];
  const flow = createDirectFlow({
    botAtThreadCapacity: () => false,
    cfg: {},
    followupsReady: () => true,
    messageSender: () => ({ kind: "person" }),
    queuedTurnTrigger: () => undefined,
    runningTurnInstance: () => undefined,
    sendSequencer: { run: async (_key: string, _fingerprint: unknown, fn: () => unknown) => fn() },
    startTurn: () => (...args: any[]) => {
      started.push(args);
      return Promise.resolve({ id: "m1" });
    },
    store: {
      appendMessage: () => {},
      bot: () => undefined,
      groupByThread: () => undefined,
      messagesFor: () => [],
      patchMessage: () => {},
      projectBotForTask: () => undefined,
      taskByThread: () => ({ threadId: "t1" }),
    },
    threadBusy: () => false,
    usageTriggerFor: () => undefined,
    ...over,
  });
  return { flow, started };
};

test("a full thread queues the person's words instead of starting", async () => {
  const { flow, started } = deps({ botAtThreadCapacity: () => true });
  const result: any = await flow.startOrQueueDirectMessage("b1", "t-queue", "hello");
  expect(result.ok).toBe(true);
  expect(result.queued).toBe(true);
  expect(result.threadId).toBe("t-queue");
  expect(result.reason).toBe("capacity");
  expect(result.queueId).toEqual(expect.any(String));
  expect(started).toEqual([]);
});

test("an idle thread starts the turn directly", async () => {
  const { flow, started } = deps();
  const result: any = await flow.startOrQueueDirectMessage("b2", "t-idle", "hi");
  expect(result).toEqual({ ok: true, threadId: "t-idle", message: { id: "m1" } });
  expect(started).toHaveLength(1);
  expect(started[0]![0]).toBe("b2");
});

test("the drain is a no-op until follow-ups are ready", () => {
  const { flow, started } = deps({ followupsReady: () => false });
  flow.drainQueuedSends();
  expect(started).toEqual([]);
});

test("a late answer refuses a retired room", async () => {
  const { flow } = deps({ store: {
    groupByThread: () => ({ id: "g1" }),
    taskByThread: () => ({ threadId: "t1" }),
  } });
  await expect(flow.deliverLateQuestionAnswer({} as never, "t1", "r1", "yes", { id: "c1" } as never, { id: "b1" } as never))
    .rejects.toMatchObject({ status: 409 });
});

test("a late answer refuses a conversation that no longer exists", async () => {
  const { flow } = deps({ store: {
    groupByThread: () => undefined,
    taskByThread: () => undefined,
  } });
  await expect(flow.deliverLateQuestionAnswer({} as never, "gone", "r1", "yes", { id: "c1" } as never, { id: "b1" } as never))
    .rejects.toMatchObject({ status: 409 });
});
