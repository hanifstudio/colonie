// A compact section in the existing conversation side panel. A routine opens
// its controls inline; scheduling and editing hand a draft to the chat.
import { useEffect, useRef, useState } from "react";
import { ArrowRight01Icon, CalendarClockIcon, Loading02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "../HIcon";
import { appendComposerDraft } from "@/lib/drafts";
import { latestRoutineRun, routineDateTime, routineNextLabel, routineRunLabel, routineRunTone, routineScheduleState } from "@/lib/routine-display";
import { scheduleLabel } from "@/lib/schedule-label";
import { api, useStore, type Bot } from "@/state/store";
import type { Routine, RoutineRun } from "@/lib/routines";

export function routinesInConversation(routines: readonly Routine[], threadId: string): Routine[] {
  return routines.filter((routine) => (routine.conversation?.threadId ?? routine.sourceThreadId ?? routine.resultsThreadId) === threadId);
}

export function ConversationRoutines({ threadId, botId, conversationId }: { threadId: string; botId?: string; conversationId?: string }) {
  const { state, dispatch } = useStore();
  const addButton = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const routines = routinesInConversation(state.routines, threadId);
  const draftId = conversationId ? `conversation:${conversationId}` : `bot:${botId}:${threadId}`;
  const ask = (routine?: Routine) => {
    const bot = state.bots.find((entry) => entry.id === (routine?.botId ?? botId));
    const text = routine ? `Change the routine "${routine.name}": ` : "Schedule a routine: ";
    appendComposerDraft(draftId, `${conversationId && bot ? `@${bot.name} ` : ""}${text}`);
    // On a narrow window the side panel covers the composer.
    if (window.matchMedia("(max-width: 767px)").matches) {
      dispatch({ type: "toggleComputer", open: false });
      dispatch({ type: "toggleGroupPanel", open: false });
    }
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('main [data-tour="composer"] textarea')?.focus());
  };
  const act = async (routine: Routine, action: RoutineAction) => {
    setPending(routine.id); setError("");
    try {
      if (action === "pause" || action === "resume") {
        const response = await api<{ routine: Routine }>(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: action === "resume" }) });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else if (action === "delete") {
        await api(`/api/routines/${routine.id}`, { method: "DELETE" });
        dispatch({ type: "routineDeleted", routineId: routine.id });
        addButton.current?.focus();
      } else if (action === "run") {
        const response = await api<{ run: RoutineRun }>(`/api/routines/${routine.id}/run`, { method: "POST" });
        dispatch({ type: "routineRunPatched", run: response.run });
      } else {
        const run = state.routineRuns.find((entry) => entry.routineId === routine.id && ["queued", "running", "waiting"].includes(entry.status));
        if (run) {
          const response = await api<{ run: RoutineRun }>(`/api/routine-runs/${run.id}/cancel`, { method: "POST" });
          dispatch({ type: "routineRunPatched", run: response.run });
        }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  };
  return <section aria-label="Routines in this conversation">
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="text-[13px] font-medium text-ink">Routines</h2>
      <button ref={addButton} type="button" onClick={() => ask()} aria-label="Schedule a routine in chat" title="Schedule in chat"
        className="flex size-7 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
        <HIcon icon={PlusSignIcon} size={17} />
      </button>
    </div>
    {state.routinesLoadState === "loading" ? <p role="status" className="py-2 text-[12px] text-ink-secondary">Loading routines…</p>
      : state.routinesLoadState === "error" ? <p role="alert" className="py-2 text-[12px] text-danger">Routines could not be loaded. Reconnect to the workspace and try again.</p>
      : <RoutineConversationList routines={routines} runs={state.routineRuns} bots={state.bots} pending={pending} onAction={(routine, action) => void act(routine, action)} onEdit={ask} />}
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
  </section>;
}

type RoutineAction = "pause" | "resume" | "run" | "delete" | "stop";
type RoutineListProps = {
  routines: readonly Routine[]; runs: readonly RoutineRun[]; bots: readonly Pick<Bot, "id" | "name">[]; pending: string | null;
  onAction: (routine: Routine, action: RoutineAction) => void; onEdit: (routine: Routine) => void;
};
export function RoutineConversationList({ routines, ...props }: RoutineListProps) {
  if (!routines.length) return <p className="py-1 text-[12px] leading-relaxed text-ink-tertiary">No routines yet. Ask in chat, for example “Every weekday at 9 AM, summarize our progress.”</p>;
  return <ul className="space-y-0.5">{routines.map((routine) => <RoutineRow key={routine.id} routine={routine} {...props} />)}</ul>;
}

function RoutineRow({ routine, runs, bots, pending, onAction, onEdit }: Omit<RoutineListProps, "routines"> & { routine: Routine }) {
  const [deleting, setDeleting] = useState(false);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const wasDeleting = useRef(false);
  useEffect(() => {
    if (deleting) cancelDelete.current?.focus();
    else if (wasDeleting.current) deleteButton.current?.focus();
    wasDeleting.current = deleting;
  }, [deleting]);
  const run = latestRoutineRun(routine.id, runs);
  const active = runs.some((entry) => entry.routineId === routine.id && ["queued", "running", "waiting"].includes(entry.status));
  const done = routine.schedule.type === "once" && routine.schedule.at <= Date.now() && !routine.enabled;
  const button = "rounded-md px-2 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40";
  const cancel = () => setDeleting(false);
  return <li>
    <details className="group/routine rounded-lg open:bg-control/30">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-lg px-1 py-2 hover:bg-control/50 focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <HIcon icon={CalendarClockIcon} size={17} className={`shrink-0 ${routine.enabled ? "text-success" : "text-ink-tertiary"}`} />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-[13px] font-medium text-ink">{routine.name}</span>
          <span className="mt-0.5 block text-[12px] text-ink-secondary">{scheduleLabel(routine.schedule)}{routine.schedule.type === "daily" && routine.timeZone ? ` · ${routine.timeZone}` : ""}</span>
          {!routine.enabled && <span className="mt-0.5 block text-[11px] text-ink-tertiary">{routineScheduleState(routine)}</span>}
          {run && (active || run.status === "failed" || run.status === "missed") && <span className={`mt-0.5 block text-[11px] ${routineRunTone(run)}`}>{run.attention ?? run.error ?? routineRunLabel(run)}</span>}
        </span>
        <HIcon icon={ArrowRight01Icon} size={12} className="shrink-0 text-ink-tertiary transition-transform group-open/routine:rotate-90" />
      </summary>
      <div className="pb-2 pl-8 pr-1">
        <p className="text-[11.5px] text-ink-tertiary">{bots.find((bot) => bot.id === routine.botId)?.name ?? "Bot"} · {routineNextLabel(routine)}</p>
        {run && <p aria-live="polite" className={`mt-1.5 text-[11.5px] ${routineRunTone(run)}`}>{routineRunLabel(run)} · {routineDateTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor)}{run.attention ? ` · ${run.attention}` : run.error ? ` · ${run.error}` : ""}</p>}
        <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-secondary">{routine.prompt}</p>
        {deleting ? <div role="group" aria-label={`Delete ${routine.name}`} className="mt-2 rounded-lg border border-hairline/50 p-2.5" onKeyDown={(event) => { if (event.key === "Escape" && !pending) { event.stopPropagation(); cancel(); } }}>
          <p className="text-[12px] text-ink">Delete this routine?</p>
          <p className="mt-1 text-[11.5px] text-ink-secondary">Future runs will stop. Reports in this conversation will stay.</p>
          <div className="mt-2 flex flex-wrap gap-1">
            <button ref={cancelDelete} type="button" className={button} disabled={Boolean(pending)} onClick={cancel}>Cancel</button>
            <button type="button" className={`${button} text-danger`} disabled={Boolean(pending)} onClick={() => onAction(routine, "delete")}>Delete routine</button>
          </div>
        </div> : <div className="-ml-2 mt-2 flex flex-wrap items-center gap-0.5" aria-busy={pending === routine.id}>
          {pending === routine.id && <HIcon icon={Loading02Icon} size={13} className="ml-2 animate-spin text-ink-tertiary" />}
          <button type="button" className={button} disabled={Boolean(pending)} onClick={() => onEdit(routine)}>Edit in chat</button>
          {!done && <button type="button" className={button} disabled={Boolean(pending)} onClick={() => onAction(routine, routine.enabled ? "pause" : "resume")}>{routine.enabled ? "Pause" : "Resume"}</button>}
          <button type="button" className={button} disabled={Boolean(pending) || active} onClick={() => onAction(routine, "run")}>Run now</button>
          {active && <button type="button" className={button} disabled={Boolean(pending)} onClick={() => onAction(routine, "stop")}>Stop run</button>}
          <button ref={deleteButton} type="button" className={`${button} hover:text-danger`} disabled={Boolean(pending)} onClick={() => setDeleting(true)}>Delete</button>
        </div>}
      </div>
    </details>
  </li>;
}
