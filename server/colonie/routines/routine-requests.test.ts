import { expect, test } from "vitest";
import { asSchedule, consequenceLine, scheduleText } from "./routine-requests.ts";
import type { RoutineRequestSchedule } from "../../../shared/routine-request.ts";

const NOW = Date.UTC(2026, 0, 5, 9, 0, 0);

const interval = (over: Partial<Extract<RoutineRequestSchedule, { type: "interval" }>> = {}): RoutineRequestSchedule => ({
  type: "interval",
  everyMinutes: 60,
  ...over,
});

test("an interval without an anchor starts one interval after confirmation", () => {
  expect(asSchedule(interval(), NOW)).toMatchObject({ type: "interval", anchorAt: NOW });
  expect(scheduleText(interval(), "UTC")).toContain("starting one interval after confirmation");
});

test("an interval that carries restrictions says so instead", () => {
  const restricted = interval({ window: { start: "09:00", end: "17:00" } });
  expect(scheduleText(restricted, "UTC")).toContain("first run is the next allowed time");
  expect(scheduleText(restricted, "UTC")).toContain("during 09:00–17:00 (UTC)");
});

test("an anchored interval names its anchor and its time zone", () => {
  const anchored = interval({ anchorAt: NOW });
  expect(scheduleText(anchored, "UTC")).toContain("anchored at");
  expect(scheduleText(anchored, "UTC")).toContain("(UTC)");
});

test("a schedule copied for the record is a copy, not a shared object", () => {
  const daily: RoutineRequestSchedule = { type: "daily", time: "08:30", weekdays: [1, 3, 5] };
  const copied = asSchedule(daily, NOW);
  expect(copied).toEqual(daily);
  expect(copied).not.toBe(daily);
  if (copied.type === "daily") expect(copied.weekdays).not.toBe(daily.weekdays);
});

test("a one-off run is a plain instant and never carries a cadence", () => {
  expect(scheduleText({ type: "once", at: NOW }, "UTC")).toContain("(UTC)");
  expect(consequenceLine({ type: "once", at: NOW })).toBe("Will run once; that run starts a fresh session.");
});

test("the consequence states how often a routine actually runs", () => {
  expect(consequenceLine(interval({ everyMinutes: 60 }))).toContain("about 24 times a day");
  expect(consequenceLine(interval({ everyMinutes: 1440 }))).toContain("about once a day");
  expect(consequenceLine(interval({ window: { start: "09:00", end: "17:00" } }))).toContain(
    "when its day, time, and end restrictions allow",
  );
});

test("a daily consequence counts the days, and continuity carries the report", () => {
  expect(consequenceLine({ type: "daily", time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6] })).toContain("every day");
  expect(consequenceLine({ type: "daily", time: "08:00", weekdays: [1] })).toContain("one day a week");
  expect(consequenceLine({ type: "daily", time: "08:00", weekdays: [1, 2, 3] })).toContain("3 days a week");
  expect(consequenceLine(interval({ everyMinutes: 60 }), true)).toContain("previous run's report");
  // a one-off run has nothing to continue from, so the flag changes nothing
  expect(consequenceLine({ type: "once", at: NOW }, true)).toBe(consequenceLine({ type: "once", at: NOW }));
});