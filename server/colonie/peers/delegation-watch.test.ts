// Ending a delegation watch is what turns "the teammate is still working" into a
// terminal state, so the cheap ends are the ones worth guarding: a watch that is
// not there must end nothing, and the entry must be taken out exactly once.
import { expect, test } from "vitest";
import { createDelegationWatch, type DelegationWatchEntry } from "./delegation-watch.ts";

const deps = (entries: Array<[string, DelegationWatchEntry]> = []) => {
  const woken: string[] = [];
  const watch = createDelegationWatch({
    store: {
      bot: (id: string) => (id === "b-source" ? { id, name: "Source", color: "#000" } : undefined),
      botByThread: () => undefined,
      groupByThread: () => undefined,
      taskByThread: () => ({ id: "task1" }),
      appendMessage: () => ({ id: "m1" }),
    } as never,
    markTaskContextExternallyUpdated: () => {},
    wakeDelegationSource: (source) => { woken.push(source.id); },
  });
  for (const [threadId, entry] of entries) watch.delegationWatch.set(threadId, entry);
  return { watch, woken };
};

test("a watch that is not there ends nothing", () => {
  const { watch } = deps();

  expect(watch.finalizeDelegationWatch("t-gone", true, "done")).toBe(false);
  expect(watch.delegationWatch.size).toBe(0);
});

test("ending a watch takes the entry out, once", () => {
  const { watch } = deps([["t1", { toBotId: "b-target", toBotName: "Target" }]]);

  expect(watch.finalizeDelegationWatch("t1", true, "hasil")).toBe(true);
  expect(watch.delegationWatch.size).toBe(0);
  // A second finalize cannot re-report a watch that is already gone.
  expect(watch.finalizeDelegationWatch("t1", true, "hasil")).toBe(false);
});

test("a source that is still reachable is woken with the name that answered", () => {
  const { watch, woken } = deps([[
    "t1",
    { toBotId: "b-target", toBotName: "Target", sourceBotId: "b-source", sourceThreadId: "s1" },
  ]]);

  const ok = watch.finalizeDelegationWatch("t1", true, "hasil");

  expect(ok).toBe(true);
  expect(woken).toEqual(["b-source"]);
});