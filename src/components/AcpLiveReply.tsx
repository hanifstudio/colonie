import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { listenLiveFrames } from "@/lib/live-events";
import { ChatMarkdown } from "./ChatMarkdown";
import { isColonieAcpDriver } from "../../shared/acp";
import type { RuntimeEvent } from "../../shared/runtime-events";

export interface LiveReply { turnId: string; itemId: string; text: string }

export function foldAcpReply(current: LiveReply | null, event: RuntimeEvent): LiveReply | null {
  if (!isColonieAcpDriver(event.provider)) return current;
  if (event.type === "content.delta" && event.streamKind === "assistant_text" && event.turnId && event.itemId) {
    const previous = current?.turnId === event.turnId && current.itemId === event.itemId ? current.text : "";
    const offset = event.offset ?? previous.length;
    if (offset !== previous.length) return current;
    return { turnId: event.turnId, itemId: event.itemId, text: previous + event.delta };
  }
  if ((event.type === "item.completed" && event.itemType === "assistant_text" && event.itemId === current?.itemId)
    || ((event.type === "turn.completed" || event.type === "session.exited") && (!event.turnId || event.turnId === current?.turnId))) return null;
  return current;
}

export function AcpLiveReply({ botId, threadId, onProgress }: { botId: string; threadId: string; onProgress: () => void }) {
  const [reply, setReply] = useState<LiveReply | null>(null);
  useEffect(() => {
    let disposed = false;
    let hydrating = true;
    let buffered: RuntimeEvent[] = [];
    let generation = 0;
    let controller: AbortController | undefined;
    const hydrate = async () => {
      const own = ++generation;
      controller?.abort();
      controller = new AbortController();
      hydrating = true;
      buffered = [];
      try {
        const result = await api(`/api/bots/${botId}/acp-live?threadId=${encodeURIComponent(threadId)}`, { signal: controller.signal }) as { reply: LiveReply | null };
        if (!disposed && own === generation) setReply(buffered.reduce(foldAcpReply, result.reply));
      } catch {
        if (!disposed && own === generation) setReply(null);
      } finally { if (own === generation) { hydrating = false; buffered = []; } }
    };
    const unsubscribe = listenLiveFrames({
      onFrame: (frame) => {
        if (frame.kind !== "runtime" || frame.event.threadId !== threadId || !isColonieAcpDriver(frame.event.provider)) return;
        if (hydrating) buffered.push(frame.event);
        else setReply((current) => foldAcpReply(current, frame.event));
      },
      onMissedFrames: () => { void hydrate(); },
    });
    void hydrate();
    return () => { disposed = true; controller?.abort(); unsubscribe(); };
  }, [botId, threadId]);
  useEffect(() => { if (reply?.text) onProgress(); }, [reply?.text, onProgress]);
  if (!reply?.text) return null;
  return (
    <div data-testid="acp-live-reply" className="flex justify-start" aria-label="Streaming agent reply">
      <div className="max-w-[85%] rounded-2xl bg-card px-4 py-3 text-ink">
        <ChatMarkdown text={reply.text} />
        <span className="mt-1 block text-[11px] text-ink-secondary">Streaming…</span>
      </div>
    </div>
  );
}
