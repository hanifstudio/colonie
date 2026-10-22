// Memory: what this bot carries between conversations, in plain words. Two
// scopes (shared with every bot, and this bot alone), an explicit switch for
// each, and a list a person can edit or forget. It never shows transport,
// hashes or source message ids: a remembered fact names its conversation by
// date only.
//
// Fetched while the section is active; polling runs only while capture is
// working, to show background progress without a request loop when hidden.
// Every response is guarded by a request sequence, so switching bots or
// unmounting can never let a stale response populate another bot's list, and
// a conflicted save keeps the person's draft instead of reporting success.
import { Add01Icon, Delete02Icon, NoteEditIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { ApiError, api, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { useAdvancedMode } from "@/lib/interface-mode";
import type { MemoryEntry, MemoryKind, MemoryView } from "../../../shared/colonie-memory";
import { ConfirmDialog } from "../ConfirmDialog";
import { HIcon } from "../HIcon";
import { Switch } from "../SettingsPrimitives";
import { inputCls } from "./field";

const buttonCls = "rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50";
const quietButtonCls = "rounded-md px-2 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";

export interface MemorySectionState {
  view: MemoryView | null;
  error: string | null;
  conflict: boolean;
}

export const initialMemorySectionState: MemorySectionState = { view: null, error: null, conflict: false };

export type MemorySectionAction =
  | { type: "reset" }
  | { type: "loaded"; view: MemoryView; seq: number; current: number }
  | { type: "failed"; error: string; seq: number; current: number }
  | { type: "conflict" }
  | { type: "clearConflict" };

/** A stale response (another bot, or an unmounted panel) is dropped, never
 * merged. Kept pure so the guard is directly testable. */
export function memorySectionReducer(state: MemorySectionState, action: MemorySectionAction): MemorySectionState {
  switch (action.type) {
    case "reset":
      return initialMemorySectionState;
    case "loaded":
      return action.seq === action.current ? { view: action.view, error: null, conflict: state.conflict } : state;
    case "failed":
      return action.seq === action.current ? { ...state, error: action.error } : state;
    case "conflict":
      return { ...state, conflict: true };
    case "clearConflict":
      return { ...state, conflict: false };
  }
}

export function splitEntries(entries: readonly MemoryEntry[]): { shared: MemoryEntry[]; bot: MemoryEntry[] } {
  return { shared: entries.filter((entry) => entry.scope === "shared"), bot: entries.filter((entry) => entry.scope === "bot") };
}

export function formatMemoryDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** Human-friendly provenance. Never a message id or hash. */
export function sourceLabel(entry: MemoryEntry): string {
  const origin = entry.origin === "automatic" ? "Remembered automatically" : "Added by you";
  return entry.source ? `${origin} · from a conversation on ${formatMemoryDate(entry.source.at)}` : origin;
}

interface Draft {
  id: string;
  text: string;
  kind: MemoryKind;
  until: string;
  expectedRevision: string;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function ColonieMemorySection({ bot, active = true }: { bot: Bot; active?: boolean }) {
  const [state, dispatch] = useReducer(memorySectionReducer, initialMemorySectionState);
  const advanced = useAdvancedMode();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [adding, setAdding] = useState<{ scope: "shared" | "bot"; kind: MemoryKind; text: string; until: string } | null>(null);
  const [forgetTarget, setForgetTarget] = useState<MemoryEntry | null>(null);
  const [clearScope, setClearScope] = useState<"shared" | "bot" | null>(null);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const request = useCallback(
    async (path: string, init?: RequestInit): Promise<MemoryView | null> => {
      const current = ++seq.current;
      try {
        const next = await api<MemoryView>(path, init);
        if (current !== seq.current) return null;
        dispatch({ type: "loaded", view: next, seq: current, current: seq.current });
        return next;
      } catch (cause) {
        if (current !== seq.current) return null;
        if (cause instanceof ApiError && cause.status === 409) {
          dispatch({ type: "conflict" });
          return null;
        }
        dispatch({ type: "failed", error: messageOf(cause), seq: current, current: seq.current });
        return null;
      }
    },
    [],
  );

  const load = useCallback(async () => {
    const current = ++seq.current;
    try {
      const next = await api<MemoryView>(`/api/bots/${bot.id}/colonie-memory`);
      if (current !== seq.current) return null;
      dispatch({ type: "loaded", view: next, seq: current, current: seq.current });
      return next;
    } catch (cause) {
      dispatch({ type: "failed", error: messageOf(cause), seq: current, current: seq.current });
      return null;
    }
  }, [bot.id]);

  useEffect(() => {
    seq.current += 1;
    dispatch({ type: "reset" });
    setEditing(null);
    setAdding(null);
    setForgetTarget(null);
    setClearScope(null);
    setSaving(false);
    if (active) void load();
    return () => {
      seq.current += 1;
    };
  }, [bot.id, active, load]);

  const view = state.view;
  useEffect(() => {
    if (!active || saving) return;
    // New captures can begin after an initially idle view was loaded.
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 4000);
    return () => clearInterval(timer);
  }, [active, saving, load]);

  const patchPreferences = async (scope: "shared" | "bot", patch: Partial<{ enabled: boolean; automatic: boolean }>) => {
    if (!view) return;
    const current = scope === "shared" ? view.app : view.bot;
    setSaving(true);
    await request(`/api/bots/${bot.id}/colonie-memory/preferences`, {
      method: "PATCH",
      body: JSON.stringify({ scope, preferences: { ...current, ...patch }, expectedRevision: view.revision }),
    });
    setSaving(false);
  };

  const saveDraft = async () => {
    if (!view || !editing) return;
    setSaving(true);
    const next = await request(`/api/bots/${bot.id}/colonie-memory/entries/${editing.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        text: editing.text,
        kind: editing.kind,
        until: editing.until ? editing.until : null,
        expectedRevision: editing.expectedRevision,
      }),
    });
    if (next) setEditing(null);
    setSaving(false);
  };

  const addEntry = async () => {
    if (!view || !adding || !adding.text.trim()) return;
    setSaving(true);
    const next = await request(`/api/bots/${bot.id}/colonie-memory/entries`, {
      method: "POST",
      body: JSON.stringify({
        entry: {
          scope: adding.scope,
          kind: adding.kind,
          text: adding.text.trim(),
          ...(adding.until ? { until: adding.until } : {}),
        },
        expectedRevision: view.revision,
      }),
    });
    if (next) setAdding(null);
    setSaving(false);
  };

  const confirmForget = async () => {
    if (!view || !forgetTarget) return;
    setSaving(true);
    await request(`/api/bots/${bot.id}/colonie-memory/entries/${forgetTarget.id}?expectedRevision=${encodeURIComponent(view.revision)}`, {
      method: "DELETE",
    });
    setForgetTarget(null);
    setSaving(false);
  };

  const confirmClear = async () => {
    if (!view || !clearScope) return;
    setSaving(true);
    await request(`/api/bots/${bot.id}/colonie-memory/clear`, {
      method: "POST",
      body: JSON.stringify({ scope: clearScope, expectedRevision: view.revision }),
    });
    setClearScope(null);
    setSaving(false);
  };

  const lists = view ? splitEntries(view.entries) : { shared: [], bot: [] };

  return (
    <div role="region" aria-label="Bot memory" className="flex flex-col gap-4">
      <div className="px-1">
        <div className="text-[15px] font-medium text-ink">Memory</div>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
          What {bot.name} remembers between conversations, kept by itself. Read, change or forget anything here.
        </p>
      </div>

      {/* switching memory off is a builder's choice: Advanced mode only */}
      {view && advanced && (
        <div className="rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">Workspace memory</div>
          <p className="mt-1 text-[12.5px] text-ink-secondary">These controls affect memory for all your bots.</p>
          <label className="mt-3 flex items-center justify-between gap-3 text-[13px] text-ink">
            Use memory across Colonie
            <Switch checked={view.app.enabled} disabled={saving} aria-label="Use memory across Colonie" onClick={() => void patchPreferences("shared", { enabled: !view.app.enabled })} />
          </label>
          <label className="mt-2 flex items-center justify-between gap-3 text-[13px] text-ink">
            Automatic memory across Colonie
            <Switch checked={view.app.automatic} disabled={saving} aria-label="Automatic memory across Colonie" onClick={() => void patchPreferences("shared", { automatic: !view.app.automatic })} />
          </label>
        </div>
      )}

      {view && advanced && (
        <div className="rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">This bot</div>
          <label className="mt-3 flex items-center justify-between gap-3 text-[13px] text-ink">
            Use memory
            <Switch checked={view.bot.enabled} disabled={saving} aria-label="Use memory" onClick={() => void patchPreferences("bot", { enabled: !view.bot.enabled })} />
          </label>
          <label className="mt-2 flex items-center justify-between gap-3 text-[13px] text-ink">
            Remember useful details automatically
            <Switch checked={view.bot.automatic} disabled={saving} aria-label="Remember useful details automatically" onClick={() => void patchPreferences("bot", { automatic: !view.bot.automatic })} />
          </label>
        </div>
      )}

      {view && (
        <MemoryList
          title="About you · Shared with your bots"
          hint="Facts about you that any of your bots may recall."
          entries={lists.shared}
          onEdit={(entry) => setEditing({ id: entry.id, text: entry.text, kind: entry.kind, until: entry.until ?? "", expectedRevision: view.revision })}
          onForget={setForgetTarget}
          onClear={() => setClearScope("shared")}
          canClear={lists.shared.length > 0}
        />
      )}

      {view && (
        <MemoryList
          title={`Only ${bot.name}`}
          hint="Project facts and decisions kept private to this bot."
          entries={lists.bot}
          onEdit={(entry) => setEditing({ id: entry.id, text: entry.text, kind: entry.kind, until: entry.until ?? "", expectedRevision: view.revision })}
          onForget={setForgetTarget}
          onClear={() => setClearScope("bot")}
          canClear={lists.bot.length > 0}
        />
      )}

      {view && (adding ? (
        <div className="rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">Add a memory</div>
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex gap-2">
                <select className={cn(inputCls, "text-[13px]")} aria-label="Memory scope" value={adding.scope} onChange={(event) => setAdding({ ...adding, scope: event.target.value as "shared" | "bot" })}>
                  <option value="bot">Only {bot.name}</option>
                  <option value="shared">Shared with all bots</option>
                </select>
                <select className={cn(inputCls, "text-[13px]")} aria-label="Memory kind" value={adding.kind} onChange={(event) => setAdding({ ...adding, kind: event.target.value as MemoryKind })}>
                  <option value="preference">Preference</option>
                  <option value="fact">Fact</option>
                  <option value="decision">Decision</option>
                </select>
              </div>
              <textarea className={cn(inputCls, "min-h-[72px] resize-y text-[14px]")} aria-label="New memory text" value={adding.text} onChange={(event) => setAdding({ ...adding, text: event.target.value })} placeholder="What should be remembered?" />
              <div className="flex items-center gap-2">
                <label className="text-[12.5px] text-ink-secondary">
                  Holds until (optional)
                  <input type="date" className={cn(inputCls, "ml-2 inline-block w-auto py-1 text-[12.5px]")} value={adding.until} onChange={(event) => setAdding({ ...adding, until: event.target.value })} />
                </label>
              </div>
              <div className="flex gap-2">
                <button type="button" className={buttonCls} disabled={saving || !adding.text.trim()} onClick={() => void addEntry()}>{saving ? "Saving…" : "Add"}</button>
                <button type="button" className={quietButtonCls} disabled={saving} onClick={() => setAdding(null)}>Cancel</button>
              </div>
            </div>
        </div>
      ) : (
        <button type="button" className={cn(buttonCls, "flex items-center gap-1.5 self-start")} onClick={() => setAdding({ scope: "bot", kind: "fact", text: "", until: "" })}>
          <HIcon icon={Add01Icon} size={15} /> Add a memory
        </button>
      ))}

      {editing && (
        <div className="rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">Edit memory</div>
          {state.conflict && (
            <p className="mt-2 text-[12.5px] text-danger">Memory changed elsewhere. Your draft is kept; refresh to see the latest, or save again.</p>
          )}
          <textarea className={cn(inputCls, "mt-2 min-h-[72px] resize-y text-[14px]")} aria-label="Edit memory text" value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} />
          <div className="mt-2 flex items-center gap-2">
            <select className={cn(inputCls, "w-auto text-[13px]")} aria-label="Edit memory kind" value={editing.kind} onChange={(event) => setEditing({ ...editing, kind: event.target.value as MemoryKind })}>
              <option value="preference">Preference</option>
              <option value="fact">Fact</option>
              <option value="decision">Decision</option>
            </select>
            <input type="date" className={cn(inputCls, "w-auto py-1 text-[12.5px]")} aria-label="Edit memory until" value={editing.until} onChange={(event) => setEditing({ ...editing, until: event.target.value })} />
            <button type="button" className={buttonCls} disabled={saving || !editing.text.trim()} onClick={() => void saveDraft()}>{saving ? "Saving…" : "Save"}</button>
            <button type="button" className={quietButtonCls} disabled={saving} onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className={quietButtonCls} disabled={saving} onClick={() => {
              void load().then((next) => { if (next) {
                setEditing((current) => current && { ...current, expectedRevision: next.revision });
                dispatch({ type: "clearConflict" });
              } });
            }}>Refresh</button>
          </div>
        </div>
      )}

      {/* how automatic memory is doing: only when there is news, or in Advanced mode */}
      {view && (advanced || view.status.running || view.status.pending > 0 || view.status.lastError) && (
        <div className="rounded-xl bg-card p-4">
          <div className="flex items-center gap-2 text-[13px] text-ink-secondary">
            <HIcon icon={SparklesIcon} size={14} />
            {view.status.running
              ? "Noticing useful details from your last message…"
              : view.status.pending > 0
                ? `${view.status.pending} message${view.status.pending === 1 ? "" : "s"} waiting to be read.`
                : view.status.lastCaptureAt
                  ? `Last checked ${formatMemoryDate(view.status.lastCaptureAt)}.`
                  : "Nothing remembered automatically yet."}
          </div>
          {view.status.lastError && <p className="mt-1 text-[12px] text-warning">{view.status.lastError}</p>}
        </div>
      )}

      {state.error && <div className="text-[12.5px] text-danger">{state.error}</div>}

      <ConfirmDialog
        open={forgetTarget !== null}
        title="Forget this memory?"
        body="It will no longer be recalled in future conversations. Your past messages are unchanged."
        confirmLabel="Forget"
        pending={saving}
        onCancel={() => setForgetTarget(null)}
        onConfirm={() => void confirmForget()}
      />
      <ConfirmDialog
        open={clearScope !== null}
        title={clearScope === "shared" ? "Clear shared memory?" : `Clear ${bot.name}'s memory?`}
        body="Every memory in this list is removed from future recall. Your past messages are unchanged."
        confirmLabel="Clear"
        pending={saving}
        onCancel={() => setClearScope(null)}
        onConfirm={() => void confirmClear()}
      />
    </div>
  );
}

function MemoryList({
  title,
  hint,
  entries,
  onEdit,
  onForget,
  onClear,
  canClear,
}: {
  title: string;
  hint: string;
  entries: readonly MemoryEntry[];
  onEdit: (entry: MemoryEntry) => void;
  onForget: (entry: MemoryEntry) => void;
  onClear: () => void;
  canClear: boolean;
}) {
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[15px] font-medium text-ink">{title}</div>
          <p className="mt-0.5 text-[12.5px] text-ink-secondary">{hint}</p>
        </div>
        {canClear && (
          <button type="button" className={quietButtonCls} onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <div className="mt-3 text-[12.5px] text-ink-secondary">Nothing here yet.</div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {entries.map((entry) => (
            <div key={entry.id} className="rounded-lg bg-inset px-3 py-2">
              <div className="text-[13px] leading-relaxed text-ink">{entry.text}</div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-[11.5px] text-ink-secondary">{sourceLabel(entry)}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <button type="button" className={cn(quietButtonCls, "inline-flex items-center gap-1")} onClick={() => onEdit(entry)}>
                    <HIcon icon={NoteEditIcon} size={12} /> Edit
                  </button>
                  <button type="button" className={cn(quietButtonCls, "inline-flex items-center gap-1 text-danger")} onClick={() => onForget(entry)}>
                    <HIcon icon={Delete02Icon} size={12} /> Forget
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
