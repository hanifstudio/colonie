// The small button on a bot's "working" line in a group, for the person who asked: Cancel while the
// request is still waiting its turn, Stop once the bot is at work on it. Same icon-button look as the
// 1:1 queue tray (ComposerQueuedMessages): a 28 px target, grey until hovered, a visible focus ring.
// While the request is being sent the button spins and cannot be pressed twice; if it fails the reason
// shows under the button and the button comes back. On success the line itself changes to
// "Stopped by the person who asked." (with Continue), which unmounts this.
import { useState } from "react";
import { Loading02Icon, MultiplicationSignIcon, SquareIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import type { Message } from "@/state/store";

export function WorkingLineCancel({ message, viewerKey, onCancel }: { message: Message; viewerKey?: string; onCancel?: (messageId: string) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // only the person who asked for this request may cancel it
  if (!onCancel || !message.askedBy || message.askedBy !== viewerKey) return null;
  const queued = !message.workingSince;
  const name = message.from?.name ?? "the bot";
  const label = queued ? `Cancel ${name}'s queued request` : `Stop ${name}'s work on this request`;
  const hint = queued ? "Cancel: this request will not run" : "Stop: interrupt the work on this request now";
  const press = () => {
    if (pending) return;
    setPending(true); setError("");
    void onCancel!(message.id).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    });
  };
  return (
    <div className="-me-2 ms-1 flex shrink-0 flex-col items-end gap-1 self-start">
      <button type="button" onClick={press} disabled={pending} aria-label={label} title={hint} aria-busy={pending || undefined}
        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-tertiary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60">
        <HIcon icon={pending ? Loading02Icon : queued ? MultiplicationSignIcon : SquareIcon} size={queued ? 14 : 12}
          className={pending ? "animate-spin" : undefined} aria-hidden="true" />
      </button>
      {error && <span role="alert" className="max-w-44 text-right text-[11px] leading-4 text-danger">{error}</span>}
    </div>
  );
}
