// The sidebar's groups and the people of the workspace, like Slack's
// channels and direct messages: each group by its name, then everyone else
// here; a person opens the DM with them (started on the first click). Unread
// ones are marked, and there is a way to start a new group.
import { useCallback, useEffect, useState } from "react";
import { PlusSignIcon, UserGroupIcon, UserIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "../HIcon";
import { cn } from "@/lib/cn";
import {
  CONVERSATIONS_CHANGED, OPEN_NEW_CONVERSATION, createConversation, useConversations, workspacePeople, type Conversation,
} from "@/lib/conversations";
import { useStore } from "@/state/store";

export interface Person { email: string; name: string }
export type SidebarRow = { kind: "conversation"; conversation: Conversation } | { kind: "person"; person: Person };

/** Groups first, then one row per other person: their DM when there is one. */
export function sidebarRows(conversations: Conversation[], others: Person[]): SidebarRow[] {
  const groups = conversations.filter((conversation) => conversation.kind === "group");
  const dms = conversations.filter((conversation) => conversation.kind === "dm");
  const dmWith = (email: string) => dms.find((dm) => dm.people.some((person) => !person.you && person.email.toLowerCase() === email.toLowerCase()));
  const people: SidebarRow[] = others.map((person) => {
    const dm = dmWith(person.email);
    return dm ? { kind: "conversation", conversation: dm } : { kind: "person", person };
  });
  // a DM with someone no longer listed here stays reachable
  const listed = new Set(others.map((person) => person.email.toLowerCase()));
  const rest = dms.filter((dm) => !dm.people.some((person) => !person.you && listed.has(person.email.toLowerCase())));
  return [...groups.map((conversation) => ({ kind: "conversation" as const, conversation })), ...people, ...rest.map((conversation) => ({ kind: "conversation" as const, conversation }))];
}

const rowClass = (selected: boolean) => cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13.5px]",
  selected ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/50 hover:text-ink");

export function ConversationListView({ conversations, people = [], selectedId, onSelect, onPerson = () => {}, onNew }: {
  conversations: Conversation[];
  /** Everyone else in the workspace. */
  people?: Person[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onPerson?: (email: string) => void;
  onNew: () => void;
}) {
  const rows = sidebarRows(conversations, people);
  return (
    <section aria-label="Groups and people" className="px-2 pb-2 pt-1">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">Groups and people</span>
        <button type="button" onClick={onNew} aria-label="New group or DM" title="New group or DM"
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink">
          <HIcon icon={PlusSignIcon} size={14} />
        </button>
      </div>
      {!rows.some((row) => row.kind === "conversation" && row.conversation.kind === "group") && (
        <button type="button" onClick={onNew} className="w-full rounded-lg px-2 py-1.5 text-left text-[12.5px] text-ink-tertiary hover:bg-raised/50 hover:text-ink-secondary">
          Start a group with people and bots
        </button>
      )}
      {rows.map((row) => row.kind === "person" ? (
        <button key={`person:${row.person.email}`} type="button" onClick={() => onPerson(row.person.email)} title={row.person.email} className={rowClass(false)}>
          <HIcon icon={UserIcon} size={15} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{row.person.name}</span>
        </button>
      ) : (
        <button key={row.conversation.id} type="button" onClick={() => onSelect(row.conversation.id)}
          aria-current={row.conversation.id === selectedId ? "page" : undefined} className={rowClass(row.conversation.id === selectedId)}>
          <HIcon icon={row.conversation.kind === "dm" ? UserIcon : UserGroupIcon} size={15} className="shrink-0" />
          <span className={cn("min-w-0 flex-1 truncate", row.conversation.unread && "font-semibold text-ink")}>{row.conversation.title}</span>
          {row.conversation.mentioned
            ? <span aria-label="You were mentioned" title="You were mentioned" className="shrink-0 rounded-full bg-accent px-1.5 text-[10.5px] font-bold leading-4 text-white">@</span>
            : row.conversation.unread && <span aria-label="Unread" className="size-2 shrink-0 rounded-full bg-accent" />}
        </button>
      ))}
    </section>
  );
}

/** Everyone in the workspace but the caller, refreshed when the window comes back. */
function useOtherPeople(): Person[] {
  const [others, setOthers] = useState<Person[]>([]);
  const reload = useCallback(() => {
    void Promise.all([workspacePeople(), fetch("/api/me", { credentials: "same-origin" }).then((res) => res.json()).catch(() => null)])
      .then(([everyone, me]) => {
        const mine = (me as { account?: { email?: string } } | null)?.account?.email?.toLowerCase();
        setOthers(everyone.filter((person) => person.email.toLowerCase() !== mine).sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => setOthers([]));
  }, []);
  useEffect(() => {
    reload();
    window.addEventListener("focus", reload);
    window.addEventListener(CONVERSATIONS_CHANGED, reload);
    return () => { window.removeEventListener("focus", reload); window.removeEventListener(CONVERSATIONS_CHANGED, reload); };
  }, [reload]);
  return others;
}

export function SidebarConversations() {
  const { state, dispatch } = useStore();
  const { conversations } = useConversations();
  const people = useOtherPeople();
  if (!conversations) return null;
  const openDm = async (email: string) => {
    try {
      const dm = await createConversation({ kind: "dm", emails: [email], bots: [] });
      window.dispatchEvent(new Event(CONVERSATIONS_CHANGED));
      dispatch({ type: "selectConversation", id: dm.id });
    } catch { window.dispatchEvent(new Event(OPEN_NEW_CONVERSATION)); }
  };
  return (
    <ConversationListView conversations={conversations} people={people} selectedId={state.selectedConversationId}
      onSelect={(id) => dispatch({ type: "selectConversation", id })}
      onPerson={(email) => void openDm(email)}
      onNew={() => window.dispatchEvent(new Event(OPEN_NEW_CONVERSATION))} />
  );
}
