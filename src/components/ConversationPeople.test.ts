// The people in a conversation of a Shared workspace, as its header shows them.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { ConversationPeopleView } from "./ConversationPeople";

const people = [
  { email: "ada@x.com", name: "Ada", you: true },
  { email: "bob@x.com", name: "Bob", you: false },
];
const view = (extra: Partial<Parameters<typeof ConversationPeopleView>[0]> = {}) => renderToStaticMarkup(createElement(ConversationPeopleView, {
  people, open: true, email: "", busy: false, error: "", onToggle: () => {}, onEmail: () => {}, onAdd: () => {}, onLeave: () => {}, ...extra,
}));

test("the header says how many people are in it", () => {
  expect(view({ open: false })).toContain("2 people");
});

test("open, it lists everyone, marks you, and offers adding someone and leaving", () => {
  const html = view();
  expect(html).toContain("Ada");
  expect(html).toContain("(you)");
  expect(html).toContain("Bob");
  expect(html).toContain("bob@x.com");
  expect(html).toContain("Add");
  expect(html).toContain("Leave this conversation");
  expect(html).toMatch(/people in this workspace/i);
});

test("a refused address says why", () => {
  expect(view({ error: "mallory@evil.example is not in this workspace." })).toContain("is not in this workspace");
});
