// The chat work card: what the Chief has delegated from this conversation and
// where each task stands. It polls only while the card is mounted and the
// document is visible, guards against a stale response from a sibling
// conversation, and opens the target bot/task through the existing store
// navigation. It never shows transport or hash details.
import { useCallback, useEffect, useReducer, useRef } from "react";

import { api, openThread, useStore } from "@/state/store";
import type { ChiefAssignment, ChiefAssignmentStatus, ChiefView } from "../../shared/colonie-chief";

export interface ChiefActivityState {
  view: ChiefView | null;
  error: string | null;
}

export const initialChiefActivityState: ChiefActivityState = { view: null, error: null };

export type ChiefActivityAction =
  | { type: "reset" }
  | { type: "loaded"; view: ChiefView; seq: number; current: number }
  | { type: "failed"; error: string; seq: number; current: number };

/** Ignore a response that belongs to another conversation or an unmounted card. */
export function chiefActivityReducer(state: ChiefActivityState, action: ChiefActivityAction): ChiefActivityState {
  switch (action.type) {
    case "reset":
      return initialChiefActivityState;
    case "loaded":
      return action.seq === action.current ? { view: action.view, error: null } : state;
    case "failed":
      return action.seq === action.current ? { ...state, error: action.error } : state;
  }
}

/** Plain words for each task state, including the interrupted-after-restart case. */
export function assignmentStatusLabel(status: ChiefAssignmentStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Working";
    case "waiting":
      return "Needs your approval";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
    case "interrupted":
      return "Stopped";
  }
}

export function assignmentPreview(assignment: ChiefAssignment): string {
  return assignment.result ?? assignment.error ?? "";
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function ChiefActivity({ botId, threadId }: { botId: string; threadId: string }) {
  const { state: appState, dispatch: appDispatch } = useStore();
  const [state, dispatch] = useReducer(chiefActivityReducer, initialChiefActivityState);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const current = ++seq.current;
    try {
      const view = await api<ChiefView>(`/api/colonie/chief?threadId=${encodeURIComponent(threadId)}`);
      if (current !== seq.current) return;
      dispatch({ type: "loaded", view, seq: current, current: seq.current });
    } catch (cause) {
      if (current !== seq.current) return;
      dispatch({ type: "failed", error: messageOf(cause), seq: current, current: seq.current });
    }
  }, [threadId]);

  useEffect(() => {
    seq.current += 1;
    dispatch({ type: "reset" });
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 4000);
    return () => {
      seq.current += 1;
      clearInterval(timer);
    };
  }, [botId, threadId, load]);

  const assignments = state.view?.assignments ?? [];
  if (!assignments.length && !state.error) return null;

  return (
    <div className="rounded-xl border border-hairline/40 bg-card p-3">
      <div className="text-[13px] font-medium text-ink">Chief work</div>
      {state.error ? <p className="mt-1 text-[12.5px] text-danger">{state.error}</p> : null}
      <ul className="mt-2 space-y-2">
        {assignments.map((assignment) => {
          const name = appState.bots.find((bot) => bot.id === assignment.targetBotId)?.name ?? assignment.targetBotId;
          const preview = assignmentPreview(assignment);
          return (
            <li key={assignment.id} className="rounded-lg border border-hairline/40 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] text-ink">{name}</span>
                <span className="text-[12px] text-ink-secondary">{assignmentStatusLabel(assignment.status)}</span>
              </div>
              <p className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{assignment.message}</p>
              {preview ? <p className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-secondary">{preview}</p> : null}
              {assignment.targetThreadId ? (
                <button
                  type="button"
                  className="mt-1 text-[12.5px] text-accent hover:underline"
                  onClick={() => openThread(appDispatch, { botId: assignment.targetBotId, threadId: assignment.targetThreadId! }, appState)}
                >
                  Open task
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}