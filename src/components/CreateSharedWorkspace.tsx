// The owner's Shared workspace servers, from the menu: each with where it is
// and how it is doing, Open, and Delete (a droplet made here) or Forget (the
// owner's own server, left running). Making one is the Shared workspace
// onboarding (onboarding/SharedOnboarding.tsx); this list only looks after
// them. Desktop owner only.
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CloudServerIcon, Copy01Icon, Loading02Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { api } from "@/state/store";
import { useCopyFeedback } from "@/lib/copy-text";
import { cn } from "@/lib/cn";
import { loadSharedServers, markSharedOpened, openShared, type SharedServer, type SharedServersState } from "@/lib/shared-servers";

export { openShared, type SharedServer, type SharedServersState };

/** Opens the Shared workspace onboarding (onboarding/SharedOnboarding.tsx). */
export const OPEN_CREATE_SHARED = "colonie:create-shared";
/** Opens this list of the owner's Shared workspace servers. */
export const OPEN_SHARED_SERVERS = "colonie:shared-servers";

/** The one line to paste into the owner's own server, with a Copy button. */
export function PasteCommand({ command }: { command: string }) {
  const { state, copy } = useCopyFeedback(command);
  return (
    <div className="mt-2 rounded-lg border border-hairline/40 bg-inset p-2.5">
      <p className="mb-1.5 text-[11.5px] text-ink-secondary">Paste this into your server, signed in over SSH:</p>
      <div className="flex items-start gap-2">
        <code className="max-h-16 min-w-0 flex-1 overflow-hidden break-all font-mono text-[10.5px] leading-snug text-ink select-all">{command}</code>
        <button type="button" onClick={copy} className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">
          <HIcon icon={state === "copied" ? Tick01Icon : Copy01Icon} size={13} className={cn(state === "copied" && "text-success")} />
          {state === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

const PROGRESS: Record<SharedServer["state"], string> = {
  creating: "Creating the server on DigitalOcean…",
  starting: "Starting Colonie on the server. The first start takes a few minutes.",
  ready: "Ready.",
  failed: "",
};

export function SharedServersView({ state, busy, error, onOpen, onDelete, onNew, onClose }: {
  state: SharedServersState | null;
  /** a server id being opened or deleted */
  busy: string;
  error: string;
  onOpen: (server: SharedServer) => void;
  onDelete: (server: SharedServer) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const button = "flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-60";
  const quiet = "rounded-lg px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="shared-servers-title"
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        className="animate-pop-in flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-[520px] flex-col overflow-y-auto rounded-[20px] border border-hairline/50 bg-panel p-6 shadow-2xl shadow-black/50">
        <div className="flex items-center gap-2">
          <HIcon icon={CloudServerIcon} size={18} className="text-accent" />
          <h2 id="shared-servers-title" className="text-[17px] font-semibold text-ink">Shared workspace servers</h2>
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
          The servers your Shared workspaces run on. A server on DigitalOcean is billed until you delete it; your own
          server keeps running until you stop it.
        </p>
        {!state && <p className="mt-4 flex items-center gap-2 text-[12.5px] text-ink-secondary"><HIcon icon={Loading02Icon} size={13} className="animate-spin" />Checking…</p>}
        {state && state.servers.length === 0 && (
          <p className="mt-4 text-[13px] text-ink-secondary">None yet. Make one with New workspace → Shared.</p>
        )}
        {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
        {state && state.servers.length > 0 && (
          <div className="mt-4">
            {state.servers.map((server) => (
              <div key={server.id} className="flex items-center gap-3 border-b border-hairline/20 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ink">{server.name}</div>
                  <div className={server.state === "failed" ? "text-[11.5px] text-danger" : "text-[11.5px] text-ink-secondary"}>
                    {server.state === "failed" ? server.error
                      : server.state === "ready" ? server.address?.replace(/^https:\/\//, "")
                      : server.kind === "self" ? `Waiting for ${server.address?.replace(/^https:\/\//, "")} to answer. This opens when it does.`
                      : PROGRESS[server.state]}
                  </div>
                  {server.kind === "self" && server.state === "starting" && server.command && <PasteCommand command={server.command} />}
                </div>
                {(server.state === "creating" || server.state === "starting") && <HIcon icon={Loading02Icon} size={14} className="shrink-0 animate-spin text-ink-secondary" />}
                {server.state === "ready" && <button type="button" className={button} disabled={busy !== ""} onClick={() => onOpen(server)}>Open</button>}
                <button type="button" className={quiet} disabled={busy !== ""} onClick={() => onDelete(server)}>{server.kind === "self" ? "Forget" : "Delete"}</button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-5 flex justify-between">
          <button type="button" className={quiet} onClick={onNew}>New Shared workspace…</button>
          <button type="button" className={quiet} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export function SharedServersDialog() {
  const bridge = typeof window !== "undefined" ? window.colonie?.environments : undefined;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SharedServersState | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setState(await loadSharedServers()); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => {
    if (!bridge) return;
    const show = () => { setOpen(true); setError(""); };
    window.addEventListener(OPEN_SHARED_SERVERS, show);
    return () => window.removeEventListener(OPEN_SHARED_SERVERS, show);
  }, [bridge]);
  const inProgress = Boolean(state?.servers.some((server) => server.state === "creating" || server.state === "starting"));
  useEffect(() => {
    if (!open) return;
    void load();
    if (!inProgress) return;
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [open, inProgress, load]);
  if (!bridge || !open) return null;
  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label); setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(""); }
  };
  const openServer = (server: SharedServer) => run(server.id, async () => {
    if (await openShared(bridge, markSharedOpened, server)) setOpen(false);
  });
  const remove = (server: SharedServer) => run(server.id, async () => {
    const sure = await (window.colonie?.confirm ?? (async (message: string) => window.confirm(message)))(server.kind === "self"
      ? `Forget “${server.name}”? It is removed from this list only; your server keeps running until you stop it.`
      : `Delete “${server.name}”? Its server and everything on it are deleted from DigitalOcean, and billing stops. This cannot be undone.`,
    );
    if (!sure) return;
    await api(`/api/shared-servers/${server.id}`, { method: "DELETE" });
    await load();
  });
  return createPortal(
    <SharedServersView state={state} busy={busy} error={error}
      onOpen={(server) => void openServer(server)} onDelete={(server) => void remove(server)}
      onNew={() => { setOpen(false); window.dispatchEvent(new Event(OPEN_CREATE_SHARED)); }}
      onClose={() => { if (!busy) setOpen(false); }} />,
    document.body,
  );
}
