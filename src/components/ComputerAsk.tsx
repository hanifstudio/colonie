import type { Message } from "@/state/store";

/** Historical setup offers must never launch a removed desktop feature. */
export function ComputerAsk({ message: _message, threadId: _threadId }: { message: Message; threadId: string }) {
  return <div className="rounded-xl bg-card p-4 text-[13px] text-ink-secondary">Desktop computer access is no longer available. This bot can use its browser.</div>;
}
