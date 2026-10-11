import { useState } from "react";
import { CancelCircleIcon, CheckmarkCircle02Icon, CircleIcon, Copy01Icon, Loading02Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { runLogText, type TimelineEvent } from "@/lib/taskTimeline";
import { formatTime } from "@/state/store";

const STATUS = {
  running: "inspector.run.running",
  complete: "inspector.run.complete",
  failed: "inspector.run.failed",
  observed: "inspector.run.observed",
} as const;

export function RunLog({ events }: { events: TimelineEvent[] }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  // The full conversation remains in chat. Keep the debugging view bounded.
  const recent = events.slice(-200);
  const copy = async () => {
    const result = await copyText(runLogText(recent));
    if (result !== "empty") setCopyState(result);
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex items-start gap-3 px-4 py-3">
        <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-secondary">{t("inspector.run.hint")}</p>
        {recent.length > 0 && <button
          type="button"
          onClick={() => void copy()}
          aria-label={t("inspector.run.copy")}
          title={t("inspector.run.copy")}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          {copyState === "copied" ? <HIcon icon={Tick01Icon} size={14} /> : <HIcon icon={Copy01Icon} size={14} />}
        </button>}
      </div>
      {copyState !== "idle" && <p role="status" className="px-4 pb-2 text-[12px] text-ink-secondary">
        {t(copyState === "copied" ? "inspector.run.copied" : "inspector.run.copyFailed")}
      </p>}
      {events.length > recent.length && <p className="px-4 pb-2 text-[12px] text-ink-secondary">{t("inspector.run.recent", { count: recent.length })}</p>}
      {recent.length === 0 ? <p className="px-4 py-6 text-[13px] text-ink-secondary">{t("inspector.run.empty")}</p> : (
        <ol aria-label={t("inspector.run.title")} className="px-4 pb-4">
          {recent.map((event) => {
            const Icon = event.state === "failed" ? CancelCircleIcon : event.state === "complete" ? CheckmarkCircle02Icon : event.state === "running" ? Loading02Icon : CircleIcon;
            const label = event.kind === "task" ? t("inspector.run.userInput")
              : event.kind === "screen" ? t("inspector.run.screen")
                : event.kind === "result" ? t("inspector.run.response") : event.label;
            return <li key={event.id} className="border-t border-hairline/30 py-3">
              <div className="flex items-start gap-2 text-[12px]">
                <HIcon icon={Icon} size={14} aria-hidden="true" className={cn("mt-0.5 shrink-0", event.state === "failed" ? "text-danger" : event.state === "running" ? "animate-spin text-accent" : "text-ink-secondary")} />
                <span className="min-w-0 flex-1 break-words font-medium text-ink">{label}</span>
                <time dateTime={new Date(event.at).toISOString()} className="shrink-0 tabular-nums text-ink-secondary">{formatTime(event.at)}</time>
              </div>
              {event.command && <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-inset p-2 font-mono text-[11.5px] leading-relaxed text-ink">{event.command}</pre>}
              {event.kind === "tool" && <p className={cn("mt-1 pl-[22px] text-[11px]", event.state === "failed" ? "text-danger" : "text-ink-secondary")}>{t(STATUS[event.state])}</p>}
            </li>;
          })}
        </ol>
      )}
    </div>
  );
}
