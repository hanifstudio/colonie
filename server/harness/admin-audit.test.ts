// The guarded-send contract is the boundary the Slack worker opts into, so its
// id/length rules and the on-behalf-of refinement are pinned here.
import { expect, test } from "vitest";
import { createAdminAudit } from "./admin-audit.ts";

const { guardedSendSchema } = createAdminAudit({} as never);

const valid = { threadId: "t-1", sendId: "a".repeat(16), text: "hi", expectedActiveLeafId: null };

test("a well-formed guarded send parses", () => {
  expect(guardedSendSchema.parse(valid).sendId).toBe("a".repeat(16));
});

test("a send id shorter than the contract is refused", () => {
  expect(guardedSendSchema.safeParse({ ...valid, sendId: "short" }).success).toBe(false);
});

test("an empty text is refused", () => {
  expect(guardedSendSchema.safeParse({ ...valid, text: "" }).success).toBe(false);
});

test("on-behalf-of names a person by email or by name, never nobody", () => {
  expect(guardedSendSchema.safeParse({ ...valid, onBehalfOf: {} }).success).toBe(false);
  expect(guardedSendSchema.safeParse({ ...valid, onBehalfOf: { name: "Ada" } }).success).toBe(true);
});

test("an unknown field is refused rather than passed through", () => {
  expect(guardedSendSchema.safeParse({ ...valid, injected: true }).success).toBe(false);
});