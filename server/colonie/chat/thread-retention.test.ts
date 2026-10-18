// Retention must remove only what it says it removes: a thread's idle event
// logs, never a busy or unread one, and only once it is past the window.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { EVENTS_DIR, NATIVE_DIR } from "../../config.ts";
import {
  scheduleThreadLogRetention,
  sweepThreadEventLogs,
  sweepThreadEventLogsNow,
  type ThreadLogRetentionCandidate,
} from "./thread-retention.ts";

const DAY = 24 * 60 * 60 * 1000;

function seedLog(threadId: string): string[] {
  mkdirSync(EVENTS_DIR, { recursive: true });
  mkdirSync(NATIVE_DIR, { recursive: true });
  return [EVENTS_DIR, NATIVE_DIR].map((dir) => {
    const path = join(dir, `${threadId}.ndjson`);
    writeFileSync(path, "log\n");
    return path;
  });
}

function candidate(threadId: string, stamp: number, extra: Partial<ThreadLogRetentionCandidate> = {}): ThreadLogRetentionCandidate {
  return { threadId, closedAt: stamp, archivedAt: null, unread: false, busy: false, openDirectHandoff: false, ...extra };
}

test("an idle closed thread's logs are removed, both dirs", () => {
  const paths = seedLog("retention-idle");
  const now = Date.now();
  expect(sweepThreadEventLogs([candidate("retention-idle", now - 3 * DAY)], 1, now)).toBe(1);
  for (const path of paths) expect(existsSync(path)).toBe(false);
});

test("a thread inside the window, or busy or unread, keeps its logs", () => {
  const fresh = seedLog("retention-fresh");
  const busy = seedLog("retention-busy");
  const unread = seedLog("retention-unread");
  const now = Date.now();
  const swept = sweepThreadEventLogs([
    candidate("retention-fresh", now - 1000),
    candidate("retention-busy", now - 3 * DAY, { busy: true }),
    candidate("retention-unread", now - 3 * DAY, { unread: true }),
  ], 1, now);
  expect(swept).toBe(0);
  for (const path of [...fresh, ...busy, ...unread]) expect(existsSync(path)).toBe(true);
});

test("the source callback decides whether anything is swept at all", () => {
  const paths = seedLog("retention-off");
  const threads: string[] = [];
  let days: number | null = null;
  const source = {
    bots: () => { threads.push("b1"); return [{ id: "b1", tasks: [{ threadId: "retention-off", closedBy: { at: Date.now() - 3 * DAY } }] }]; },
    retentionDays: () => days,
    threadBusy: () => false,
  };
  sweepThreadEventLogsNow(source);
  // Retention off: the store is never even read.
  expect(threads).toEqual([]);
  for (const path of paths) expect(existsSync(path)).toBe(true);

  days = 1;
  sweepThreadEventLogsNow(source);
  expect(threads).toEqual(["b1"]);
  for (const path of paths) expect(existsSync(path)).toBe(false);
});

test("the schedule sweeps at boot and again on its daily timer", () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    const first = seedLog("retention-schedule");
    const later = seedLog("retention-schedule-2");
    const tasks = [{ threadId: "retention-schedule", closedBy: { at: now - 3 * DAY } }];
    scheduleThreadLogRetention({
      bots: () => [{ id: "b1", tasks }],
      retentionDays: () => 1,
      threadBusy: () => false,
    });
    // The boot sweep takes the one thread it can see; the other is not known yet.
    for (const path of first) expect(existsSync(path)).toBe(false);
    for (const path of later) expect(existsSync(path)).toBe(true);

    // A later thread appears and the daily timer takes it on the next pass.
    tasks.push({ threadId: "retention-schedule-2", closedBy: { at: now - 3 * DAY } });
    vi.advanceTimersByTime(DAY + 1);
    for (const path of later) expect(existsSync(path)).toBe(false);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

test("a throttled store fails the boot sweep loudly but not fatally", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(() => scheduleThreadLogRetention({
      bots: () => { throw new Error("store unreadable"); },
      retentionDays: () => 1,
      threadBusy: () => false,
    })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("store unreadable"));
  } finally {
    warn.mockRestore();
    vi.clearAllTimers();
  }
});
