import { expect, test } from "vitest";
import { pinnedClientThread } from "./pinned-client.ts";

const store = (threads: number) =>
  ({ tasks: () => Array.from({ length: threads }, (_, index) => ({ id: `t${index}` })) }) as never;
const session = { kind: "session", session: { id: "s1" } } as never;
const admin = { kind: "admin", scopes: [] } as never;

test("a client on a bot with several threads must name one", () => {
  const require = pinnedClientThread({ auth: session, store: store(2) });

  expect(() => require("b1", undefined)).toThrowError(/more than one thread/);
  expect(() => require("b1", undefined)).toThrowError(
    expect.objectContaining({ status: 409 }),
  );
});

test("one thread is unambiguous, so an unnamed client is fine", () => {
  const require = pinnedClientThread({ auth: session, store: store(1) });

  expect(() => require("b1", undefined)).not.toThrow();
});

test("an admin or loopback caller is not held to the client's rule", () => {
  const require = pinnedClientThread({ auth: admin, store: store(3) });

  expect(() => require("b1", undefined)).not.toThrow();
});

test("a named thread, or an explicit null, is taken as given", () => {
  const require = pinnedClientThread({ auth: session, store: store(2) });

  expect(() => require("b1", "t1")).not.toThrow();
  expect(() => require("b1", null)).not.toThrow();
});