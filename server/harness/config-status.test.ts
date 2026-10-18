// Access filtering is the boundary that keeps private settings off a
// non-admin client, so both the admin pass-through and the strip are pinned.
import { expect, test } from "vitest";
import { createConfigStatus } from "./config-status.ts";

const build = (over: Record<string, unknown> = {}) =>
  createConfigStatus({ bus: { subscribe: () => () => {} }, ...over } as never);

const status = {
  edition: { edition: "pro", features: ["a"] },
  signIn: { admins: ["a@x"], members: ["b@x"] },
  opencodeGo: { configured: true, providerKeys: ["k"] },
  profile: { name: "N", email: "e@x" },
  browserProfiles: [{ id: "p1", partitionId: "part" }],
  other: 1,
};

test("an admin sees the full status unchanged", () => {
  const { configForAccess } = build();
  expect(configForAccess(status as never, true)).toBe(status);
});

test("a non-admin loses the sign-in list and private identifiers", () => {
  const { configForAccess } = build();
  const restricted = configForAccess(status as never, false);
  expect(restricted.signIn).toEqual({ admins: [], members: [] });
  expect(restricted.profile.email).toBe("");
  expect(restricted.browserProfiles[0]).toEqual({ id: "p1" });
  expect(restricted.edition).toEqual({ edition: "pro", features: ["a"] });
  expect(restricted.opencodeGo.providerKeys).toEqual([]);
});