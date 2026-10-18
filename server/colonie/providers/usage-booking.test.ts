// Who gets billed for a turn: the ledger row's trigger must name the person
// who asked, and a line queued by an older build must still resolve to one.
import { expect, test } from "vitest";
import { createUsageBooking } from "./usage-booking.ts";

const { usageTriggerFor, queuedTurnTrigger } = createUsageBooking({} as never);

test("a signed-in person's turn is booked to that person", () => {
  expect(usageTriggerFor({ kind: "session", session: { email: "person@example.com", label: "Person" } } as never))
    .toEqual({ kind: "user", email: "person@example.com", label: "Person" });
  // A session that never carried an email is still a person, just unnamed.
  expect(usageTriggerFor({ kind: "session", session: { label: "Device" } } as never))
    .toEqual({ kind: "user", label: "Device" });
});

test("a loopback request is booked to the owner", () => {
  expect(usageTriggerFor({ kind: "loopback", trust: "owner" } as never)).toEqual({ kind: "owner" });
});

test("a stored trigger is kept exactly as it was recorded", () => {
  const trigger = { kind: "bot" as const, botId: "b1" };
  expect(queuedTurnTrigger({ trigger })).toBe(trigger);
});

test("a bot's own queued words set no trigger", () => {
  expect(queuedTurnTrigger({ peerAsk: { botId: "b1" } })).toBeUndefined();
});

test("a queued line falls back to its sender, else the owner", () => {
  expect(queuedTurnTrigger({ sender: { name: "Person" } } as never)).toEqual({ kind: "user", label: "Person" });
  expect(queuedTurnTrigger({})).toEqual({ kind: "owner" });
});
