import { Loading02Icon, MonitorIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { BrowserPanel } from "./BrowserPanel";
import { ComputerViewer } from "./ComputerViewer";
import { useComputer } from "@/lib/computer";
import type { ComputerView } from "../../shared/computer.ts";
import type { Bot } from "@/state/store";

const primary = "rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50";
const secondary = "rounded-lg bg-raised px-3 py-1.5 text-[12.5px] text-ink hover:bg-control disabled:opacity-50";

/** A bot's place to work in the side panel: its screen on the workspace's computer when
 * that is on, and its built-in browser until then, with one clear way to turn the computer on.
 * Where the server cannot run a computer, it is simply the browser. */
export function ComputerPane({ bot }: { bot: Bot }) {
  const { view, error, working, turnOn, turnOff, refresh } = useComputer();
  if (!view || view.state === "unsupported") return <BrowserPanel bot={bot} />;
  if (view.state === "on") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ComputerViewer key={bot.id} bot={bot} />
        <div className="flex items-center justify-between gap-2 px-4 pb-3 text-[12px] text-ink-tertiary">
          <span>Turns itself off after {view.idleMinutes} idle minutes. {view.screens.length > 1 ? `${view.screens.length} bots have a screen.` : ""}</span>
          <button type="button" disabled={working} onClick={() => void turnOff()} className={secondary}>Turn off</button>
        </div>
        {error && <p role="alert" className="px-4 pb-2 text-[12px] text-danger">{error}</p>}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Offer bot={bot} view={view} working={working} error={error} turnOn={turnOn} refresh={refresh} />
      <div className="flex min-h-0 flex-1 flex-col"><BrowserPanel bot={bot} /></div>
    </div>
  );
}

function Offer({ bot, view, working, error, turnOn, refresh }: {
  bot: Bot; view: ComputerView; working: boolean; error: string; turnOn: () => Promise<void>; refresh: () => Promise<void>;
}) {
  const getting = view.state === "preparing" || view.state === "starting";
  return (
    <div className="mx-3 mt-1 flex flex-col gap-2 rounded-xl bg-card px-4 py-3" role="region" aria-label="Computer">
      {getting ? (
        <div className="flex items-center gap-2.5 text-[13px] text-ink">
          <HIcon icon={Loading02Icon} size={16} className="shrink-0 animate-spin" />
          <span>{view.state === "preparing" ? "Getting the computer ready. The first time takes a few minutes." : "Starting the computer…"}</span>
        </div>
      ) : view.state === "no-runtime" ? (
        <>
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink"><HIcon icon={MonitorIcon} size={16} /> Give {bot.name} a computer</div>
          <p className="text-[12.5px] leading-relaxed text-ink-secondary">{view.message}</p>
          <div><button type="button" onClick={() => void refresh()} className={secondary}>Check again</button></div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink"><HIcon icon={MonitorIcon} size={16} /> Give {bot.name} a computer</div>
          <p className="text-[12.5px] leading-relaxed text-ink-secondary">
            {bot.name} browses with the built-in browser now. A computer adds apps, downloads and sign-ins that stay, and you can watch every screen. It uses about 1 GB of memory while on and turns itself off after {view.idleMinutes} idle minutes.
          </p>
          <div><button type="button" disabled={working} onClick={() => void turnOn()} className={primary}>Turn on computer</button></div>
        </>
      )}
      {(error || (view.state === "off" && view.message)) && <p role="alert" className="text-[12px] text-danger">{error || view.message}</p>}
    </div>
  );
}
