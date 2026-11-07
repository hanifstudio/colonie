// Who a quoted message is "from": in a group the quote must name the real writer, whichever line of a
// run it is, and say "You" only on the viewer's own lines. A 1:1 chat is unchanged.
import { expect, test } from "vitest";

import type { Message } from "@/state/store";
import { asChatMessages, type ConversationPerson } from "./conversations";
import { replyAuthor } from "./replies";

const people = [
  { key: "ana", name: "Ana", you: true },
  { key: "bob", name: "Bob" },
] as unknown as ConversationPerson[];
const said = (id: string, by: "ana" | "bob", text = id) => ({ id, role: "user", kind: "text", text, sender: { id: by, name: by === "ana" ? "Ana" : "Bob" } }) as unknown as Message;
const botLine = { id: "b1", role: "bot", kind: "text", text: "ok", from: { botId: "x", name: "Reka" } } as unknown as Message;

test("in a group a quote names Bob on every one of his lines, not only the first of a run", () => {
  const shown = asChatMessages([said("m1", "bob"), said("m2", "bob"), said("m3", "ana"), botLine], people);
  const byId = new Map(shown.map((message) => [message.id, message]));
  expect(replyAuthor(byId.get("m1")!, undefined, "ana")).toBe("Bob");
  // the second line of Bob's run carries no sender on screen; the quote still says Bob
  expect(byId.get("m2")!.sender).toBeUndefined();
  expect(replyAuthor(byId.get("m2")!, undefined, "ana")).toBe("Bob");
  expect(replyAuthor(byId.get("m3")!, undefined, "ana")).toBe("You");
  expect(replyAuthor(byId.get("b1")!, undefined, "ana")).toBe("Reka");
});

test("a raw message from another person names them, and the viewer's own reads You", () => {
  expect(replyAuthor(said("m1", "bob"), undefined, "ana")).toBe("Bob");
  expect(replyAuthor(said("m2", "ana"), undefined, "ana")).toBe("You");
});

test("a 1:1 chat is unchanged: no viewer means You for the person and the bot's name for the bot", () => {
  expect(replyAuthor(said("m1", "bob"))).toBe("You");
  expect(replyAuthor({ id: "u", role: "user", kind: "text", text: "hi" } as Message)).toBe("You");
  expect(replyAuthor({ id: "a", role: "bot", kind: "text", text: "hi" } as Message, "Nova")).toBe("Nova");
});
