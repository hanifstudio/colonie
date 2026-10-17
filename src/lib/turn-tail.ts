import type { Message } from "@/state/store";

/** Whether the transcript tail should show the "working" dots.
 *
 * A turn ends across three server frames: the settled reply (`message`),
 * `turn.completed`, then the bot patch that flips `busy` off. Deriving the
 * dots from `busy && !streaming` alone re-shows them in that window — the
 * reply lands, the dots pop back under it for a beat, then vanish — and the
 * pinned scroll re-anchors around each height change. That grow-shrink-jump
 * is the end-of-stream jitter. A settled reply at the tail means there is
 * nothing to wait for, so the dots stay hidden until something actually new
 * starts: a tool chip or the user's next prompt.
 */
export function showWorkingDots(
  busy: boolean | undefined,
  lastMessage: Message | undefined,
): boolean {
  if (!busy) return false;
  if (!lastMessage) return true;
  return !(lastMessage.role === "bot" && lastMessage.kind === "text");
}
