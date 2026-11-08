// What a group composer shows when a message did not go out: the reason, a promise that nothing was lost
// (the words stay in the box, so the person can edit them), and one button to send the same message again.
// Sending again is safe: the message keeps its id, so the server makes it once even if the first try arrived.
export function SendFailure({ reason, busy, onRetry }: { reason: string; busy?: boolean; onRetry: () => void }) {
  return (
    <div role="alert" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-danger">
      <span className="min-w-0">Not sent. {/[.!?]$/.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`} Your message is still in the box; edit it or try again.</span>
      <button type="button" onClick={onRetry} disabled={busy}
        className="rounded-lg bg-danger/10 px-2.5 py-1 font-medium outline-none hover:bg-danger/20 focus-visible:ring-2 focus-visible:ring-danger/50 disabled:opacity-60">
        Try again
      </button>
    </div>
  );
}
