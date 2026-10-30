// The Browser panel opens by itself only where the person watches the bot,
// once per turn, and never over a panel already open.
import { expect, test } from "vitest";

import { shouldOpenBrowserPanel } from "./browser-auto-open";

const use = { botId: "b1", threadId: "t1", turn: "g1" };
const closed = { selectedId: "b1", selectedConversationId: null, browserOpen: false };

test("opens in the bot's own chat, once per turn", () => {
  expect(shouldOpenBrowserPanel(closed, use, undefined)).toBe(true);
  expect(shouldOpenBrowserPanel(closed, use, "g1")).toBe(false);
  expect(shouldOpenBrowserPanel(closed, { ...use, turn: "g2" }, "g1")).toBe(true);
});

test("opens in the group the bot works for, and nowhere else", () => {
  const inGroup = { ...use, conversationId: "c1" };
  expect(shouldOpenBrowserPanel({ ...closed, selectedConversationId: "c1" }, inGroup, undefined)).toBe(true);
  expect(shouldOpenBrowserPanel({ ...closed, selectedConversationId: "c2" }, inGroup, undefined)).toBe(false);
  expect(shouldOpenBrowserPanel(closed, inGroup, undefined)).toBe(false);
  expect(shouldOpenBrowserPanel({ ...closed, selectedId: "b2" }, use, undefined)).toBe(false);
});

test("never replaces a panel already open", () => {
  expect(shouldOpenBrowserPanel({ ...closed, browserOpen: true }, use, undefined)).toBe(false);
});
