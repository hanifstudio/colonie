import type { ReactNode } from "react";
import { GlobeIcon, Loading02Icon, MonitorIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { ComputerViewer } from "./ComputerViewer";
import { Button } from "./ui/Button";
import { EmptyCard } from "./ui/EmptyCard";
import { useComputer } from "@/lib/computer";
import type { ComputerView } from "../../shared/computer.ts";
import type { Bot } from "@/state/store";

/** The Screen tab: the bot's own screen on the workspace's computer. It only ever shows that screen,
 * or says plainly why there is none yet and how to get one. The built-in browser lives in its own
 * Browser tab, so this tab never changes what it means. */
export function ScreenPane({ bot, onOpenBrowser }: { bot: Bot; onOpenBrowser: () => void }) {
  const { view, error, working, turnOn, turnOff, refresh, takeOver, handBack } = useComputer();
  if (!view) return <ScreenCard bot={bot} icon={<HIcon icon={Loading02Icon} size={22} className="animate-spin" />} title="Checking the computer…" />;
  if (view.state === "on") {
    const taken = view.screens.find((screen) => screen.botId === bot.id)?.taken === true;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ComputerViewer key={bot.id} bot={bot} taken={taken} error={error} onTakeOver={() => takeOver(bot.id)} onHandBack={() => handBack(bot.id)} />
        <div className="flex items-center justify-between gap-2 px-4 pb-3 text-[12px] text-ink-tertiary">
          <span>Turns itself off after {view.idleMinutes} idle minutes.{view.screens.length > 1 ? ` ${view.screens.length} bots have a screen.` : ""}</span>
          <Button size="sm" disabled={working} onClick={() => void turnOff()}>Turn off</Button>
        </div>
      </div>
    );
  }
  if (view.state === "unsupported") {
    return (
      <ScreenCard bot={bot} icon={<HIcon icon={MonitorIcon} size={22} />} title="A screen isn't available here yet"
        body={`A computer for ${bot.name} can't run on this server yet. ${bot.name} browses in the Browser tab instead.`}>
        <Button onClick={onOpenBrowser}><HIcon icon={GlobeIcon} size={13} className="mr-1.5 inline" />Open Browser</Button>
      </ScreenCard>
    );
  }
  if (view.state === "preparing" || view.state === "starting") {
    return <ScreenCard bot={bot} icon={<HIcon icon={Loading02Icon} size={22} className="animate-spin" />}
      title={view.state === "preparing" ? "Getting the computer ready" : "Starting the computer"}
      body={view.state === "preparing" ? "The first time takes a few minutes. You can keep using Colonie meanwhile." : `This takes a few seconds. Then you'll see ${bot.name}'s screen here.`} />;
  }
  if (view.state === "no-runtime") {
    return (
      <ScreenCard bot={bot} icon={<HIcon icon={MonitorIcon} size={22} />} title={`Give ${bot.name} a computer`} body={view.message ?? undefined}>
        <Button onClick={() => void refresh()}>Check again</Button>
        <Button variant="quiet" onClick={onOpenBrowser}>Until then, {bot.name} browses in the Browser tab</Button>
      </ScreenCard>
    );
  }
  return <Offer bot={bot} view={view} working={working} error={error} turnOn={turnOn} onOpenBrowser={onOpenBrowser} />;
}

function Offer({ bot, view, working, error, turnOn, onOpenBrowser }: {
  bot: Bot; view: ComputerView; working: boolean; error: string; turnOn: () => Promise<void>; onOpenBrowser: () => void;
}) {
  return (
    <ScreenCard bot={bot} icon={<HIcon icon={MonitorIcon} size={22} />} title={`Give ${bot.name} a computer`}
      body={`A computer is a private desktop for ${bot.name}: apps, downloads, and sign-ins that stay. You can watch its screen live and take over any time.`}
      note={`Uses about 1 GB of memory while on. Turns itself off after ${view.idleMinutes} idle minutes.`}
      problem={error || view.message || undefined}>
      <Button variant="primary" disabled={working} onClick={() => void turnOn()}>Turn on computer</Button>
      <Button variant="quiet" onClick={onOpenBrowser}>Until then, {bot.name} browses in the Browser tab</Button>
    </ScreenCard>
  );
}

/** The Screen tab's empty states, as the shared card with this bot's name on the region. */
function ScreenCard({ bot, ...rest }: { bot: Bot; icon: ReactNode; title: string; body?: string; note?: string; problem?: string; children?: ReactNode }) {
  return <EmptyCard label={`${bot.name}'s screen`} {...rest} />;
}
