import { useEffect, useRef, useState } from "react";
import { HandIcon, Loading02Icon, MonitorIcon } from "@hugeicons/core-free-icons";
import RFB from "@novnc/novnc";
import { HIcon } from "./HIcon";
import { api, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";

type Connection = "opening" | "connecting" | "connected" | "lost" | "refused";

/** A bot's own screen on the workspace's computer, live. It is a window onto the screen until the
 * person takes over: then the bot is paused (the server refuses its tool calls) and they can click and
 * type. `taken` is the server's word, so a hand-back from anywhere ends it here too. Only desktop
 * pixels and input cross the container boundary; the page is this app's own. */
export function ComputerViewer({ bot, taken, onTakeOver, onHandBack, error }: {
  bot: Bot; taken: boolean; onTakeOver: () => Promise<void>; onHandBack: () => Promise<void>; error?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const client = useRef<RFB | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<Connection>("opening");
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    let rfb: RFB | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    setConnection("opening"); setReason("");
    void (async () => {
      try { await api(`/api/computer/screens/${encodeURIComponent(bot.id)}`, { method: "POST", signal: abort.signal }); }
      catch (cause) {
        if (abort.signal.aborted) return;
        setReason(cause instanceof Error ? cause.message : "The screen could not be opened.");
        setConnection("refused");
        return;
      }
      if (abort.signal.aborted || !host.current) return;
      setConnection("connecting");
      const url = new URL(`/api/computer/screens/${encodeURIComponent(bot.id)}/websockify`, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      rfb = new RFB(host.current, url.href, { credentials: { password: "", username: "", target: "" } });
      client.current = rfb;
      rfb.scaleViewport = true;
      rfb.viewOnly = true;
      rfb.background = "var(--color-inset)";
      deadline = setTimeout(() => { rfb?.disconnect(); setConnection("lost"); }, 20_000);
      rfb.addEventListener("connect", () => { if (!abort.signal.aborted) { clearTimeout(deadline); setConnection("connected"); } });
      rfb.addEventListener("disconnect", () => { if (!abort.signal.aborted) { clearTimeout(deadline); setConnection("lost"); } });
    })();
    return () => {
      abort.abort();
      clearTimeout(deadline);
      rfb?.disconnect();
      if (client.current === rfb) client.current = null;
    };
  }, [bot.id, attempt]);

  // typing is allowed exactly while the server says the person is driving and the picture is live
  const driving = taken && connection === "connected";
  useEffect(() => { if (client.current) client.current.viewOnly = !driving; }, [driving, connection]);

  const message = connection === "refused" ? reason
    : connection === "lost" ? "The screen disconnected."
    : connection === "opening" ? `Opening ${bot.name}'s screen…`
    : connection === "connecting" ? "Connecting…" : "";
  const toggle = async () => {
    setAsking(true);
    try { await (taken ? onHandBack() : onTakeOver()); } finally { setAsking(false); }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
      <div className="flex items-center justify-between gap-3 text-[12px] text-ink-secondary">
        <span className="flex min-w-0 items-center gap-1.5" aria-live="polite">
          <HIcon icon={MonitorIcon} size={14} className="shrink-0" />
          <span className="truncate">{taken ? `You're in control. ${bot.name} is paused.` : `Watching ${bot.name}'s screen`}</span>
        </span>
        <button type="button" disabled={asking || (!taken && connection !== "connected")} aria-pressed={taken} onClick={() => void toggle()}
          title={taken ? `Give the screen back to ${bot.name}` : `Pause ${bot.name} and use the screen yourself`}
          className={cn("flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] disabled:opacity-40",
            taken ? "bg-accent text-accent-ink" : "bg-raised text-ink hover:bg-control")}>
          <HIcon icon={HandIcon} size={13} /> {taken ? "Hand back" : "Take over"}
        </button>
      </div>
      <div className={cn("relative min-h-64 flex-1 overflow-hidden rounded-xl bg-inset", driving && "ring-2 ring-accent/70")}>
        <div ref={host} className="absolute inset-0" data-testid="computer-screen" />
        {message && <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-inset/90 p-6 text-center text-[13px] text-ink-secondary">
          {connection === "refused" || connection === "lost" ? <HIcon icon={MonitorIcon} size={24} /> : <HIcon icon={Loading02Icon} size={24} className="animate-spin" />}
          <span>{message}</span>
          {(connection === "refused" || connection === "lost") && <button type="button" onClick={() => setAttempt((value) => value + 1)}
            className="rounded-lg bg-raised px-3 py-1.5 text-[12.5px] text-ink hover:bg-control">Try again</button>}
        </div>}
      </div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}
