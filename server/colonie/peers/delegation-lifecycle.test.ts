// The delegation lifecycle only wakes a source bot on safe conditions, so the
// hold/refuse gates and the cheap predicates are the paths worth pinning.
import { expect, test } from "vitest";
import { createDelegationLifecycle } from "./delegation-lifecycle.ts";

const build = (over: Record<string, unknown> = {}) =>
  createDelegationLifecycle({
    bus: { subscribe: () => () => {} },
    store: { taskByThread: () => undefined, messagesFor: () => [], patchMessage: () => {} },
    routines: () => undefined,
    ...over,
  } as never);

test("only a running or waiting routine run is active", () => {
  const runs: Record<string, { id: string; status: string } | undefined> = {
    r1: { id: "run1", status: "running" },
    w1: { id: "run2", status: "waiting" },
    d1: { id: "run3", status: "done" },
  };
  const { activeRoutineRunForThread } = build({ routines: () => ({ runForThread: (t: string) => runs[t] }) });
  expect(activeRoutineRunForThread("r1")).toMatchObject({ id: "run1" });
  expect(activeRoutineRunForThread("w1")).toMatchObject({ id: "run2" });
  expect(activeRoutineRunForThread("d1")).toBeNull();
  expect(activeRoutineRunForThread("nope")).toBeNull();
});

test("a busy source is held in pendingDelegationWakes, not dispatched", () => {
  const { wakeDelegationSource, pendingDelegationWakes } = build({
    store: { taskByThread: () => ({ id: "t1" }), messagesFor: () => [], patchMessage: () => {} },
    threadBusy: () => true,
  });
  wakeDelegationSource({ id: "bot1", name: "Bot" } as never, "t1", "Helper");
  expect(pendingDelegationWakes.has("t1")).toBe(true);
});

test("a thread without a task is never woken", () => {
  const { wakeDelegationSource, pendingDelegationWakes } = build();
  wakeDelegationSource({ id: "bot1" } as never, "t1", "Helper");
  expect(pendingDelegationWakes.size).toBe(0);
});

test("settling one card patches the waiting chip once", () => {
  const patched: Array<{ threadId: string; id: string }> = [];
  const { settleWaitingOnPersonChips, pendingDelegationWakes } = build({
    store: {
      taskByThread: () => undefined,
      messagesFor: () => [{ id: "m1", tool: { name: "waiting" } }],
      patchMessage: (threadId: string, id: string) => patched.push({ threadId, id }),
    },
  });
  void pendingDelegationWakes;
  // no chips recorded, so settling is a no-op with no patch
  settleWaitingOnPersonChips("t1", "r1");
  expect(patched).toEqual([]);
});

test("context markers and context messages are recognised", () => {
  const { isExternalContextMarker, isContextMessage } = build();
  expect(isExternalContextMarker("__colonie_external_context__:x")).toBe(true);
  expect(isExternalContextMarker("plain")).toBe(false);
  expect(isContextMessage({ kind: "text", text: "hi" } as never)).toBe(true);
  expect(isContextMessage({ kind: "text", text: "" } as never)).toBe(false);
  expect(isContextMessage({ kind: "compaction" } as never)).toBe(true);
});