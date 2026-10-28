// A bot asking the person to do one step in its browser: sign in, pass a
// CAPTCHA, enter a code (shared/sign-in-request.ts). Open shows the bot's
// browser beside the chat and keeps it in the person's control; Done or
// Cancel settles the card and sends the person's words that resume the bot.
import { useEffect, useState } from "react";
import { GlobeIcon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { cn } from "@/lib/cn";
import { api, useStore, type Message } from "@/state/store";
import { writeComputerPanelView } from "@/lib/computer-panel-view";
import { endBrowserHelp, startBrowserHelp } from "@/lib/browser-help";
import { signInResumeText } from "../../shared/sign-in-request";

export function SignInAsk({ message, threadId, onSettled, canAnswer = true }: {
  /** The card as the bot's own thread holds it (a group's copy passes its origin id). */
  message: Message;
  threadId: string;
  /** Sends the person's words to the bot, in the place the card is shown. */
  onSettled: (text: string) => void;
  canAnswer?: boolean;
}) {
  const { state, dispatch } = useStore();
  const ask = message.signInAsk!;
  const [outcome, setOutcome] = useState(ask.outcome);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setOutcome(ask.outcome), [ask.outcome]);
  const botName = state.bots.find((bot) => bot.id === ask.botId)?.name ?? message.from?.name ?? "The bot";
  const open = () => {
    startBrowserHelp(ask.botId);
    writeComputerPanelView(ask.botId, "browser");
    dispatch({ type: "toggleComputer", open: true, botId: ask.botId });
  };
  const settle = async (next: "done" | "cancelled") => {
    setBusy(true); setError("");
    try {
      await api(`/api/threads/${encodeURIComponent(threadId)}/sign-in`, { method: "POST", body: JSON.stringify({ messageId: message.id, outcome: next }) });
      setOutcome(next);
      endBrowserHelp(ask.botId);
      onSettled(signInResumeText(ask.site, next));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const button = "shrink-0 rounded-xl px-3.5 py-2 text-[13px] font-medium disabled:opacity-50";
  return (
    <div className="flex w-full justify-start" data-sign-in-ask={ask.site}>
      <div className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-sm">
        <div className="flex items-start gap-3 p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-control text-ink"><HIcon icon={GlobeIcon} size={19} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13.5px] font-semibold text-ink">{botName} needs you on {ask.site}</span>
              {outcome && <span className={cn("flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", outcome === "done" ? "bg-success/15 text-success" : "bg-control text-ink-secondary")}>
                {outcome === "done" && <HIcon icon={Tick01Icon} size={11} />}{outcome === "done" ? "Done" : "Cancelled"}
              </span>}
            </div>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">
              {ask.reason ? `${ask.reason} ` : ""}{outcome ? "" : `Open ${botName}’s browser, do just this step (a sign-in, a CAPTCHA, a code), then press Done.`}
            </p>
            {canAnswer && !outcome && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={open} className={cn(button, "bg-accent text-white hover:brightness-110")}>Open browser</button>
                <button type="button" disabled={busy} onClick={() => void settle("done")} className={cn(button, "bg-control text-ink hover:bg-raised")}>Done</button>
                <button type="button" disabled={busy} onClick={() => void settle("cancelled")} className={cn(button, "text-ink-secondary hover:bg-raised")}>Cancel</button>
              </div>
            )}
            {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
