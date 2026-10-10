import { useEffect, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { credentialOperationError, type ComposioCredentialStatus } from "../../shared/composio-credential";

const sourceLabel = {
  "secure-store": "Saved on this device",
  "workspace-settings": "From existing workspace settings",
  environment: "Provided by the runtime environment",
  none: "No project key configured",
};
const originLabel = {
  "user-input": "Entered in the app",
  "workspace-migration": "Imported from existing workspace settings",
  "existing-device-store": "Existing device credential; original setup history is unavailable",
  environment: "Supplied when the app was launched",
  "workspace-settings": "Existing workspace configuration",
  none: "Not configured",
};
export function ComposioCredentialPanel({ onStatus }: { onStatus(status: ComposioCredentialStatus | null): void }) {
  const { state, dispatch } = useStore();
  const [status, setStatus] = useState<ComposioCredentialStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api("/api/colonie/composio/credential", { signal: controller.signal })
      .then((value: ComposioCredentialStatus) => { if (!controller.signal.aborted) { setStatus(value); onStatus(value); } })
      .catch(() => { if (!controller.signal.aborted) { setStatus(null); onStatus(null); setError("Could not read Composio setup status. Refresh to try again."); } });
    return () => controller.abort();
  }, [revision, state.config?.composio, onStatus]);
  const save = async (action: "save" | "remove") => {
    if (busy || !status) return;
    const key = action === "remove" ? "" : draft.trim();
    if (action === "save" && (!key.startsWith("ak_") || /\s/.test(key))) { setError("Enter a Composio project key starting with ak_."); return; }
    if (action === "remove" && !status.canRemove) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const config: ConfigStatus = window.ogb?.setCredential
        ? await window.ogb.setCredential("composioApiKey", key)
        : await api("/api/config", { method: "PUT", body: JSON.stringify({ composio: { apiKey: key } }) });
      dispatch({ type: "configStatus", config });
      const next: ComposioCredentialStatus = await api("/api/colonie/composio/credential");
      setStatus(next); onStatus(next); setDraft(""); setEditing(false);
      setNotice(action === "remove" ? next.available ? "The saved key was removed. An external key is still active." : "Project key removed."
        : "Project key saved. Connect an app account below if needed.");
    } catch (cause) {
      setError(credentialOperationError(cause, action));
      // Failed mutations retain the previous source/masked key, not a success state.
      setRevision((value) => value + 1);
    } finally { setBusy(false); }
  };
  const attention = status?.storage !== "available" && status?.storage !== undefined;
  return <div className="space-y-3" aria-label="Composio project key setup" data-composio-credential>
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-sm font-medium">Composio project key</h4>
      <span role="status" className="text-xs text-ink-secondary">{!status ? "Checking setup…" : attention ? "Needs attention" : status.available ? "Key available" : "Not set up"}</span>
    </div>
    {status?.available && <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm"><dt className="text-ink-secondary">Active key</dt><dd data-testid="composio-masked-key" className="font-mono">{status.maskedKey}</dd>
        <dt className="text-ink-secondary">Source</dt><dd>{sourceLabel[status.source]}</dd>
        <dt className="text-ink-secondary">Origin</dt><dd>{originLabel[status.origin]}</dd></dl>
      <p className="text-xs text-ink-secondary">A project key enables Composio setup. Gmail, Drive and other accounts are connected separately below.</p>
      {status.source === "environment" && <p className="text-xs text-ink-secondary">This key is supplied outside the app. Remove it from the launch environment to turn it off.</p>}
      <div className="flex gap-2"><button disabled={busy || status.storage === "unreadable"} onClick={() => { setEditing(true); setError(""); setNotice(""); }} className="rounded-lg bg-control px-3 py-2 text-sm">Replace key</button>
        {status.canRemove && <button disabled={busy} onClick={() => void save("remove")} className="rounded-lg bg-control px-3 py-2 text-sm text-danger">{busy ? "Please wait…" : "Remove key"}</button>}</div>
    </>}
    {status && (!status.available || editing) && <form onSubmit={(event) => { event.preventDefault(); void save("save"); }} className="space-y-2">
      <label className="block text-sm">{status.available ? "New Composio project key" : "Enter your Composio project key"}
        <input type="password" aria-label="Composio project key" value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy || status.storage === "unreadable"} autoComplete="off" placeholder="ak_…" className="mt-1 w-full rounded-lg border border-hairline bg-inset p-3" /></label>
      <div className="flex gap-2"><button disabled={busy || !draft.trim() || status.storage === "unreadable"} className="rounded-lg bg-control px-3 py-2 text-sm">{busy ? "Saving…" : "Save key"}</button>
        {editing && <button type="button" disabled={busy} onClick={() => { setEditing(false); setDraft(""); }} className="px-3 py-2 text-sm">Cancel</button>}
        <a href="https://dashboard.composio.dev" target="_blank" rel="noopener noreferrer" className="px-3 py-2 text-sm underline">Get a project key</a></div>
    </form>}
    {status?.storage === "migration-pending" && <p className="text-xs text-ink-secondary">An existing workspace key could not be moved to the macOS credential store. The source shown above is the configuration currently in use.</p>}
    {status?.storage === "unreadable" && <p className="text-xs text-danger">The saved credential store could not be read. Unlock your keychain and restart Colonie before changing saved keys.</p>}
    {notice && <p role="status" className="text-sm text-ink-secondary">{notice}</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!status && <button onClick={() => setRevision((value) => value + 1)} className="text-sm underline">Refresh setup status</button>}
  </div>;
}
