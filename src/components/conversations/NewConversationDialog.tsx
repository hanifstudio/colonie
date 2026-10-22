// Starting a group (a name, people, bots) or a DM with one person.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "../HIcon";
import { cn } from "@/lib/cn";
import { CONVERSATIONS_CHANGED, OPEN_NEW_CONVERSATION, createConversation, workspacePeople } from "@/lib/conversations";
import { useStore } from "@/state/store";

type Kind = "group" | "dm";

export function NewConversationView({ kind, name, people, bots, chosenPeople, chosenBots, busy, error, onKind, onName, onTogglePerson, onToggleBot, onCreate, onClose }: {
  kind: Kind; name: string;
  people: Array<{ email: string; name: string }>; bots: Array<{ id: string; name: string }>;
  chosenPeople: string[]; chosenBots: string[]; busy: boolean; error: string;
  onKind: (kind: Kind) => void; onName: (name: string) => void;
  onTogglePerson: (email: string) => void; onToggleBot: (id: string) => void;
  onCreate: () => void; onClose: () => void;
}) {
  const check = (on: boolean) => cn("flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]", on ? "bg-accent/15 text-ink" : "text-ink-secondary hover:bg-raised");
  const ready = kind === "dm" ? chosenPeople.length === 1 : Boolean(name.trim()) && chosenPeople.length + chosenBots.length > 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form role="dialog" aria-modal="true" aria-label="New group or DM" onSubmit={(event) => { event.preventDefault(); if (ready) onCreate(); }}
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        className="w-full max-w-[460px] rounded-[20px] border border-hairline/50 bg-panel p-6 shadow-2xl shadow-black/50">
        <div role="radiogroup" aria-label="Kind" className="grid grid-cols-2 gap-2">
          {([["group", "Group", "People and bots, with a name"], ["dm", "Direct message", "You and one person"]] as const).map(([value, label, detail]) => (
            <button key={value} type="button" role="radio" aria-checked={kind === value} onClick={() => onKind(value)}
              className={cn("rounded-xl border p-3 text-left", kind === value ? "border-accent/60 bg-accent/10" : "border-hairline/40 hover:bg-raised")}>
              <span className="block text-[13.5px] font-medium text-ink">{label}</span>
              <span className="block text-[11.5px] text-ink-secondary">{detail}</span>
            </button>
          ))}
        </div>
        {kind === "group" && (
          <input autoFocus value={name} onChange={(event) => onName(event.target.value)} maxLength={60} aria-label="Group name" placeholder="Group name"
            className="mt-4 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-tertiary focus:outline-none" />
        )}
        {people.length > 0 && (
          <fieldset className="mt-4">
            <legend className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-ink-tertiary">People</legend>
            <div className="flex max-h-40 flex-col overflow-y-auto">
              {people.map((person) => (
                <button key={person.email} type="button" className={check(chosenPeople.includes(person.email))} onClick={() => onTogglePerson(person.email)} aria-pressed={chosenPeople.includes(person.email)}>
                  <span className="min-w-0 flex-1 truncate">{person.name}</span>
                  {person.name !== person.email && <span className="truncate text-[11.5px] text-ink-tertiary">{person.email}</span>}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        {kind === "group" && bots.length > 0 && (
          <fieldset className="mt-4">
            <legend className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-ink-tertiary">Bots</legend>
            <div className="flex max-h-32 flex-col overflow-y-auto">
              {bots.map((bot) => (
                <button key={bot.id} type="button" className={check(chosenBots.includes(bot.id))} onClick={() => onToggleBot(bot.id)} aria-pressed={chosenBots.includes(bot.id)}>
                  {bot.name}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        {kind === "dm" && people.length === 0 && <p className="mt-4 text-[12.5px] text-ink-secondary">Nobody else is in this workspace yet. Invite people first.</p>}
        {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-[12.5px] text-ink-secondary hover:bg-raised">Cancel</button>
          <button type="submit" disabled={!ready || busy} className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50">
            {busy && <HIcon icon={Loading02Icon} size={13} className="animate-spin" />}{kind === "dm" ? "Start DM" : "Create group"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function NewConversationDialog() {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("group");
  const [name, setName] = useState("");
  const [people, setPeople] = useState<Array<{ email: string; name: string }>>([]);
  const [chosenPeople, setChosenPeople] = useState<string[]>([]);
  const [chosenBots, setChosenBots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const show = () => { setOpen(true); setError(""); setName(""); setChosenPeople([]); setChosenBots([]); };
    window.addEventListener(OPEN_NEW_CONVERSATION, show);
    return () => window.removeEventListener(OPEN_NEW_CONVERSATION, show);
  }, []);
  useEffect(() => {
    if (!open) return;
    void Promise.all([workspacePeople(), fetch("/api/me", { credentials: "same-origin" }).then((res) => res.json()).catch(() => null)])
      .then(([everyone, me]) => setPeople(everyone.filter((person) => person.email !== (me as { account?: { email?: string } } | null)?.account?.email)))
      .catch(() => setPeople([]));
  }, [open]);
  if (!open) return null;
  const toggle = (list: string[], value: string, single: boolean) => list.includes(value) ? list.filter((entry) => entry !== value) : single ? [value] : [...list, value];
  const create = async () => {
    setBusy(true); setError("");
    try {
      const made = await createConversation({ kind, name, emails: chosenPeople, bots: kind === "group" ? chosenBots : [] });
      window.dispatchEvent(new Event(CONVERSATIONS_CHANGED));
      dispatch({ type: "selectConversation", id: made.id });
      setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  return createPortal(
    <NewConversationView kind={kind} name={name} people={people} bots={state.bots.filter((bot) => !bot.hidden)}
      chosenPeople={chosenPeople} chosenBots={chosenBots} busy={busy} error={error}
      onKind={(next) => { setKind(next); setChosenPeople([]); }} onName={setName}
      onTogglePerson={(email) => setChosenPeople((list) => toggle(list, email, kind === "dm"))}
      onToggleBot={(id) => setChosenBots((list) => toggle(list, id, false))}
      onCreate={() => void create()} onClose={() => setOpen(false)} />,
    document.body,
  );
}
