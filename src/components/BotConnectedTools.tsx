import { useEffect, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import type { ConnectedAppsView } from "../../shared/connected-apps";
import type { ToolkitCard } from "./PluginsPanel";

export function BotConnectedTools({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [view, setView] = useState<ConnectedAppsView | null>(null);
  const [cards, setCards] = useState<ToolkitCard[]>([]);
  const [servers, setServers] = useState<Array<{ name: string; enabled: boolean }>>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [toolkits, setToolkits] = useState<string[]>([]);
  const [customServers, setCustomServers] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController(); setView(null); setError("");
    void Promise.all([api(`/api/bots/${bot.id}/connected-tools`, { signal: controller.signal }), api("/api/mcp/servers", { signal: controller.signal })])
      .then(async ([policy, custom]) => {
        if (controller.signal.aborted) return;
        setView(policy); setToolkits(policy.toolkits); setCustomServers(policy.customServers ?? []); setServers(custom.servers ?? []);
        if (policy.configured) {
          const catalog = await api("/api/connectors/catalog", { signal: controller.signal });
          if (!controller.signal.aborted) setCards(catalog.cards ?? []);
        } else setCards([]);
      }).catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [bot.id, revision]);
  const save = async () => {
    if (!view || saving) return;
    setSaving(true); setError("");
    try { setView(await api(`/api/bots/${bot.id}/connected-tools`, { method: "PATCH", body: JSON.stringify({ expectedRevision: view.revision, preferences: { toolkits, customServers } }) })); }
    catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };
  const toggle = (values: string[], value: string) => values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
  const working = bot.tasks?.some((task) => task.busy) || bot.busy;
  const knownCards = [...cards, ...toolkits.filter((slug) => !cards.some((card) => card.slug === slug)).map((slug) => ({ slug, label: slug }))];
  const visibleCards = knownCards.filter((card) => toolkits.includes(card.slug) || `${card.label} ${card.slug}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(toolkits.includes(b.slug)) - Number(toolkits.includes(a.slug))).slice(0, 40);
  const visibleServers = [...servers, ...customServers.filter((name) => !servers.some((server) => server.name === name)).map((name) => ({ name, enabled: false }))];
  return <section aria-label="Bot connected tools" className="space-y-3 rounded-xl border border-hairline bg-inset p-3 text-sm">
    <div className="flex items-center justify-between gap-2"><h3 className="font-medium">Connected apps and tools</h3><button disabled={saving} onClick={() => setRevision((value) => value + 1)} className="text-xs underline">Refresh</button></div>
    <p className="text-xs text-ink-secondary">Choose the tools this bot can use. Changes apply with its next message and keep existing conversations.</p>
    <button onClick={() => { dispatch({ type: "toggleSettings", open: false }); dispatch({ type: "toggleAppSettings", open: true, section: "connections" }); }} className="rounded-lg bg-control px-3 py-1.5">Manage connections</button>
    {!view && !error && <p>Loading…</p>}
    {view && <fieldset disabled={saving || Boolean(working)} className="space-y-3">
      <legend className="font-medium">Composio apps</legend>
      {!view.configured && <p className="text-xs text-ink-secondary">Set up Composio in app settings to choose apps.</p>}
      {view.configured && <><input aria-label="Find apps for this bot" placeholder="Find an app" className="w-full rounded-lg border border-hairline bg-panel p-2" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="max-h-44 space-y-2 overflow-auto">{visibleCards.map((card) => <label key={card.slug} className="flex gap-2"><input type="checkbox" checked={toolkits.includes(card.slug)} onChange={() => setToolkits(toggle(toolkits, card.slug))} />{card.label}</label>)}</div></>}
      <h4 className="font-medium">Custom MCP</h4>
      {visibleServers.filter((server) => server.enabled || customServers.includes(server.name)).map((server) => <label key={server.name} className="flex gap-2"><input type="checkbox" disabled={!server.enabled && !customServers.includes(server.name)} checked={customServers.includes(server.name)} onChange={() => setCustomServers(toggle(customServers, server.name))} />{server.name}{!server.enabled && " · Disabled or removed in app settings"}</label>)}
      {!servers.length && <p className="text-xs text-ink-secondary">No custom connections yet.</p>}
      <button onClick={() => void save()} className="rounded-lg bg-control px-3 py-1.5 disabled:opacity-50">{saving ? "Saving…" : "Save tool access"}</button>
      {working && <p className="text-xs text-ink-secondary">Wait for this bot's conversations to finish before changing access.</p>}
    </fieldset>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </section>;
}
