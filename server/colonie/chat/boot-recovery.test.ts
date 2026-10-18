// A restart or workspace restore must not re-run words a dispatch may already
// have executed: a claimed row recovers as a user line plus a review notice and
// counts as handed to the resumed session, an unowned claim is cancelled, and
// rows that were never claimed are left for their own lanes.
import { expect, test } from "vitest";
import { chatFollowups, saveChatFollowup, settleChatFollowups } from "../../persistence/message-db.ts";
import type { Message } from "../../persistence/store.ts";
import { createBootRecovery } from "./boot-recovery.ts";

interface FakeTask {
  handedMessages?: Record<string, { session?: string; ids: string[] }>;
}

function build(options: { tasks?: Record<string, FakeTask>; groups?: Record<string, string> } = {}) {
  const messages = new Map<string, Message[]>();
  const appended: Array<[string, Message]> = [];
  const handed: Array<[string, string, string, unknown]> = [];
  let seq = 0;
  const store = {
    groupByThread: (threadId: string) => options.groups?.[threadId] ? { id: options.groups[threadId] } : undefined,
    taskByThread: (botId: string, threadId: string) => options.tasks?.[`${botId}:${threadId}`],
    messagesFor: (threadId: string) => messages.get(threadId) ?? [],
    appendMessage: (threadId: string, message: Omit<Message, "id" | "at">) => {
      const full = { ...message, id: `m${++seq}`, at: seq } as Message;
      messages.set(threadId, [...(messages.get(threadId) ?? []), full]);
      appended.push([threadId, full]);
      return full;
    },
    activePath: (threadId: string) => messages.get(threadId) ?? [],
    setHandedMessages: (...args: [string, string, string, unknown]) => handed.push(args),
  };
  createBootRecovery({ isContextMessage: () => true, store } as never);
  return { appended, handed };
}

function claim(id: string, kind: "bot" | "channel" | "aside", ownerId: string, threadId: string, payload: Record<string, unknown>) {
  saveChatFollowup({ id, kind, ownerId, threadId, payload: payload as never });
  settleChatFollowups([id], "dispatching");
}

function statusOf(id: string) {
  return chatFollowups().find((row) => row.id === id)?.status;
}

test("a claim whose task is gone is cancelled, not recovered as words", () => {
  claim("unowned-1", "bot", "b1", "t-unowned", { text: "never ran" });
  const { appended } = build();
  expect(statusOf("unowned-1")).toBe("cancelled");
  expect(appended).toEqual([]);
});

test("an owned claim recovers a user line and a review notice, then retires", () => {
  claim("owned-1", "bot", "b1", "t-owned", { text: "did this run?" });
  const { appended, handed } = build({ tasks: { "b1:t-owned": { handedMessages: { i1: { session: "s1", ids: [] } } } } });
  expect(appended.map(([threadId, message]) => [threadId, message.role, message.kind])).toEqual([
    ["t-owned", "user", "text"],
    ["t-owned", "bot", "activity"],
  ]);
  expect(appended[0]![1]).toMatchObject({ text: "did this run?", queueId: "owned-1" });
  // The review notice never claims the words ran — only that they may have.
  expect(appended[1]![1].tool?.name).toContain("may have already run");
  // The recovered line counts as handed, so a resumed session is not sent it
  // again as something it has not seen.
  expect(handed).toEqual([["b1", "t-owned", "i1", { session: "s1", ids: [], through: "m1" }]]);
  expect(statusOf("owned-1")).toBeUndefined();
});

test("a channel claim recovers its room provenance, and a foreign owner is cancelled", () => {
  claim("chan-owned", "channel", "g1", "t-room", { text: "room line", mode: "goal", via: "api" });
  claim("chan-foreign", "channel", "g9", "t-room", { text: "other room" });
  const { appended } = build({ groups: { "t-room": "g1" } });
  expect(statusOf("chan-owned")).toBeUndefined();
  expect(statusOf("chan-foreign")).toBe("cancelled");
  expect(appended).toHaveLength(2);
  expect(appended[0]![1]).toMatchObject({ text: "room line", channelMode: "goal", via: "api", queueId: "chan-owned" });
});

test("a row that was never claimed stays for its own lane", () => {
  saveChatFollowup({ id: "waiting-1", kind: "bot", ownerId: "b2", threadId: "t-waiting", payload: { text: "queued" } });
  const { appended } = build();
  expect(statusOf("waiting-1")).toBe("pending");
  expect(appended).toEqual([]);
});
