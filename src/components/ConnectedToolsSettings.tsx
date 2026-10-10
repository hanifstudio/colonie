import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { reserveConnectionPage } from "@/lib/connector-oauth";
import { ComposioCredentialPanel } from "./ComposioCredentialPanel";
import type { ComposioCredentialStatus } from "../../shared/composio-credential";
import { McpServersPanel } from "./McpServersPanel";
import type { ToolkitCard, ConnectorStatus } from "./PluginsPanel";

export function ConnectedToolsSettings() {
  const [credential, setCredential] = useState<ComposioCredentialStatus | null>(null);
  const configured = credential?.available === true;
  const [loaded, setLoaded] = useState(false);
  const [cards, setCards] = useState<ToolkitCard[]>([]);
  const [services, setServices] = useState<Record<string, ConnectorStatus>>({});
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const pending = useRef<ReturnType<typeof reserveConnectionPage> | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    pending.current?.cancel(); request.current?.abort(); setLink(null); setBusy(""); setLoaded(false); setError("");
    if (!configured) { setCards([]); setServices({}); return; }
    const controller = new AbortController(); setError(""); setCards([]); setServices({});
    void Promise.all([api("/api/connectors/catalog", { signal: controller.signal }), api("/api/connectors/connected", { signal: controller.signal })])
      .then(([catalog, inventory]) => { if (!controller.signal.aborted) { setCards(catalog.cards ?? []); setServices(inventory.services ?? {}); setLoaded(true); } })
      .catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [configured, credential?.revision, revision]);
  useEffect(() => () => { pending.current?.cancel(); request.current?.abort(); }, []);
  const connect = async (slug: string) => {
    pending.current?.cancel(); request.current?.abort();
    const page = reserveConnectionPage(); pending.current = page;
    const controller = new AbortController(); request.current = controller;
    setBusy(slug); setError(""); setLink(null);
    try {
      const result = await api(`/api/connectors/${slug}/authorize`, { method: "POST", body: "{}", signal: controller.signal });
      if (controller.signal.aborted) return;
      const url = new URL(result.url);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("The connection service returned an invalid sign-in link.");
      setLink(url.href); await page.open(url.href);
    } catch (cause) { page.cancel(); if (!controller.signal.aborted) setError((cause as Error).message); }
    finally { if (!controller.signal.aborted) setBusy(""); }
  };
  const visible = cards.filter((card) => !query || `${card.label} ${card.slug}`.toLowerCase().includes(query.toLowerCase())).slice(0, 30);
  return <div className="space-y-6">
    <section className="space-y-3 rounded-2xl border border-hairline p-4" aria-label="Composio connections">
      <h3 className="text-base font-semibold">Composio</h3>
      <p className="text-sm text-ink-secondary">Connect your apps here, then choose which apps each bot can use in its profile.</p>
      <ComposioCredentialPanel onStatus={setCredential} />
      {configured && <>
        {loaded && <p role="status" className="text-sm text-ink-secondary">Composio is ready. App accounts are connected separately below.</p>}
        <div className="flex gap-2"><input aria-label="Search Composio apps" placeholder="Search apps" value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-hairline bg-inset p-2 text-sm" />
          <button onClick={() => setRevision((value) => value + 1)} disabled={Boolean(busy)} className="rounded-lg bg-control px-3 text-sm">Refresh connections</button></div>
        {link && <p className="rounded-lg bg-inset p-3 text-sm">Finish signing in, then refresh connections. <a href={link} target="_blank" rel="noopener noreferrer" className="underline">Open sign-in page</a></p>}
        <div className="max-h-80 divide-y divide-hairline overflow-auto">
          {visible.map((card) => <div key={card.slug} className="flex items-center justify-between gap-3 py-2 text-sm">
            <div className="min-w-0"><div className="font-medium">{card.label}</div><div className="truncate text-xs text-ink-secondary">{card.noAuth ? "No sign-in needed" : services[card.slug]?.connected ? "Connected" : "Not connected"}</div></div>
            {!card.noAuth && !services[card.slug]?.connected && <button disabled={Boolean(busy)} onClick={() => void connect(card.slug)} className="shrink-0 rounded-lg bg-control px-3 py-1.5">{busy === card.slug ? "Opening…" : "Connect"}</button>}
          </div>)}
          {!loaded && !error && <p className="py-3 text-sm text-ink-secondary">Checking Composio and loading apps…</p>}
        </div>
      </>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </section>
    <section className="space-y-3 rounded-2xl border border-hairline p-4" aria-label="Custom MCP connections">
      <h3 className="text-base font-semibold">Custom MCP</h3>
      <p className="text-sm text-ink-secondary">Add the URL or local command provided by your tool, or paste its MCP configuration. Choose which bots can use it in their profiles.</p>
      <McpServersPanel embedded nativeSettings={false} />
    </section>
  </div>;
}
