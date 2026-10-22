// The sidebar's groups and the people of the workspace, like Slack's
// channels and direct messages: each group by its name, then everyone else
// here; a person opens the DM with them (started on the first click). Each
// row is the size of a bot's, with a face and the last thing said; unread
// ones are marked. A new group starts from the sidebar's + menu.
import { useCallback, useEffect, useState } from "react";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "../HIcon";
import { PersonAvatar } from "../PersonAvatar";
import { cn } from "@/lib/cn";
import {
  CONVERSATIONS_CHANGED, OPEN_NEW_CONVERSATION, createConversation, useConversations, workspacePeople, type Conversation,
} from "@/lib/conversations";
import { useShowThreads } from "@/lib/thread-preferences";
import { useStore } from "@/state/store";

export interface Person { email: string; name: string; avatar?: string }
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

/** The size a bot's row has at this density (Sidebar's BotListItem), so a
 * person, a group and a bot sit in the sidebar as equals. */
export function rowMetrics(density: "compact" | "comfortable" | string, showThreads: boolean) {
  const compact = density === "compact";
  return {
    avatar: compact ? (showThreads ? 26 : 40) : (showThreads ? 32 : 56),
    row: cn("flex w-full items-center rounded-md pr-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
      compact ? (showThreads ? "gap-1.5 py-1" : "gap-2 py-1.5") : (showThreads ? "gap-2 py-2" : "gap-3 py-2.5"),
      showThreads ? "pl-6" : "pl-2"),
  };
}

function Face({ conversation, person, size }: { conversation?: Conversation; person?: Person; size: number }) {
  const other = person ?? (conversation?.kind === "dm" ? conversation.people.find((entry) => !entry.you) : undefined);
  return other
    ? <PersonAvatar name={other.name} email={other.email} src={other.avatar} size={size} />
    : <span className="flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary" style={{ width: size, height: size }}>
      <HIcon icon={UserGroupIcon} size={Math.round(size * 0.5)} />
    </span>;
}

export function ConversationListView({ conversations, people = [], selectedId, density = "comfortable", showThreads = true, onSelect, onPerson = () => {} }: {
  conversations: Conversation[];
  /** Everyone else in the workspace. */
  people?: Person[];
  selectedId: string | undefined;
  density?: string;
  showThreads?: boolean;
  onSelect: (id: string) => void;
  onPerson?: (email: string) => void;
}) {
  const rows = sidebarRows(conversations, people);
  if (rows.length === 0) return null;
  const metrics = rowMetrics(density, showThreads);
  const line = (name: string, second: string, unread = false, mentioned = false) => (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[14px] font-semibold text-ink">{name}</span>
        {mentioned && <span aria-label="You were mentioned" title="You were mentioned" className="shrink-0 rounded-full bg-accent px-1.5 text-[10.5px] font-bold leading-4 text-white">@</span>}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] text-ink-secondary">{second}</span>
        {unread && !mentioned && <span aria-label="Unread" className="size-2 shrink-0 rounded-full bg-accent" />}
      </div>
    </div>
  );
  return (
    <section aria-label="Groups and people" className="flex flex-col gap-0.5 pb-1.5">
      {rows.map((row) => row.kind === "person" ? (
        <button key={`person:${row.person.email}`} type="button" onClick={() => onPerson(row.person.email)} title={row.person.email}
          className={cn(metrics.row, "hover:bg-raised/40")}>
          <Face person={row.person} size={metrics.avatar} />
          {line(row.person.name, "Send a message")}
        </button>
      ) : (
        <button key={row.conversation.id} type="button" onClick={() => onSelect(row.conversation.id)}
          aria-current={row.conversation.id === selectedId ? "page" : undefined}
          className={cn(metrics.row, row.conversation.id === selectedId ? "bg-raised/70" : "hover:bg-raised/40")}>
          <Face conversation={row.conversation} size={metrics.avatar} />
          {line(row.conversation.title,
            row.conversation.preview || (row.conversation.kind === "group" ? `${row.conversation.people.length + row.conversation.bots.length} members` : "Send a message"),
            row.conversation.unread, row.conversation.mentioned)}
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

export function SidebarConversations({ density }: { density: string }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
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
      density={density} showThreads={showThreads}
      onSelect={(id) => dispatch({ type: "selectConversation", id })}
      onPerson={(email) => void openDm(email)} />
  );
}
