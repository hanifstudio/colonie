// What this server says about itself: the packaged app's identity handshake,
// the edition it runs (and why), and this deployment's brand.
import { editionForMembers, editionStatus } from "../enterprise.ts";
import { loadBrand } from "../brand.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ServerInfoRouteDeps {
  /** `COLONIE_STATIC_DIR`, or null when the server serves no client build. */
  staticDir: string | null;
  sharedWorkspaceFullAccessEnabled: () => boolean;
}

export function createServerInfoRoutes(deps: ServerInfoRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    // identity handshake for the packaged app's port fallback: the forked
    // child proves it is OURS by echoing its pid (a stray dev server has
    // the same API shape but a different pid)
    if (method === "GET" && path === "/api/health") {
      return json(res, 200, { app: "colonie", pid: process.pid, static: Boolean(deps.staticDir), capabilities: {
        guardedMessages: 1, guardedRequests: 1, guardedFullAccess: 1, guardedOnBehalfOf: 1,
        ...(deps.sharedWorkspaceFullAccessEnabled() ? { sharedWorkspaceFullAccess: 1 } : {}),
      } });
    }
    // ── the fleet: client workspaces on this server, through the root agent ──
    // Which edition this server runs and why (see server/enterprise.ts). Read-only.
    if (method === "GET" && path === "/api/edition") {
      // A member learns what is entitled; when the key lapses is for admins.
      const status = editionStatus();
      return json(res, 200, auth.scopes.includes("admin") ? status : editionForMembers(status));
    }
    // The brand for this deployment (server/brand.ts): read per request so edits show on reload.
    if (method === "GET" && path === "/api/brand") {
      return json(res, 200, loadBrand());
    }
    return PASS;
  };
}