// Joining a Shared workspace from the desktop app. The person pastes the
// invite link someone sent them (or the workspace's address); the app asks to
// confirm, saves the workspace, and opens it, where they sign in with their
// Colonie account. Opened from the profile menu and from the native
// workspace menu's "Join a Shared workspace…".
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loading02Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";

export const OPEN_JOIN_SHARED = "colonie:join-shared";

/** Electron wraps a refusal as "Error invoking remote method '…': Error: <reason>". */
const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^.*Error: /, "");

export async function joinShared(bridge: { addFromLink: (link: string) => Promise<boolean | void> }, link: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const text = link.trim();
  if (!text) return { ok: false, error: "Paste the invite link first." };
  try {
    return (await bridge.addFromLink(text)) === false ? { ok: false, error: "" } : { ok: true };
  } catch (cause) {
    return { ok: false, error: reason(cause) };
  }
}

export function JoinSharedWorkspaceView({ link, busy, error, onLink, onJoin, onClose }: {
  link: string;
  busy: boolean;
  error: string;
  onLink: (link: string) => void;
  onJoin: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form role="dialog" aria-modal="true" aria-labelledby="join-shared-title"
        onSubmit={(event) => { event.preventDefault(); onJoin(); }}
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        className="animate-pop-in w-full max-w-[460px] rounded-[20px] border border-hairline/50 bg-panel p-6 shadow-2xl shadow-black/50">
        <div className="flex items-center gap-2">
          <HIcon icon={UserGroupIcon} size={18} className="text-accent" />
          <h2 id="join-shared-title" className="text-[17px] font-semibold text-ink">Join a Shared workspace</h2>
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
          Paste the invite link someone sent you. You sign in with your Colonie account, or create one, and the
          workspace opens here. Your workspaces on this computer stay as they are.
        </p>
        <input autoFocus value={link} disabled={busy} onChange={(event) => onLink(event.target.value)}
          aria-label="Invite link" placeholder="https://…/invite/…"
          className="mt-4 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-tertiary focus:border-accent/60 focus:outline-none" />
        {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg px-3 py-2 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink">Cancel</button>
          <button type="submit" disabled={busy || !link.trim()} className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-60">
            {busy && <HIcon icon={Loading02Icon} size={13} className="animate-spin" />}Join
          </button>
        </div>
      </form>
    </div>
  );
}

/** Mounted once in the app; shows itself when asked. Desktop app only. */
export function JoinSharedWorkspace() {
  const bridge = typeof window !== "undefined" ? window.colonie?.environments : undefined;
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!bridge) return;
    const show = () => { setOpen(true); setError(""); };
    window.addEventListener(OPEN_JOIN_SHARED, show);
    // The native menu's item: no saved server's id means "join one".
    const stop = bridge.onOpenSettings?.((computerId) => { if (!computerId) show(); });
    if (new URLSearchParams(location.search).get("desktop-settings") === "workspaces" && !new URLSearchParams(location.search).has("share-computer")) show();
    return () => { window.removeEventListener(OPEN_JOIN_SHARED, show); stop?.(); };
  }, [bridge]);
  if (!bridge || !open) return null;
  const close = () => { if (!busy) { setOpen(false); setLink(""); setError(""); } };
  const join = async () => {
    setBusy(true);
    setError("");
    const result = await joinShared(bridge, link);
    setBusy(false);
    if (result.ok) { setOpen(false); setLink(""); } else setError(result.error);
  };
  return createPortal(<JoinSharedWorkspaceView link={link} busy={busy} error={error} onLink={(next) => { setLink(next); setError(""); }} onJoin={() => void join()} onClose={close} />, document.body);
}
