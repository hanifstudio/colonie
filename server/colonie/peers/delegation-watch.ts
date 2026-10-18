// The delegation watch: one entry per conversation waiting on work another bot
// does for it, and the one place that ends such a watch. The receipt is written
// before any mirror short-circuits, so a delegating bot's check or wait always
// sees a terminal state — even when the channel, the target or the peer access
// behind it is gone. The map itself stays the caller's: whoever dispatches the
// delegated turn puts the entry in, this module takes it out.
import type { BotRecord, Message, Store } from "../../persistence/store.ts";
import { recordDelegationReceipt } from "./delegations.ts";
import { canReachPeer } from "./peer-roster.ts";

export interface DelegationWatchEntry {
toBotId: string;
toBotName?: string;
taskId?: string;
sourceThreadId?: string;
sourceBotId?: string;
/** Bind a late peer result to the run that requested it, not later user
 * work that happens to reuse that run's execution conversation. */
routineRunId?: string;
/** when the delegated turn was dispatched — elapsed time for status checks */
startedAtMs?: number;
/** Cross-bot send: leave the terminal state in the recipient thread. */
oneWay?: boolean;
/** An external runtime's handoff: record the receipt, never wake the source. */
completionOwner?: "external";
}

export interface DelegationWatchDeps {
  store: Store;
  markTaskContextExternallyUpdated: (bot: BotRecord, threadId: string) => void;
  wakeDelegationSource: (source: BotRecord, threadId: string, targetName: string, failureReason?: string, routineRunId?: string) => void;
}

export function createDelegationWatch(deps: DelegationWatchDeps) {
  const { store, markTaskContextExternallyUpdated, wakeDelegationSource } = deps;
  const delegationWatch = new Map<string, DelegationWatchEntry>();
function finalizeDelegationWatch(
  threadId: string,
  ok: boolean,
  reply = "",
  failureName = "Delegated turn did not finish",
): boolean {
  const watched = delegationWatch.get(threadId);
  if (!watched) return false;
  delegationWatch.delete(threadId);
  const target = store.bot(watched.toBotId);
  const targetName = target?.name ?? watched.toBotName ?? watched.toBotId;
  const source = watched.sourceBotId
    ? store.bot(watched.sourceBotId)
    : (watched.sourceThreadId ? store.botByThread(watched.sourceThreadId) : undefined);
  if (!watched.oneWay && source && target && !canReachPeer(source, target)) {
    ok = false;
    reply = "";
    failureName = "Result withheld: team or peer access changed while the teammate was working";
  }
  // The receipt is written before any mirror short-circuits: the delegating
  // bot's check/wait_delegation must see a terminal state even when the
  // channel or target is gone.
  if (watched.taskId && watched.sourceThreadId) {
    recordDelegationReceipt({
      id: watched.taskId,
      sourceThreadId: watched.sourceThreadId,
      toBotId: watched.toBotId,
      toBotName: store.bot(watched.toBotId)?.name ?? watched.toBotId,
      status: ok ? "done" : "failed",
      result: ok ? reply : failureName,
    });
  }
  if (watched.oneWay) {
    if (!ok && store.taskByThread(watched.toBotId, threadId)) {
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Send failed — ${failureName}`, ok: false, ...(watched.taskId ? { handoffId: watched.taskId } : {}) },
      });
    }
    return true;
  }
  if (source && watched.sourceThreadId) {
    if (store.groupByThread(watched.sourceThreadId)) {
      // A delegation queued from a stored room before rooms were retired.
      // Room transcripts are read-only history, so the result stays in the
      // target's own thread instead of being written into the room.
    } else if (store.taskByThread(source.id, watched.sourceThreadId)) {
      // 1:1 source: the source thread is the delegating bot's own task.
      if (ok && reply.trim()) {
        const sourceReply: Omit<Message, "id" | "at"> = {
          role: "bot",
          kind: "text",
          text: `@${targetName} replied to the delegated task:\n\n${reply.trim()}`,
        };
        if (target) sourceReply.from = { botId: target.id, name: target.name, color: target.color };
        store.appendMessage(watched.sourceThreadId, sourceReply);
      } else {
        store.appendMessage(watched.sourceThreadId, {
          role: "bot",
          kind: "activity",
          tool: {
            name: ok
              ? `Delegation to @${targetName} completed without a text reply`
              : `Delegation to @${targetName} failed — ${failureName}`,
            ok,
          },
        });
      }
      markTaskContextExternallyUpdated(source, watched.sourceThreadId);
      // Peer wake: a settled delegated turn resumes the source bot so it
      // folds the result in and answers the user, instead of sitting idle
      // with the reply only visible in the thread (the "delegated and went
      // silent" gap). Failures wake it too — the user must hear the task did
      // not finish. Idle-checked and burst-capped so a busy source or a
      // re-delegating loop cannot spin up runs. An external runtime polls
      // for the receipt instead; waking would answer it a second time.
      if (watched.completionOwner !== "external") {
        if (ok) {
          wakeDelegationSource(source, watched.sourceThreadId, targetName, undefined, watched.routineRunId);
        } else {
          wakeDelegationSource(source, watched.sourceThreadId, targetName, failureName || "the delegated turn did not finish", watched.routineRunId);
        }
      }
    }
  }

  return true;
}
  return { delegationWatch, finalizeDelegationWatch };
}
