import { expect, test } from "vitest";
import { listedTask } from "./listed-tasks";

test("a bot's own conversations are listed; a routine's run and its work for a group are not", () => {
  expect(listedTask({})).toBe(true);
  expect(listedTask({ routineRunId: "r1" })).toBe(false);
  expect(listedTask({ forConversation: "c1" })).toBe(false);
});
