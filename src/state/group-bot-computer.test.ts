// A group opens one of its bots' screens beside the conversation, as Grok
// Bot's computer preview opens beside a chat: the group stays open.
import { expect, it } from "vitest";

import { initialState, reducer, type AppState, type Bot } from "./store";

const bot = (id: string) => ({ id, name: id, title: "", description: "", threadId: "", messages: [], color: "blue", notifications: true, unread: false,
  modelSelection: { instanceId: "claude-acp", model: "m" } }) as unknown as Bot;

it("opens the named bot's computer and keeps the group open", () => {
  const before: AppState = { ...initialState, bots: [bot("b1"), bot("b2")], selectedId: "b1", selectedConversationId: "group-1" };
  const state = reducer(before, { type: "toggleComputer", open: true, botId: "b2" });
  expect(state.computerOpen).toBe(true);
  expect(state.selectedId).toBe("b2");
  expect(state.selectedConversationId).toBe("group-1");
});
