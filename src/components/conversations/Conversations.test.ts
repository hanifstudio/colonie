// Groups and DMs between people in the app: the sidebar list, the
// conversation with its people and bots, and making a new one.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Conversation } from "@/lib/conversations";
import { asChatMessages, mentionQuery, mentionSuggestions, withFrame } from "@/lib/conversations";
import type { Message } from "@/state/store";
import { ConversationListView, rowMetrics, sidebarRows } from "./SidebarConversations";
import { NewConversationView } from "./NewConversationDialog";

const conversation = (extra: Partial<Conversation>): Conversation => ({
  id: "c1", threadId: "t1", kind: "group", title: "Launch", name: "Launch",
  people: [{ email: "ana@x.com", name: "Ana", you: true }, { email: "bob@x.com", name: "Bob", you: false }],
  bots: ["b1"], lastMessageAt: 1, unread: false, ...extra,
});
const message = (extra: Partial<Message>): Message => ({ id: "m1", at: 1, role: "user", kind: "text", text: "hi", ...extra } as Message);

describe("groups and DMs between people", () => {
  it("the sidebar lists them by name with the last thing said, marks unread ones, and is quiet when empty", () => {
    const html = renderToStaticMarkup(createElement(ConversationListView, {
      conversations: [conversation({ preview: "Bob: see you Friday" }), conversation({ id: "c2", kind: "dm", title: "Bob", unread: true })],
      selectedId: "c1", onSelect: () => {},
    }));
    expect(html).toContain("Launch");
    expect(html).toContain("Bob: see you Friday");
    expect(html).toContain("Bob");
    expect(html).toContain('aria-label="Unread"');
    // no heading or "start a group" line: a new group starts from the + menu
    expect(html).not.toContain("Start a group");
    expect(renderToStaticMarkup(createElement(ConversationListView, { conversations: [], selectedId: undefined, onSelect: () => {} }))).toBe("");
  });

  it("a person's or group's row is the size of a bot's row at each density", () => {
    expect(rowMetrics("comfortable", true).avatar).toBe(32);
    expect(rowMetrics("comfortable", false).avatar).toBe(56);
    expect(rowMetrics("compact", true).avatar).toBe(26);
    expect(rowMetrics("comfortable", true).row).toMatch(/\bpl-6\b/);
  });

  it("shows who wrote each message, people and bots: yours on the right, the first of a run with a face", () => {
    const people = [{ key: "pa", email: "ana@x.com", name: "Ana", you: true }, { key: "pb", email: "bob@x.com", name: "Bob", you: false, avatar: "https://cloud/avatars/b" }];
    const shown = asChatMessages([
      message({ id: "m0", text: "hi all", sender: { name: "Ana", id: "pa" } }),
      message({ id: "m1", text: "plan for Friday?", sender: { name: "Bob", id: "pb" } }),
      message({ id: "m2", text: "and Saturday?", sender: { name: "Bob", id: "pb" } }),
      message({ id: "m3", role: "bot", text: "Here is the plan.", from: { botId: "b1", name: "Riset", color: "teal" } }),
    ], people);
    expect(shown.map((m) => [m.role, m.sender?.name ?? null])).toEqual([["user", null], ["bot", "Bob"], ["bot", null], ["bot", "Riset"]]);
    expect(shown[1]!.sender).toMatchObject({ kind: "human", avatar: "https://cloud/avatars/b", email: "bob@x.com" });
    expect(shown[3]!.sender).toMatchObject({ kind: "bot" });
  });

  it("a new conversation asks a group's name, its people and bots; a DM one person", () => {
    const people = [{ email: "bob@x.com", name: "Bob" }];
    const bots = [{ id: "b1", name: "Riset" }];
    const group = renderToStaticMarkup(createElement(NewConversationView, { kind: "group", name: "", people, bots, chosenPeople: [], chosenBots: [], busy: false, error: "",
      onKind: () => {}, onName: () => {}, onTogglePerson: () => {}, onToggleBot: () => {}, onCreate: () => {}, onClose: () => {} }));
    expect(group).toContain("Group name");
    expect(group).toContain("Bob");
    expect(group).toContain("Riset");
    expect(group).toContain("Create group");
    const dm = renderToStaticMarkup(createElement(NewConversationView, { kind: "dm", name: "", people, bots, chosenPeople: [], chosenBots: [], busy: false, error: "",
      onKind: () => {}, onName: () => {}, onTogglePerson: () => {}, onToggleBot: () => {}, onCreate: () => {}, onClose: () => {} }));
    expect(dm).not.toContain("Group name");
    expect(dm).toContain("Start DM");
  });

  it("live messages are added once and patched in place", () => {
    const first = message({ id: "m1", role: "bot", text: "Riset is working on it…" });
    let list = withFrame([], { kind: "message", threadId: "t1", message: first });
    list = withFrame(list, { kind: "message", threadId: "t1", message: first });
    expect(list).toHaveLength(1);
    list = withFrame(list, { kind: "message.patch", threadId: "t1", message: { ...first, text: "Done." } });
    expect(list[0]!.text).toBe("Done.");
  });

  it("lists everyone else in the workspace, like Slack: a person with a DM shows that DM", () => {
    const dm = conversation({ id: "c2", kind: "dm", title: "Bob", unread: true });
    const gone = conversation({ id: "c3", kind: "dm", title: "Cy", people: [{ email: "ana@x.com", name: "Ana", you: true }, { email: "cy@x.com", name: "Cy", you: false }] });
    const rows = sidebarRows([dm, conversation({}), gone], [{ email: "Bob@x.com", name: "Bob" }, { email: "dee@x.com", name: "Dee" }]);
    expect(rows.map((row) => row.kind === "person" ? `person:${row.person.name}` : row.conversation.id)).toEqual(["c1", "c2", "person:Dee", "c3"]);
    const html = renderToStaticMarkup(createElement(ConversationListView, {
      conversations: [], people: [{ email: "dee@x.com", name: "Dee" }], selectedId: undefined, onSelect: () => {},
    }));
    expect(html).toContain("Dee");
    expect(html).toContain("Send a message");
  });

  it("someone @named sees it on the conversation, before plain unread", () => {
    const html = renderToStaticMarkup(createElement(ConversationListView, {
      conversations: [conversation({ unread: true, mentioned: true })], selectedId: undefined, onSelect: () => {},
    }));
    expect(html).toContain('aria-label="You were mentioned"');
    expect(html).not.toContain('aria-label="Unread"');
  });

  it("typing @ suggests the people here and the bots, by any word of their name", () => {
    expect(mentionQuery("hey @bo")).toBe("bo");
    expect(mentionQuery("mail me at bob@x.com")).toBeNull();
    expect(mentionQuery("done")).toBeNull();
    const names = [{ name: "Bob Builder", kind: "person" as const }, { name: "Riset", kind: "bot" as const }];
    expect(mentionSuggestions("bu", names).map((entry) => entry.name)).toEqual(["Bob Builder"]);
    expect(mentionSuggestions("", names)).toHaveLength(2);
  });

  it("a line about the conversation itself reads as a note, not as someone's words", () => {
    const shown = asChatMessages([message({ id: "n1", role: "bot", notice: true, text: "Ana made the group with Bob, Riset." })], []);
    expect(shown[0]).toMatchObject({ notice: true, text: "Ana made the group with Bob, Riset." });
    expect(shown[0]!.sender).toBeUndefined();
  });
});
