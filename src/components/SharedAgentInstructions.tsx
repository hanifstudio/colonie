import { useEffect, useState } from "react";
import { api } from "@/state/store";
import type { AppContextPreferences } from "../../shared/acp-context";

export function SharedAgentInstructions() {
  const [settings, setSettings] = useState<(AppContextPreferences & { revision: string }) | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api("/api/acp-context", { signal: controller.signal }).then((value: AppContextPreferences & { revision: string }) => {
      if (controller.signal.aborted) return;
      setSettings(value); setDraft(value.instructions);
    }).catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, []);
  const save = async () => {
    if (!settings || busy) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      setSettings(await api("/api/acp-context", { method: "PATCH", body: JSON.stringify({ expectedRevision: settings.revision,
        preferences: { enabled: settings.enabled, instructions: draft } }) }));
      setSaved(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="space-y-2 py-3">
    <label htmlFor="shared-agent-instructions" className="text-sm font-medium text-ink">Instructions for all bots</label>
    <p className="text-xs text-ink-secondary">Optional preferences for every bot, such as your preferred writing style. Each bot's role and instructions belong in its profile. Changes apply to new conversations.</p>
    <textarea id="shared-agent-instructions" maxLength={32_000} disabled={!settings || busy} value={draft}
      onChange={(event) => { setDraft(event.target.value); setSaved(false); }} className="min-h-24 w-full rounded-xl border border-hairline bg-inset p-3 text-sm" placeholder="For example: Use plain language and keep summaries short." />
    <button disabled={!settings || busy} onClick={() => void save()} className="rounded-lg bg-control px-3 py-2 text-sm disabled:opacity-50">{busy ? "Saving…" : "Save shared instructions"}</button>
    {saved && <p role="status" className="text-xs text-ink-secondary">Saved for new conversations.</p>}
    {settings && !settings.enabled && <p className="text-xs text-ink-secondary">Shared instructions were turned off in Developer tools. Restore the default there to use them.</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
}
