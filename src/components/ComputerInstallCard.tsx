// Shown in Simple mode when this Mac has no container app yet: what giving a
// bot its computer costs, in plain words, and the one free app to install
// (owner, October 29). After installing, the panel checks again and sets the
// computer up by itself.
import { t } from "@/lib/i18n";

/** Podman Desktop: free, an ordinary Mac installer, no terminal. */
export const COMPUTER_APP_DOWNLOAD = "https://podman-desktop.io/downloads";

const GB = 1024 ** 3;

export function ComputerInstallCard({ botName, memoryBytes, onCheck }: { botName: string; memoryBytes?: number; onCheck: () => void }) {
  const memory = memoryBytes ? Math.round(memoryBytes / GB) : null;
  return (
    <div className="flex flex-col gap-3 px-5 py-4 text-left text-[12.5px] leading-relaxed text-ink-secondary" data-testid="computer-install">
      <div className="text-[14px] font-medium text-ink">{t("computer.install.title", { name: botName })}</div>
      <p>{t("computer.install.body", { name: botName })}</p>
      <ul className="list-disc space-y-1 pl-4">
        <li>{t("computer.install.app")}</li>
        <li>{memory ? t("computer.install.memoryOf", { name: botName, gb: memory }) : t("computer.install.memory", { name: botName })}</li>
        <li>{t("computer.install.idle")}</li>
      </ul>
      <div className="flex flex-wrap gap-2">
        <a href={COMPUTER_APP_DOWNLOAD} target="_blank" rel="noreferrer" className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110">
          {t("computer.install.download")}
        </a>
        <button type="button" onClick={onCheck} className="rounded-lg bg-control px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised">
          {t("computer.install.check")}
        </button>
      </div>
    </div>
  );
}
