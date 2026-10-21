// Beat: what the person came for. A workspace is what the bots, the
// conversations and the connections belong to, so the choice comes before the
// engines. Local continues the welcome here (engines, permissions, a bot).
// Setting up a Shared workspace or joining one ends the welcome and opens
// that path at once: on a Shared workspace the engines are signed in on the
// server, and someone joining needs nothing set up on this computer.
import { useState } from "react";
import { CloudServerIcon, ComputerIcon, Link02Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "../../HIcon";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { PrimaryButton, staggerIndex, type BeatProps } from "./shared";

export type WorkspaceChoice = "local" | "create" | "join";

function KindRow({ index, icon, name, detail, chosen, onChoose }: {
  index: number;
  icon: typeof ComputerIcon;
  name: string;
  detail: string;
  chosen: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      onClick={onChoose}
      className={cn(
        "animate-rise flex items-center justify-between gap-3 rounded-xl border bg-card p-3.5 text-left transition-colors",
        chosen ? "border-accent/50" : "border-hairline/40 hover:border-hairline",
      )}
      style={staggerIndex(index)}
    >
      <span className="flex items-start gap-3">
        <HIcon icon={icon} size={18} className={cn("mt-0.5 shrink-0", chosen ? "text-accent" : "text-ink-secondary")} />
        <span>
          <span className="block text-[14px] font-medium text-ink">{name}</span>
          <span className="mt-0.5 block text-[12.5px] text-ink-secondary">{detail}</span>
        </span>
      </span>
      {chosen && <HIcon icon={Tick01Icon} size={16} className="shrink-0 text-success" aria-hidden="true" />}
    </button>
  );
}

const CONTINUE: Record<WorkspaceChoice, string> = {
  local: "onboarding.continue",
  create: "onboarding.workspace.createNext",
  join: "onboarding.workspace.joinNext",
};

export function WorkspaceBeat({ onNext, onShared, initialChoice = "local" }: BeatProps & {
  /** Opens a Shared workspace path and ends the welcome. Absent where this
   * app cannot open one (a browser): then only Local is offered. */
  onShared?: (choice: "create" | "join") => void;
  /** Preview and tests: start on another choice. */
  initialChoice?: WorkspaceChoice;
}) {
  const [choice, setChoice] = useState<WorkspaceChoice>(onShared ? initialChoice : "local");
  const go = () => (choice === "local" || !onShared ? onNext() : onShared(choice));
  return (
    <div className="flex flex-col">
      <p className="animate-rise mt-1 text-[13.5px] text-ink-secondary">{t("onboarding.workspace.intro")}</p>

      <div className="stagger mt-4 flex flex-col gap-2.5" role="radiogroup" aria-label={t("onboarding.workspace.title")}>
        <KindRow index={1} icon={ComputerIcon} name={t("onboarding.workspace.local")} detail={t("onboarding.workspace.localDetail")}
          chosen={choice === "local"} onChoose={() => setChoice("local")} />
        {onShared && <>
          <KindRow index={2} icon={CloudServerIcon} name={t("onboarding.workspace.server")} detail={t("onboarding.workspace.serverDetail")}
            chosen={choice === "create"} onChoose={() => setChoice("create")} />
          <KindRow index={3} icon={Link02Icon} name={t("onboarding.workspace.join")} detail={t("onboarding.workspace.joinDetail")}
            chosen={choice === "join"} onChoose={() => setChoice("join")} />
        </>}
      </div>

      <PrimaryButton onClick={go} className="mt-5">
        {t(CONTINUE[choice] as Parameters<typeof t>[0])}
      </PrimaryButton>
    </div>
  );
}
