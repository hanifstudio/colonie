// Where a routine's lifecycle card lands: pick the source conversation (results snapshot, else the chat that made the routine, else the bot's oldest open thread), render the card and its fallback line, and upsert one durable card per run.
import { canReachPeer } from "../../colonie/peers/peer-roster.ts";
import { threadTitleFrom, type Message, type TaskRecord } from "../../persistence/store.ts";
import { redactSecretsInText } from "../../redact.ts";
import type { RoutineRun } from "./routines.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface RoutineRunCardsDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createRoutineRunCards(deps: RoutineRunCardsDeps) {
  const {
    store
  } = deps;


// ── routines: persisted definitions → detached bot tasks ───────────────
// The scheduler owns timing and receipts; the existing harness remains the
// only owner of provider sessions, approvals, tools, computers and messages.
function routineSourceOwner(run: Pick<RoutineRun, "botId" | "sourceThreadId" | "resultsThreadId">) {
  if (run.resultsThreadId) {
    const bot = store.bot(run.botId);
    const task = bot && store.taskByThread(bot.id, run.resultsThreadId);
    return bot && !bot.hidden && task && !task.routineRunId
      ? { bot, threadId: task.threadId }
      : null;
  }
  // Without a results snapshot (a run from before every routine reported to
  // its bot's main thread, or a bot with no visible thread) the chat that
  // made the routine is the destination.
  const threadId = run.sourceThreadId?.trim();
  if (!threadId) return null;
  // Validate before messagesFor(): Store lazily opens transcript storage, so
  // reading an orphan id first would recreate a deleted conversation.
  const bot = store.bot(run.botId);
  if (!bot) return null;
  // The source is stamped from the confirmed request, never calendar input.
  // A request for a teammate runs as that teammate but reports to the bot
  // whose conversation held the card. Recheck their section before sharing
  // a result, since either bot may have moved since confirmation.
  const sourceBot = store.botByThread(threadId);
  if (sourceBot && !sourceBot.hidden && !store.taskByThread(sourceBot.id, threadId)?.routineRunId &&
    (sourceBot.id === bot.id || canReachPeer(sourceBot, bot))) {
    return { bot: sourceBot, threadId };
  }
  // A stored room is read-only history: the run keeps its own thread.
  return null;
}

/** There is no durable "main thread" (bot.threadId is only the UI
 * selection), so a routine reports into the bot's oldest open conversation:
 * the one it was created with until that is deleted or archived. Deleting
 * the last one already gives the bot a fresh conversation (Store.deleteTask). */
function botMainThread(botId: string): string | undefined {
  const visible: TaskRecord[] = store.tasks(botId).filter((task: TaskRecord) => !task.routineRunId);
  const open = visible.filter((task: TaskRecord) => task.archivedAt === undefined);
  return (open.length ? open : visible).reduce<TaskRecord | undefined>(
    (oldest, task) => (!oldest || task.createdAt < oldest.createdAt ? task : oldest), undefined,
  )?.threadId;
}

/** Routines without a chosen thread used to get an automatic "<name> ·
 * Results" thread. One nobody renamed is that automatic default, not a
 * choice: new runs move to the main thread, and the old thread stays. */
function legacyResultsThread(routineName: string, task: TaskRecord): boolean {
  return task.title.endsWith(" · Results") || task.title === threadTitleFrom(`${routineName} · Results`);
}

function routineSourceThread(run: RoutineRun): string | null {
  return routineSourceOwner(run)?.threadId ?? null;
}

function routineRunCard(run: RoutineRun): NonNullable<Message["routineRun"]> {
  const visibleSummary = run.status === "waiting" ? run.attention : run.output;
  const summary = visibleSummary ? redactSecretsInText(visibleSummary).slice(0, 2_000) : undefined;
  const error = run.error ? redactSecretsInText(run.error).slice(0, 500) : undefined;
  const card: NonNullable<Message["routineRun"]> = {
    runId: run.id,
    routineId: run.routineId,
    routineName: redactSecretsInText(run.routineName),
    scheduledFor: run.scheduledFor,
    status: run.status,
  };
  if (run.goalStatus) card.goalStatus = run.goalStatus;
  if (run.deferredAt != null && run.status === "queued") card.deferredAt = run.deferredAt;
  if (run.threadId) card.executionThreadId = run.threadId;
  if (summary) card.summary = summary;
  if (error) card.error = error;
  return card;
}

function routineRunFallbackText(card: NonNullable<Message["routineRun"]>): string {
  const goalState = card.goalStatus === "needs-input"
    ? "needs your input"
    : card.goalStatus === "blocked"
      ? "was blocked"
      : card.goalStatus === "limit-reached"
        ? "reached its limit"
        : card.goalStatus === "stopped"
          ? "was stopped"
          : card.goalStatus === "failed"
            ? "failed"
            : undefined;
  const state = goalState ?? (
    card.status === "waiting"
      ? "needs your attention"
      : card.status === "completed"
        ? "completed"
        : card.status === "failed"
          ? "failed"
          : card.status === "cancelled"
            ? "was cancelled"
            : card.status === "missed"
              ? "was missed"
              : card.status === "queued" && card.deferredAt != null
                ? "deferred: target busy"
              : card.status
  );
  // Clients without the card (older phones) draw only this line, so it
  // carries what the run said, not just that it finished.
  const detail = card.summary ?? card.error;
  return `Routine “${card.routineName}” ${state}${detail ? `\n\n${detail}` : ""}`;
}

/** Upsert one durable lifecycle card per run. Replaying the same transition,
 * including restart recovery, patches the existing run id instead of adding
 * another chat message. */
function syncRoutineRunToSource(run: RoutineRun): string | null {
  const source = routineSourceOwner(run);
  if (!source) {
    const execution = run.threadId ? store.taskByThread(run.botId, run.threadId) : null;
    if (execution?.routineRunId === run.id) {
      store.patchTask(run.botId, execution.threadId, {
        routineRunId: undefined,
        ...(["waiting", "completed", "failed", "missed"].includes(run.status) ? { unread: true } : {}),
      });
    }
    return null;
  }
  const sourceThreadId = source.threadId;
  const card = routineRunCard(run);
  const text = routineRunFallbackText(card);
  const existing = store.messagesFor(sourceThreadId).find(
    (message: Message) => message.kind === "routine.run" && message.routineRun?.runId === run.id,
  );
  const statusChanged = existing?.routineRun?.status !== run.status;
  if (existing) {
    store.patchMessage(sourceThreadId, existing.id, { text, routineRun: card });
  } else {
    store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "routine.run",
      text,
      routineRun: card,
    });
  }

  // Mark only the fresh execution, after its first running card persisted
  // and before dispatch adds any transcript. A user can later promote it by
  // sending a normal follow-up; replaying/marking the old receipt seen must
  // never hide that conversation again.
  if (run.target === "bot" && run.triggerSource !== "webhook" && run.threadId && run.threadId !== sourceThreadId) {
    const execution = store.taskByThread(run.botId, run.threadId);
    const freshExecution = execution && run.status === "running" && !execution.routineRunId &&
      store.messagesFor(run.threadId).length === 0;
    if (execution && freshExecution) {
      store.patchTask(run.botId, run.threadId, { routineRunId: run.id, unread: false });
    } else if (execution?.routineRunId === run.id && execution.unread) {
      // Already this run. Clear the dot without rewriting the tag, so a
      // promoted thread (tag cleared, transcript present) stays visible.
      store.patchTask(run.botId, run.threadId, { unread: false });
    }
  }

  // Merely queueing/running is ambient progress. Attention and terminal
  // states become unread in the conversation where the user asked for them.
  if (statusChanged && ["waiting", "completed", "failed", "missed"].includes(run.status)) {
    store.patchTask(source.bot.id, sourceThreadId, { unread: true });
  }
  return sourceThreadId;
}

  return {
    routineSourceOwner,
    botMainThread,
    legacyResultsThread,
    routineSourceThread,
    syncRoutineRunToSource,
  };
}
