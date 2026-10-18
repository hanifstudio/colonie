// The digest state a finished turn leaves behind. These cases pin the clearing
// half — the part every settle and a cancelled dispatch depends on — without a
// provider, so a later move of the recorder cannot strand per-thread state.
import { expect, test } from "vitest";
import { createTurnDigest } from "./turn-digest.ts";

const make = (over: Record<string, unknown> = {}) => {
  const appended: unknown[] = [];
  const memoryRows = new Map<string, unknown[]>();
  const digest = createTurnDigest({
    store: { appendMessage: (...args: unknown[]) => { appended.push(args); return { id: "m1" }; }, activePath: () => [] },
    memoryRowsByThread: memoryRows,
    isContextMessage: () => Boolean,
    ...over,
  } as never);
  return { digest, memoryRows, appended };
};

test("clearTurnDigestState forgets the thread's started time and live turn", () => {
  const { digest } = make();
  digest.turnStartedAt.set("t1", 1234);
  digest.liveTurnByThread.set("t1", "turn-1");
  digest.clearTurnDigestState("t1");
  expect(digest.turnStartedAt.has("t1")).toBe(false);
  expect(digest.liveTurnByThread.has("t1")).toBe(false);
});

test("clearTurnDigestState also clears the memory rows it was handed", () => {
  const { digest, memoryRows } = make();
  memoryRows.set("t1", [{ id: "row" }]);
  digest.clearTurnDigestState("t1");
  expect(memoryRows.has("t1")).toBe(false);
});

test("scheduleTurnDigest drops per-thread state before it checks isCurrent", async () => {
  const { digest, memoryRows, appended } = make();
  digest.turnStartedAt.set("t1", Date.now());
  memoryRows.set("t1", []);
  await digest.scheduleTurnDigest({
    botId: "b1", botName: "Bot", threadId: "t1", turnId: "turn-1",
    driverKind: "claude", reply: "hi", isCurrent: () => false,
  });
  expect(digest.turnStartedAt.has("t1")).toBe(false);
  expect(memoryRows.has("t1")).toBe(false);
  expect(appended).toEqual([]);
});

test("forgetTurnCheckpoint on an untracked thread is a no-op", () => {
  const { digest } = make();
  expect(() => digest.forgetTurnCheckpoint("nobody")).not.toThrow();
});
