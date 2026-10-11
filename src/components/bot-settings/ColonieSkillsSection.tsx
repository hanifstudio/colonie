// Skills: the guides this bot reads when a task matches, managed in plain
// words. A person types a name, a "when to use" line and instructions; the
// server owns the SKILL.md envelope. Imports land disabled and are read in
// full before they can be switched on — the review step is the existing
// behavior, not a new technical setup. Shared library guides can be assigned
// to this bot; their own enablement stays a library-wide decision.
//
// Fetched while the section is active. Every response is guarded by a
// request sequence, so switching bots or unmounting can never let a stale
// response populate another bot's list, and a conflicted save keeps the
// person's draft instead of reporting success. No hashes, paths or transport
// details appear in the default UI.
import { BookOpen01Icon, Delete02Icon, NoteEditIcon } from "@hugeicons/core-free-icons";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { ApiError, api, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import type { ColonieSkill, ColonieSkillsView } from "../../../shared/colonie-skills";
import { HIcon } from "../HIcon";
import { Switch } from "../SettingsPrimitives";
import { Field, inputCls } from "./field";

const quietButtonCls = "rounded-md px-2 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";
const primaryButtonCls = "rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50";
const softButtonCls = "rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50";

export interface SkillsSectionState {
  view: ColonieSkillsView | null;
  error: string | null;
  conflict: boolean;
}

export const initialSkillsSectionState: SkillsSectionState = { view: null, error: null, conflict: false };

export type SkillsSectionAction =
  | { type: "reset" }
  | { type: "loaded"; view: ColonieSkillsView; seq: number; current: number }
  | { type: "failed"; error: string; seq: number; current: number }
  | { type: "conflict" }
  | { type: "clearConflict" };

/** A stale response (another bot, or an unmounted panel) is dropped, never
 * merged. Kept pure so the guard is directly testable. */
export function skillsSectionReducer(state: SkillsSectionState, action: SkillsSectionAction): SkillsSectionState {
  switch (action.type) {
    case "reset":
      return initialSkillsSectionState;
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

export function skillOriginLabel(skill: ColonieSkill): string {
  return skill.origin === "library" ? "Library" : "This bot";
}

/** The editable body of a saved guide, with the frontmatter envelope removed. */
export function instructionsFromSkillMd(text: string): string {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return (match?.[1] ?? text).trimStart();
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface Draft {
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
}

const EMPTY_DRAFT: Draft = { name: "", description: "", instructions: "", enabled: true };

export function ColonieSkillsSection({ bot, active = true }: { bot: Bot; active?: boolean }) {
  const [state, dispatch] = useReducer(skillsSectionReducer, initialSkillsSectionState);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [creating, setCreating] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<(Draft & { expectedSha256: string }) | null>(null);
  const [viewing, setViewing] = useState<{ name: string; text: string } | null>(null);
  const [source, setSource] = useState("");
  const [pasted, setPasted] = useState("");
  const [libraryChoice, setLibraryChoice] = useState("");
  const seq = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const view = state.view;

  const load = useCallback(async () => {
    const current = ++seq.current;
    try {
      const next = await api<ColonieSkillsView>(`/api/bots/${bot.id}/colonie-skills`);
      if (current !== seq.current) return null;
      dispatch({ type: "loaded", view: next, seq: current, current: seq.current });
      return next;
    } catch (cause) {
      if (current === seq.current) dispatch({ type: "failed", error: messageOf(cause), seq: current, current: seq.current });
      return null;
    } finally {
      if (current === seq.current) setLoading(false);
    }
  }, [bot.id]);

  useEffect(() => {
    seq.current += 1;
    dispatch({ type: "reset" });
    setCreating(EMPTY_DRAFT);
    setEditing(null);
    setViewing(null);
    setSource("");
    setPasted("");
    setLibraryChoice("");
    setWorking("");
    setLoading(true);
    if (active) void load();
    return () => {
      seq.current += 1;
    };
  }, [bot.id, active, load]);

  const send = useCallback(
    async (path: string, init: RequestInit): Promise<ColonieSkillsView | null> => {
      const current = seq.current;
      try {
        const next = await api<ColonieSkillsView>(path, init);
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

  const submitCreate = async () => {
    if (!view || !creating.name.trim() || !creating.description.trim() || !creating.instructions.trim()) return;
    setWorking("create");
    const next = await send(`/api/bots/${bot.id}/colonie-skills`, {
      method: "POST",
      body: JSON.stringify({ skill: creating, expectedRevision: view.revision }),
    });
    if (next) setCreating(EMPTY_DRAFT);
    setWorking("");
  };

  const openEdit = async (skill: ColonieSkill) => {
    setWorking(skill.name);
    try {
      const content = await api<{ skill: ColonieSkill; text: string }>(
        `/api/bots/${bot.id}/colonie-skills/${encodeURIComponent(skill.name)}`,
      );
      setEditing({
        name: content.skill.name,
        description: content.skill.description,
        instructions: instructionsFromSkillMd(content.text),
        enabled: content.skill.enabled,
        expectedSha256: content.skill.sha256,
      });
    } catch (cause) {
      dispatch({ type: "failed", error: messageOf(cause), seq: seq.current, current: seq.current });
    } finally {
      setWorking("");
    }
  };

  const submitEdit = async () => {
    if (!view || !editing) return;
    setWorking(editing.name);
    const next = await send(`/api/bots/${bot.id}/colonie-skills/${encodeURIComponent(editing.name)}`, {
      method: "PATCH",
      body: JSON.stringify({
        skill: { name: editing.name, description: editing.description, instructions: editing.instructions, enabled: editing.enabled },
        expectedRevision: view.revision,
        expectedSha256: editing.expectedSha256,
      }),
    });
    if (next) setEditing(null);
    setWorking("");
  };

  const toggle = async (skill: ColonieSkill, enabled: boolean) => {
    if (!view) return;
    setWorking(skill.name);
    await send(`/api/bots/${bot.id}/colonie-skills/${encodeURIComponent(skill.name)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled, expectedRevision: view.revision }),
    });
    setWorking("");
  };

  const review = async (skill: ColonieSkill) => {
    setWorking(skill.name);
    try {
      const content = await api<{ text: string }>(`/api/bots/${bot.id}/colonie-skills/${encodeURIComponent(skill.name)}`);
      setViewing({ name: skill.name, text: content.text });
    } catch (cause) {
      dispatch({ type: "failed", error: messageOf(cause), seq: seq.current, current: seq.current });
    } finally {
      setWorking("");
    }
  };

  const remove = async (skill: ColonieSkill) => {
    if (!view) return;
    setWorking(skill.name);
    await send(
      `/api/bots/${bot.id}/colonie-skills/${encodeURIComponent(skill.name)}?expectedRevision=${encodeURIComponent(view.revision)}`,
      { method: "DELETE" },
    );
    setWorking("");
  };

  const importSkill = async () => {
    if (!view || (!source.trim() && !pasted.trim())) return;
    setWorking("import");
    const body = pasted.trim()
      ? { text: pasted, ...(source.trim() ? { source: source.trim() } : {}), expectedRevision: view.revision }
      : { source: source.trim(), expectedRevision: view.revision };
    const next = await send(`/api/bots/${bot.id}/colonie-skills/import`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (next) {
      setSource("");
      setPasted("");
      if (fileRef.current) fileRef.current.value = "";
    }
    setWorking("");
  };

  const assignLibrary = async (name: string, remove: boolean) => {
    if (!view) return;
    const names = remove
      ? view.assignedSkills.filter((entry) => entry !== name)
      : [...new Set([...view.assignedSkills, name])];
    setWorking(name);
    await send(`/api/bots/${bot.id}/colonie-skills/assign`, {
      method: "PUT",
      body: JSON.stringify({ names, expectedRevision: view.revision }),
    });
    setWorking("");
    setLibraryChoice("");
  };

  const librarySkills = view?.skills.filter((skill) => skill.origin === "library") ?? [];

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-center gap-2">
        <HIcon icon={BookOpen01Icon} size={16} className="text-ink-secondary" />
        <div className="text-[15px] font-medium text-ink">Skills</div>
      </div>
      <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
        Guides are reusable instructions {bot.name} reads when a task matches. Changes apply to future requests; older
        conversations keep their own history.
      </div>

      {state.conflict && (
        <div className="mt-2 flex items-center justify-between rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span>These guides changed elsewhere. Your draft was kept.</span>
          <button type="button" className={quietButtonCls} onClick={() => { dispatch({ type: "clearConflict" }); void load(); }}>
            Refresh
          </button>
        </div>
      )}

      {loading ? (
        <div className="mt-3 text-[12px] text-ink-secondary">Loading…</div>
      ) : (
        <>
          {view && view.skills.length > 0 ? (
            <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
              {view.skills.map((skill) => (
                <div key={skill.name} className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => void review(skill)} className="min-w-0 flex-1 text-left">
                      <div className="truncate font-mono text-[12.5px] text-ink">{skill.name}</div>
                      <span className="mt-0.5 inline-block rounded bg-control px-1.5 py-px text-[10px] uppercase tracking-wide text-ink-secondary">
                        {skillOriginLabel(skill)}
                      </span>
                      <div className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-secondary">{skill.description}</div>
                    </button>
                    {skill.origin === "private" ? (
                      <Switch
                        checked={skill.enabled}
                        aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                        disabled={Boolean(working)}
                        onClick={() => void toggle(skill, !skill.enabled)}
                      />
                    ) : (
                      <button
                        type="button"
                        disabled={Boolean(working)}
                        onClick={() => void assignLibrary(skill.name, true)}
                        className={quietButtonCls}
                      >
                        Unassign
                      </button>
                    )}
                    {skill.editable && (
                      <button
                        type="button"
                        aria-label={`Edit ${skill.name}`}
                        disabled={Boolean(working)}
                        onClick={() => void openEdit(skill)}
                        className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
                      >
                        <HIcon icon={NoteEditIcon} size={15} />
                      </button>
                    )}
                    {skill.origin === "private" && (
                      <button
                        type="button"
                        aria-label={`Remove ${skill.name}`}
                        disabled={Boolean(working)}
                        onClick={() => void remove(skill)}
                        className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                      >
                        <HIcon icon={Delete02Icon} size={15} />
                      </button>
                    )}
                  </div>
                  <div className="mt-1 truncate text-[10.5px] text-ink-secondary" title={skill.source}>
                    Source: {skill.source}
                  </div>
                  {skill.warnings.length > 0 && (
                    <div className="mt-1 text-[10.5px] text-warning">{skill.warnings.join(" · ")}</div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">
              No guides yet. Create one below, or import an existing SKILL.md.
            </div>
          )}

          <div className="mt-4 flex flex-col gap-2 rounded-lg bg-inset/60 p-3">
            <div className="text-[13px] font-medium text-ink">Create a guide</div>
            <Field label="Name">
              <input
                className={inputCls}
                aria-label="New guide name"
                placeholder="weekly-report"
                value={creating.name}
                onChange={(e) => setCreating({ ...creating, name: e.target.value })}
              />
            </Field>
            <Field label="When to use">
              <input
                className={inputCls}
                aria-label="New guide description"
                placeholder="Use when the user asks for the weekly report."
                value={creating.description}
                onChange={(e) => setCreating({ ...creating, description: e.target.value })}
              />
            </Field>
            <Field label="Instructions">
              <textarea
                className={cn(inputCls, "min-h-24 font-mono text-[13px]")}
                aria-label="New guide instructions"
                placeholder="Steps and details the bot should follow."
                value={creating.instructions}
                onChange={(e) => setCreating({ ...creating, instructions: e.target.value })}
              />
            </Field>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
                <input
                  type="checkbox"
                  checked={creating.enabled}
                  onChange={(e) => setCreating({ ...creating, enabled: e.target.checked })}
                />
                Usable as soon as I save
              </label>
              <button
                type="button"
                className={primaryButtonCls}
                disabled={Boolean(working) || !creating.name.trim() || !creating.description.trim() || !creating.instructions.trim()}
                onClick={() => void submitCreate()}
              >
                {working === "create" ? "Saving…" : "Create guide"}
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            <div className="text-[13px] font-medium text-ink">Import a guide</div>
            <div className="flex items-center gap-2">
              <input
                className={inputCls}
                aria-label="Import a guide from a URL"
                placeholder="owner/repo, GitHub SKILL.md URL, or skills.sh URL"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
              <button type="button" className={softButtonCls} disabled={Boolean(working) || (!source.trim() && !pasted.trim())} onClick={() => void importSkill()}>
                {working === "import" ? "Importing…" : "Import"}
              </button>
            </div>
            <textarea
              className={cn(inputCls, "min-h-20 font-mono text-[13px]")}
              aria-label="Paste SKILL.md"
              placeholder="…or paste SKILL.md text here"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <input
              ref={fileRef}
              type="file"
              accept=".md,text/markdown,text/plain"
              aria-label="Import a SKILL.md file"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setPasted(await file.text());
              }}
            />
            <div className="text-[11.5px] text-ink-secondary">Imported guides start switched off. Open one and read it before turning it on.</div>
          </div>

          {view && view.library.length > 0 && (
            <div className="mt-4 flex flex-col gap-2">
              <div className="text-[13px] font-medium text-ink">Add a guide from the library</div>
              <div className="flex items-center gap-2">
                <select
                  aria-label="Add a guide from the library"
                  value={libraryChoice}
                  disabled={Boolean(working)}
                  onChange={(e) => setLibraryChoice(e.target.value)}
                  className={cn(inputCls, "truncate")}
                >
                  <option value="">Choose a library guide…</option>
                  {view.library.map((skill) => (
                    <option key={skill.name} value={skill.name}>{skill.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className={softButtonCls}
                  disabled={!libraryChoice || Boolean(working)}
                  onClick={() => void assignLibrary(libraryChoice, false)}
                >
                  Add
                </button>
              </div>
            </div>
          )}

          {librarySkills.length > 0 && (
            <div className="mt-2 text-[11.5px] text-ink-secondary">
              Library guides are shared. Their on/off state is managed in Settings → Skills.
            </div>
          )}
        </>
      )}

      {state.error && !state.conflict && (
        <div role="alert" className="mt-2 text-[12px] text-danger">{state.error}</div>
      )}

      {editing && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-6" role="dialog" aria-modal="true" aria-label={`Edit ${editing.name}`}>
          <div className="flex max-h-[min(760px,90vh)] w-full max-w-2xl flex-col rounded-2xl bg-card p-5 shadow-2xl">
            <div className="text-[16px] font-semibold text-ink">Edit {editing.name}</div>
            <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
              <Field label="When to use">
                <input className={inputCls} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
              </Field>
              <Field label="Instructions">
                <textarea
                  className={cn(inputCls, "min-h-48 font-mono text-[13px]")}
                  value={editing.instructions}
                  onChange={(e) => setEditing({ ...editing, instructions: e.target.value })}
                />
              </Field>
              <label className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
                <input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
                Usable for future requests
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={quietButtonCls} disabled={Boolean(working)} onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="button" className={primaryButtonCls} disabled={Boolean(working)} onClick={() => void submitEdit()}>
                Save guide
              </button>
            </div>
          </div>
        </div>
      )}

      {viewing && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-6" role="dialog" aria-modal="true" aria-label={`${viewing.name} contents`}>
          <div className="flex max-h-[min(760px,90vh)] w-full max-w-2xl flex-col rounded-2xl bg-card p-5 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[16px] font-semibold text-ink">{viewing.name}</div>
              <button type="button" className={quietButtonCls} onClick={() => setViewing(null)}>Close</button>
            </div>
            <pre className="mt-3 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink">
              {viewing.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}