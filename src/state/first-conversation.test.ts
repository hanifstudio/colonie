// A person's first message to a bot in a Shared workspace starts their own
// conversation; the app follows it at once, so the reply and any approval
// card show live instead of after a reload.
import { describe, expect, it } from "vitest";

import { initialState, openNotificationTarget, reducer, type AppState, type Bot, type Message } from "./store";

const bot = { id: "b1", name: "Nova", title: "", description: "", threadId: "", messages: [], color: "blue", notifications: true, unread: false,
  modelSelection: { instanceId: "codex-acp", model: "m" }, tasks: [{ threadId: "t1", title: "hi", createdAt: 1, updatedAt: 1 }] } as unknown as Bot;
const message = (extra: Partial<Message>): Message => ({ id: "m1", at: 1, role: "user", kind: "text", text: "hi", parentId: null, ...extra } as Message);

describe("a person's first conversation with a bot", () => {
  it("a routine notification opens its originating group rather than the bot's personal DM", () => {
    const actions: unknown[] = [];
    openNotificationTarget((action) => actions.push(action), { botId: bot.id, threadId: "group-chat", conversationId: "launch" }, { bots: [bot] });
    expect(actions).toEqual([{ type: "selectConversation", id: "launch" }]);
  });
  it("never adopts a group's work as the first personal conversation", () => {
    const work = { ...bot.tasks![0]!, forConversation: "group-1" };
    const before: AppState = { ...initialState, bots: [{ ...bot, tasks: [work] }], selectedId: bot.id, selectedConversationId: "group-1" };
    let state = reducer(before, { type: "messageAdded", threadId: work.threadId, message: message({ text: "Internal group context" }) });
    state = reducer(state, { type: "messageAdded", threadId: work.threadId, message: message({ id: "answer", role: "bot", text: "Group answer" }) });
    expect(state.bots[0]!.threadId).toBe("");
    expect(state.bots[0]!.messages).toEqual([]);
    expect(state.selectedConversationId).toBe("group-1");
  });
  it("is followed as soon as its first message arrives, and what comes next shows in it", () => {
    let state: AppState = { ...initialState, bots: [bot], selectedId: "b1" };
    state = reducer(state, { type: "messageAdded", threadId: "t1", message: message({}) });
    state = reducer(state, { type: "messageAdded", threadId: "t1", message: message({ id: "m2", role: "bot", kind: "options", parentId: "m1", card: { title: "Approval needed", subtitle: "", options: ["Allow once", "Deny"], requestId: "r1", tool: "edit" } } as Partial<Message>) });
    const now = state.bots[0]!;
    expect(now.threadId).toBe("t1");
    expect(now.messages.map((entry) => entry.id)).toEqual(["m1", "m2"]);
    expect(state.backgroundThreadEvents.t1).toBeUndefined();
  });

  it("a bot already in a conversation still keeps another thread's messages in the background", () => {
    let state: AppState = { ...initialState, bots: [{ ...bot, threadId: "t0", tasks: [...(bot.tasks ?? []), { threadId: "t0", title: "x", createdAt: 1, updatedAt: 1 }] } as Bot] };
    state = reducer(state, { type: "messageAdded", threadId: "t1", message: message({}) });
    expect(state.bots[0]!.threadId).toBe("t0");
    expect(state.backgroundThreadEvents.t1?.length).toBe(1);
  });
});
