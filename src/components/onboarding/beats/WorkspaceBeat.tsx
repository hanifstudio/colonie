// Beat: which kind of workspace this is. A workspace is what the bots, the
// conversations and the connections belong to, so the choice comes before the
// engines. Local is the one the app can create today; Server is shown with its
// real status instead of being hidden, because the person will hear about it
// and an option that is simply missing reads as an oversight.
//
import { CloudServerIcon, ComputerIcon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "../../HIcon";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { PrimaryButton, staggerIndex, type BeatProps } from "./shared";

/** A kind of workspace: what it is, where it runs, and whether it can be
 * chosen yet. The unavailable one is still drawn — disabled, never as if it
 * worked. */
function KindRow({
  index,
  icon,
  name,
  detail,
  available,
}: {
  index: number;
  icon: typeof ComputerIcon;
  name: string;
  detail: string;
  available: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={available}
      disabled={!available}
      className={cn(
        "animate-rise flex items-center justify-between gap-3 rounded-xl border bg-card p-3.5 text-left transition-colors",
        available
          ? "cursor-default border-accent/50"
          : "cursor-not-allowed border-hairline/40 opacity-60",
      )}
      style={staggerIndex(index)}
    >
      <span className="flex items-start gap-3">
        <HIcon
          icon={icon}
          size={18}
          className={cn("mt-0.5 shrink-0", available ? "text-accent" : "text-ink-secondary")}
        />
        <span>
          <span className="block text-[14px] font-medium text-ink">{name}</span>
          <span className="mt-0.5 block text-[12.5px] text-ink-secondary">{detail}</span>
        </span>
      </span>
      {available ? (
        <HIcon icon={Tick01Icon} size={16} className="shrink-0 text-success" aria-hidden="true" />
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-control px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
          <span className="size-1.5 rounded-full bg-ink-secondary/60" aria-hidden="true" />
          {t("onboarding.workspace.soon")}
        </span>
      )}
    </button>
  );
}

export function WorkspaceBeat({ onNext }: BeatProps) {
  return (
    <div className="flex flex-col">
      <p className="animate-rise mt-1 text-[13.5px] text-ink-secondary">{t("onboarding.workspace.intro")}</p>
      <p className="animate-rise mt-1 text-[12.5px] text-ink-tertiary">{t("onboarding.workspace.pick")}</p>

      <div className="stagger mt-4 flex flex-col gap-2.5" role="radiogroup" aria-label={t("onboarding.workspace.title")}>
        <KindRow
          index={1}
          icon={ComputerIcon}
          name={t("onboarding.workspace.local")}
          detail={t("onboarding.workspace.localDetail")}
          available
        />
        <KindRow
          index={2}
          icon={CloudServerIcon}
          name={t("onboarding.workspace.server")}
          detail={t("onboarding.workspace.serverDetail")}
          available={false}
        />
      </div>

      <PrimaryButton onClick={onNext} className="mt-5">
        {t("onboarding.continue")}
      </PrimaryButton>
    </div>
  );
}
