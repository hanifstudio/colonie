// Who is signed in, and signing one of those devices out.
//
// Revoking your own device also clears the cookie that named it: the session is
// gone from the registry, so the browser must stop presenting the token that
// pointed at it. Revoking another device leaves this browser's cookie alone.
import { clearSessionCookie } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface AuthSessionRouteDeps {
  sessions: {
    list: () => unknown[];
    revoke: (id: string) => boolean;
  };
  cookieName: string;
}

export function createAuthSessionRoutes(deps: AuthSessionRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    if (!path.startsWith("/api/auth/sessions")) return PASS;

    if (method === "GET" && path === "/api/auth/sessions") {
      return json(res, 200, { sessions: deps.sessions.list(), current: auth.kind === "session" ? auth.session.id : null });
    }
    const match = path.match(/^\/api\/auth\/sessions\/([\w-]+)$/);
    if (match && method === "DELETE") {
      const revoked = deps.sessions.revoke(match[1]);
      if (auth.kind === "session" && auth.session.id === match[1]) res.setHeader("set-cookie", clearSessionCookie(deps.cookieName));
      return json(res, revoked ? 200 : 404, revoked ? { ok: true } : { error: "no such session" });
    }
    return PASS;
  };
}