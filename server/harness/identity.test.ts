// personKey is what a thread or message carries instead of a session id, so
// it must be stable per person (email wins over device) and never the raw id.
import { expect, test } from "vitest";
import { createIdentity } from "./identity.ts";

const { personKey } = createIdentity({} as never);

test("the same email is the same person, whatever the session or casing", () => {
  const a = personKey({ id: "s-1", email: " Ada@X.io " } as never);
  const b = personKey({ id: "s-2", email: "ada@x.io" } as never);
  expect(a).toBe(b);
});

test("a session with no email is keyed by the session itself", () => {
  const a = personKey({ id: "s-1" } as never);
  const b = personKey({ id: "s-2" } as never);
  expect(a).not.toBe(b);
  expect(a).not.toContain("s-1");
  expect(a).toMatch(/^p_[A-Za-z0-9_-]{22}$/);
});