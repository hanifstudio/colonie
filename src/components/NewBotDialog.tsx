import { useEffect, useRef, useState } from "react";
import { Delete02Icon, Loading02Icon, MultiplicationSignIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { BotAvatar } from "./Avatar";
import { MAUS_COLORS } from "@/lib/mascot";
import { api, BotEditorStore, useStore, type Bot, type ModelSelection } from "@/state/store";
import { BotCreationDraft, EMPTY_BOT_DEFAULTS } from "@/lib/bot-creation-draft";
import { createConfiguredBot, preparedBotTemplate } from "@/lib/create-configured-bot";
import { BOT_ROLES, roleProfilePatch } from "@/lib/bot-roles";
import { chosenPreset, presetDraftPatch, presetGroups, presetPictureFile, presetSummaryLines, type BotPreset } from "@/lib/bot-presets";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { visibilityFromForm, type VisibilityMode } from "./bot-settings/VisibilitySection";
import type { NewBotDefaults } from "../../shared/new-bot-defaults.ts";
import type { Routine } from "@/lib/routines";
import { IdentitySection } from "./bot-settings/IdentitySection";
import { SoulSection } from "./bot-settings/SoulSection";
import { SkillsSection } from "./bot-settings/SkillsSection";
import { AccessSection } from "./bot-settings/AccessSection";
import { ModelSection } from "./bot-settings/ModelSection";
import { PermissionsSection } from "./bot-settings/PermissionsSection";
import { VoiceSection } from "./bot-settings/VoiceSection";
import { useBotSettingsDerived } from "./bot-settings/useBotSettingsDerived";
import { BotEditorContext } from "./bot-settings/BotEditorContext";
import { inputCls } from "./bot-settings/field";
import { RoutineEditor } from "./RoutinesPage";
import { FullAccessWarning } from "./FullAccessWarning";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { SharePresetDialog } from "./SharePresetDialog";

const SECTIONS = ["Identity", "Soul", "Skills", "Memory", "Routines", "Access", "Model", "Permissions", "Voice & alerts"] as const;
type Section = typeof SECTIONS[number];

/** Companion pairing permits creation, but not reading host defaults or
 * patching host settings. Keep its existing single-request creation flow. */
export function CompanionNewBotDialog() {
  const { state, dispatch } = useStore();
  const dialog = useRef<HTMLDivElement>(null);
  const close = () => dispatch({ type: "toggleNewBot", open: false });
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("newBot.create")} tabIndex={-1}
      className="w-full max-w-sm rounded-2xl border border-hairline/50 bg-panel p-5 text-ink shadow-2xl"
      onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); close(); }
        if (event.key === "Tab") {
          const root = event.currentTarget;
          const buttons = [...root.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
          if (event.shiftKey && (document.activeElement === root || document.activeElement === buttons[0])) { event.preventDefault(); buttons.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
        }
      }}>
      <h2 className="mb-4 text-[17px] font-semibold">{t("newBot.create")}</h2>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={close} className="rounded-lg px-3 py-2">{t("common.cancel")}</button>
        <button type="button" disabled={state.botCreationPending} onClick={() => dispatch({ type: "newBot", onCreated: close })}
          className="rounded-lg bg-accent px-4 py-2 text-white disabled:opacity-40">{t("newBot.create")}</button>
      </div>
    </div>
  </div>;
}

export function NewBotDialog(props: Parameters<typeof LocalNewBotDialog>[0] = {}) {
  return typeof window !== "undefined" && window.colonie?.remoteClient?.active
    ? <CompanionNewBotDialog /> : <LocalNewBotDialog {...props} />;
}

export function LocalNewBotDialog({ defaultsMode = false, onClose, section, onCreated, preserveSelection = false }: {
  defaultsMode?: boolean; onClose?: () => void; section?: string; onCreated?: (bot: Bot) => void | Promise<void>; preserveSelection?: boolean;
} = {}) {
  const parent = useStore();
  const [, render] = useState(0);
  const [draft, setDraft] = useState(() => new BotCreationDraft(EMPTY_BOT_DEFAULTS, () => render(value => value + 1)));
  const [active, setActive] = useState<Section>("Identity");
  const [ready, setReady] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [localSaving, setSaving] = useState(false);
  const saving = localSaving || parent.state.botCreationPending;
  const savingRef = useRef(false);
  const alive = useRef(true);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState<"full" | "local" | null>(null);
  const [audience, setAudience] = useState<VisibilityMode>("everyone");
  const [people, setPeople] = useState("");
  const ownerOrAdmin = useOwnerOrAdmin();
  const choosesVisibility = !defaultsMode && typeof window !== "undefined" && !window.colonie && ownerOrAdmin === true;
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(() => {});
  closeRef.current = () => {
    if (onClose) onClose();
    else parent.dispatch({ type: "toggleNewBot", open: false });
  };
  useEffect(() => {
    let cancelled = false;
    void api<{ defaults: NewBotDefaults; modelSelection: ModelSelection; suggestedName: string }>("/api/bot-defaults")
      .then(result => {
        if (cancelled) return;
        const defaults = structuredClone(result.defaults);
        defaults.profile.modelSelection ??= result.modelSelection;
        // No engine can run a turn yet (none signed in): guide to setup
        // instead of submitting an empty model and failing validation.
        setNeedsSetup(!defaults.profile.modelSelection?.instanceId);
        if (!defaultsMode) defaults.profile.name = defaults.profile.name?.trim() || result.suggestedName;
        if (section !== undefined) defaults.profile.section = section;
        setDraft(new BotCreationDraft(defaults, () => render(value => value + 1)));
        setReady(true);
      }).catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [defaultsMode, section]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => () => draft.dispose(), [draft]);
  // Disabling the focused Create button drops focus to the page in Chromium.
  // Keep keyboard dismissal and focus trapping inside the pending dialog.
  useEffect(() => { if (saving) dialog.current?.focus(); }, [saving]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const root = dialog.current;
      if (!root || (event.target instanceof Node && !root.contains(event.target))) return;
      const nested = root.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
      if (nested && nested.getClientRects().length) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const controls = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')]
        .filter(control => control.getClientRects().length && !control.closest("[hidden],fieldset:disabled"));
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); root.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
  }, []);
  const save = async () => {
    if (!ready || needsSetup || savingRef.current || parent.state.botCreationPending) return;
    if (!defaultsMode && draft.bot.approvalMode === "full" && !draft.consent.confirmFullAccess) { setWarning("full"); return; }
    if (!defaultsMode && draft.bot.approvalMode === "auto" && draft.bot.computer === "local" && !draft.consent.acknowledgeLocalAuto) { setWarning("local"); return; }
    const visibility = choosesVisibility ? visibilityFromForm(audience, people) : null;
    if (visibility && !visibility.ok) { setError(t("botSettings.visibility.needPeople")); return; }
    savingRef.current = true; setSaving(true); setError("");
    parent.dispatch({ type: "botCreationPending", on: true });
    try {
      if (defaultsMode) await api("/api/config", { method: "PATCH", body: JSON.stringify({ newBotDefaults: await preparedBotTemplate(draft) }) });
      else {
        const { bot, warnings } = await createConfiguredBot(draft, undefined, undefined, undefined, visibility?.ok ? visibility.visibility : undefined);
        parent.dispatch({ type: "botAdded", bot, preserveSelection });
        if (warnings.length) parent.dispatch({ type: "error", message: warnings.join("\n") });
        try { await onCreated?.(bot); }
        catch (cause) { parent.dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }); }
      }
      savingRef.current = false; if (alive.current) closeRef.current();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      savingRef.current = false;
      parent.dispatch({ type: "botCreationPending", on: false });
      if (alive.current) setSaving(false);
    }
  };
  const bot = draft.bot;
  const scopedStore: ReturnType<typeof useStore> = {
    ...parent,
    state: { ...parent.state, bots: [bot, ...parent.state.bots], routines: draft.routines, routineRuns: [], routinesLoadState: "ready" },
    flushBotPatches: async () => bot,
    dispatch: action => {
      if (action.type === "updateBot" && action.botId === draft.id) draft.patch(action.patch);
      else if (action.type === "setModel" && action.botId === draft.id) {
        draft.setModel(action.selection);
        if (action.resetApprovalToAsk) draft.patch({ approvalMode: "ask" });
      } else if (action.type === "routinePatched") { /* Applied by the draft transport. */ }
      else if (action.type === "toggleSettings") { /* Editor links stay inside this dialog. */ }
      else parent.dispatch(action);
    },
  };
  const title = defaultsMode ? t("newBot.defaults") : t("sidebar.newBot");
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 sm:p-5">
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={title} aria-busy={saving} tabIndex={-1}
      className={cn("flex w-full flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none",
        defaultsMode ? "h-[min(760px,94dvh)] max-w-[900px]" : "max-h-[94dvh] max-w-[520px]")}>
      <div className="flex shrink-0 items-center justify-between border-b border-hairline/40 px-5 py-4">
        <h2 className="text-[17px] font-semibold text-ink">{title}</h2>
        <button type="button" onClick={() => closeRef.current()} aria-label={t("common.close")}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"><HIcon icon={MultiplicationSignIcon} size={18} className="pointer-events-none" /></button>
      </div>
        {choosesVisibility && (
          <div className="flex flex-wrap items-center gap-2 px-5 pt-3 text-[13px] text-ink-secondary" data-new-bot-visibility>
            <label className="flex items-center gap-2">
              {t("botSettings.visibility.title")}
              <select
                value={audience}
                disabled={saving}
                onChange={(event) => setAudience(event.target.value as VisibilityMode)}
                className="rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[13px] text-ink focus:outline-none"
              >
                <option value="everyone">{t("botSettings.visibility.everyone")}</option>
                <option value="admins">{t("botSettings.visibility.admins")}</option>
                <option value="people">{t("botSettings.visibility.people")}</option>
              </select>
            </label>
            {audience === "people" && (
              <input
                value={people}
                disabled={saving}
                onChange={(event) => setPeople(event.target.value)}
                placeholder={t("botSettings.visibility.peoplePlaceholder")}
                aria-label={t("botSettings.visibility.peopleLabel")}
                className="min-w-[16rem] flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
              />
            )}
          </div>
        )}
      {!defaultsMode && <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {!ready && !error && <div role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><HIcon icon={Loading02Icon} size={16} className="animate-spin" />{t("newBot.loading")}</div>}
        {ready && <fieldset disabled={saving} className="min-w-0"><SimpleNewBot draft={draft} /></fieldset>}
      </div>}
      {defaultsMode && <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label={t("newBot.sections")} className="flex shrink-0 gap-1 overflow-x-auto border-b border-hairline/40 p-2 sm:w-40 sm:flex-col sm:border-b-0 sm:border-r">
          {SECTIONS.map(label => <button key={label} type="button" onClick={() => setActive(label)} aria-current={active === label ? "page" : undefined}
            className={cn("shrink-0 rounded-lg px-3 py-2 text-left text-[13px]", active === label ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50")}>{label}</button>)}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-5">
          {!ready && !error && <div role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><HIcon icon={Loading02Icon} size={16} className="animate-spin" />{t("newBot.loading")}</div>}
          {ready && <fieldset disabled={saving} className="min-w-0">
            <BotEditorStore value={scopedStore}><BotEditorContext.Provider value={{ request: draft.request, draft: true, uploadAvatar: draft.uploadAvatar }}>
              <DraftSection active={active} draft={draft} defaultsMode={defaultsMode} />
            </BotEditorContext.Provider></BotEditorStore>
          </fieldset>}
        </div>
      </div>}
      {needsSetup && <div role="alert" className="flex flex-wrap items-center gap-2 border-t border-hairline/40 px-5 py-3 text-[13px] text-ink-secondary">
        {t("newBot.needsModel")}
        <button type="button" className="underline" onClick={() => { closeRef.current(); parent.dispatch({ type: "toggleAppSettings", open: true, section: "engines" }); }}>{t("newBot.openModels")}</button>
      </div>}
      {error && <p role="alert" className="max-h-24 overflow-y-auto border-t border-hairline/40 px-5 py-3 text-[13px] text-danger">{error}</p>}
      <div className="flex shrink-0 justify-end gap-2 border-t border-hairline/40 px-5 py-3">
        <button type="button" onClick={() => closeRef.current()} className="rounded-lg px-4 py-2 text-[13px] text-ink-secondary hover:bg-control">{t("common.cancel")}</button>
        <button type="button" disabled={!ready || saving || needsSetup || (!defaultsMode && !bot.name.trim())} onClick={() => void save()}
          className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40">
          {saving && <HIcon icon={Loading02Icon} size={15} className="animate-spin" />}{t(defaultsMode ? "newBot.saveDefaults" : "newBot.create")}
        </button>
      </div>
      <FullAccessWarning open={warning === "full"} onCancel={() => setWarning(null)} onConfirm={() => { draft.consent.confirmFullAccess = true; setWarning(null); void save(); }} />
      <LocalComputerAutoWarning open={warning === "local"} onCancel={() => setWarning(null)} onConfirm={() => { draft.consent.acknowledgeLocalAuto = true; setWarning(null); void save(); }} />
    </div>
  </div>;
}

/** Making a bot: its face and name (a friendly name is suggested), what it
 * should do (its standing instructions), or a role to start from. The rest
 * (skills, memory, model, permissions, voice) waits in the bot's settings. */
export function SimpleNewBot({ draft }: { draft: BotCreationDraft }) {
  const bot = draft.bot;
  const colors = Object.keys(MAUS_COLORS) as Array<keyof typeof MAUS_COLORS>;
  const nextColor = () => colors[(colors.indexOf(bot.color as keyof typeof MAUS_COLORS) + 1) % colors.length]!;
  const name = bot.name.trim() || "this bot";
  return <div className="space-y-5">
    <div className="flex items-center gap-4">
      <button type="button" onClick={() => draft.patch({ color: nextColor() })} title="Change look" aria-label="Change look"
        className="flex shrink-0 flex-col items-center gap-1 rounded-xl p-1 text-[11px] text-ink-secondary hover:bg-control/50 hover:text-ink">
        <BotAvatar bot={bot} state="happy" size={56} motion="none" motionKey={0} animated={false} />
        Change look
      </button>
      <label className="min-w-0 flex-1 text-[13px] text-ink-secondary">Name
        <input value={bot.name} onChange={event => draft.patch({ name: event.target.value })} maxLength={60} autoFocus
          className={cn(inputCls, "mt-1.5")} />
      </label>
    </div>
    <label className="block text-[13px] text-ink-secondary">What should {name} do?
      <textarea value={bot.soul ?? ""} onChange={event => draft.patch({ soul: event.target.value })} rows={4}
        placeholder="For example: keep our launch on track, remind people of deadlines, and sum up each week."
        className={cn(inputCls, "mt-1.5 resize-y")} />
    </label>
    <div>
      <div className="text-[13px] text-ink-secondary">Or start from</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {BOT_ROLES.map(role => <button key={role.id} type="button" title={role.description}
          onClick={() => { const { name: _role, ...job } = roleProfilePatch(role); draft.choosePreset(undefined); draft.patch(job); }}
          className={cn("rounded-full border px-3 py-1 text-[12.5px]", bot.soul === role.soul ? "border-accent/60 bg-accent/10 text-ink" : "border-hairline/50 text-ink-secondary hover:text-ink")}>
          {role.name}
        </button>)}
      </div>
    </div>
    <p className="text-[12px] text-ink-tertiary">Skills, memory, model and permissions are in the bot's settings once it is made.</p>
  </div>;
}

function DraftSection({ active, draft, defaultsMode }: { active: Section; draft: BotCreationDraft; defaultsMode: boolean }) {
  const bot = draft.bot;
  const derived = useBotSettingsDerived(bot);
  if (active === "Identity") return <div className="space-y-4">
    <StartingRole draft={draft} defaultsMode={defaultsMode} />
    <IdentitySection bot={bot} patch={derived.patch} activeState={derived.activeState} mascotMotion={null}
      namePlaceholder={defaultsMode ? t("newBot.randomName") : undefined} />
  </div>;
  if (active === "Soul") return <SoulSection bot={bot} patch={derived.patch} />;
  if (active === "Skills") return <SkillsSection bot={bot} />;
  if (active === "Memory") return <DraftMemory draft={draft} />;
  if (active === "Routines") return <DraftRoutines draft={draft} />;
  if (active === "Access") return <AccessSection bot={bot} derived={derived} />;
  if (active === "Model") return <ModelSection bot={bot} />;
  if (active === "Permissions") return <PermissionsSection bot={bot} derived={derived} />;
  return <VoiceSection bot={bot} derived={derived} />;
}

/** Starting role: presets from the organization and imported files first,
 * then the built-in roles. A preset fills name, look and instructions (all
 * still editable); its skills and notes are added when the bot is created. */
function StartingRole({ draft, defaultsMode }: { draft: BotCreationDraft; defaultsMode: boolean }) {
  const [presets, setPresets] = useState<BotPreset[]>([]);
  const [loads, setLoads] = useState(0);
  const [error, setError] = useState("");
  // The draft's picture came from a preset (so the next preset may replace it).
  const presetPicture = useRef(false);
  useEffect(() => {
    // Defaults are the installation's own; presets are for one new bot.
    if (defaultsMode) return;
    let cancelled = false;
    void api<{ presets: BotPreset[] }>("/api/bot-presets")
      .then(result => { if (!cancelled) setPresets(result.presets); })
      // Members and older servers: the built-in roles only.
      .catch(() => { if (!cancelled) setPresets([]); });
    return () => { cancelled = true; };
  }, [defaultsMode, loads]);
  const chosen = draft.preset ? presets.find(preset => preset.id === draft.preset!.id) : undefined;
  const choose = async (value: string) => {
    setError("");
    const preset = value.startsWith("preset:") ? presets.find(candidate => candidate.id === value.slice("preset:".length)) : undefined;
    if (!preset) {
      draft.choosePreset(undefined);
      const role = BOT_ROLES.find(role => role.id === value);
      if (role) draft.patch(roleProfilePatch(role));
      return;
    }
    draft.patch(presetDraftPatch(preset));
    draft.choosePreset(chosenPreset(preset));
    const picture = presetPictureFile(preset);
    try {
      if (picture) {
        draft.patch({ avatarUrl: await draft.uploadAvatar(picture), avatarCrop: preset.bot.appearance!.avatar!.crop });
        presetPicture.current = true;
      } else if (presetPicture.current) {
        draft.patch({ avatarUrl: "" });
        presetPicture.current = false;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const remove = async (preset: BotPreset) => {
    setError("");
    try {
      await api(`/api/bot-presets/${encodeURIComponent(preset.id)}`, { method: "DELETE" });
      if (draft.preset?.id === preset.id) draft.choosePreset(undefined);
      setLoads(value => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const roles = BOT_ROLES.map(role => <option key={role.id} value={role.id}>{role.title}</option>);
  return <div>
    <label className="block text-[13px] text-ink-secondary">{t("newBot.startingRole")}
      <select className={cn(inputCls, "mt-1.5")} value={draft.preset ? `preset:${draft.preset.id}` : ""} onChange={event => void choose(event.target.value)}>
        <option value="">{t("newBot.customSettings")}</option>
        {presetGroups(presets).map(group => <optgroup key={group.label} label={group.label}>
          {group.presets.map(preset => <option key={preset.id} value={`preset:${preset.id}`}>{preset.name}</option>)}
        </optgroup>)}
        {presets.length ? <optgroup label={t("newBot.builtInRoles")}>{roles}</optgroup> : roles}
      </select>
    </label>
    {chosen && <div className="mt-2 space-y-1 rounded-lg bg-card px-3 py-2.5 text-[12.5px] text-ink-secondary" data-new-bot-preset>
      {presetSummaryLines(chosen).map((line, index) => <p key={index} className="break-words">{line}</p>)}
      {chosen.source === "file" && <button type="button" onClick={() => void remove(chosen)}
        className="mt-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">{t("newBot.presetRemove")}</button>}
    </div>}
    {error && <p role="alert" className="mt-2 text-[12.5px] text-danger">{error}</p>}
  </div>;
}

function DraftMemory({ draft }: { draft: BotCreationDraft }) {
  const [path, setPath] = useState("MEMORY.md");
  const [name, setName] = useState("");
  return <div className="space-y-3">
    <select className={inputCls} aria-label="Memory file" value={path} onChange={event => setPath(event.target.value)}>
      {[...new Set(["MEMORY.md", ...Object.keys(draft.template.memory)])].map(file => <option key={file}>{file}</option>)}
    </select>
    <textarea className={cn(inputCls, "min-h-72 font-mono")} aria-label="Memory contents" value={draft.template.memory[path] ?? ""} onChange={event => draft.setMemory(path, event.target.value)} />
    <div className="flex gap-2"><input className={inputCls} aria-label="New memory topic" placeholder="Topic name" value={name} onChange={event => setName(event.target.value)} />
      <button type="button" aria-label="Add memory topic" disabled={!/^[a-zA-Z0-9_-]+$/.test(name)} className="rounded-lg bg-control px-3 disabled:opacity-40" onClick={() => { const next = `memory/${name}.md`; if (!(next in draft.template.memory)) draft.setMemory(next, ""); setPath(next); setName(""); }}><HIcon icon={PlusSignIcon} size={16} /></button>
      {path !== "MEMORY.md" && <button type="button" aria-label="Remove memory topic" className="rounded-lg bg-control px-3" onClick={() => { draft.setMemory(path, null); setPath("MEMORY.md"); }}><HIcon icon={Delete02Icon} size={16} /></button>}
    </div>
  </div>;
}

function DraftRoutines({ draft }: { draft: BotCreationDraft }) {
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  return <div className="space-y-3">
    <button type="button" className="rounded-lg bg-accent px-3 py-2 text-[13px] text-white" onClick={() => setEditing("new")}>{t("computer.routines.create")}</button>
    {draft.routines.map(routine => <div key={routine.id} className="flex items-center gap-2 rounded-lg bg-card p-3">
      <button type="button" className="min-w-0 flex-1 text-left text-[13px]" onClick={() => setEditing(routine)}>{routine.name}</button>
      <label className="flex items-center gap-1.5 text-[12px] text-ink-secondary"><input type="checkbox" checked={routine.enabled} onChange={event => draft.setRoutineEnabled(routine.id, event.target.checked)} />Enabled</label>
      <button type="button" aria-label={`Remove ${routine.name}`} onClick={() => draft.removeRoutine(routine.id)} className="rounded p-1.5 hover:bg-control"><HIcon icon={Delete02Icon} size={15} /></button>
    </div>)}
    {editing && <RoutineEditor routine={editing === "new" ? undefined : editing} bots={[draft.bot]} lockedBotId={draft.id} onClose={() => setEditing(null)} />}
  </div>;
}

export function DefaultBotSettings() {
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  return <>
    <div className="flex items-center justify-between gap-4 py-3"><span className="text-[13px] text-ink">{t("newBot.defaults")}</span>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={() => setSharing(true)} className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink">{t("newBot.sharePreset")}</button>
        <button type="button" onClick={() => setOpen(true)} className="rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover">{t("newBot.edit")}</button>
      </div>
    </div>
    {open && <NewBotDialog defaultsMode onClose={() => setOpen(false)} />}
    {sharing && <SharePresetDialog onClose={() => setSharing(false)} />}
  </>;
}
