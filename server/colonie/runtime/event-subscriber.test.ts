// The runtime event bus subscriber is what turns provider events into stored
// messages, so the cheap paths are the ones worth guarding here: an event the
// bus ignores must touch nothing, and an event whose thread has no bot must
// stop after the public frame. Both are entry conditions, so they also prove the
// wiring object is read correctly before any real turn exists.
import { expect, test } from "vitest";
import { createRuntimeEventSubscriber } from "./event-subscriber.ts";

const deps = (over: Record<string, unknown> = {}) => {
  const broadcasted: unknown[] = [];
  const touched: string[] = [];
  const subscriber = createRuntimeEventSubscriber({
    shouldIgnoreProviderEvent: () => false,
    localVmThreadTargets: new Map(),
    localVmLeaseFor: () => ({ touch: (id: string) => touched.push("lease:" + id) }),
    localVmIdleFor: () => ({ touch: () => touched.push("idle") }),
    store: { botByThread: () => undefined },
    routines: () => undefined,
    broadcast: (frame: unknown) => broadcasted.push(frame),
    ...over,
  } as never);
  return { subscriber, broadcasted, touched };
};

test("an ignored event is not broadcast", () => {
  const { subscriber, broadcasted } = deps({ shouldIgnoreProviderEvent: () => true });
  subscriber({ type: "turn.started", threadId: "t1" } as never);
  expect(broadcasted).toEqual([]);
});

test("a thread without a bot stops after the public frame", () => {
  const { subscriber, broadcasted } = deps();
  subscriber({ type: "turn.started", threadId: "t1" } as never);
  expect(broadcasted).toHaveLength(1);
});

test("legacy Local VM tracking is ignored when a provider turn starts", () => {
  const targets = new Map([["t1", { key: "k1" }]]);
  const { subscriber, touched } = deps({ localVmThreadTargets: targets });
  subscriber({ type: "turn.started", threadId: "t1" } as never);
  expect(touched).toEqual([]);
});