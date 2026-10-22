// The sidebar's groups and DMs between people: each by its name (a DM by the
// other person's), unread ones marked, and a way to start a new one.
import { PlusSignIcon, UserGroupIcon, UserIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "../HIcon";
import { cn } from "@/lib/cn";
import { OPEN_NEW_CONVERSATION, useConversations, type Conversation } from "@/lib/conversations";
import { useStore } from "@/state/store";

export function ConversationListView({ conversations, selectedId, onSelect, onNew }: {
  conversations: Conversation[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <section aria-label="Groups and people" className="px-2 pb-2 pt-1">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">Groups and people</span>
        <button type="button" onClick={onNew} aria-label="New group or DM" title="New group or DM"
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink">
          <HIcon icon={PlusSignIcon} size={14} />
        </button>
      </div>
      {conversations.length === 0 && (
        <button type="button" onClick={onNew} className="w-full rounded-lg px-2 py-1.5 text-left text-[12.5px] text-ink-tertiary hover:bg-raised/50 hover:text-ink-secondary">
          Start a group with people and bots
        </button>
      )}
      {conversations.map((conversation) => (
        <button key={conversation.id} type="button" onClick={() => onSelect(conversation.id)}
          aria-current={conversation.id === selectedId ? "page" : undefined}
          className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13.5px]",
            conversation.id === selectedId ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/50 hover:text-ink")}>
          <HIcon icon={conversation.kind === "dm" ? UserIcon : UserGroupIcon} size={15} className="shrink-0" />
          <span className={cn("min-w-0 flex-1 truncate", conversation.unread && "font-semibold text-ink")}>{conversation.title}</span>
          {conversation.unread && <span aria-label="Unread" className="size-2 shrink-0 rounded-full bg-accent" />}
        </button>
      ))}
    </section>
  );
}

export function SidebarConversations() {
  const { state, dispatch } = useStore();
  const { conversations } = useConversations();
  if (!conversations) return null;
  return (
    <ConversationListView conversations={conversations} selectedId={state.selectedConversationId}
      onSelect={(id) => dispatch({ type: "selectConversation", id })}
      onNew={() => window.dispatchEvent(new Event(OPEN_NEW_CONVERSATION))} />
  );
}
