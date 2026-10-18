// Recall is a privacy boundary: a turn with memory off, or with auto-recall
// switched off, must be prefixed with nothing at all.
import { expect, test } from "vitest";
import { createRecallPrompt } from "./recall-prompt.ts";

const bot = { id: "b1", name: "Ada", threadId: "t1", tasks: [] } as never;

const build = (features?: Record<string, unknown>) =>
  createRecallPrompt({ cfg: { features }, store: () => ({ taskByThread: () => undefined }) } as never);

test("a bot with memory off gets no recalled block", () => {
  const { autoRecallPrompt } = build();
  expect(autoRecallPrompt({ ...(bot as object), memoryEnabled: false } as never, "t1", "hello", { conversations: true, userName: "Person" })).toBe("");
});

test("auto-recall switched off in settings gets no recalled block", () => {
  const { autoRecallPrompt } = build({ autoRecall: false });
  expect(autoRecallPrompt(bot, "t1", "hello", { conversations: false, userName: "Person" })).toBe("");
});

test("the recalled block sits in front of the message, or the message is alone", () => {
  const { withRecalled } = build();
  expect(withRecalled("NOTE", "hello")).toBe("NOTE\n\nhello");
  expect(withRecalled("", "hello")).toBe("hello");
});
