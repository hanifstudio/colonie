// The served web UI's view of its own authentication. On the owner's machine
// the server trusts loopback and none of this is visible.

export interface EnvironmentDescriptor {
  environmentId: string;
  label: string;
  platform: string;
  version: string;
  capabilities: { remoteSessions: true; selfUpdate: "desktop-managed" | "operator"; emailSignIn?: boolean; sharedComputers?: true };
}

export type SessionState =
  // `service`: a shared server that does not treat this machine as its owner
  | { kind: "loopback"; trust?: "service" }
  | { kind: "session"; id: string; label: string; scopes: string[]; expiresAt: number }
  | { kind: "unauthenticated"; error: string }
  | { kind: "unreachable"; error: string };

/** Ask the server who we are. A 401/403 comes back unauthenticated; a
 * network failure is reported separately. */
export async function readSessionState(fetchImpl: typeof fetch = fetch): Promise<SessionState> {
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/session", { credentials: "same-origin" });
  } catch (error) {
    return { kind: "unreachable", error: error instanceof Error ? error.message : String(error) };
  }
  const body: unknown = await res.json().catch(() => ({}));
  const record = Object(body) as Record<string, unknown>; // SAFETY: read with typeof checks below; never trusted as a shape
  if (res.status === 401 || res.status === 403) {
    return { kind: "unauthenticated", error: typeof record.error === "string" ? record.error : `${res.status}` };
  }
  if (!res.ok) return { kind: "unreachable", error: `${res.status} ${res.statusText}` };
  if (record.kind === "session" && typeof record.id === "string") {
    return {
      kind: "session",
      id: record.id,
      label: typeof record.label === "string" ? record.label : "",
      scopes: Array.isArray(record.scopes) ? record.scopes.filter((s): s is string => typeof s === "string") : [],
      expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : 0,
    };
  }
  return record.trust === "service" ? { kind: "loopback", trust: "service" } : { kind: "loopback" };
}

/** A connection that can use the app: a session, or the owner on this machine. */
export function isConnected(state: SessionState | null): boolean {
  return state?.kind === "session" || (state?.kind === "loopback" && state.trust !== "service");
}

/** The owner on this machine or an admin session: who may manage the server. */
export function isOwnerOrAdmin(state: SessionState | null): boolean {
  if (!state) return false;
  return state.kind === "loopback" ? state.trust !== "service" : state.kind === "session" && state.scopes.includes("admin");
}

