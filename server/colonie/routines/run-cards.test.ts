// The source conversation decides where a routine's card and its unread dot
// land, so an invalid destination (gone, hidden, or an execution thread) must
// read as no destination rather than fall back to one.
import { expect, test } from "vitest";
import { createRoutineRunCards } from "./run-cards.ts";

const build = (store: Record<string, unknown>) =>
  createRoutineRunCards({ store } as never);

const bot = { id: "bot-1", hidden: false };

test("a hidden results bot never becomes the source", () => {
  const { routineSourceOwner } = build({
    bot: () => ({ ...bot, hidden: true }),
    taskByThread: () => ({ threadId: "t-1" }),
  });
  expect(routineSourceOwner({ botId: "bot-1", resultsThreadId: "t-1" })).toBeNull();
});

test("a live results thread the bot still owns is the source", () => {
  const { routineSourceOwner } = build({
    bot: () => bot,
    taskByThread: () => ({ threadId: "t-1" }),
  });
  expect(routineSourceOwner({ botId: "bot-1", resultsThreadId: "t-1" }))
    .toEqual({ bot, threadId: "t-1" });
});

test("a results thread already carrying a routine run is not reused", () => {
  const { routineSourceOwner } = build({
    bot: () => bot,
    taskByThread: () => ({ threadId: "t-1", routineRunId: "run-1" }),
  });
  expect(routineSourceOwner({ botId: "bot-1", resultsThreadId: "t-1" })).toBeNull();
});

test("no results snapshot and no source thread is no source", () => {
  const { routineSourceOwner } = build({ bot: () => bot });
  expect(routineSourceOwner({ botId: "bot-1" })).toBeNull();
});
test("in a group, a run with nothing to tell keeps its short completed card without the marker; a real report keeps its text", () => {
  const appended: Array<{ text?: string; routineRun?: { summary?: string; status: string } }> = [];
  const { syncRoutineRunToSource } = createRoutineRunCards({
    store: { bot: () => bot, messagesFor: () => [], appendMessage: (_thread: string, message: never) => { appended.push(message); } },
    conversationOf: () => ({ id: "g1" }),
  } as never);
  const run = (id: string, output: string) => ({ id, routineId: "daily", routineName: "Daily check", botId: "bot-1", status: "completed", target: "other", output, conversation: { id: "g1", threadId: "t-g" } });
  syncRoutineRunToSource(run("a", "NO_REPLY") as never);
  syncRoutineRunToSource(run("b", "Revenue dropped 12%.") as never);
  expect(appended[0]!.routineRun?.summary).toBeUndefined();
  expect(appended[0]!.text).toBe("Routine “Daily check” completed");
  expect(appended[1]!.routineRun?.summary).toBe("Revenue dropped 12%.");
});
