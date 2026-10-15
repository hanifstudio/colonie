// Cloud data, Colonie's original chat UI. No alternate workspace chat design.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { ChatView, CHATHEAD_PILL } from "@/components/ChatView";
import { COMPOSER_INPUT, COMPOSER_PILL, COMPOSER_ROW } from "@/components/Composer";
import { HIcon } from "@/components/HIcon";
import { classicConversation } from "@/lib/colonie-classic-ui";
import { cn } from "@/lib/cn";
import { conversationTitle, dmPeer, type PlatformConversation, type PlatformMessage } from "@/lib/colonie-platform";
import { AvatarFor, Button, Notice, Spinner } from "./ui";

export function ConversationView({ conversation, selfPrincipalId, messages, working, loading, loadError, sendError,
  onSend, onStop: _onStop, onLoadEarlier, loadingEarlier, earlierError, headerAction,
}: {
  conversation: PlatformConversation; selfPrincipalId: string; messages: PlatformMessage[];
  working: boolean; loading: boolean; loadError: string | null; sendError: string | null;
  onSend: (body: string) => Promise<void>; onStop?: () => void; onLoadEarlier?: () => void;
  loadingEarlier?: boolean; earlierError?: string | null; headerAction?: ReactNode;
}) {
  const title = conversationTitle(conversation, selfPrincipalId);
  const peer = dmPeer(conversation, selfPrincipalId);
  const bot = classicConversation(conversation, selfPrincipalId, loadError ? [] : messages, working);
  return <ChatView bot={bot} accountConversation={{
    identity: <span className={cn(CHATHEAD_PILL, "pr-3.5")}>
      {peer ? <AvatarFor kind={peer.kind} id={peer.botId ?? peer.principalId} name={peer.displayName} size={24} /> : <HIcon icon={UserGroupIcon} size={18} />}
      <span className="min-w-0 truncate text-[14px] font-semibold">{title}</span>
    </span>,
    actions: headerAction,
    beforeMessages: <>
      {loading ? <div className="flex justify-center py-8"><Spinner /></div> : null}
      {loadError ? <Notice tone="error">{loadError}</Notice> : null}
      {!loading && (messages[0]?.sequence ?? 1) > 1 ? <div className="flex flex-col items-center gap-2 py-2">
        {earlierError ? <Notice tone="error">{earlierError}</Notice> : null}
        <Button variant="ghost" busy={loadingEarlier} onClick={onLoadEarlier}>Load earlier messages</Button>
      </div> : null}
    </>,
    empty: <p className="py-10 text-center text-[13px] text-ink-secondary">{loading || loadError ? "" : `Start the conversation with ${title}.`}</p>,
    composer: <AccountComposer key={conversation.id} title={title} error={sendError} onSend={onSend} />,
  }} />;
}

/** Same pill, typography, backdrop and placement as the existing Composer.
 * Only plain text is offered because Cloud does not yet support attachments. */
function AccountComposer({ title, error, onSend }: { title: string; error: string | null; onSend: (body: string) => Promise<void> }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = "auto";
    input.current.style.height = `${Math.min(input.current.scrollHeight, 144)}px`;
  }, [draft]);
  async function send() {
    const original = draft;
    const body = original.trim();
    if (!body || sending) return;
    setSending(true);
    try { await onSend(body); setDraft((current) => current === original ? "" : current); }
    catch { /* The error is displayed; keep the unsent draft. */ }
    finally { setSending(false); input.current?.focus(); }
  }
  return <div className="pointer-events-none relative px-5 pb-3">
    <div className="pointer-events-auto relative w-full">
      {error ? <div className="mb-2"><Notice tone="error">{error}</Notice></div> : null}
      <div className="relative">
        <div aria-hidden data-composer-backdrop className="pointer-events-none absolute -left-5 -right-5 -bottom-3 top-1/2 bg-app" />
        <div data-tour="composer" className={COMPOSER_PILL}>
          <div data-composer-row className={COMPOSER_ROW}>
            <textarea ref={input} aria-label="Message" placeholder={`Message ${title}`} rows={1} dir="auto"
              value={draft} onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
              className={cn(COMPOSER_INPUT, "ml-2 flex-1")} />
            <button type="button" aria-label="Send message" title="Send message" disabled={!draft.trim() || sending} onClick={() => void send()}
              className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-white hover:brightness-110 disabled:opacity-40">
              {sending ? <Spinner size={14} /> : <HIcon icon={ArrowUp01Icon} size={17} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>;
}
