import type { ReactNode } from "react";
import { GlobeIcon, Loading02Icon, MonitorIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { ComputerViewer } from "./ComputerViewer";
import { useComputer } from "@/lib/computer";
import type { ComputerView } from "../../shared/computer.ts";
import type { Bot } from "@/state/store";

const primary = "rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50";
const secondary = "rounded-lg bg-raised px-3 py-1.5 text-[12.5px] text-ink hover:bg-control disabled:opacity-50";
const quiet = "text-[12.5px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline";

/** The Screen tab: the bot's own screen on the workspace's computer. It only ever shows that screen,
 * or says plainly why there is none yet and how to get one. The built-in browser lives in its own
 * Browser tab, so this tab never changes what it means. */
export function ScreenPane({ bot, onOpenBrowser }: { bot: Bot; onOpenBrowser: () => void }) {
  const { view, error, working, turnOn, turnOff, refresh, takeOver, handBack } = useComputer();
  if (!view) return <Card bot={bot} icon={<HIcon icon={Loading02Icon} size={22} className="animate-spin" />} title="Checking the computer…" />;
  if (view.state === "on") {
    const taken = view.screens.find((screen) => screen.botId === bot.id)?.taken === true;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ComputerViewer key={bot.id} bot={bot} taken={taken} error={error} onTakeOver={() => takeOver(bot.id)} onHandBack={() => handBack(bot.id)} />
        <div className="flex items-center justify-between gap-2 px-4 pb-3 text-[12px] text-ink-tertiary">
          <span>Turns itself off after {view.idleMinutes} idle minutes.{view.screens.length > 1 ? ` ${view.screens.length} bots have a screen.` : ""}</span>
          <button type="button" disabled={working} onClick={() => void turnOff()} className={secondary}>Turn off</button>
        </div>
      </div>
    );
  }
  if (view.state === "unsupported") {
    return (
      <Card bot={bot} icon={<HIcon icon={MonitorIcon} size={22} />} title="A screen isn't available here yet"
        body={`A computer for ${bot.name} can't run on this server yet. ${bot.name} browses in the Browser tab instead.`}>
        <button type="button" onClick={onOpenBrowser} className={secondary}><HIcon icon={GlobeIcon} size={13} className="mr-1.5 inline" />Open Browser</button>
      </Card>
    );
  }
  if (view.state === "preparing" || view.state === "starting") {
    return <Card bot={bot} icon={<HIcon icon={Loading02Icon} size={22} className="animate-spin" />}
      title={view.state === "preparing" ? "Getting the computer ready" : "Starting the computer"}
      body={view.state === "preparing" ? "The first time takes a few minutes. You can keep using Colonie meanwhile." : `This takes a few seconds. Then you'll see ${bot.name}'s screen here.`} />;
  }
  if (view.state === "no-runtime") {
    return (
      <Card bot={bot} icon={<HIcon icon={MonitorIcon} size={22} />} title={`Give ${bot.name} a computer`} body={view.message ?? undefined}>
        <button type="button" onClick={() => void refresh()} className={secondary}>Check again</button>
        <button type="button" onClick={onOpenBrowser} className={quiet}>Until then, {bot.name} browses in the Browser tab</button>
      </Card>
    );
  }
  return <Offer bot={bot} view={view} working={working} error={error} turnOn={turnOn} onOpenBrowser={onOpenBrowser} />;
}

function Offer({ bot, view, working, error, turnOn, onOpenBrowser }: {
  bot: Bot; view: ComputerView; working: boolean; error: string; turnOn: () => Promise<void>; onOpenBrowser: () => void;
}) {
  return (
    <Card bot={bot} icon={<HIcon icon={MonitorIcon} size={22} />} title={`Give ${bot.name} a computer`}
      body={`A computer is a private desktop for ${bot.name}: apps, downloads, and sign-ins that stay. You can watch its screen live and take over any time.`}
      note={`Uses about 1 GB of memory while on. Turns itself off after ${view.idleMinutes} idle minutes.`}
      problem={error || view.message || undefined}>
      <button type="button" disabled={working} onClick={() => void turnOn()} className={primary}>Turn on computer</button>
      <button type="button" onClick={onOpenBrowser} className={quiet}>Until then, {bot.name} browses in the Browser tab</button>
    </Card>
  );
}

function Card({ bot, icon, title, body, note, problem, children }: {
  bot: Bot; icon: ReactNode; title: string; body?: string; note?: string; problem?: string; children?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-10 text-center" role="region" aria-label={`${bot.name}'s screen`}>
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-card text-ink-secondary">{icon}</div>
      <h3 className="text-[15px] font-medium text-ink">{title}</h3>
      {body && <p className="mt-1.5 max-w-[34ch] text-[13px] leading-relaxed text-ink-secondary">{body}</p>}
      {note && <p className="mt-2 max-w-[34ch] text-[12px] leading-relaxed text-ink-tertiary">{note}</p>}
      {problem && <p role="alert" className="mt-3 max-w-[38ch] text-[12.5px] leading-relaxed text-danger">{problem}</p>}
      {children && <div className="mt-5 flex flex-col items-center gap-3">{children}</div>}
    </div>
  );
}
