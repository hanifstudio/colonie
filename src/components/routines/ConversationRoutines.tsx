// The same routine controls in a bot DM and a group. Changes stay beside
// the chat; editing hands a draft to its existing composer.
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar03Icon, Loading02Icon, MultiplicationSignIcon, PauseIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "../HIcon";
import { ConfirmDialog } from "../ConfirmDialog";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { appendComposerDraft } from "@/lib/drafts";
import { latestRoutineRun, routineDateTime, routineNextLabel, routineRunLabel, routineRunTone, routineScheduleState } from "@/lib/routine-display";
import { scheduleLabel } from "@/lib/schedule-label";
import { api, useStore, type Bot } from "@/state/store";
import type { Routine, RoutineRun } from "@/lib/routines";

export function routinesInConversation(routines: readonly Routine[], threadId: string): Routine[] {
  return routines.filter((routine) => (routine.conversation?.threadId ?? routine.sourceThreadId ?? routine.resultsThreadId) === threadId);
}

export function ConversationRoutines({ threadId, botId, conversationId }: { threadId: string; botId?: string; conversationId?: string }) {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const routines = routinesInConversation(state.routines, threadId);
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-label={`Routines in this conversation${routines.length ? ` (${routines.length})` : ""}`} title="Routines in this conversation"
      className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink">
      <HIcon icon={Calendar03Icon} size={16} />
      <span className="max-sm:sr-only">Routines</span>
      {routines.length > 0 && <span className="tabular-nums text-ink-tertiary">{routines.length}</span>}
    </button>
    {open && <RoutineDialog threadId={threadId} botId={botId} conversationId={conversationId} onClose={() => setOpen(false)} />}
  </>;
}

function RoutineDialog({ threadId, botId, conversationId, onClose }: { threadId: string; botId?: string; conversationId?: string; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const dialog = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<Routine | null>(null);
  useModalDialog(dialog, () => { if (!deleting) onClose(); });
  const routines = routinesInConversation(state.routines, threadId);
  const draftId = conversationId ? `conversation:${conversationId}` : `bot:${botId}:${threadId}`;
  const ask = (routine?: Routine) => {
    const bot = state.bots.find((entry) => entry.id === (routine?.botId ?? botId));
    const text = routine ? `Change the routine "${routine.name}": ` : "Schedule a routine: ";
    appendComposerDraft(draftId, `${conversationId && bot ? `@${bot.name} ` : ""}${text}`);
    onClose();
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('main [data-tour="composer"] textarea')?.focus());
  };
  const act = async (routine: Routine, action: "pause" | "resume" | "run" | "delete" | "stop") => {
    setPending(routine.id); setError("");
    try {
      if (action === "pause" || action === "resume") {
        const response = await api<{ routine: Routine }>(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: action === "resume" }) });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else if (action === "delete") {
        await api(`/api/routines/${routine.id}`, { method: "DELETE" });
        dispatch({ type: "routineDeleted", routineId: routine.id }); setDeleting(null);
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
    } catch (cause) { setDeleting(null); setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  };
  return createPortal(<>
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) onClose(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Routines in this conversation" tabIndex={-1}
        className="flex max-h-[min(720px,85dvh)] w-full max-w-[540px] flex-col rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none">
        <div className="flex items-start gap-3 px-5 pb-4 pt-5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><HIcon icon={Calendar03Icon} size={19} /></span>
          <div className="min-w-0 flex-1"><h2 className="text-[16px] font-semibold text-ink">Routines</h2><p className="mt-0.5 text-[12.5px] text-ink-secondary">Scheduled work that reports back to this conversation.</p></div>
          <button type="button" onClick={onClose} aria-label="Close routines" className="rounded-full p-1.5 text-ink-secondary hover:bg-control hover:text-ink"><HIcon icon={MultiplicationSignIcon} size={17} /></button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 pb-4">
          {state.routinesLoadState === "loading" ? <p role="status" className="py-8 text-center text-[13px] text-ink-secondary">Loading routines…</p>
            : state.routinesLoadState === "error" ? <p role="alert" className="py-6 text-[13px] text-danger">Routines could not be loaded. Reconnect to the workspace and try again.</p>
            : <RoutineConversationList routines={routines} runs={state.routineRuns} bots={state.bots} pending={pending} onAction={(routine, action) => action === "delete" ? setDeleting(routine) : void act(routine, action)} onEdit={ask} />}
          {error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}</p>}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-hairline/40 px-5 py-3.5">
          <p className="text-[12px] text-ink-tertiary">Ask in chat to change the time or instructions.</p>
          <button type="button" onClick={() => ask()} className="shrink-0 rounded-full bg-accent px-3.5 py-2 text-[12.5px] font-medium text-white hover:brightness-110">Schedule in chat</button>
        </div>
      </div>
    </div>
    <ConfirmDialog open={Boolean(deleting)} title={`Delete “${deleting?.name ?? "routine"}”?`} body="Future runs will stop. Reports already in this conversation will stay." confirmLabel="Delete routine" pending={Boolean(pending)} onCancel={() => setDeleting(null)} onConfirm={() => { if (deleting) void act(deleting, "delete"); }} />
  </>, document.body);
}

type RoutineAction = "pause" | "resume" | "run" | "delete" | "stop";
export function RoutineConversationList({ routines, runs, bots, pending, onAction, onEdit }: {
  routines: readonly Routine[]; runs: readonly RoutineRun[]; bots: readonly Pick<Bot, "id" | "name">[]; pending: string | null;
  onAction: (routine: Routine, action: RoutineAction) => void; onEdit: (routine: Routine) => void;
}) {
  if (!routines.length) return <div className="rounded-xl bg-inset px-5 py-8 text-center"><p className="text-[14px] font-medium text-ink">Let a bot take care of it regularly</p><p className="mx-auto mt-2 max-w-80 text-[12.5px] leading-relaxed text-ink-secondary">Try “Every weekday at 9 AM, summarize our progress and report here.”</p></div>;
  return <ul className="space-y-2.5">{routines.map((routine) => {
    const run = latestRoutineRun(routine.id, runs);
    const active = runs.some((entry) => entry.routineId === routine.id && ["queued", "running", "waiting"].includes(entry.status));
    const done = routine.schedule.type === "once" && routine.schedule.at <= Date.now() && !routine.enabled;
    const button = "rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40";
    return <li key={routine.id} className="rounded-xl border border-hairline/40 bg-card p-3.5">
      <div className="flex items-baseline justify-between gap-2"><h3 className="min-w-0 break-words text-[14px] font-semibold text-ink">{routine.name}</h3><span className="shrink-0 text-[11.5px] text-ink-tertiary">{routineScheduleState(routine)}</span></div>
      <p className="mt-1 text-[12.5px] text-ink-secondary">{scheduleLabel(routine.schedule)}{routine.schedule.type === "daily" && routine.timeZone ? ` · ${routine.timeZone}` : ""}</p>
      <p className="mt-1 text-[11.5px] text-ink-tertiary">{bots.find((bot) => bot.id === routine.botId)?.name ?? "Bot"} · {routineNextLabel(routine)}</p>
      {run && <p aria-live="polite" className={`mt-2 text-[12px] ${routineRunTone(run)}`}>{routineRunLabel(run)} · {routineDateTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor)}{run.attention ? ` · ${run.attention}` : run.error ? ` · ${run.error}` : ""}</p>}
      <details className="mt-2 text-[12px] text-ink-secondary"><summary className="cursor-pointer py-1 hover:text-ink">Instructions</summary><p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{routine.prompt}</p></details>
      <div className="-ml-1 mt-2 flex flex-wrap items-center gap-0.5" aria-busy={pending === routine.id}>
        {pending === routine.id && <HIcon icon={Loading02Icon} size={13} className="ml-2 animate-spin text-ink-tertiary" />}
        <button type="button" className={button} disabled={Boolean(pending)} onClick={() => onEdit(routine)}>Edit in chat</button>
        {!done && <button type="button" className={button} disabled={Boolean(pending)} onClick={() => onAction(routine, routine.enabled ? "pause" : "resume")}><HIcon icon={routine.enabled ? PauseIcon : PlayIcon} size={12} className="mr-1 inline-block" />{routine.enabled ? "Pause" : "Resume"}</button>}
        <button type="button" className={button} disabled={Boolean(pending) || active} onClick={() => onAction(routine, "run")}>Run now</button>
        {active && <button type="button" className={button} disabled={Boolean(pending)} onClick={() => onAction(routine, "stop")}>Stop run</button>}
        <button type="button" className={`${button} ml-auto hover:text-danger`} disabled={Boolean(pending)} onClick={() => onAction(routine, "delete")}>Delete</button>
      </div>
    </li>;
  })}</ul>;
}
