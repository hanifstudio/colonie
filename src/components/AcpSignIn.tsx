import { useState } from "react";
import { Loader2, LogIn } from "lucide-react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";

/** In-app sign-in for a Colonie ACP connection. The adapter runs the provider's
 * own authenticate flow with the isolated config dir; the app only waits. */
export function AcpSignIn({ instanceId }: { instanceId: string }) {
  const { refreshInstances, refreshModels } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/instances/${encodeURIComponent(instanceId)}/acp-auth`, { method: "POST", body: "{}" });
      await refreshInstances();
      await refreshModels(instanceId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return <div className="mt-3 space-y-2" data-acp-sign-in={instanceId}>
    <button
      type="button"
      disabled={busy}
      onClick={() => void start()}
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
      {busy ? t("engineSetup.device.waiting") : t("pro.signIn")}
    </button>
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
  </div>;
}