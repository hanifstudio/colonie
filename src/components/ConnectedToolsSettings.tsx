import { useState } from "react";
import { useStore } from "@/state/store";
import { ComposioCredentialPanel } from "./ComposioCredentialPanel";
import { Card } from "./SettingsPrimitives";
import type { ComposioCredentialStatus } from "../../shared/composio-credential";

/** Colonie settings for the Composio project key. Connecting app accounts and
 * adding Custom MCP live in the Apps panel (the puzzle entry), so this surface
 * stays the one place for the key and does not duplicate that catalog. */
export function ConnectedToolsSettings() {
  const { dispatch } = useStore();
  const [, setCredential] = useState<ComposioCredentialStatus | null>(null);
  // the same card as every other block of settings (SettingsPrimitives Card)
  return <section aria-label="Composio project key">
    <Card title="Composio" subtitle="Your Composio project key powers app connections. Connect app accounts and add MCP servers from the Apps panel.">
      <div className="space-y-3">
        <ComposioCredentialPanel onStatus={setCredential} />
        <button type="button" onClick={() => dispatch({ type: "togglePlugins", open: true })} className="rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised">Open Apps</button>
      </div>
    </Card>
  </section>;
}