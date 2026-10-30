import { useState } from "react";
import { Folder01Icon, GlobeIcon, MultiplicationSignIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { BrowserPanel } from "./BrowserPanel";
import { BotFilesPane } from "./BotFilesPane";
import { ConversationRoutines } from "./routines/ConversationRoutines";
import { useCaptionChrome } from "./DesktopCapabilities";
import { usePreviewPanel } from "./file-preview/use-preview-panel";
import { useConversations } from "@/lib/conversations";
import { readBotPanelView, writeBotPanelView } from "@/lib/bot-panel-view";
import { cn } from "@/lib/cn";
import { currentTaskBot, useStore, type Bot } from "@/state/store";

/** A bot's browser, files, and the current conversation's routines. */
export function BrowserSidePanel({ bot: profileBot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const bot = currentTaskBot(profileBot);
  const { conversations } = useConversations();
  const conversation = conversations?.find((entry) => entry.id === state.selectedConversationId);
  const { padClass } = useCaptionChrome();
  const { panel, width, minimum, maximum, resize } = usePreviewPanel();
  const [view, setView] = useState(() => readBotPanelView(bot.id));
  const select = (next: "browser" | "files") => { setView(next); writeBotPanelView(bot.id, next); };
  const tab = (active: boolean) => cn("flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px]", active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink");
  return <aside ref={panel} aria-label={`${bot.name}'s browser`}
    className="animate-panel-in relative flex h-full max-w-full shrink-0 flex-col border-l border-hairline/40 bg-panel max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!" style={{ width }}>
    <div role="separator" aria-label="Resize browser panel" aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={width} tabIndex={0} {...resize}
      className="absolute inset-y-0 left-0 z-10 w-1.5 touch-none cursor-col-resize hover:bg-accent/30 focus-visible:bg-accent/50 max-md:hidden" />
    <div className={cn("px-4 py-3", padClass)}>
      <div className="relative flex min-h-7 items-center justify-center">
        <button type="button" aria-label="Browser settings" onClick={() => { dispatch({ type: "toggleBrowser", open: false }); dispatch({ type: "toggleSettings", open: true, section: "access" }); }}
          className="absolute left-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"><HIcon icon={Settings01Icon} size={18} /></button>
        <div className="mx-9 flex gap-0.5 rounded-full bg-inset p-0.5" aria-label="Bot panel view" data-tour="computer-tabs">
          <button type="button" data-tour="computer-browser" aria-pressed={view === "browser"} className={tab(view === "browser")} onClick={() => select("browser")}><HIcon icon={GlobeIcon} size={13} /> Browser</button>
          <button type="button" aria-pressed={view === "files"} className={tab(view === "files")} onClick={() => select("files")}><HIcon icon={Folder01Icon} size={13} /> Files</button>
        </div>
        <button type="button" aria-label="Close browser panel" onClick={() => dispatch({ type: "toggleBrowser", open: false })}
          className="absolute right-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"><HIcon icon={MultiplicationSignIcon} size={18} /></button>
      </div>
    </div>
    <div className="flex min-h-0 flex-1 flex-col">{view === "files" ? <BotFilesPane bot={bot} /> : <BrowserPanel bot={bot} />}</div>
    {(!state.selectedConversationId || conversation) && <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-hairline/40 px-5 py-3">
      <ConversationRoutines key={conversation?.threadId ?? bot.threadId} threadId={conversation?.threadId ?? bot.threadId} conversationId={conversation?.id} botId={conversation?.leadBotId ?? bot.id} />
    </div>}
  </aside>;
}
