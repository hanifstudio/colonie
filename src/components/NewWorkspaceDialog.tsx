// New workspace, from the one workspace list (the top-left menu). Local: a
// name; it is created and opened, and being new it starts with its own
// onboarding. Shared: the Shared workspace onboarding. Also answers the
// menu's "Shared workspace servers…".
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CloudServerIcon, ComputerIcon, Loading02Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { cn } from "@/lib/cn";
import { nameIssueMessage, switchNotice, switchRefusal, workspaceNameIssue } from "@/lib/local-workspaces";
import { OPEN_CREATE_SHARED, OPEN_SHARED_SERVERS } from "./CreateSharedWorkspace";

type Kind = "local" | "shared";
export const OPEN_NEW_WORKSPACE = "colonie:new-workspace";

export function NewWorkspaceView({ kind, name, busy, error, notice, onKind, onName, onCreate, onClose }: {
  kind: Kind; name: string; busy: boolean; error: string; notice: string;
  onKind: (kind: Kind) => void; onName: (name: string) => void; onCreate: () => void; onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form role="dialog" aria-modal="true" aria-labelledby="new-workspace-title" onSubmit={(event) => { event.preventDefault(); onCreate(); }}
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        className="w-full max-w-[460px] rounded-[20px] border border-hairline/50 bg-panel p-6 shadow-2xl shadow-black/50">
        <h2 id="new-workspace-title" className="text-[17px] font-semibold text-ink">New workspace</h2>
        <div role="radiogroup" aria-label="Kind" className="mt-4 grid grid-cols-2 gap-2">
          {([["local", "Local", "On this computer, just you and your bots.", ComputerIcon], ["shared", "Shared", "On a server; people you invite join it.", CloudServerIcon]] as const).map(([value, label, detail, icon]) => (
            <button key={value} type="button" role="radio" aria-checked={kind === value} onClick={() => onKind(value)}
              className={cn("rounded-xl border p-3 text-left", kind === value ? "border-accent/60 bg-accent/10" : "border-hairline/40 hover:bg-raised")}>
              <span className="flex items-center gap-1.5 text-[13.5px] font-medium text-ink"><HIcon icon={icon} size={15} />{label}</span>
              <span className="mt-0.5 block text-[11.5px] text-ink-secondary">{detail}</span>
            </button>
          ))}
        </div>
        {kind === "local" && (
          <>
            <input autoFocus value={name} onChange={(event) => onName(event.target.value)} aria-label="Workspace name" placeholder="Workspace name" disabled={busy}
              className="mt-4 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-tertiary focus:outline-none" />
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
              It opens right away and is set up from the start: its own AI connection, bots and conversations.
            </p>
          </>
        )}
        {notice && <p role="status" className="mt-3 text-[12.5px] text-ink">{notice}</p>}
        {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-[12.5px] text-ink-secondary hover:bg-raised">Cancel</button>
          <button type="submit" disabled={busy || (kind === "local" && !name.trim())} className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50">
            {busy && <HIcon icon={Loading02Icon} size={13} className="animate-spin" />}{kind === "local" ? "Create" : "Continue"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function NewWorkspaceDialog() {
  const bridge = typeof window !== "undefined" ? window.colonie?.localWorkspaces : undefined;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("local");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!bridge) return;
    const show = () => { setOpen(true); setKind("local"); setName(""); setError(""); setNotice(""); };
    const act = (action: "new-workspace" | "shared-servers") => {
      if (action === "shared-servers") window.dispatchEvent(new Event(OPEN_SHARED_SERVERS));
      else show();
    };
    window.addEventListener(OPEN_NEW_WORKSPACE, show);
    const stop = window.colonie?.environments?.onAction?.(act);
    // the menu sent this page here with what to open
    const asked = new URLSearchParams(location.search).get("desktop-action");
    if (asked === "new-workspace" || asked === "shared-servers") act(asked);
    return () => { window.removeEventListener(OPEN_NEW_WORKSPACE, show); stop?.(); };
  }, [bridge]);
  if (!bridge || !open) return null;
  const create = async () => {
    if (kind === "shared") {
      setOpen(false);
      window.dispatchEvent(new Event(OPEN_CREATE_SHARED));
      return;
    }
    const state = await bridge.list();
    const issue = workspaceNameIssue(name, state.nameMax);
    if (issue) { setError(nameIssueMessage(issue, state.nameMax)); return; }
    setBusy(true); setError("");
    try {
      const created = await bridge.create(name.trim());
      if (!created.ok) { setError(created.message); return; }
      const result = await bridge.switch(created.workspace.id);
      if (!result.ok) { setError(switchRefusal(result.code, result.message)); return; }
      setNotice(switchNotice(result.mode, created.workspace.name));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  return createPortal(
    <NewWorkspaceView kind={kind} name={name} busy={busy} error={error} notice={notice}
      onKind={setKind} onName={(next) => { setName(next); setError(""); }} onCreate={() => void create()} onClose={() => { if (!busy) setOpen(false); }} />,
    document.body,
  );
}
