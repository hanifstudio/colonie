// A group's right panel (owner, October 30): its project files and its
// members, beside the conversation like a bot's Computer panel. The Files
// tab follows T3 Code's file browser (a folder tree with search, expand all
// and refresh; a file opens in the reading panel), sized for a group's
// folder, which is small enough to list whole.
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown01Icon, ArrowRight01Icon, Download01Icon, FileTextIcon, Folder01Icon, Loading02Icon,
  GlobeIcon, MultiplicationSignIcon, PlusSignIcon, RefreshCwIcon, Search01Icon, UnfoldLessIcon, UnfoldMoreIcon, UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HIcon } from "../HIcon";
import { BotAvatar } from "../Avatar";
import { PersonAvatar } from "../PersonAvatar";
import { ConfirmDialog } from "../ConfirmDialog";
import { FullAccessWarning } from "../FullAccessWarning";
import { useDesktopCapabilities, useCaptionChrome } from "../DesktopCapabilities";
import { usePreviewPanel } from "../file-preview/use-preview-panel";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { filePreviewKind } from "@/lib/file-preview";
import { useAdminSession, useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import {
  CONVERSATIONS_CHANGED, addToConversation, conversationFiles, deleteGroup, downloadConversationFile, leaveConversation, removeBotFromConversation, updateConversation, workspacePeople,
  type Conversation, type ConversationFile, type GroupResponder,
} from "@/lib/conversations";
import { useStore, type Bot, type Message } from "@/state/store";
import { approvalModeFor, type ApprovalMode } from "../../../shared/approval-mode";
import { writeComputerPanelView } from "@/lib/computer-panel-view";

export function GroupPanel({ conversation, bots, messages, tab, onLeft }: {
  conversation: Conversation; bots: Bot[]; messages: Message[] | null; tab: "files" | "members" | "browser"; onLeft: () => void;
}) {
  const { dispatch } = useStore();
  const { padClass } = useCaptionChrome();
  const { panel, width, minimum, maximum, resize } = usePreviewPanel();
  const memberBots = bots.filter((bot) => conversation.bots.includes(bot.id));
  const tabClass = (active: boolean) => cn(
    "flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] transition-colors",
    active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
  );
  const close = () => dispatch({ type: "toggleGroupPanel", open: false });
  return (
    <aside ref={panel} aria-label={`${conversation.title}: ${tab === "files" ? "Files" : tab === "browser" ? "Browser" : "Members"}`}
      className="animate-panel-in relative flex h-full max-w-full shrink-0 flex-col border-l border-hairline/40 bg-panel max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!"
      style={{ width }}>
      <div role="separator" aria-label="Resize panel" aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={width} tabIndex={0} {...resize}
        className="absolute inset-y-0 left-0 z-10 w-1.5 touch-none cursor-col-resize transition-colors hover:bg-accent/30 focus-visible:bg-accent/50 focus-visible:outline-none max-md:hidden" />
      <div className={cn("px-4 py-3", padClass)}>
        <div className="relative flex min-h-7 items-center justify-center">
          <div className="mx-9 flex gap-0.5 rounded-full bg-inset p-0.5" aria-label="Group panel view">
            <button type="button" aria-pressed={tab === "members"} className={tabClass(tab === "members")} onClick={() => dispatch({ type: "toggleGroupPanel", tab: "members", open: true })}>
              <HIcon icon={UserGroupIcon} size={13} /> Members
            </button>
            <button type="button" aria-pressed={tab === "files"} className={tabClass(tab === "files")} onClick={() => dispatch({ type: "toggleGroupPanel", tab: "files", open: true })}>
              <HIcon icon={Folder01Icon} size={13} /> Files
            </button>
            {memberBots.length > 0 && <button type="button" aria-pressed={tab === "browser"} className={tabClass(tab === "browser")} onClick={() => dispatch({ type: "toggleGroupPanel", tab: "browser", open: true })}>
              <HIcon icon={GlobeIcon} size={13} /> Browser
            </button>}
          </div>
          <button type="button" onClick={close} aria-label="Close panel" title="Close panel"
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink">
            <HIcon icon={MultiplicationSignIcon} size={18} />
          </button>
        </div>
      </div>
      {tab === "files"
        ? <ProjectFiles conversation={conversation} messages={messages} />
        : tab === "browser" ? <BotScreens bots={memberBots} />
        : <Members conversation={conversation} memberBots={memberBots.map((bot) => bot.id)} bots={bots} onLeft={onLeft} />}
    </aside>
  );
}

const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

interface TreeFolder { name: string; path: string; folders: TreeFolder[]; files: ConversationFile[] }

/** The flat listing as folders inside folders, each sorted by name. */
function treeOf(files: ConversationFile[]): TreeFolder {
  const root: TreeFolder = { name: "", path: "", folders: [], files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      const path = folder.path ? `${folder.path}/${part}` : part;
      let next = folder.folders.find((entry) => entry.name === part);
      if (!next) { next = { name: part, path, folders: [], files: [] }; folder.folders.push(next); }
      folder = next;
    }
    folder.files.push(file);
  }
  const sort = (folder: TreeFolder) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.files.sort((a, b) => a.path.localeCompare(b.path));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
}

const foldersIn = (folder: TreeFolder): string[] => folder.folders.flatMap((entry) => [entry.path, ...foldersIn(entry)]);

/** The conversation's project folder: every bot here works in it, and
 * everyone here can open or save its files. Read again as messages arrive,
 * so a file a bot just made shows up. */
function ProjectFiles({ conversation, messages }: { conversation: Conversation; messages: Message[] | null }) {
  const { dispatch } = useStore();
  const [listing, setListing] = useState<{ files: ConversationFile[]; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const latest = messages?.at(-1)?.id;
  useEffect(() => {
    setRefreshing(true);
    void conversationFiles(conversation.id).then((next) => { setListing(next); setError(""); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setRefreshing(false));
  }, [conversation.id, latest, attempt]);
  const tree = useMemo(() => treeOf(listing?.files ?? []), [listing]);
  const allFolders = useMemo(() => foldersIn(tree), [tree]);
  // a small folder opens whole; a big one starts with its top level
  useEffect(() => { if ((listing?.files.length ?? 0) <= 30) setOpen(new Set(allFolders)); }, [allFolders, listing?.files.length]);
  const allOpen = allFolders.length > 0 && allFolders.every((path) => open.has(path));
  const needle = query.trim().toLowerCase();
  const matches = needle ? (listing?.files ?? []).filter((file) => file.path.toLowerCase().includes(needle)) : [];
  const show = (file: ConversationFile) => {
    const name = file.path.split("/").at(-1) ?? file.path;
    // files the reading panel cannot show are saved instead
    if (!filePreviewKind(file.path)) { void save(file); return; }
    dispatch({ type: "openFilePreview", preview: { threadId: conversation.threadId, messageId: "", path: file.path, name, conversationId: conversation.id } });
  };
  const save = (file: ConversationFile) => downloadConversationFile(conversation.id, file.path).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  const row = (file: ConversationFile, depth: number, label: string) => (
    <li key={file.path} className="group flex items-center rounded-md hover:bg-raised/60">
      <button type="button" onClick={() => show(file)} title={file.path}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 text-left text-[13px] text-ink" style={{ paddingLeft: 8 + depth * 14 + 16 }}>
        <HIcon icon={FileTextIcon} size={14} className="shrink-0 text-ink-secondary" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 text-[11px] text-ink-tertiary">{fileSize(file.bytes)}</span>
      </button>
      <button type="button" onClick={() => void save(file)} aria-label={`Save ${label}`} title="Save a copy"
        className="mr-1 rounded p-1 text-ink-secondary opacity-0 hover:bg-control hover:text-ink focus-visible:opacity-100 group-hover:opacity-100">
        <HIcon icon={Download01Icon} size={13} />
      </button>
    </li>
  );
  const folder = (entry: TreeFolder, depth: number): React.ReactNode => {
    const expanded = open.has(entry.path);
    return (
      <li key={`folder:${entry.path}`}>
        <button type="button" aria-expanded={expanded} title={entry.path}
          onClick={() => setOpen((current) => { const next = new Set(current); if (expanded) next.delete(entry.path); else next.add(entry.path); return next; })}
          className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px] text-ink hover:bg-raised/60" style={{ paddingLeft: 8 + depth * 14 }}>
          <HIcon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} size={12} className="shrink-0 text-ink-tertiary" />
          <HIcon icon={Folder01Icon} size={14} className="shrink-0 text-ink-secondary" />
          <span className="min-w-0 truncate">{entry.name}</span>
        </button>
        {expanded && <ul>{entry.folders.map((child) => folder(child, depth + 1))}{entry.files.map((file) => row(file, depth + 1, file.path.split("/").at(-1)!))}</ul>}
      </li>
    );
  };
  const place = conversation.kind === "dm" ? "conversation" : "group";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-3 pb-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5">
          <HIcon icon={Search01Icon} size={13} className="shrink-0 text-ink-tertiary" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files" aria-label="Search files"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink placeholder:text-ink-tertiary focus:outline-none" />
        </label>
        <button type="button" disabled={!allFolders.length} onClick={() => setOpen(allOpen ? new Set() : new Set(allFolders))}
          aria-label={allOpen ? "Collapse all folders" : "Expand all folders"} title={allOpen ? "Collapse all folders" : "Expand all folders"}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40">
          <HIcon icon={allOpen ? UnfoldLessIcon : UnfoldMoreIcon} size={15} />
        </button>
        <button type="button" onClick={() => setAttempt((value) => value + 1)} aria-label="Refresh files" title="Refresh files"
          className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink">
          <HIcon icon={refreshing ? Loading02Icon : RefreshCwIcon} size={15} className={refreshing ? "animate-spin" : undefined} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!listing && !error && <div className="flex justify-center py-8"><HIcon icon={Loading02Icon} size={16} className="animate-spin text-ink-secondary" /></div>}
        {listing && listing.files.length === 0 && <p className="px-3 py-6 text-center text-[12.5px] text-ink-tertiary">No files yet. The bots in this {place} share one project folder; ask one to make a file.</p>}
        {needle
          ? <ul>{matches.map((file) => row(file, 0, file.path))}{!matches.length && <li className="px-3 py-4 text-[12.5px] text-ink-tertiary">No file matches “{query}”.</li>}</ul>
          : <ul>{tree.folders.map((entry) => folder(entry, 0))}{tree.files.map((file) => row(file, 0, file.path))}</ul>}
        {listing?.truncated && <p className="px-3 pt-2 text-[11.5px] text-ink-tertiary">Showing the newest 500 files.</p>}
        {error && <p role="alert" className="px-3 pt-2 text-[12px] text-danger">{error}</p>}
      </div>
    </div>
  );
}

/** The three approval levels (owner, October 29), as a group shows them. */
const LEVELS = ["ask", "auto", "full"] as const satisfies readonly ApprovalMode[];
const levelLabel = (mode: ApprovalMode) => t(mode === "full" ? "approvalMode.full.label" : mode === "auto" ? "approvalMode.auto.label" : "approvalMode.ask.label");
const SELECT = "rounded-md border border-hairline/40 bg-inset px-2 py-1 text-[12px] text-ink disabled:opacity-50";
const HEADING = "block px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-tertiary";
const ROW = "group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left";

/** Each bot's screen (owner, October 28): watch it browse, or take over. */
function BotScreens({ bots }: { bots: Bot[] }) {
  const { dispatch } = useStore();
  const ordered = [...bots].sort((a, b) => Number(Boolean(b.busy)) - Number(Boolean(a.busy)));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
      <p className="px-2 pb-2 text-[12.5px] text-ink-secondary">Watch a bot's browser while it works, or take over to help it.</p>
      {ordered.map((bot) => (
        <button key={bot.id} type="button" className={cn(ROW, "hover:bg-raised/60")}
          onClick={() => { writeComputerPanelView(bot.id, "browser"); dispatch({ type: "toggleComputer", open: true, botId: bot.id }); }}>
          <BotAvatar bot={bot} state="happy" size={36} motion="none" motionKey={0} animated={false} />
          <span className="min-w-0 flex-1 truncate text-[14.5px] text-ink">{bot.name}</span>
          <span className="text-[12px] text-ink-tertiary">{bot.busy ? "Working · open" : "Open"}</span>
        </button>
      ))}
    </div>
  );
}

/** The members, as Grok Bot lists them: a face and a name per row, Remove on
 * hover, Add member at the end. A bot opens to its approval level and to
 * leading the group; the group's own settings follow the list. */
function Members({ conversation, memberBots, bots, onLeft }: {
  conversation: Conversation; memberBots: string[]; bots: Bot[]; onLeft: () => void;
}) {
  const { dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  // Full access needs the installed app's own channel, or a Shared admin
  const adminSession = useAdminSession();
  const fullAvailable = Boolean(window.colonie?.approvals && capabilities.host.packaged) || adminSession;
  // Full access is confirmed first, for one bot or for every bot here
  const [fullFor, setFullFor] = useState<string[] | null>(null);
  const { id: conversationId, kind, people } = conversation;
  const [everyone, setEveryone] = useState<Array<{ email: string; name: string }>>([]);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openBot, setOpenBot] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const canDelete = useOwnerOrAdmin();
  useEffect(() => { void workspacePeople().then(setEveryone).catch(() => {}); }, []);
  const changed = () => window.dispatchEvent(new Event(CONVERSATIONS_CHANGED));
  const act = async (run: () => Promise<unknown>) => {
    setError("");
    try { await run(); changed(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const inPeople = new Set(people.map((person) => person.email));
  const here = bots.filter((bot) => memberBots.includes(bot.id));
  const levelOf = (bot: Bot): ApprovalMode => {
    const mode = approvalModeFor(bot);
    return mode === "full" || mode === "auto" ? mode : "ask";
  };
  const setLevel = (targets: Bot[], mode: ApprovalMode) => {
    const changing = targets.filter((bot) => levelOf(bot) !== mode);
    if (!changing.length) return;
    if (mode === "full") { setFullFor(changing.map((bot) => bot.id)); return; }
    for (const bot of changing) dispatch({ type: "updateBot", botId: bot.id, patch: { approvalMode: mode } });
  };
  const leads = kind === "group" && (conversation.responder?.kind ?? "lead") === "lead";
  const addablePeople = kind === "group" ? everyone.filter((person) => !inPeople.has(person.email)) : [];
  const addableBots = bots.filter((bot) => !memberBots.includes(bot.id));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 text-[12.5px]">
      <h3 className={cn(HEADING, "px-2 text-[12px] normal-case tracking-normal text-ink-secondary")}>Members · {people.length + here.length}</h3>
      <ul className="flex flex-col">
        {here.map((bot) => {
          const expanded = openBot === bot.id;
          const lead = leads && conversation.leadBotId === bot.id;
          return (
            <li key={bot.id} className={cn("rounded-xl", expanded && "bg-raised/50")}>
              <div className={cn(ROW, !expanded && "hover:bg-raised/50")}>
                <button type="button" aria-expanded={expanded} onClick={() => setOpenBot(expanded ? null : bot.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <BotAvatar bot={bot} state="happy" size={36} motion="none" motionKey={0} animated={false} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[14.5px] text-ink">{bot.name}</span>
                      {lead && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-medium text-accent">Lead</span>}
                    </span>
                    <span className="block truncate text-[11.5px] text-ink-tertiary">{levelLabel(levelOf(bot))}</span>
                  </span>
                </button>
                <button type="button" onClick={() => void act(() => removeBotFromConversation(conversationId, bot.id))}
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] text-danger opacity-0 hover:bg-danger/10 focus-visible:opacity-100 group-hover:opacity-100">Remove</button>
              </div>
              {expanded && (
                <div className="flex flex-col gap-2 px-3 pb-3 pl-[58px]">
                  <label className="flex items-center justify-between gap-2 text-ink-secondary">Asks for permission
                    {/* the level is the bot's own: it acts the same in every group */}
                    <select aria-label={`How ${bot.name} asks for permission`} disabled={Boolean(bot.busy)} title={bot.busy ? t("approvalMode.busy") : undefined}
                      className={SELECT} value={levelOf(bot)} onChange={(event) => setLevel([bot], event.target.value as ApprovalMode)}>
                      {LEVELS.map((mode) => <option key={mode} value={mode} disabled={mode === "full" && !fullAvailable}>{levelLabel(mode)}</option>)}
                    </select>
                  </label>
                  {kind === "group" && !lead && (
                    <button type="button" className="self-start text-[12px] text-accent hover:underline"
                      onClick={() => void act(() => updateConversation(conversationId, { responder: { kind: "lead", botId: bot.id } }))}>
                      Make {bot.name} the lead
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
        {people.map((person) => (
          <li key={person.email || person.name} className={cn(ROW, "hover:bg-raised/50")}>
            <PersonAvatar name={person.name} email={person.email} src={person.avatar} size={36} />
            <span className="min-w-0 flex-1 truncate text-[14.5px] text-ink">{person.you ? `${person.name} (you)` : person.name}</span>
          </li>
        ))}
      </ul>
      {(addablePeople.length > 0 || addableBots.length > 0) && (adding
        ? <select autoFocus aria-label="Add a member" className={cn(SELECT, "mt-1 w-full py-2 text-[13px]")} value=""
            onBlur={() => setAdding(false)}
            onChange={(event) => {
              const [what, value] = event.target.value.split(":", 2) as [string, string];
              setAdding(false);
              void act(() => addToConversation(conversationId, what === "bot" ? { bots: [value] } : { emails: [value] }));
            }}>
            <option value="">Choose who to add…</option>
            {addableBots.map((bot) => <option key={bot.id} value={`bot:${bot.id}`}>{bot.name} (bot)</option>)}
            {addablePeople.map((person) => <option key={person.email} value={`person:${person.email}`}>{person.name}</option>)}
          </select>
        : <button type="button" onClick={() => setAdding(true)} className={cn(ROW, "text-ink-secondary hover:bg-raised/50 hover:text-ink")}>
            <span className="flex size-9 items-center justify-center"><HIcon icon={PlusSignIcon} size={18} /></span>
            <span className="text-[14px]">Add member</span>
          </button>)}

      {kind === "group" && (
        <div className="mt-5 border-t border-hairline/40 px-1 pt-4">
          <WhoAnswers conversation={conversation} bots={here} onError={setError} />
          {here.length > 1 && (
            <label className="mb-4 flex flex-col gap-1 text-ink-secondary">
              <span className="flex items-center justify-between gap-2">Set every bot here to
                <select className={SELECT} value="" disabled={here.some((bot) => bot.busy)} title={here.some((bot) => bot.busy) ? t("approvalMode.busy") : undefined}
                  onChange={(event) => { if (event.target.value) setLevel(here, event.target.value as ApprovalMode); }}>
                  <option value="">Choose…</option>
                  {LEVELS.map((mode) => <option key={mode} value={mode} disabled={mode === "full" && !fullAvailable}>{levelLabel(mode)}</option>)}
                </select>
              </span>
              <span className="text-[11.5px] text-ink-tertiary">Changes these bots everywhere, not only here.</span>
            </label>
          )}
          <GroupInstructions conversation={conversation} onError={setError} />
        </div>
      )}
      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 border-t border-hairline/40 px-2 pt-3">
        <button type="button" className="text-danger hover:underline" onClick={() => void leaveConversation(conversationId).then(() => { changed(); onLeft(); })}>
          Leave this {kind === "dm" ? "DM" : "group"}
        </button>
        {kind === "group" && canDelete && <button type="button" className="text-danger hover:underline" onClick={() => setDeleting(true)}>Delete group</button>}
      </div>
      {error && <p role="alert" className="mt-2 px-2 text-danger">{error}</p>}
      <FullAccessWarning open={fullFor !== null} allThreads onCancel={() => setFullFor(null)} onConfirm={() => {
        const targets = fullFor ?? [];
        setFullFor(null);
        for (const botId of targets) dispatch({ type: "updateBot", botId, patch: { approvalMode: "full", confirmFullAccess: true, applyToAllThreads: true } });
      }} />
      <ConfirmDialog open={deleting} title="Delete group?" body={`“${conversation.title}” and its conversation will be deleted for everyone. This cannot be undone.`}
        tone="danger" pending={busy} confirmLabel={busy ? "Deleting…" : "Delete group"} onCancel={() => setDeleting(false)} onConfirm={() => {
          if (busy) return;
          setBusy(true); setError("");
          void deleteGroup(conversationId).then(() => { changed(); onLeft(); }).catch((cause: unknown) => {
            setDeleting(false); setError(cause instanceof Error ? cause.message : String(cause));
          }).finally(() => setBusy(false));
        }} />
    </div>
  );
}

/** Who answers a message that names no one (owner, October 30): the lead
 * bot, every bot, or only bots that are named. */
function WhoAnswers({ conversation, bots, onError }: { conversation: Conversation; bots: Bot[]; onError: (message: string) => void }) {
  const responder = conversation.responder ?? { kind: "lead" as const };
  const [saving, setSaving] = useState(false);
  const choose = async (next: GroupResponder) => {
    setSaving(true); onError("");
    try { await updateConversation(conversation.id, { responder: next }); window.dispatchEvent(new Event(CONVERSATIONS_CHANGED)); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); } finally { setSaving(false); }
  };
  const choices: Array<{ kind: GroupResponder["kind"]; title: string; hint: string }> = [
    { kind: "lead", title: "The lead answers", hint: "One bot takes it, and hands parts to the others when they fit better" },
    { kind: "everyone", title: "Every bot answers", hint: "Each bot here answers in turn" },
    { kind: "mentions", title: "Only when named", hint: "Bots stay quiet until someone types @ and their name" },
  ];
  return (
    <section className="mb-4">
      <h3 className={HEADING}>When a message names no one</h3>
      <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="When a message names no one">
        {choices.map((choice) => {
          const selected = responder.kind === choice.kind;
          return (
            <button key={choice.kind} type="button" role="radio" aria-checked={selected} disabled={saving}
              onClick={() => { if (!selected) void choose({ kind: choice.kind } as GroupResponder); }}
              className={cn("flex w-full flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60",
                selected ? "border-accent-border bg-raised-hover" : "border-hairline/40 bg-inset hover:bg-raised")}>
              <span className="text-[13px] font-medium text-ink">{choice.title}</span>
              <span className="text-[11.5px] text-ink-secondary">{choice.hint}</span>
            </button>
          );
        })}
      </div>
      {responder.kind === "lead" && bots.length > 1 && (
        <label className="mt-2 flex items-center justify-between gap-2 px-1 text-ink-secondary">Lead
          <select aria-label="Lead bot" className={SELECT} disabled={saving} value={conversation.leadBotId ?? ""}
            onChange={(event) => void choose({ kind: "lead", botId: event.target.value })}>
            {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
        </label>
      )}
    </section>
  );
}

/** What every bot in the group reads ("focus on the IGRS project, answer
 * in Indonesian"). */
function GroupInstructions({ conversation, onError }: { conversation: Conversation; onError: (message: string) => void }) {
  const [text, setText] = useState(conversation.instructions ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => setText(conversation.instructions ?? ""), [conversation.instructions]);
  const changed = text.trim() !== (conversation.instructions ?? "").trim();
  const save = async () => {
    setSaving(true); onError("");
    try { await updateConversation(conversation.id, { instructions: text }); window.dispatchEvent(new Event(CONVERSATIONS_CHANGED)); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); } finally { setSaving(false); }
  };
  return (
    <section>
      <label className="block">
        <span className={HEADING}>Instructions for this group</span>
        <span className="block px-1 text-[12px] text-ink-secondary">Every bot here reads them, for example the project it is about or the language to use.</span>
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} maxLength={4000}
          placeholder="Focus on the IGRS project. Answer in Indonesian."
          className="mt-2 w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-tertiary focus:border-accent/60 focus:outline-none" />
      </label>
      {changed && <button type="button" disabled={saving} onClick={() => void save()}
        className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50">{saving ? "Saving…" : "Save instructions"}</button>}
    </section>
  );
}
