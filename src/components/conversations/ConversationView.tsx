// A group or a DM between people, open in the main pane: who is in it, every
// message with who wrote it (people and bots), and a composer where
// @mentioning a bot asks it to answer here.
import { useEffect, useMemo, useRef, useState } from "react";
import { Loading02Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "../HIcon";
import { ChatMarkdown } from "../ChatMarkdown";
import { MentionTextarea } from "../MentionTextarea";
import { cn } from "@/lib/cn";
import {
  CONVERSATIONS_CHANGED, THREAD_FRAME, addToConversation, conversationMessages, leaveConversation, markConversationRead,
  postToConversation, useConversations, withFrame, workspacePeople, type ThreadFrame,
} from "@/lib/conversations";
import { useStore, type Message } from "@/state/store";

export function ConversationMessagesView({ messages, threadId = "" }: { messages: Message[]; threadId?: string }) {
  if (messages.length === 0) return <p className="px-2 py-8 text-center text-[13px] text-ink-tertiary">No messages yet. Say hello, or @mention a bot to ask it.</p>;
  return (
    <ol className="flex flex-col gap-4">
      {messages.map((message) => {
        const bot = message.role === "bot";
        const who = bot ? message.from?.name ?? "Bot" : message.sender?.name ?? "Someone";
        return (
          <li key={message.id} className="flex gap-3">
            <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold", bot ? "bg-accent/20 text-accent" : "bg-raised text-ink-secondary")}>
              {who.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] text-ink-secondary"><span className="font-medium text-ink">{who}</span>{bot && " · Bot"}</div>
              <div className="text-[14px] text-ink"><ChatMarkdown text={message.text ?? ""} mentionPeers={[]} message={{ threadId, messageId: message.id }} /></div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function ConversationView({ id }: { id: string }) {
  const { state, dispatch } = useStore();
  const { conversations } = useConversations();
  const conversation = conversations?.find((entry) => entry.id === id);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [membersOpen, setMembersOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: "end" }); }, [messages?.length]);

  const bots = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);
  const memberBots = bots.filter((bot) => conversation?.bots.includes(bot.id));
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true); setError("");
    try {
      const { message } = await postToConversation(id, value);
      setMessages((current) => withFrame(current ?? [], { kind: "message", threadId: threadId ?? "", message }));
      setText("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };

  if (!conversation) {
    return <main className="flex h-full flex-1 items-center justify-center bg-app text-ink-secondary"><HIcon icon={Loading02Icon} size={18} className="animate-spin" /></main>;
  }
  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <header className="flex items-center gap-3 border-b border-hairline/40 px-6 py-3">
        <HIcon icon={UserGroupIcon} size={18} className="text-ink-secondary" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold text-ink">{conversation.title}</h1>
          <p className="truncate text-[12px] text-ink-secondary">
            {[...conversation.people.map((person) => person.you ? "You" : person.name), ...memberBots.map((bot) => bot.name)].join(", ")}
          </p>
        </div>
        <button type="button" onClick={() => setMembersOpen((open) => !open)} className="rounded-lg border border-hairline bg-panel px-3 py-1.5 text-xs text-ink-secondary hover:bg-raised">Members</button>
      </header>
      {membersOpen && <Members conversationId={id} kind={conversation.kind} people={conversation.people} memberBots={memberBots.map((bot) => bot.id)}
        bots={bots} onLeft={() => { setMembersOpen(false); dispatch({ type: "selectConversation", id: null }); }} />}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {messages ? <ConversationMessagesView messages={messages} threadId={threadId} /> : <HIcon icon={Loading02Icon} size={16} className="animate-spin text-ink-secondary" />}
        <div ref={endRef} />
      </div>
      <form className="border-t border-hairline/40 px-6 py-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <div className="rounded-2xl border border-hairline/50 bg-panel px-4 py-2.5">
          <MentionTextarea inputRef={inputRef} peers={bots} value={text} rows={2} disabled={busy}
            placeholder={`Message ${conversation.title} — @mention a bot to ask it`}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
            className="w-full resize-none bg-transparent text-[14px] text-ink placeholder:text-ink-tertiary focus:outline-none" />
          {bots.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {bots.slice(0, 6).map((bot) => (
                <button key={bot.id} type="button" onClick={() => { setText((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}@${bot.name} `); inputRef.current?.focus(); }}
                  className="rounded-full bg-raised px-2 py-0.5 text-[11.5px] text-ink-secondary hover:text-ink">@{bot.name}</button>
              ))}
            </div>
          )}
        </div>
        {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
      </form>
    </main>
  );
}

function Members({ conversationId, kind, people, memberBots, bots, onLeft }: {
  conversationId: string; kind: "group" | "dm"; people: Array<{ email: string; name: string; you: boolean }>;
  memberBots: string[]; bots: Array<{ id: string; name: string }>; onLeft: () => void;
}) {
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
    <div className="border-b border-hairline/40 bg-panel px-6 py-3 text-[12.5px]">
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
