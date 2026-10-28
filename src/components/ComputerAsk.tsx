// A bot offering to set up its own computer, when this Mac lacks the free app
// the computer needs (owner, October 29). Show me how opens the bot's
// Computer panel, which explains the app and sets the computer up once it is
// installed; Not now stops bots from offering it again.
import { useEffect, useState } from "react";
import { ComputerIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { cn } from "@/lib/cn";
import { api, useStore, type Message } from "@/state/store";
import { writeComputerPanelView } from "@/lib/computer-panel-view";
import { t } from "@/lib/i18n";

export function ComputerAsk({ message, threadId }: {
  /** The card as the bot's own thread holds it (a group's copy passes its origin id). */
  message: Message;
  threadId: string;
}) {
  const { state, dispatch } = useStore();
  const ask = message.computerAsk!;
  const [later, setLater] = useState(ask.outcome === "later");
  useEffect(() => setLater(ask.outcome === "later"), [ask.outcome]);
  const botName = state.bots.find((bot) => bot.id === ask.botId)?.name ?? message.from?.name ?? "The bot";
  const show = () => {
    writeComputerPanelView(ask.botId, "computer");
    dispatch({ type: "toggleComputer", open: true, botId: ask.botId });
  };
  const notNow = () => {
    setLater(true);
    void api(`/api/threads/${encodeURIComponent(threadId)}/computer-offer`, { method: "POST", body: JSON.stringify({ messageId: message.id }) }).catch(() => setLater(false));
  };
  const button = "shrink-0 rounded-xl px-3.5 py-2 text-[13px] font-medium";
  return (
    <div className="flex w-full justify-start" data-computer-ask={ask.botId}>
      <div className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-sm">
        <div className="flex items-start gap-3 p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-control text-ink"><HIcon icon={ComputerIcon} size={19} /></div>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-ink">{t("computer.ask.title", { name: botName })}</div>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">
              {ask.reason ? `${ask.reason} ` : ""}{later ? t("computer.ask.later") : t("computer.ask.body", { name: botName })}
            </p>
            {!later && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={show} className={cn(button, "bg-accent text-white hover:brightness-110")}>{t("computer.ask.show")}</button>
                <button type="button" onClick={notNow} className={cn(button, "text-ink-secondary hover:bg-raised")}>{t("computer.ask.notNow")}</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
