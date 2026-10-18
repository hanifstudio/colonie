import { expect, test } from "vitest";
import {
  asSchedule,
  consequenceLine,
  reconcileRoutineRequestReceiptsAtBoot,
  scheduleText,
} from "./routine-requests.ts";
import type { RoutineRequestSchedule } from "../../../shared/routine-request.ts";
import type { RoutineRequestOwner } from "./routines.ts";

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

function owner(over: Partial<RoutineRequestOwner> = {}): RoutineRequestOwner {
  return { requestId: "req-1", messageId: "msg-1", botId: "bot-1", threadId: "thread-1", ...over };
}

function openCard(request: RoutineRequestOwner, over: Record<string, unknown> = {}) {
  return {
    id: request.messageId,
    card: {
      routineRequest: { requestId: request.requestId, botId: request.botId, threadId: request.threadId },
      ...over,
    },
  };
}

/** Runs the boot reconciliation against recorders and returns what it read
 * and what it reconciled, without touching a real store or manager. */
function boot(receipts: RoutineRequestOwner[], messages: Record<string, unknown[]>) {
  const reconciled: RoutineRequestOwner[][] = [];
  const reads: string[] = [];
  const routines = {
    routineRequestReceiptOwners: () => receipts,
    reconcileRoutineRequestReceipts: (reachable: RoutineRequestOwner[]) => {
      reconciled.push(reachable);
      return reachable.length;
    },
  };
  const store = {
    messagesFor: (threadId: string) => {
      reads.push(threadId);
      return messages[threadId] ?? [];
    },
  };
  reconcileRoutineRequestReceiptsAtBoot({ store: store as never, routines: routines as never });
  return { reconciled, reads };
}

test("a launch with no receipts never reads a transcript", () => {
  const { reconciled, reads } = boot([], {});
  expect(reconciled).toHaveLength(0);
  expect(reads).toHaveLength(0);
});

test("only a receipt's threads are read, once each", () => {
  const request = owner();
  const { reads } = boot([request, owner({ requestId: "req-2", messageId: "msg-2" })], {
    "thread-1": [openCard(request)],
  });
  expect(reads).toEqual(["thread-1"]);
});

test("a still-open card is kept, and a vanished one is not", () => {
  const request = owner();
  const { reconciled } = boot([request], { "thread-1": [openCard(request)] });
  expect(reconciled).toEqual([[{
    requestId: "req-1",
    messageId: "msg-1",
    botId: "bot-1",
    threadId: "thread-1",
  }]]);
  const gone = boot([request], {});
  expect(gone.reconciled).toEqual([[]]);
});

test("a settled or dismissed card is not a reachable receipt", () => {
  const request = owner();
  expect(boot([request], { "thread-1": [openCard(request, { answered: "applied" })] }).reconciled).toEqual([[]]);
  expect(boot([request], { "thread-1": [openCard(request, { dismissed: true })] }).reconciled).toEqual([[]]);
});