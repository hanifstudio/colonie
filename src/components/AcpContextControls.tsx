import { useEffect, useState } from "react";
import { api } from "@/state/store";
import type { AcpContextSection, AcpContextView } from "../../shared/acp-context";

export function ContextSections({ sections }: { sections: Array<AcpContextSection & { blockIndex?: number }> }) {
  return <div className="space-y-2">
    {sections.map((section) => <details key={section.id} className="rounded border border-hairline p-2 text-xs">
      <summary className="cursor-pointer">{section.label} · {section.status}</summary>
      <dl className="my-2 grid grid-cols-[auto_1fr] gap-x-2 break-all text-ink-secondary">
        <dt>Scope</dt><dd>{section.scope}</dd><dt>Source</dt><dd>{section.source}</dd>
        <dt>Version</dt><dd>{section.version}</dd><dt>SHA-256</dt><dd>{section.hash}</dd>
        {section.blockIndex !== undefined && <><dt>Exact input block</dt><dd>{section.blockIndex + 1}</dd></>}
      </dl>
      {section.text && <pre className="whitespace-pre-wrap break-words rounded bg-inset p-2">{section.text}</pre>}
    </details>)}
  </div>;
}

export function AcpContextControls({ botId, threadId, view, onSaved }: { botId: string; threadId: string; view: AcpContextView; onSaved: (view: AcpContextView) => void }) {
  const [app, setApp] = useState({ enabled: view.app.enabled, instructions: view.app.instructions });
  const [bot, setBot] = useState({ persona: view.bot.persona, soul: view.bot.soul });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setApp({ enabled: view.app.enabled, instructions: view.app.instructions }); }, [view.app.revision]);
  useEffect(() => { setBot({ persona: view.bot.persona, soul: view.bot.soul }); }, [view.bot.revision]);
  const save = async (scope: "app" | "bot") => {
    setBusy(true); setError("");
    try {
      onSaved(await api(`/api/bots/${botId}/acp-context`, { method: "PATCH", body: JSON.stringify({ threadId, scope,
        expectedRevision: view[scope].revision, preferences: scope === "app" ? app : bot }) }));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="mb-4 space-y-3 text-sm">
    <fieldset disabled={busy} className="space-y-2 rounded-lg border border-hairline p-3">
      <legend className="px-1 font-medium">App-wide context · all bots</legend>
      <label className="flex gap-2"><input type="checkbox" checked={app.enabled} onChange={(event) => setApp({ ...app, enabled: event.target.checked })} />Include Colonie awareness and shared instructions</label>
      <label className="block">Shared app instructions<textarea aria-label="Shared app instructions" maxLength={32_000} className="mt-1 min-h-20 w-full rounded border border-hairline bg-inset p-2" value={app.instructions} onChange={(event) => setApp({ ...app, instructions: event.target.value })} /></label>
      <p className="text-xs text-ink-secondary">Applies to new conversations for every bot in this workspace. Includes factory identity and effective connection capabilities.</p>
      <button className="rounded bg-control px-3 py-1.5 hover:bg-raised" onClick={() => void save("app")}>Save app-wide context</button>
    </fieldset>
    <fieldset disabled={busy} className="space-y-2 rounded-lg border border-hairline p-3">
      <legend className="px-1 font-medium">Bot-specific context · this bot only</legend>
      <label className="flex gap-2"><input type="checkbox" checked={bot.persona} onChange={(event) => setBot({ ...bot, persona: event.target.checked })} />Include this bot's persona</label>
      <label className="flex gap-2"><input type="checkbox" checked={bot.soul} onChange={(event) => setBot({ ...bot, soul: event.target.checked })} />Include this bot's SOUL</label>
      <p className="text-xs text-ink-secondary">Persona uses saved Name, Title, Blurb, and configured Chief identity. Edit those fields and standing instructions in bot settings. Changes apply to new conversations for this bot only.</p>
      <button className="rounded bg-control px-3 py-1.5 hover:bg-raised" onClick={() => void save("bot")}>Save bot context</button>
    </fieldset>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <p className="text-xs text-ink-secondary">All switches off keeps new conversations plain/native, except separately configured instance instructions. Saved context is pinned at first dispatch; Native discovery does not pin it.</p>
    {view.pinned && <p className="break-all rounded bg-inset p-2 text-xs" data-testid="acp-context-pin">Pinned {view.pinned.pinnedAt} · SHA-256 {view.pinned.hash}{view.pinned.legacyPlain ? " · Existing plain conversation" : ""}. {view.changed ? "Settings/profile changed. This conversation keeps its pinned context; start a new conversation to use the updates." : "This conversation keeps this context after restart."}</p>}
    {!view.pinned && view.preview.legacyPlain && <p className="text-xs text-ink-secondary">This existing ACP conversation stays plain for app and bot additions. Start a new conversation to enable them.</p>}
    <details open={!view.pinned} className="rounded-lg border border-hairline p-3">
      <summary className="cursor-pointer font-medium">{view.pinned ? "Pinned conversation context" : "Saved context preview · next dispatch"}</summary>
      <p className="my-2 text-xs text-ink-secondary">Effective capabilities are added at dispatch when app awareness is enabled. Native system/project instructions are not part of this preview.</p>
      <ContextSections sections={(view.pinned ?? view.preview).sections} />
    </details>
    {view.pinned && <details className="rounded-lg border border-hairline p-3"><summary className="cursor-pointer">Preview for a new conversation</summary><ContextSections sections={view.preview.sections} /></details>}
  </div>;
}
