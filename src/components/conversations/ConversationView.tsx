// A group or a DM between people, open in the main pane. It is the same chat
// as with a bot (ChatView: header pill, bubbles, composer pill): your own
// messages on the right, everyone else's on the left under their face and
// name. @mentioning a bot asks it to answer here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  CONVERSATIONS_CHANGED, THREAD_FRAME, asChatMessages, conversationMessages, markConversationRead,
  postToConversation, stopConversation, useConversations, withFrame, type Conversation, type ThreadFrame,
} from "@/lib/conversations";
import { api, useStore, type Bot, type Message } from "@/state/store";
import { useMentionPicker } from "@/lib/use-mention-picker";
import { writeComputerPanelView } from "@/lib/computer-panel-view";
import { HERE_MENTION } from "../../../shared/mention-boundary";
import { GroupPanel } from "./GroupPanel";

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
  const mentionPeople = useMemo(() => [...conversation?.people.map((person) => person.name) ?? [], ...(conversation?.kind === "group" ? [HERE_MENTION] : [])], [conversation?.people, conversation?.kind]);
  const viewerKey = conversation?.people.find((person) => person.you)?.key;
  // a card settled for a bot (a secret saved, a sign-in done): tell the bot
  // here, in the person's words, so it carries on
  const continueBot = useCallback((text: string, botId: string) => {
    const botName = state.bots.find((bot) => bot.id === botId)?.name;
    if (!botName) return;
    void postToConversation(id, `@${botName} ${text}`)
      .then(({ message }) => setMessages((current) => withFrame(current ?? [], { kind: "message", threadId: threadId ?? "", message })))
      .catch(() => {});
  }, [state.bots, id, threadId]);
  const relay = useMemo(() => ({
    viewerKey,
    onSecretSaved: (name: string, botId: string) => continueBot(`I saved ${name}. Please continue.`, botId),
    continueBot,
  }), [viewerKey, continueBot]);
  if (!conversation) {
    return <main className="flex h-full flex-1 items-center justify-center bg-app text-ink-secondary"><HIcon icon={Loading02Icon} size={18} className="animate-spin" /></main>;
  }
  const memberBots = bots.filter((bot) => conversation.bots.includes(bot.id));
  const other = conversation.kind === "dm" ? conversation.people.find((person) => !person.you) : undefined;
  return (<>
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
        {memberBots.length > 0 && <BotBrowserButton bots={memberBots} onOpen={(botId) => {
          writeComputerPanelView(botId, "browser");
          dispatch({ type: "toggleComputer", open: true, botId });
        }} />}
        {/* Files and Members open the group's right panel, like a bot's Computer panel */}
        <button type="button" onClick={() => dispatch({ type: "toggleGroupPanel", tab: "files" })} aria-pressed={state.groupPanel === "files"}
          className={cn("rounded-lg border border-hairline bg-panel px-3 py-1.5 text-xs text-ink-secondary hover:bg-raised", state.groupPanel === "files" && "bg-raised text-ink")}>
          Files
        </button>
        <button type="button" onClick={() => dispatch({ type: "toggleGroupPanel", tab: "members" })} aria-pressed={state.groupPanel === "members"}
          className={cn("rounded-lg border border-hairline bg-panel px-3 py-1.5 text-xs text-ink-secondary hover:bg-raised", state.groupPanel === "members" && "bg-raised text-ink")}>
          {conversation.kind === "dm" ? "Details" : `Members · ${conversation.people.length + memberBots.length}`}
        </button>
        </>
      ),
      beforeMessages: (
        <>
          {stopError && <p role="alert" className="px-4 py-2 text-sm text-ink-secondary">{stopError}</p>}
          {!messages && <div className="flex justify-center py-8"><HIcon icon={Loading02Icon} size={16} className="animate-spin text-ink-secondary" /></div>}
        </>
      ),
      empty: messages ? <p className="py-10 text-center text-[13px] text-ink-secondary">No messages yet. Say hello, or @mention a bot to ask it.</p> : <></>,
      composer: <ConversationComposer key={conversation.id} conversation={conversation} bots={bots} messages={shown} viewerKey={viewerKey}
        onSent={(message) => setMessages((current) => withFrame(current ?? [], { kind: "message", threadId: conversation.threadId, message }))} />,
    }} />
    {state.groupPanel && <GroupPanel conversation={conversation} bots={bots} messages={messages} tab={state.groupPanel}
      onLeft={() => { dispatch({ type: "toggleGroupPanel", open: false }); dispatch({ type: "selectConversation", id: null }); }} />}
  </>);
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingSend = useRef<{ text: string; id: string } | null>(null);
  const people = useMemo(() => conversation.people.filter((person) => !person.you), [conversation.people]);
  // @here asks every bot in the group and tells every person
  const mentionable = useMemo(() => [
    ...(conversation.kind === "group" ? [{ name: HERE_MENTION, kind: "here" as const }] : []),
    ...people.map((person) => ({ name: person.name, kind: "person" as const })),
    ...bots.map((bot) => ({ name: bot.name, kind: "bot" as const })),
  ], [conversation.kind, people, bots]);
  const mentions = useMentionPicker({ text, choices: mentionable, inputRef, onChange: setText });
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
  const face = (entry: { name: string; kind: "here" | "person" | "bot" }) => {
    if (entry.kind === "here") return <span className="flex size-6 items-center justify-center rounded-full bg-control text-ink"><HIcon icon={UserGroupIcon} size={14} /></span>;
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
          {mentions.open && (
            <div ref={mentions.listRef} id={mentions.listId} role="listbox" aria-label="Mention" className="absolute bottom-full start-2 z-20 mb-2 max-h-72 w-72 overflow-y-auto overscroll-contain rounded-xl border border-hairline/40 bg-raised shadow-lg">
              {mentions.candidates.map((entry, index) => (
                <ComposerMenuRow key={`${entry.kind}:${entry.name}`} id={mentions.optionId(index)} role="option" tabIndex={-1} aria-selected={index === mentions.highlight} selected={index === mentions.highlight}
                  onMouseDown={(event) => event.preventDefault()} onClick={() => mentions.pick(entry)} onMouseEnter={() => mentions.setHighlight(index)}
                  icon={face(entry)} name={entry.name} description={entry.kind === "here" ? "Everyone in this group" : undefined} kind={entry.kind === "here" ? "Everyone" : entry.kind === "bot" ? "Bot" : "Person"} />
              ))}
            </div>
          )}
          <div data-tour="composer" className={COMPOSER_PILL}>
            <div data-composer-row className={COMPOSER_ROW}>
              <MentionTextarea {...mentions.inputProps} wrapperClassName="ml-2" inputRef={inputRef} peers={mentionable.map((entry) => ({ name: entry.name }))} value={text} rows={1}
                placeholder={conversation.kind === "group" && bots.length ? `Message ${conversation.title} · type @ to ask a bot` : `Message ${conversation.title}`} aria-label="Message"
                onChange={(event) => { setText(event.target.value); mentions.changed(event.currentTarget); }}
                onKeyDown={(event) => {
                  if (mentions.isComposing(event) || mentions.keyDown(event)) return;
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
                }}
                className={COMPOSER_INPUT} />
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

/** A bot's screen, opened beside the conversation (owner, October 28, as
 * Grok Bot's computer preview): watch it browse, or take over. With several
 * bots, the one working now is listed first. */
function BotBrowserButton({ bots, onOpen }: { bots: Bot[]; onOpen: (botId: string) => void }) {
  const [open, setOpen] = useState(false);
  const ordered = [...bots].sort((a, b) => Number(Boolean(b.busy)) - Number(Boolean(a.busy)));
  const button = "rounded-lg border border-hairline bg-panel px-3 py-1.5 text-xs text-ink-secondary hover:bg-raised";
  if (ordered.length === 1) return <button type="button" className={button} onClick={() => onOpen(ordered[0]!.id)}>Browser</button>;
  return (
    <div className="relative">
      <button type="button" className={button} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}>Browser</button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-40 mt-1 w-48 overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60">
          {ordered.map((bot) => (
            <button key={bot.id} type="button" role="menuitem" onClick={() => { setOpen(false); onOpen(bot.id); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink hover:bg-raised/70">
              <BotAvatar bot={bot} state="happy" size={18} motion="none" motionKey={0} animated={false} />
              <span className="min-w-0 flex-1 truncate">{bot.name}</span>
              {bot.busy && <span className="text-[11px] text-ink-tertiary">working</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
