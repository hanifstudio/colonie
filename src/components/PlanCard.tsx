// A bot's step list for one turn: a small card with no bubble. Open while the bot is still at work,
// folded to one line ("Steps · 2 of 3 done") once the turn ends; the person can open or fold it either way.
// Marks: a dotted ring for not started, a turning arc for the step in progress, a check for done.
// A step still "in progress" after the turn ended reads as not started, never as spinning forever.
import { useState } from "react";
import { ArrowDown01Icon, ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { planProgress, planStepState, type ConversationPlan } from "../../shared/conversation-plan";
import { t } from "@/lib/i18n";

export function PlanCard({ plan, compact }: { plan: ConversationPlan; compact?: boolean }) {
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  if (!plan.steps.length) return null;
  const progress = planProgress(plan);
  const open = chosen ?? !plan.ended;
  const title = progress.stopped ? t("plan.stoppedTitle") : t("plan.title");
  return (
    <div className={`${compact ? "mt-2" : "w-full max-w-[34rem] py-1"} text-[12.5px] text-ink-secondary`} data-testid="plan-card">
      <button type="button" aria-expanded={open} onClick={() => setChosen(!open)}
        className="flex items-center gap-1.5 rounded-md py-0.5 text-ink-tertiary outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60">
        <HIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} aria-hidden="true" />
        <span className="font-medium">{title}</span>
        <span aria-hidden="true">·</span>
        <span>{t("plan.progress", { done: progress.done, total: progress.total })}</span>
      </button>
      {open && (
        <ol className="mt-1 flex flex-col gap-1 ps-1">
          {plan.steps.map((step, index) => {
            const state = planStepState(plan, step);
            return (
              <li key={index} className="flex items-start gap-2 leading-5">
                <span className="mt-[3px] flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                  {state === "done" ? <HIcon icon={Tick02Icon} size={13} className="text-accent" />
                    : state === "active" ? <span className="size-3 rounded-full border-2 border-accent border-t-transparent motion-safe:animate-spin" />
                    : <span className="size-3 rounded-full border border-dotted border-ink-tertiary" />}
                </span>
                <span className="sr-only">{state === "done" ? t("plan.done") : state === "active" ? t("plan.active") : t("plan.pending")}: </span>
                <span className={state === "done" ? "text-ink-tertiary line-through" : state === "active" ? "text-ink" : undefined}>{step.text}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
