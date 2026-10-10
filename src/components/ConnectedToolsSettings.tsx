import { useState } from "react";
import { useStore } from "@/state/store";
import { ComposioCredentialPanel } from "./ComposioCredentialPanel";
import type { ComposioCredentialStatus } from "../../shared/composio-credential";

/** Colonie settings for the Composio project key. Connecting app accounts and
 * adding Custom MCP live in the Apps panel (the puzzle entry), so this surface
 * stays the one place for the key and does not duplicate that catalog. */
export function ConnectedToolsSettings() {
  const { dispatch } = useStore();
  const [, setCredential] = useState<ComposioCredentialStatus | null>(null);
  return <section className="space-y-3 rounded-2xl border border-hairline p-4" aria-label="Composio project key">
    <h3 className="text-base font-semibold">Composio</h3>
    <p className="text-sm text-ink-secondary">Your Composio project key powers app connections. Connect app accounts and add Custom MCP from the Apps panel.</p>
    <ComposioCredentialPanel onStatus={setCredential} />
    <button type="button" onClick={() => dispatch({ type: "togglePlugins", open: true })} className="rounded-lg bg-control px-3 py-1.5 text-sm">Open Apps</button>
  </section>;
}