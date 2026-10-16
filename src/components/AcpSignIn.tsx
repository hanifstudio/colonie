import { useState } from "react";
import { Copy01Icon, Loading02Icon, Login01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";

/** In-app sign-in for a Colonie ACP connection. Codex signs in through the
 * adapter's own browser flow; Claude's adapter offers only a terminal login,
 * which the app opens (running it) with the isolated config dir. */
export function AcpSignIn({ instanceId }: { instanceId: string }) {
  const { refreshInstances, refreshModels } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = async () => {
    await refreshInstances();
    await refreshModels(instanceId);
  };
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ terminal?: { command: string } }>(`/api/instances/${encodeURIComponent(instanceId)}/acp-auth`, { method: "POST", body: "{}" });
      if (result.terminal) {
        // Run the login in a real Terminal; only fall back to showing the
        // command when no terminal can be launched (a browser client).
        const opened = await window.colonie?.signInTerminal?.(instanceId);
        if (!opened) setTerminal(result.terminal.command);
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (terminal && (await copyText(terminal)) === "copied") setCopied(true);
  };
  return <div className="mt-3 space-y-2" data-acp-sign-in={instanceId}>
    <button
      type="button"
      disabled={busy}
      onClick={() => void start()}
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
    >
      {busy ? <HIcon icon={Loading02Icon} size={14} className="animate-spin" /> : <HIcon icon={Login01Icon} size={14} />}
      {busy ? t("engineSetup.device.waiting") : t("pro.signIn")}
    </button>
    {terminal && <div className="space-y-1 rounded-lg border border-hairline/50 bg-app p-2">
      <p className="text-[11.5px] text-ink-secondary">{t("engineSetup.terminalSignIn")}</p>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-secondary" title={terminal}>{terminal}</code>
        <button type="button" onClick={() => void copy()} aria-label={t("engineSetup.copyCommand")} className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink">
          {copied ? <HIcon icon={Tick01Icon} size={12} className="text-success" /> : <HIcon icon={Copy01Icon} size={12} />}
        </button>
      </div>
    </div>}
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
  </div>;
}