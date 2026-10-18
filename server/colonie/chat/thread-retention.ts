// Retention for per-thread event logs (#1280).
//
// The events/ and native/ NDJSON logs are the bulk of on-disk data: they
// outgrow thread metadata by orders of magnitude and nothing bounded them.
// This sweep removes the log files of threads that have been idle — closed
// or archived — longer than a configured window. It never deletes
// transcripts, thread records, or workspace state, and it never touches a
// thread that is busy, unread, or carrying an open direct handoff. Group
// threads carry no close/archive stamp today, so they are out of scope
// until they grow one.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { EVENTS_DIR, NATIVE_DIR } from "../../config.ts";

export interface ThreadLogRetentionCandidate {
  threadId: string;
  /** task.closedBy?.at — when close_thread last closed the thread. */
  closedAt: number | null;
  /** task.archivedAt — when the person archived the thread. */
  archivedAt: number | null;
  unread: boolean;
  busy: boolean;
  openDirectHandoff: boolean;
}

/** The host facts one sweep reads: every bot's tasks as candidates, whether a
 * thread is busy, and how long a thread must be idle (null when retention is
 * off). Kept as callbacks so a sweep always sees the current config and store. */
export interface ThreadLogRetentionSource {
  bots(): Array<{
    id: string;
    tasks?: Array<{
      threadId: string;
      closedBy?: { at?: number } | null;
      archivedAt?: number | null;
      unread?: boolean;
    }>;
  }>;
  threadBusy(botId: string, threadId: string): boolean;
  retentionDays(): number | null;
}

/** One sweep over the current store. Throws if the store or the file checks
 * do; the daily schedule wraps that, and a caller may sweep on its own. */
export function sweepThreadEventLogsNow(source: ThreadLogRetentionSource): void {
  const retentionDays = source.retentionDays();
  if (retentionDays === null) return;
  const candidates: ThreadLogRetentionCandidate[] = source.bots().flatMap((bot) =>
    (bot.tasks ?? []).map((task) => ({
      threadId: task.threadId,
      closedAt: task.closedBy?.at ?? null,
      archivedAt: task.archivedAt ?? null,
      unread: task.unread === true,
      busy: source.threadBusy(bot.id, task.threadId),
      // Stored handoff trees load settled, so none holds a thread open.
      openDirectHandoff: false,
    })));
  const swept = sweepThreadEventLogs(candidates, retentionDays);
  if (swept > 0) console.log(`[retention] removed event logs for ${swept} idle thread(s) past ${retentionDays} day(s)`);
}

/** Sweep once at boot, then daily. Retention is off unless configured, and
 * even then it only removes log files — transcripts, thread records and
 * workspace state stay untouched. A thread qualifies only when its newest
 * close or archive stamp is older than the window and it is not busy, unread,
 * or carrying an open direct handoff. Only the boot sweep is guarded: a later
 * failure is the timer's to report, as it always was. */
export function scheduleThreadLogRetention(source: ThreadLogRetentionSource): void {
  try {
    sweepThreadEventLogsNow(source);
  } catch (error) {
    console.warn(`thread event log retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // A days-scale window needs no tighter cadence; unref so the timer never
  // holds the process open.
  setInterval(() => sweepThreadEventLogsNow(source), THREAD_LOG_RETENTION_SWEEP_MS).unref();
}

/** A days-scale sweep needs no tighter cadence. */
export const THREAD_LOG_RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The newest close/archive stamp decides: a thread picked back up and
 * closed again must wait out the full window from its newest stamp. */
function idleSince(candidate: ThreadLogRetentionCandidate): number | null {
  const stamps = [candidate.closedAt, candidate.archivedAt].filter((value): value is number => value !== null);
  return stamps.length ? Math.max(...stamps) : null;
}

/** Remove the event logs of every candidate idle longer than retentionDays.
 * Returns how many threads had logs removed. Missing files simply leave
 * nothing to do — an already-swept thread is not counted again. */
export function sweepThreadEventLogs(
  candidates: Iterable<ThreadLogRetentionCandidate>,
  retentionDays: number,
  now: number = Date.now(),
): number {
  const cutoff = now - retentionDays * DAY_MS;
  let swept = 0;
  for (const candidate of candidates) {
    if (candidate.unread || candidate.busy || candidate.openDirectHandoff) continue;
    const since = idleSince(candidate);
    if (since === null || since >= cutoff) continue;
    let removedAny = false;
    for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
      const path = join(dir, `${candidate.threadId}.ndjson`);
      try {
        unlinkSync(path);
        removedAny = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          console.warn(`[retention] could not remove ${path}: ${(error as Error).message}`);
        }
      }
    }
    if (removedAny) swept++;
  }
  return swept;
}
