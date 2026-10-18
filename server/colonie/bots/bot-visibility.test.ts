import { expect, test } from "vitest";
import {
  isRestricted,
  intersectAudience,
  narrowestAudience,
  parseVisibility,
  SEES_EVERYTHING,
  sameAudience,
  storedVisibility,
  audienceWithin,
  viewerSees,
} from "./bot-visibility.ts";

test("an admin's input reads as everyone, admins, or a list of people", () => {
  expect(parseVisibility(null)).toEqual({ ok: true, visibility: "everyone" });
  expect(parseVisibility("everyone")).toEqual({ ok: true, visibility: "everyone" });
  expect(parseVisibility("admins")).toEqual({ ok: true, visibility: "admins" });
  expect(parseVisibility({ people: ["Riaen@Example.com", "@example.org"] })).toEqual({
    ok: true,
    visibility: { people: ["riaen@example.com", "@example.org"] },
  });
});

test("a list that names nobody means admins only, never everyone", () => {
  expect(parseVisibility({ people: [] })).toEqual({ ok: true, visibility: "admins" });
  expect(parseVisibility({ people: ["  ", ""] })).toEqual({ ok: true, visibility: "admins" });
  // and one duplicated entry stays one entry
  expect(parseVisibility({ people: ["a@b.com", "A@B.COM"] })).toEqual({ ok: true, visibility: { people: ["a@b.com"] } });
});

test("an entry that is not an address is refused with the offending value", () => {
  const refused = parseVisibility({ people: ["not-an-address"] });

  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error).toContain("not-an-address");
  expect(parseVisibility({ people: ["a@b.com", 7] }).ok).toBe(false);
  expect(parseVisibility({ people: Array.from({ length: 501 }, (_, i) => `p${i}@x.com`) }).ok).toBe(false);
});

test("a damaged value read back from disk fails closed to admins", () => {
  for (const damaged of [7, "somebody", {}, { people: "a@b.com" }, { people: [7] }, { other: [] }]) {
    expect(storedVisibility(damaged), JSON.stringify(damaged)).toBe("admins");
  }
  expect(storedVisibility(undefined)).toBe("everyone");
  expect(storedVisibility(null)).toBe("everyone");
  expect(isRestricted("everyone")).toBe(false);
  expect(isRestricted({ people: ["a@b.com"] })).toBe(true);
});

test("who may see a bot", () => {
  expect(viewerSees(SEES_EVERYTHING, "admins")).toBe(true);
  expect(viewerSees({ kind: "member", email: "someone@example.com" }, "admins")).toBe(false);
  expect(viewerSees({ kind: "member", email: "someone@example.com" }, "everyone")).toBe(true);
  expect(viewerSees({ kind: "member", email: "Someone@Example.com " }, "admins")).toBe(false);
  expect(viewerSees({ kind: "member", email: "Someone@Example.com " }, { people: ["someone@example.com"] })).toBe(true);
  expect(viewerSees({ kind: "member", email: "a@example.com" }, { people: ["@example.com"] })).toBe(true);
  expect(viewerSees({ kind: "member", email: "a@notexample.com" }, { people: ["@example.com"] })).toBe(false);
  expect(viewerSees({ kind: "member" }, { people: ["@example.com"] })).toBe(false);
  expect(viewerSees({ kind: "member", email: "not-an-email" }, { people: ["@example.com"] })).toBe(false);
});

test("an audience is inside another only when nobody new can see it", () => {
  expect(audienceWithin("everyone", "everyone")).toBe(true);
  expect(audienceWithin({ people: ["a@b.com"] }, "everyone")).toBe(true);
  expect(audienceWithin("admins", "everyone")).toBe(true);
  expect(audienceWithin("everyone", "admins")).toBe(false);
  expect(audienceWithin({ people: ["a@b.com"] }, "admins")).toBe(false);
  expect(audienceWithin({ people: ["a@b.com"] }, { people: ["@b.com"] })).toBe(true);
  expect(audienceWithin({ people: ["@b.com"] }, { people: ["a@b.com"] })).toBe(false);
});

test("the people who can see both sides", () => {
  expect(intersectAudience("everyone", { people: ["a@b.com"] })).toEqual({ people: ["a@b.com"] });
  expect(intersectAudience("everyone", "admins")).toBe("admins");
  expect(intersectAudience("admins", { people: ["a@b.com"] })).toBe("admins");
  expect(intersectAudience({ people: ["a@b.com"] }, { people: ["a@b.com"] })).toEqual({ people: ["a@b.com"] });
  expect(intersectAudience({ people: ["a@b.com"] }, { people: ["a@b.com", "c@d.com"] })).toEqual({ people: ["a@b.com"] });
  // an intersection that names nobody is admins only
  expect(intersectAudience({ people: ["a@b.com"] }, { people: ["c@d.com"] })).toBe("admins");
});

test("the narrowest of several audiences, and equal readings", () => {
  expect(narrowestAudience([])).toBe("everyone");
  expect(narrowestAudience(["everyone", { people: ["a@b.com"] }])).toEqual({ people: ["a@b.com"] });
  expect(narrowestAudience([{ people: ["a@b.com"] }, "everyone", "admins"])).toBe("admins");
  expect(sameAudience({ people: ["a@b.com", "c@d.com"] }, { people: ["c@d.com", "a@b.com"] })).toBe(true);
  expect(sameAudience("everyone", { people: ["a@b.com"] })).toBe(false);
});