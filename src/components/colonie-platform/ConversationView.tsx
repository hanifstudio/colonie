// One conversation: readable, attributed bubbles; a composer that never
// throws away a typed message on failure; a working indicator and Stop that
// appear only when the backend supplies them. Human and bot senders are named.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpIcon, HashtagIcon, StopIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "@/components/HIcon";
import { AvatarFor, Button, IconButton, Notice, Spinner, TextArea } from "./ui";
import { cn } from "@/lib/cn";
import { conversationTitle, dmPeer, type PlatformConversation, type PlatformMessage } from "@/lib/colonie-platform";

export function ConversationView({
  conversation,
  selfPrincipalId,
  messages,
  working,
  loading,
  loadError,
  sendError,
  onSend,
  onStop,
  onLoadEarlier,
  loadingEarlier,
  earlierError,
  headerAction,
}: {
  conversation: PlatformConversation;
  selfPrincipalId: string;
  messages: PlatformMessage[];
  working: boolean;
  loading: boolean;
  loadError: string | null;
  sendError: string | null;
  onSend: (body: string) => Promise<void>;
  onStop?: () => void;
  /** Loads the page of messages before the ones on screen. */
  onLoadEarlier?: () => void;
  loadingEarlier?: boolean;
  earlierError?: string | null;
  headerAction?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const title = conversationTitle(conversation, selfPrincipalId);
  const peer = dmPeer(conversation, selfPrincipalId);
  const isGroup = conversation.kind === "group";
  /** The oldest sequence on screen; above 1 there is an earlier page to fetch. */
  const earlierSequence = messages[0]?.sequence ?? 1;

  // Keep the newest message in view as it arrives without fighting a reader
  // who scrolled up: only auto-scroll when already near the bottom.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 160;
    if (nearBottom) node.scrollTop = node.scrollHeight;
  }, [messages.length, working]);

  useEffect(() => setDraft(""), [conversation.id]);

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onSend(body);
      setDraft("");
    } catch {
      // Caller surfaces the message; the draft is deliberately kept.
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-app text-ink">
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2.5 sm:px-5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-secondary">
          <HIcon icon={isGroup ? HashtagIcon : UserGroupIcon} size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold">{title}</div>
          <div className="truncate text-[11.5px] text-ink-tertiary">
            {isGroup
              ? groupSubtitle(conversation)
              : peer?.kind === "bot"
                ? "Bot · private to you"
                : "Direct message · private to you both"}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">{headerAction}</div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
        {loading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : loadError ? (
          <Notice tone="error">{loadError}</Notice>
        ) : messages.length === 0 ? (
          <p className="py-10 text-center text-[13px] text-ink-tertiary">
            {isGroup ? "No messages yet. Say hello to the group." : `Start the conversation with ${title}.`}
          </p>
        ) : (
          <>
            {earlierSequence > 1 ? (
              <div className="mx-auto flex max-w-3xl flex-col items-center gap-2 py-3">
                {earlierError ? <p className="text-center text-[12.5px] text-ink-tertiary">{earlierError}</p> : null}
                <Button variant="ghost" className="px-2 py-1 text-[12px]" busy={Boolean(loadingEarlier)} onClick={() => onLoadEarlier?.()}>
                  Load earlier messages
                </Button>
              </div>
            ) : null}
            <ol className="mx-auto flex max-w-3xl flex-col gap-3">
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} own={message.senderPrincipalId === selfPrincipalId} />
              ))}
            </ol>
          </>
        )}

        {working ? (
          <div className="mx-auto mt-3 flex max-w-3xl items-center gap-2 text-[12.5px] text-ink-secondary">
            <Spinner size={13} />
            <span>{title} is working…</span>
            {onStop ? <IconButton label="Stop" icon={StopIcon} onClick={onStop} className="ml-1" /> : null}
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-hairline px-3 py-3 sm:px-5">
        <div className="mx-auto max-w-3xl">
          {sendError && <div className="mb-2"><Notice tone="error">{sendError}</Notice></div>}
          <div className="flex items-end gap-2">
            <TextArea
              aria-label="Message"
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={isGroup ? "Message the group" : `Message ${title}`}
              className="max-h-40 min-h-10 py-2.5"
            />
            <Button
              variant="primary"
              aria-label="Send message"
              busy={sending}
              disabled={!draft.trim()}
              onClick={() => void send()}
              className="h-10 shrink-0 px-3"
            >
              {!sending && <HIcon icon={ArrowUpIcon} size={16} aria-hidden="true" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message, own }: { message: PlatformMessage; own: boolean }) {
  return (
    <li className={cn("flex items-end gap-2", own ? "flex-row-reverse" : "flex-row")}>
      <AvatarFor kind={message.senderKind} id={message.senderPrincipalId} name={message.senderName} size={28} />
      <div className={cn("flex min-w-0 max-w-[80%] flex-col", own ? "items-end" : "items-start")}>
        <span className="mb-0.5 px-1 text-[11px] text-ink-tertiary">
          {message.senderName}
          {message.senderKind === "bot" ? " · Bot" : ""}
        </span>
        <div
          className={cn(
            "whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed",
            own ? "bg-bubble-user text-ink" : "bg-card text-ink",
          )}
        >
          {message.body}
        </div>
        <time className="mt-0.5 px-1 text-[10.5px] text-ink-tertiary" dateTime={message.createdAt}>
          {formatTime(message.createdAt)}
        </time>
      </div>
    </li>
  );
}

function groupSubtitle(conversation: PlatformConversation): string {
  const humans = conversation.participants.filter((p) => p.kind === "human").length;
  const bots = conversation.participants.filter((p) => p.kind === "bot").length;
  const parts: string[] = [];
  parts.push(`${humans} ${humans === 1 ? "person" : "people"}`);
  if (bots) parts.push(`${bots} ${bots === 1 ? "bot" : "bots"}`);
  return parts.join(" · ");
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
