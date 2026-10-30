// viewerFor decides the whole visibility path: the wrong answer here either
// hides an admin's own workspace or widens a member to every bot.
import { expect, test } from "vitest";
import { createVisibility } from "./visibility.ts";

const build = () => createVisibility({} as never);

test("a routine's work uses current group membership, so leaving revokes old run access", () => {
  let people = ["ana", "bob"];
  const bot = { id: "ada", threadId: "main", tasks: [{ threadId: "run-thread" }] };
  const { visibleTo, forgetVisibility } = createVisibility({
    store: () => ({ bots: [bot], groups: [], botByThread: () => bot, taskByThread: () => ({ forConversation: "launch" }), threadParticipants: () => ["ana", "bob"] }),
    conversationById: () => ({ people }),
  });
  expect(visibleTo({ kind: "person", key: "ana", admin: true }).thread("run-thread")).toBe(true);
  people = ["bob"]; forgetVisibility();
  expect(visibleTo({ kind: "person", key: "ana", admin: true }).thread("run-thread")).toBe(false);
  expect(visibleTo({ kind: "person", key: "bob", admin: false }).thread("run-thread")).toBe(true);
});

test("loopback and admin sessions see everything", () => {
  const { viewerFor } = build();
  expect(viewerFor({ kind: "loopback", trust: "owner" } as never)).toEqual({ kind: "all" });
  expect(viewerFor({ kind: "session", scopes: ["admin"] } as never)).toEqual({ kind: "all" });
});

test("another session is a member, named by the email it signed in with", () => {
  const { viewerFor } = build();
  expect(viewerFor({ kind: "session", scopes: [], session: { email: "a@x" } } as never))
    .toEqual({ kind: "member", email: "a@x" });
  expect(viewerFor({ kind: "session", scopes: [], session: {} } as never))
    .toEqual({ kind: "member" });
});
test("in a Shared workspace everyone is a person, admins included, and loopback is nobody", () => {
  const { viewerFor } = createVisibility({ sharedWorkspace: () => true } as never);
  const member = viewerFor({ kind: "session", scopes: ["client"], session: { id: "s1", email: "Ada@X.com" } } as never);
  const admin = viewerFor({ kind: "session", scopes: ["admin", "client"], session: { id: "s2", email: "bob@x.com" } } as never);
  expect(member).toMatchObject({ kind: "person", admin: false, email: "Ada@X.com" });
  expect(admin).toMatchObject({ kind: "person", admin: true });
  expect((member as { key: string }).key).toMatch(/^p_[\w-]{22}$/);
  // the same person on another device is the same key
  const otherDevice = viewerFor({ kind: "session", scopes: ["client"], session: { id: "s9", email: "ada@x.com" } } as never);
  expect((otherDevice as { key: string }).key).toBe((member as { key: string }).key);
  expect(viewerFor({ kind: "loopback", trust: "owner" } as never)).toEqual({ kind: "person", key: "", admin: true });
});
