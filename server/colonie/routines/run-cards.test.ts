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