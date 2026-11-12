import { useState, type ReactNode } from "react";
import { Folder01Icon, GlobeIcon, MonitorIcon, MultiplicationSignIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { ScreenPane } from "./ScreenPane";
import { BrowserPanel } from "./BrowserPanel";
import { BotFilesPane } from "./BotFilesPane";
import { ConversationRoutines } from "./routines/ConversationRoutines";
import { useCaptionChrome } from "./DesktopCapabilities";
import { usePreviewPanel } from "./file-preview/use-preview-panel";
import { useConversations } from "@/lib/conversations";
import { firstBotPanelView, readBotPanelView, writeBotPanelView, type BotPanelView } from "@/lib/bot-panel-view";
import { useWorkingTab } from "@/lib/bot-surface";
import { screenAvailable, useComputer } from "@/lib/computer";
import { cn } from "@/lib/cn";
import { currentTaskBot, useStore, type Bot } from "@/state/store";

/** A bot's panel beside the conversation: its Screen (its own computer), its Browser (the built-in
 * browser), and Files, plus the current conversation's routines. A green dot marks where it is working. */
export function BrowserSidePanel({ bot: profileBot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const bot = currentTaskBot(profileBot);
  const { conversations } = useConversations();
  const conversation = conversations?.find((entry) => entry.id === state.selectedConversationId);
  const { padClass } = useCaptionChrome();
  const { panel, width, minimum, maximum, resize } = usePreviewPanel();
  const { view: computer } = useComputer();
  const [chosen, setChosen] = useState(() => readBotPanelView(bot.id));
  const view = chosen ?? firstBotPanelView(screenAvailable(computer));
  const working = useWorkingTab(bot.id, Boolean(bot.busy));
  const select = (next: BotPanelView) => { setChosen(next); writeBotPanelView(bot.id, next); };
  const tab = (active: boolean) => cn("flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px]", active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink");
  const tabs: Array<{ id: BotPanelView; label: string; icon: typeof MonitorIcon; tour?: string }> = [
    { id: "screen", label: "Screen", icon: MonitorIcon, tour: "computer-browser" },
    { id: "browser", label: "Browser", icon: GlobeIcon },
    { id: "files", label: "Files", icon: Folder01Icon },
  ];
  let body: ReactNode;
  if (view === "files") body = <BotFilesPane bot={bot} />;
  else if (view === "browser") body = <BrowserTab bot={bot} computerOn={computer?.state === "on"} onOpenScreen={() => select("screen")} />;
  else body = <ScreenPane bot={bot} onOpenBrowser={() => select("browser")} />;
  return <aside ref={panel} aria-label={`${bot.name}'s ${view}`}
    className="animate-panel-in relative flex h-full max-w-full shrink-0 flex-col border-l border-hairline/40 bg-panel max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!" style={{ width }}>
    <div role="separator" aria-label="Resize panel" aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={width} tabIndex={0} {...resize}
      className="absolute inset-y-0 left-0 z-10 w-1.5 touch-none cursor-col-resize hover:bg-accent/30 focus-visible:bg-accent/50 max-md:hidden" />
    <div className={cn("px-4 py-3", padClass)}>
      <div className="relative flex min-h-7 items-center justify-center">
        <button type="button" aria-label="Bot settings" onClick={() => { dispatch({ type: "toggleBrowser", open: false }); dispatch({ type: "toggleSettings", open: true, section: "access" }); }}
          className="absolute left-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"><HIcon icon={Settings01Icon} size={18} /></button>
        <div className="mx-9 flex gap-0.5 rounded-full bg-inset p-0.5" aria-label="Bot panel view" data-tour="computer-tabs">
          {tabs.map(({ id, label, icon, tour }) => (
            <button key={id} type="button" data-tour={tour} aria-pressed={view === id} className={tab(view === id)} onClick={() => select(id)}>
              <HIcon icon={icon} size={13} /> {label}
              {working === id && <span role="img" aria-label={`${bot.name} is using this now`} data-testid={`working-${id}`} className="size-1.5 animate-pulse rounded-full bg-success" />}
            </button>
          ))}
        </div>
        <button type="button" aria-label="Close bot panel" onClick={() => dispatch({ type: "toggleBrowser", open: false })}
          className="absolute right-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"><HIcon icon={MultiplicationSignIcon} size={18} /></button>
      </div>
    </div>
    <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    {(!state.selectedConversationId || conversation) && <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-hairline/40 px-5 py-3">
      <ConversationRoutines key={conversation?.threadId ?? bot.threadId} threadId={conversation?.threadId ?? bot.threadId} conversationId={conversation?.id} botId={conversation?.leadBotId ?? bot.id} />
    </div>}
  </aside>;
}

/** The built-in browser. While the computer is on, the bot browses on its screen instead, and this says so. */
function BrowserTab({ bot, computerOn, onOpenScreen }: { bot: Bot; computerOn: boolean; onOpenScreen: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {computerOn && (
        <div className="mx-3 mt-1 flex items-center justify-between gap-3 rounded-xl bg-card px-3.5 py-2.5 text-[12.5px] leading-snug text-ink-secondary" role="note">
          <span>The computer is on, so {bot.name} browses on its Screen instead of here.</span>
          <button type="button" onClick={onOpenScreen} className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[12.5px] text-ink hover:bg-control">Open Screen</button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col"><BrowserPanel bot={bot} /></div>
    </div>
  );
}
