// A group or a DM between people, open in the main pane. It is the same chat
// as with a bot (ChatView: header pill, bubbles, composer pill): your own
// messages on the right, everyone else's on the left under their face and
// name. @mentioning a bot asks it to answer here.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp01Icon, Loading02Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "../HIcon";
import { ChatView, CHATHEAD_PILL } from "../ChatView";
import { COMPOSER_INPUT, COMPOSER_PILL, COMPOSER_ROW } from "../Composer";
import { MentionTextarea } from "../MentionTextarea";
import { PersonAvatar } from "../PersonAvatar";
import { cn } from "@/lib/cn";
import {
  CONVERSATIONS_CHANGED, THREAD_FRAME, addToConversation, asChatMessages, conversationMessages, leaveConversation, markConversationRead,
  mentionQuery, mentionSuggestions, postToConversation, useConversations, withFrame, workspacePeople, type Conversation, type ThreadFrame,
} from "@/lib/conversations";
import { useStore, type Bot, type Message } from "@/state/store";

/** The conversation as the chat view's "bot": its title and messages. Never
 * one of the workspace's bots, so nothing done to a bot reaches it. */
function chatFor(conversation: Conversation, messages: Message[]): Bot {
  return {
    id: `conversation:${conversation.id}`, threadId: conversation.threadId, name: conversation.title, title: "", description: "",
    messages, color: "blue", notifications: true, unread: false, busy: false, activity: "idle", computer: "off",
    modelSelection: { instanceId: "conversation", model: "" },
  } as Bot;
}

export function ConversationView({ id }: { id: string }) {
  const { state, dispatch } = useStore();
  const { conversations } = useConversations();
  const conversation = conversations?.find((entry) => entry.id === id);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const threadId = conversation?.threadId;

  useEffect(() => {
    setMessages(null);
    void conversationMessages(id).then(setMessages).catch(() => setMessages([]));
    void markConversationRead(id).then(() => window.dispatchEvent(new Event(CONVERSATIONS_CHANGED)));
  }, [id]);
  useEffect(() => {
    if (!threadId) return;
    const onFrame = (event: Event) => {
      const frame = (event as CustomEvent<ThreadFrame>).detail;
      if (frame.threadId !== threadId) return;
      setMessages((current) => withFrame(current ?? [], frame));
      void markConversationRead(id);
    };
    window.addEventListener(THREAD_FRAME, onFrame);
    return () => window.removeEventListener(THREAD_FRAME, onFrame);
  }, [id, threadId]);

  const bots = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);
  const shown = useMemo(() => conversation && messages ? asChatMessages(messages, conversation.people) : [], [conversation, messages]);
  if (!conversation) {
    return <main className="flex h-full flex-1 items-center justify-center bg-app text-ink-secondary"><HIcon icon={Loading02Icon} size={18} className="animate-spin" /></main>;
  }
  const memberBots = bots.filter((bot) => conversation.bots.includes(bot.id));
  const other = conversation.kind === "dm" ? conversation.people.find((person) => !person.you) : undefined;
  return (
    <ChatView key={conversation.id} bot={chatFor(conversation, shown)} accountConversation={{
      identity: (
        <span className={cn(CHATHEAD_PILL, "pr-3.5")} title={[...conversation.people.map((person) => person.you ? "You" : person.name), ...memberBots.map((bot) => bot.name)].join(", ")}>
          {other
            ? <PersonAvatar name={other.name} email={other.email} src={other.avatar} size={24} />
            : <span className="flex size-6 items-center justify-center rounded-full bg-raised text-ink-secondary"><HIcon icon={UserGroupIcon} size={14} /></span>}
          <span className="min-w-0 truncate text-[14px] font-semibold">{conversation.title}</span>
        </span>
      ),
      actions: (
        <button type="button" onClick={() => setMembersOpen((open) => !open)} aria-expanded={membersOpen}
          className="rounded-lg border border-hairline bg-panel px-3 py-1.5 text-xs text-ink-secondary hover:bg-raised">
          {conversation.kind === "dm" ? "Details" : `Members · ${conversation.people.length + memberBots.length}`}
        </button>
      ),
      beforeMessages: (
        <>
          {membersOpen && <Members conversation={conversation} memberBots={memberBots.map((bot) => bot.id)} bots={bots}
            onLeft={() => { setMembersOpen(false); dispatch({ type: "selectConversation", id: null }); }} />}
          {!messages && <div className="flex justify-center py-8"><HIcon icon={Loading02Icon} size={16} className="animate-spin text-ink-secondary" /></div>}
        </>
      ),
      empty: messages ? <p className="py-10 text-center text-[13px] text-ink-secondary">No messages yet. Say hello, or @mention a bot to ask it.</p> : <></>,
      composer: <ConversationComposer key={conversation.id} conversation={conversation} bots={bots}
        onSent={(message) => setMessages((current) => withFrame(current ?? [], { kind: "message", threadId: conversation.threadId, message }))} />,
    }} />
  );
}

/** The composer pill of a bot chat, for a conversation: text, @mentions of
 * the people here and the bots one can ask. */
function ConversationComposer({ conversation, bots, onSent }: { conversation: Conversation; bots: Bot[]; onSent: (message: Message) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mentionable = useMemo(() => [
    ...conversation.people.filter((person) => !person.you).map((person) => ({ name: person.name, kind: "person" as const })),
    ...bots.map((bot) => ({ name: bot.name, kind: "bot" as const })),
  ], [conversation.people, bots]);
  const query = mentionQuery(text);
  const suggestions = query === null ? [] : mentionSuggestions(query, mentionable);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
  }, [text]);
  const pick = (name: string) => {
    setText((value) => value.replace(/@([^\s@]*)$/, `@${name} `));
    inputRef.current?.focus();
  };
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true); setError("");
    try {
      const { message } = await postToConversation(conversation.id, value);
      onSent(message);
      setText("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); inputRef.current?.focus(); }
  };
  return (
    <form className="pointer-events-none relative px-5 pb-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <div className="pointer-events-auto relative w-full">
        {suggestions.length > 0 && (
          <ul role="listbox" aria-label="Mention" className="mb-2 overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1 text-[13px]">
            {suggestions.map((entry) => (
              <li key={`${entry.kind}:${entry.name}`}>
                <button type="button" onMouseDown={(event) => { event.preventDefault(); pick(entry.name); }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ink hover:bg-raised">
                  <span>@{entry.name}</span><span className="text-[11px] text-ink-tertiary">{entry.kind === "bot" ? "Bot" : "Person"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p role="alert" className="mb-2 text-[12px] text-danger">{error}</p>}
        <div className="relative">
          <div aria-hidden data-composer-backdrop className="pointer-events-none absolute -bottom-3 -left-5 -right-5 top-1/2 bg-app" />
          <div data-tour="composer" className={COMPOSER_PILL}>
            {bots.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-2 pt-1">
                {bots.slice(0, 6).map((bot) => (
                  <button key={bot.id} type="button" onClick={() => { setText((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}@${bot.name} `); inputRef.current?.focus(); }}
                    className="rounded-full bg-raised px-2 py-0.5 text-[11.5px] text-ink-secondary hover:text-ink">@{bot.name}</button>
                ))}
              </div>
            )}
            <div data-composer-row className={COMPOSER_ROW}>
              <MentionTextarea inputRef={inputRef} peers={mentionable.map((entry) => ({ name: entry.name }))} value={text} rows={1} disabled={busy}
                placeholder={`Message ${conversation.title}`} aria-label="Message"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.key === "Enter" || event.key === "Tab") && suggestions.length > 0) { event.preventDefault(); pick(suggestions[0]!.name); return; }
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
                }}
                className={cn(COMPOSER_INPUT, "ml-2 flex-1")} />
              <button type="submit" aria-label="Send message" title="Send message" disabled={!text.trim() || busy}
                className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-white hover:brightness-110 disabled:opacity-40">
                {busy ? <HIcon icon={Loading02Icon} size={14} className="animate-spin" /> : <HIcon icon={ArrowUp01Icon} size={17} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}

function Members({ conversation, memberBots, bots, onLeft }: {
  conversation: Conversation; memberBots: string[]; bots: Array<{ id: string; name: string }>; onLeft: () => void;
}) {
  const { id: conversationId, kind, people } = conversation;
  const [everyone, setEveryone] = useState<Array<{ email: string; name: string }>>([]);
  const [error, setError] = useState("");
  useEffect(() => { void workspacePeople().then(setEveryone).catch(() => {}); }, []);
  const changed = () => window.dispatchEvent(new Event(CONVERSATIONS_CHANGED));
  const add = async (input: { emails?: string[]; bots?: string[] }) => {
    setError("");
    try { await addToConversation(conversationId, input); changed(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const inPeople = new Set(people.map((person) => person.email));
  return (
    <div className="mx-auto w-full max-w-[42rem] rounded-2xl border border-hairline/40 bg-panel px-4 py-3 text-[12.5px]">
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-2">
        {people.map((person) => (
          <li key={person.email || person.name} className="flex items-center gap-2 text-ink">
            <PersonAvatar name={person.name} email={person.email} src={person.avatar} size={20} />{person.you ? `${person.name} (you)` : person.name}
          </li>
        ))}
        {bots.filter((bot) => memberBots.includes(bot.id)).map((bot) => <li key={bot.id} className="text-ink-secondary">{bot.name} · Bot</li>)}
      </ul>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {kind === "group" && everyone.filter((person) => !inPeople.has(person.email)).length > 0 && (
          <label className="flex items-center gap-2 text-ink-secondary">Add a person
            <select className="rounded-md border border-hairline/40 bg-inset px-2 py-1 text-ink" value="" onChange={(event) => void add({ emails: [event.target.value] })}>
              <option value="">Choose…</option>
              {everyone.filter((person) => !inPeople.has(person.email)).map((person) => <option key={person.email} value={person.email}>{person.name}</option>)}
            </select>
          </label>
        )}
        {bots.filter((bot) => !memberBots.includes(bot.id)).length > 0 && (
          <label className="flex items-center gap-2 text-ink-secondary">Add a bot
            <select className="rounded-md border border-hairline/40 bg-inset px-2 py-1 text-ink" value="" onChange={(event) => void add({ bots: [event.target.value] })}>
              <option value="">Choose…</option>
              {bots.filter((bot) => !memberBots.includes(bot.id)).map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          </label>
        )}
        <button type="button" className="text-danger hover:underline" onClick={() => void leaveConversation(conversationId).then(() => { window.dispatchEvent(new Event(CONVERSATIONS_CHANGED)); onLeft(); })}>
          Leave this {kind === "dm" ? "DM" : "group"}
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
    </div>
  );
}
