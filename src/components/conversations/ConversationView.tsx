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
import { ComposerMenuRow } from "../ComposerMenuRow";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "../PendingApproval";
import { BotAvatar } from "../Avatar";
import { PersonAvatar } from "../PersonAvatar";
import { cn } from "@/lib/cn";
import {
  CONVERSATIONS_CHANGED, THREAD_FRAME, addToConversation, updateConversation, asChatMessages, conversationMessages, leaveConversation, markConversationRead,
  mentionQuery, mentionSuggestions, postToConversation, stopConversation, useConversations, withFrame, workspacePeople, type Conversation, type ThreadFrame,
} from "@/lib/conversations";
import { api, useStore, type Bot, type Message } from "@/state/store";

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
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState("");
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
  const mentionPeople = useMemo(() => conversation?.people.map((person) => person.name) ?? [], [conversation?.people]);
  const viewerKey = conversation?.people.find((person) => person.you)?.key;
  // a secret saved from a bot's card: tell the bot here, so it carries on
  const relay = useMemo(() => ({
    viewerKey,
    onSecretSaved: (name: string, botId: string) => {
      const botName = state.bots.find((bot) => bot.id === botId)?.name;
      if (!botName) return;
      void postToConversation(id, `@${botName} I saved ${name}. Please continue.`)
        .then(({ message }) => setMessages((current) => withFrame(current ?? [], { kind: "message", threadId: threadId ?? "", message })))
        .catch(() => {});
    },
  }), [viewerKey, state.bots, id, threadId]);
  if (!conversation) {
    return <main className="flex h-full flex-1 items-center justify-center bg-app text-ink-secondary"><HIcon icon={Loading02Icon} size={18} className="animate-spin" /></main>;
  }
  const memberBots = bots.filter((bot) => conversation.bots.includes(bot.id));
  const other = conversation.kind === "dm" ? conversation.people.find((person) => !person.you) : undefined;
  return (
    <ChatView key={conversation.id} bot={chatFor(conversation, shown)} accountConversation={{
      mentionPeople,
      relay,
      identity: (
        <span className={cn(CHATHEAD_PILL, "pr-3.5")} title={[...conversation.people.map((person) => person.you ? "You" : person.name), ...memberBots.map((bot) => bot.name)].join(", ")}>
          {other
            ? <PersonAvatar name={other.name} email={other.email} src={other.avatar} size={24} />
            : <span className="flex size-6 items-center justify-center rounded-full bg-raised text-ink-secondary"><HIcon icon={UserGroupIcon} size={14} /></span>}
          <span className="min-w-0 truncate text-[14px] font-semibold">{conversation.title}</span>
        </span>
      ),
      actions: (
        <>
        {conversation.canStop && <button type="button" disabled={stopping} onClick={() => {
          setStopping(true); setStopError("");
          void stopConversation(id).then(() => window.dispatchEvent(new Event(CONVERSATIONS_CHANGED)))
            .catch((error: unknown) => setStopError(error instanceof Error ? error.message : String(error)))
            .finally(() => setStopping(false));
        }} className="rounded-lg border border-hairline bg-panel px-3 py-1.5 text-xs text-ink-secondary hover:bg-raised disabled:opacity-50">
          {stopping ? "Stopping…" : "Stop my work"}
        </button>}
        <button type="button" onClick={() => setMembersOpen((open) => !open)} aria-expanded={membersOpen}
          className="rounded-lg border border-hairline bg-panel px-3 py-1.5 text-xs text-ink-secondary hover:bg-raised">
          {conversation.kind === "dm" ? "Details" : `Members · ${conversation.people.length + memberBots.length}`}
        </button>
        </>
      ),
      beforeMessages: (
        <>
          {stopError && <p role="alert" className="px-4 py-2 text-sm text-ink-secondary">{stopError}</p>}
          {membersOpen && <Members conversation={conversation} memberBots={memberBots.map((bot) => bot.id)} bots={bots}
            onLeft={() => { setMembersOpen(false); dispatch({ type: "selectConversation", id: null }); }} />}
          {!messages && <div className="flex justify-center py-8"><HIcon icon={Loading02Icon} size={16} className="animate-spin text-ink-secondary" /></div>}
        </>
      ),
      empty: messages ? <p className="py-10 text-center text-[13px] text-ink-secondary">No messages yet. Say hello, or @mention a bot to ask it.</p> : <></>,
      composer: <ConversationComposer key={conversation.id} conversation={conversation} bots={bots} messages={shown} viewerKey={viewerKey}
        onSent={(message) => setMessages((current) => withFrame(current ?? [], { kind: "message", threadId: conversation.threadId, message }))} />,
    }} />
  );
}

/** The composer pill of a bot chat, for a conversation: text, and "@" for
 * the people here and the bots one can ask, in the same menu as a bot chat
 * (faces, names, arrows to choose, Enter or Tab to pick, Esc to close). */
function ConversationComposer({ conversation, bots, messages, viewerKey, onSent }: {
  conversation: Conversation; bots: Bot[]; messages: Message[]; viewerKey?: string; onSent: (message: Message) => void;
}) {
  // a bot's question for this person, relayed from its work: answered here,
  // with the same panel as a bot chat, against the bot's own work
  const approval = useMemo(() => pendingApprovals(messages.filter((message) => message.relay?.askedBy === viewerKey))[0], [messages, viewerKey]);
  const approvalBot = approval ? bots.find((bot) => bot.id === approval.message.from?.botId) : undefined;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingSend = useRef<{ text: string; id: string } | null>(null);
  const people = useMemo(() => conversation.people.filter((person) => !person.you), [conversation.people]);
  const mentionable = useMemo(() => [
    ...people.map((person) => ({ name: person.name, kind: "person" as const })),
    ...bots.map((bot) => ({ name: bot.name, kind: "bot" as const })),
  ], [people, bots]);
  const query = mentionQuery(text);
  const queryAt = query === null ? null : text.length - query.length - 1;
  const suggestions = query === null || queryAt === dismissedAt ? [] : mentionSuggestions(query, mentionable);
  const open = suggestions.length > 0;
  useEffect(() => setHighlight(0), [query]);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
  }, [text]);
  const pick = (name: string) => {
    setText((value) => value.replace(/@([^\s@]*)$/, `@${name} `));
    setDismissedAt(null);
    inputRef.current?.focus();
  };
  const send = async () => {
    const value = text;
    if (!value.trim() || busy) return;
    setBusy(true); setError("");
    try {
      if (pendingSend.current?.text !== value) pendingSend.current = { text: value, id: crypto.randomUUID() };
      const { message } = await postToConversation(conversation.id, value, pendingSend.current.id);
      onSent(message);
      pendingSend.current = null;
      setText("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); inputRef.current?.focus(); }
  };
  const face = (entry: { name: string; kind: "person" | "bot" }) => {
    if (entry.kind === "bot") {
      const bot = bots.find((candidate) => candidate.name === entry.name);
      return bot ? <BotAvatar bot={bot} state="happy" size={24} motion="none" motionKey={0} animated={false} /> : null;
    }
    const person = people.find((candidate) => candidate.name === entry.name);
    return <PersonAvatar name={entry.name} email={person?.email} src={person?.avatar} size={24} />;
  };
  return (
    <form className="pointer-events-none relative px-5 pb-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <div className="pointer-events-auto relative w-full">
        {error && <p role="alert" className="mb-2 text-[12px] text-danger">{error}</p>}
        {approval?.message.relay && (
          <div className="mb-2 overflow-hidden rounded-2xl border border-accent/40 bg-card">
            <PendingApprovalPanel pending={approval} count={1} index={0} />
            <PendingApprovalActions pending={approval} threadId={approval.message.relay.threadId} bot={approvalBot}
              onCancelTurn={() => void api(`/api/bots/${approval.message.from?.botId}/interrupt`, { method: "POST", body: JSON.stringify({ threadId: approval.message.relay!.threadId }) }).catch(() => {})} />
          </div>
        )}
        <div className="relative">
          <div aria-hidden data-composer-backdrop className="pointer-events-none absolute -bottom-3 -left-5 -right-5 top-1/2 bg-app" />
          {open && (
            <div role="listbox" aria-label="Mention" className="absolute bottom-full start-2 z-20 mb-2 max-h-72 w-72 overflow-y-auto overscroll-contain rounded-xl border border-hairline/40 bg-raised shadow-lg">
              {suggestions.map((entry, index) => (
                <ComposerMenuRow key={`${entry.kind}:${entry.name}`} role="option" aria-selected={index === highlight} selected={index === highlight}
                  onMouseDown={(event) => { event.preventDefault(); pick(entry.name); }} onMouseEnter={() => setHighlight(index)}
                  icon={face(entry)} name={entry.name} kind={entry.kind === "bot" ? "Bot" : "Person"} />
              ))}
            </div>
          )}
          <div data-tour="composer" className={COMPOSER_PILL}>
            <div data-composer-row className={COMPOSER_ROW}>
              <MentionTextarea inputRef={inputRef} peers={mentionable.map((entry) => ({ name: entry.name }))} value={text} rows={1}
                placeholder={conversation.kind === "group" && bots.length ? `Message ${conversation.title} · type @ to ask a bot` : `Message ${conversation.title}`} aria-label="Message"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (open) {
                    if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((index) => (index + 1) % suggestions.length); return; }
                    if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((index) => (index - 1 + suggestions.length) % suggestions.length); return; }
                    if (event.key === "Escape") { event.preventDefault(); setDismissedAt(queryAt); return; }
                    if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pick(suggestions[highlight]!.name); return; }
                  }
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
      {kind === "group" && <GroupInstructions conversation={conversation} onError={setError} />}
      {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
    </div>
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
    <div className="mt-4 border-t border-hairline/40 pt-3">
      <label className="block">
        <span className="text-[12.5px] font-medium text-ink">Instructions for this group</span>
        <span className="mt-0.5 block text-[12px] text-ink-secondary">Every bot here reads them, for example the project it is about or the language to use.</span>
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} maxLength={4000}
          placeholder="Focus on the IGRS project. Answer in Indonesian."
          className="mt-2 w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-tertiary focus:border-accent/60 focus:outline-none" />
      </label>
      {changed && <button type="button" disabled={saving} onClick={() => void save()}
        className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50">{saving ? "Saving…" : "Save instructions"}</button>}
    </div>
  );
}
