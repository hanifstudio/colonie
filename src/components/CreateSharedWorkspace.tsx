// Creating a Shared workspace from the desktop app. It runs on a server in
// the owner's own DigitalOcean account: they connect DigitalOcean in their
// browser, see the monthly price DigitalOcean lists, and create it. The app
// then shows the server's progress until it answers, and opens it with the
// owner's invite, so they sign in as its first admin. Opened from the
// new-workspace form's Shared choice.
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CloudServerIcon, Copy01Icon, Loading02Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { api } from "@/state/store";
import { useCopyFeedback } from "@/lib/copy-text";
import { cn } from "@/lib/cn";

export const OPEN_CREATE_SHARED = "colonie:create-shared";

const REGIONS: Record<string, string> = { sgp1: "Singapore" };
const SIZES: Record<string, string> = { "s-2vcpu-4gb": "2 CPUs, 4 GB memory" };

export interface SharedServer {
  id: string; name: string; tag: string; region: string; size: string;
  kind?: "digitalocean" | "self"; command?: string;
  state: "creating" | "starting" | "ready" | "failed";
  createdAt: string; address?: string; inviteUrl?: string; opened?: boolean; error?: string;
}
export interface SharedServersState {
  digitalOcean: {
    connected: boolean; region: string; size: string; error?: string;
    account?: { email: string; dropletLimit: number; active: boolean };
    price?: { monthlyUsd: number; hourlyUsd: number };
  };
  servers: SharedServer[];
}

/** The first open signs the owner in with their invite; later ones open the address. */
export async function openShared(
  bridge: { addFromLink: (link: string, name?: string) => Promise<boolean | void> },
  markOpened: (id: string) => Promise<void>,
  server: SharedServer,
): Promise<boolean> {
  const link = !server.opened && server.inviteUrl ? server.inviteUrl : server.address;
  if (!link) return false;
  const joined = (await bridge.addFromLink(link, server.name)) !== false;
  if (joined && !server.opened) await markOpened(server.id);
  return joined;
}

export type SetupMode = "digitalocean" | "self";

/** The one line to paste into the owner's own server, with a Copy button. */
function PasteCommand({ command }: { command: string }) {
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

export function CreateSharedWorkspaceView({ state, name, busy, error, waitingForBrowser, mode, address, onMode, onAddress, onCreateSelf, onName, onConnect, onCreate, onOpen, onDelete, onClose }: {
  state: SharedServersState | null;
  mode: SetupMode;
  address: string;
  onMode: (mode: SetupMode) => void;
  onAddress: (address: string) => void;
  onCreateSelf: () => void;
  name: string;
  /** "connect", "create", or a server id being opened or deleted */
  busy: string;
  error: string;
  waitingForBrowser: boolean;
  onName: (name: string) => void;
  onConnect: () => void;
  onCreate: () => void;
  onOpen: (server: SharedServer) => void;
  onDelete: (server: SharedServer) => void;
  onClose: () => void;
}) {
  const ocean = state?.digitalOcean;
  const button = "flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-60";
  const quiet = "rounded-lg px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="create-shared-title"
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        className="animate-pop-in flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-[520px] flex-col overflow-y-auto rounded-[20px] border border-hairline/50 bg-panel p-6 shadow-2xl shadow-black/50">
        <div className="flex items-center gap-2">
          <HIcon icon={CloudServerIcon} size={18} className="text-accent" />
          <h2 id="create-shared-title" className="text-[17px] font-semibold text-ink">Create a Shared workspace</h2>
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
          A Shared workspace runs on a server you own, so the people you invite can use it with you and your bots.
          The bots use the AI subscriptions you sign in to on that server.
        </p>
        <div role="radiogroup" aria-label="Where it runs" className="mt-4 grid grid-cols-2 gap-2">
          {([["digitalocean", "One click on DigitalOcean", "A new server in your DigitalOcean account."], ["self", "My own server", "A server you already have, with Ubuntu."]] as const).map(([value, label, detail]) => (
            <button key={value} type="button" role="radio" aria-checked={mode === value} onClick={() => onMode(value)}
              className={cn("rounded-xl border p-3 text-left", mode === value ? "border-accent/70 bg-accent/10" : "border-hairline/40 hover:bg-control")}>
              <div className="text-[13px] font-medium text-ink">{label}</div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-ink-secondary">{detail}</div>
            </button>
          ))}
        </div>

        {!state && <p className="mt-4 flex items-center gap-2 text-[12.5px] text-ink-secondary"><HIcon icon={Loading02Icon} size={13} className="animate-spin" />Checking…</p>}

        {mode === "self" && (
          <div className="mt-4 rounded-xl border border-hairline/40 bg-inset p-4 text-[12.5px]">
            <p className="leading-relaxed text-ink-secondary">
              Your server needs Ubuntu 22.04 or 24.04, at least 2 CPUs and 4 GB of memory, ports 80 and 443 open, and
              about 10 GB free. Enter its public IP address or domain name that points to it.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <input value={name} onChange={(event) => onName(event.target.value)} maxLength={60} aria-label="Workspace name" placeholder="Workspace name"
                className="rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink placeholder:text-ink-tertiary focus:border-accent/60 focus:outline-none" />
              <input value={address} onChange={(event) => onAddress(event.target.value)} aria-label="Server IP address or domain" placeholder="203.0.113.9 or team.example.com"
                className="rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink placeholder:text-ink-tertiary focus:border-accent/60 focus:outline-none" />
              <button type="button" className={cn(button, "self-end")} disabled={busy !== "" || !name.trim() || !address.trim()} onClick={onCreateSelf}>
                {busy === "create" && <HIcon icon={Loading02Icon} size={13} className="animate-spin" />}Get the command
              </button>
            </div>
          </div>
        )}

        {mode === "digitalocean" && ocean && !ocean.connected && (
          <div className="mt-4">
            <button type="button" className={button} disabled={busy === "connect"} onClick={onConnect}>
              {busy === "connect" && <HIcon icon={Loading02Icon} size={13} className="animate-spin" />}Connect DigitalOcean
            </button>
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
              {waitingForBrowser
                ? "Finish connecting in your browser. This window updates when you are done."
                : "Your browser opens DigitalOcean, where you sign in or create an account and allow Colonie to create and delete its own servers."}
            </p>
          </div>
        )}

        {mode === "digitalocean" && ocean?.connected && (
          <div className="mt-4 rounded-xl border border-hairline/40 bg-inset p-4 text-[12.5px]">
            {ocean.account && <p className="text-ink-secondary">DigitalOcean: <span className="text-ink">{ocean.account.email}</span></p>}
            <p className="mt-1 text-ink">
              {REGIONS[ocean.region] ?? ocean.region} · {SIZES[ocean.size] ?? ocean.size}
              {ocean.price && <> · <strong>${ocean.price.monthlyUsd} a month</strong></>}
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
              Billed by DigitalOcean until you delete it, also while it is switched off.
            </p>
            {ocean.error && <p className="mt-2 text-[12px] text-danger">{ocean.error}</p>}
            <div className="mt-3 flex items-center gap-2">
              <input value={name} onChange={(event) => onName(event.target.value)} maxLength={60} aria-label="Workspace name" placeholder="Workspace name"
                className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink placeholder:text-ink-tertiary focus:border-accent/60 focus:outline-none" />
              <button type="button" className={button} disabled={busy !== "" || !name.trim()} onClick={onCreate}>
                {busy === "create" && <HIcon icon={Loading02Icon} size={13} className="animate-spin" />}Create workspace
              </button>
            </div>
          </div>
        )}

        {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}

        {state && state.servers.length > 0 && (
          <div className="mt-5">
            <h3 className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">Your Shared workspaces</h3>
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

        <div className="mt-5 flex justify-end">
          <button type="button" className={quiet} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/** Mounted once in the app; shows itself when asked. Desktop owner only. */
export function CreateSharedWorkspace() {
  const bridge = typeof window !== "undefined" ? window.colonie?.environments : undefined;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SharedServersState | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [waitingForBrowser, setWaitingForBrowser] = useState(false);
  const [mode, setMode] = useState<SetupMode>("digitalocean");
  const [address, setAddress] = useState("");

  const load = useCallback(async () => {
    try {
      setState(await api<SharedServersState>("/api/shared-servers"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (!bridge) return;
    const show = (event: Event) => {
      setOpen(true);
      setError("");
      const suggested = (event as CustomEvent<{ name?: string }>).detail?.name;
      if (suggested) setName(suggested);
    };
    window.addEventListener(OPEN_CREATE_SHARED, show);
    return () => window.removeEventListener(OPEN_CREATE_SHARED, show);
  }, [bridge]);

  // While open: refresh now, then every few seconds while something is in progress.
  const inProgress = waitingForBrowser || Boolean(state?.servers.some((server) => server.state === "creating" || server.state === "starting"));
  useEffect(() => {
    if (!open) return;
    void load();
    if (!inProgress) return;
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [open, inProgress, load]);
  useEffect(() => { if (state?.digitalOcean.connected) setWaitingForBrowser(false); }, [state?.digitalOcean.connected]);

  if (!bridge || !open) return null;
  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };
  const connect = () => run("connect", async () => {
    const { authorizationUrl } = await api<{ authorizationUrl: string }>("/api/shared-servers/digitalocean/connect", { method: "POST" });
    // The window hands web links to the system browser.
    window.open(authorizationUrl, "_blank", "noopener");
    setWaitingForBrowser(true);
  });
  const create = () => run("create", async () => {
    await api("/api/shared-servers", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
    setName("");
    await load();
  });
  const createSelf = () => run("create", async () => {
    await api("/api/shared-servers/self", { method: "POST", body: JSON.stringify({ name: name.trim(), address: address.trim() }) });
    setName("");
    setAddress("");
    await load();
  });
  const openServer = (server: SharedServer) => run(server.id, async () => {
    const markOpened = async (id: string) => { await api(`/api/shared-servers/${id}/opened`, { method: "POST" }); };
    if (await openShared(bridge, markOpened, server)) setOpen(false);
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
    <CreateSharedWorkspaceView state={state} name={name} busy={busy} error={error} waitingForBrowser={waitingForBrowser}
      mode={mode} address={address} onMode={setMode} onAddress={setAddress} onCreateSelf={() => void createSelf()}
      onName={setName} onConnect={() => void connect()} onCreate={() => void create()}
      onOpen={(server) => void openServer(server)} onDelete={(server) => void remove(server)}
      onClose={() => { if (!busy) setOpen(false); }} />,
    document.body,
  );
}
