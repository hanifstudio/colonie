// One direct turn's dispatch claim is the proof that a thread's reservation is
// still yours before you touch it, so the cheap phase rules are worth guarding:
// promoting a claim must fail closed on a stale id, clearing must only release
// the matching owner, and cancelling must abort the compaction controller only
// when its generation is the claim being dropped.
import { expect, test } from "vitest";
import { createTurnDispatch, type DirectTurnDispatchClaim } from "./turn-dispatch.ts";

const deps = (over: Record<string, unknown> = {}) => {
  const claims = new Map<string, DirectTurnDispatchClaim>();
  const busyThreads = new Set<string>();
  const settled: string[] = [];
  const cancelledResumes: string[] = [];
  const clearedDigests: string[] = [];
  const dispatch = createTurnDispatch({
    cancelTeamSetupResumesForThread: () => (threadId: string) => cancelledResumes.push(threadId),
    clearTurnDigestState: () => (threadId: string) => clearedDigests.push(threadId),
    directTurnDispatchClaims: () => claims,
    directTurnGenerationByThread: () => new Map<string, string>(),
    settleTrackedRequest: () => (threadId: string) => settled.push(threadId),
    store: () => ({
      bot: (id: string) => ({ id, threadId: "t1" }),
      botByThread: () => undefined,
      taskByThread: (botId: string, threadId: string) =>
        busyThreads.has(`${botId}:${threadId}`) ? { busy: true } : undefined,
    }),
    threadBusy: () => () => false,
    ...over,
  } as never);
  return { dispatch, claims, busyThreads, settled, cancelledResumes, clearedDigests };
};

const claim = (over: Partial<DirectTurnDispatchClaim> = {}): DirectTurnDispatchClaim => ({
  id: "g1", botId: "b1", threadId: "t1", phase: "setup", ...over,
});

test("promoting a claim fails closed on a stale id", () => {
  const { dispatch, claims, busyThreads } = deps();
  claims.set("t1", claim());
  busyThreads.add("b1:t1");
  expect(dispatch.markDirectTurnDispatching("b1", "wrong", "t1")).toBe(false);
  expect(claims.get("t1")?.phase).toBe("setup");
  expect(dispatch.markDirectTurnDispatching("b1", "g1", "t1")).toBe(true);
  expect(claims.get("t1")?.phase).toBe("dispatching");
});

test("a current claim needs a busy task but an existing one does not", () => {
  const { dispatch, claims } = deps();
  claims.set("t1", claim());
  expect(dispatch.directTurnClaimExists("b1", "g1", "t1")).toBe(true);
  expect(dispatch.directTurnClaimIsCurrent("b1", "g1", "t1")).toBe(false);
});

test("clearing releases only the matching claim and re-settles the thread", () => {
  const { dispatch, claims, settled } = deps();
  claims.set("t1", claim());
  dispatch.clearDirectTurnDispatch("t1", "wrong");
  expect(claims.has("t1")).toBe(true);
  expect(settled).toEqual([]);
  dispatch.clearDirectTurnDispatch("t1", "g1");
  expect(claims.has("t1")).toBe(false);
  expect(settled).toEqual(["t1"]);
});

test("cancelling aborts the compaction controller of the dropped generation", () => {
  const { dispatch, claims, cancelledResumes } = deps();
  claims.set("t1", claim());
  const abort = new AbortController();
  dispatch.compactionControllers.set("t1", { generation: "g1", controller: abort });
  const cancelled = dispatch.cancelDirectTurnDispatch("b1");
  expect(cancelled?.id).toBe("g1");
  expect(claims.has("t1")).toBe(false);
  expect(cancelledResumes).toEqual(["t1"]);
  expect(abort.signal.aborted).toBe(true);
  expect(dispatch.pendingCancelledProviderHandshakes.has("t1")).toBe(false);
});

test("cancelling a dispatching claim quarantines its thread", () => {
  const { dispatch, claims } = deps();
  claims.set("t1", claim({ phase: "dispatching" }));
  dispatch.cancelDirectTurnDispatch("b1");
  expect(dispatch.pendingCancelledProviderHandshakes.has("t1")).toBe(true);
});
