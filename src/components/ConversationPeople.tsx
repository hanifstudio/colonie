// The people in a conversation, in a Shared workspace: shown in the
// conversation's header. Anyone in it can add another person of the
// workspace, who then sees the whole conversation and writes in it, or leave
// it. Nothing shows outside a Shared workspace (the server answers 404).
import { useCallback, useEffect, useState } from "react";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { api } from "@/state/store";

export interface ConversationPerson { email: string; name: string; you: boolean }

export function ConversationPeopleView({ people, open, email, busy, error, onToggle, onEmail, onAdd, onLeave }: {
  people: ConversationPerson[];
  open: boolean;
  email: string;
  busy: boolean;
  error: string;
  onToggle: () => void;
  onEmail: (email: string) => void;
  onAdd: () => void;
  onLeave: () => void;
}) {
  return (
    <div className="relative">
      <button type="button" onClick={onToggle} aria-expanded={open} aria-haspopup="dialog"
        className="flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-2.5 py-1.5 text-xs text-ink-secondary hover:bg-raised">
        <HIcon icon={UserGroupIcon} size={14} />{people.length === 1 ? "1 person" : `${people.length} people`}
      </button>
      {open && (
        <div role="dialog" aria-label="People in this conversation"
          className="absolute right-0 top-full z-40 mt-1.5 w-72 rounded-xl border border-hairline/50 bg-menu p-3 text-[12.5px] shadow-xl">
          <ul className="flex flex-col gap-1.5">
            {people.map((person) => (
              <li key={person.email || person.name} className="min-w-0">
                <div className="truncate text-ink">{person.name}{person.you ? " (you)" : ""}</div>
                {person.email && person.email !== person.name && <div className="truncate text-[11px] text-ink-secondary">{person.email}</div>}
              </li>
            ))}
          </ul>
          <form className="mt-3 flex gap-1.5" onSubmit={(event) => { event.preventDefault(); onAdd(); }}>
            <input value={email} onChange={(event) => onEmail(event.target.value)} disabled={busy} aria-label="Email address to add" placeholder="name@company.com"
              className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[12.5px] text-ink placeholder:text-ink-tertiary focus:outline-none" />
            <button type="submit" disabled={busy || !email.trim()} className="rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-semibold text-white disabled:opacity-60">Add</button>
          </form>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-secondary">
            You can add people in this workspace. They see the whole conversation, and the bot answers them too.
          </p>
          {error && <p role="alert" className="mt-1.5 text-[11.5px] text-danger">{error}</p>}
          <button type="button" onClick={onLeave} disabled={busy} className="mt-2 text-[11.5px] text-danger hover:underline disabled:opacity-50">Leave this conversation</button>
        </div>
      )}
    </div>
  );
}

export function ConversationPeople({ threadId, onLeft }: { threadId: string; onLeft?: () => void }) {
  const [people, setPeople] = useState<ConversationPerson[] | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!threadId) { setPeople(null); return; } // no conversation yet
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}/people`, { credentials: "same-origin" });
      setPeople(res.ok ? ((await res.json()) as { people: ConversationPerson[] }).people : null);
    } catch {
      setPeople(null);
    }
  }, [threadId]);
  useEffect(() => { setOpen(false); setError(""); void load(); }, [load]);
  if (!people || !threadId) return null;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  const add = () => run(async () => {
    const answer = await api<{ people: ConversationPerson[] }>(`/api/threads/${encodeURIComponent(threadId)}/people`, { method: "POST", body: JSON.stringify({ email: email.trim() }) });
    setPeople(answer.people);
    setEmail("");
  });
  const leave = () => run(async () => {
    await api(`/api/threads/${encodeURIComponent(threadId)}/people/me`, { method: "DELETE" });
    setOpen(false);
    setPeople(null);
    onLeft?.();
  });
  return <ConversationPeopleView people={people} open={open} email={email} busy={busy} error={error}
    onToggle={() => setOpen((value) => !value)} onEmail={(next) => { setEmail(next); setError(""); }} onAdd={() => void add()} onLeave={() => void leave()} />;
}
