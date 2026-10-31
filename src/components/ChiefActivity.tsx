// The chat work card: what the Chief has delegated from this conversation and
// where each task stands. It polls only while the card is mounted and the
// document is visible, guards against a stale response from a sibling
// conversation, and opens the target bot/task through the existing store
// navigation. It never shows transport or hash details.
import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";

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
      return "Needs your input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
    case "interrupted":
      return "Interrupted";
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
  const [expandedThread, setExpandedThread] = useState<string | null>(null);
  const detailsId = useId();

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
  const expanded = expandedThread === threadId;
  const working = assignments.filter((entry) => entry.status === "running" || entry.status === "queued").length;
  const waiting = assignments.filter((entry) => entry.status === "waiting").length;
  const summary = [working ? `${working} active` : "", waiting ? `${waiting} needs input` : ""].filter(Boolean).join(" · ") || `${assignments.length} past ${assignments.length === 1 ? "task" : "tasks"}`;

  return (
    <section aria-label="Delegated work" className="rounded-xl border border-hairline/40 bg-card px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <button type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpandedThread(expanded ? null : threadId)}
          className="flex min-w-0 items-center gap-2 text-[13px] text-ink-secondary hover:text-ink">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="font-medium text-ink">Work</span>
          <span>{state.error ? "Could not refresh" : summary}</span>
        </button>
        {expanded && <button type="button" aria-label="Close work" title="Hide work; tasks keep running" onClick={() => setExpandedThread(null)}
          className="rounded p-1 text-ink-secondary hover:bg-control hover:text-ink"><X size={14} /></button>}
      </div>
      {expanded && <div id={detailsId}>
      {state.error ? <p role="alert" className="mt-1 text-[12.5px] text-danger">{state.error}</p> : null}
      <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
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
                  View work
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      </div>}
    </section>
  );
}
