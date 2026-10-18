// viewerFor decides the whole visibility path: the wrong answer here either
// hides an admin's own workspace or widens a member to every bot.
import { expect, test } from "vitest";
import { createVisibility } from "./visibility.ts";

const build = () => createVisibility({} as never);

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