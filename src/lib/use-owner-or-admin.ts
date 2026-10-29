// Whether this browser may manage the workspace: the owner on this machine
// or an admin session (lib/session.ts isOwnerOrAdmin). Settings screens that
// only an admin can use — Activity, a bot's visibility — ask once per page
// load; null while the answer is on its way.
import { useEffect, useState } from "react";

import { isOwnerOrAdmin, readSessionState } from "./session";

let pending: Promise<boolean> | null = null;

function ownerOrAdmin(): Promise<boolean> {
  pending ??= readSessionState().then(isOwnerOrAdmin, () => false);
  return pending;
}

export function useOwnerOrAdmin(enabled = true): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void ownerOrAdmin().then((value) => {
      if (alive) setAllowed(value);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return enabled ? allowed : false;
}

let pendingSession: Promise<boolean> | null = null;

/** Whether this is a signed-in admin's session, as on a Shared workspace,
 * where an admin sets Full access from the app (the server checks again). */
export function useAdminSession(): boolean {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    let alive = true;
    pendingSession ??= readSessionState().then((state) => state.kind === "session" && state.scopes.includes("admin"), () => false);
    void pendingSession.then((value) => { if (alive) setAdmin(value); });
    return () => { alive = false; };
  }, []);
  return admin;
}
