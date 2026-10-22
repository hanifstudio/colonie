// A Shared workspace's admins see in the sidebar when a newer Colonie is
// published for its server, and update with one click. The server asks its
// host to pull and restart (server/colonie/deploy/server-update.ts); the page
// waits for the new version to answer, then reloads. Others see nothing
// (the route is admins' only).
import { useEffect, useState } from "react";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";

export interface ServerUpdateStatus { supported: boolean; current: string; latest: string | null; available: boolean; requested: string | null }

export function ServerUpdateNoticeView({ status, updating, error, onUpdate }: { status: ServerUpdateStatus | null; updating: boolean; error: string; onUpdate: () => void }) {
  if (!status?.available && !updating) return null;
  return (
    <div role="status" className="mx-2 mb-2 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2.5 text-[12.5px]">
      {updating ? (
        <p className="flex items-center gap-2 text-ink"><HIcon icon={Loading02Icon} size={13} className="animate-spin" />Updating. The workspace restarts in about a minute.</p>
      ) : (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-ink">Colonie {status!.latest} is available for this workspace.</p>
          <button type="button" onClick={onUpdate} className="shrink-0 rounded-lg bg-accent px-2.5 py-1 text-[12px] font-semibold text-white hover:brightness-110">Update</button>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-danger">{error}</p>}
    </div>
  );
}

export function ServerUpdateNotice() {
  const [status, setStatus] = useState<ServerUpdateStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void fetch("/api/server-update", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null)).then((body) => { if (alive) setStatus(body); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const update = async () => {
    setError("");
    const res = await fetch("/api/server-update", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: status?.latest }) }).catch(() => null);
    if (!res?.ok) { setError(((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? "The update could not start."); return; }
    setUpdating(true);
    // The new version answers with its own number; then the page loads it.
    const wanted = status?.latest;
    const timer = setInterval(() => {
      void fetch("/.well-known/colonie/environment").then((answer) => (answer.ok ? answer.json() : null))
        .then((environment: { version?: string } | null) => { if (environment?.version === wanted) { clearInterval(timer); location.reload(); } })
        .catch(() => {});
    }, 5_000);
  };
  return <ServerUpdateNoticeView status={status} updating={updating} error={error} onUpdate={() => void update()} />;
}
