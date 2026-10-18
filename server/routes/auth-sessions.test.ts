import { expect, test } from "vitest";
import { clearSessionCookie } from "../request-auth.ts";
import { callRoute } from "../testing/route-context.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { createAuthSessionRoutes, type AuthSessionRouteDeps } from "./auth-sessions.ts";

const COOKIE = "colonie_session_45999_testenv";

const store = () => {
  const revoked: string[] = [];
  const deps: AuthSessionRouteDeps = {
    sessions: {
      list: () => [{ id: "s1" }, { id: "s2" }],
      revoke: (id) => {
        revoked.push(id);
        return id !== "gone";
      },
    },
    cookieName: COOKIE,
  };
  return { deps, revoked };
};

/** Drive the module with a chosen identity and watch for a cookie to clear. */
const drive = async (handler: RouteHandler, path: string, method = "GET", auth: unknown = { scopes: [] }) => {
  const { ctx, sent } = callRoute(path, method);
  const cookies: string[] = [];
  (ctx as { auth: unknown }).auth = auth;
  (ctx.res as { setHeader: (key: string, value: string) => void }).setHeader = (key, value) => {
    if (key === "set-cookie") cookies.push(value);
  };
  return { out: await handler(ctx), sent, cookies };
};

test("only the plural path belongs to this module", async () => {
  const { deps } = store();
  const handler = createAuthSessionRoutes(deps);
  // /api/auth/session (one device's ticket) is a different block and must not be claimed
  const singular = await drive(handler, "/api/auth/session");
  const elsewhere = await drive(handler, "/api/health");

  expect(singular.out).toBe(PASS);
  expect(elsewhere.out).toBe(PASS);
  expect(singular.sent).toEqual([]);
});

test("the list names this device only when this device is a session", async () => {
  const { deps } = store();
  const handler = createAuthSessionRoutes(deps);
  const asSession = await drive(handler, "/api/auth/sessions", "GET", { kind: "session", session: { id: "s2" } });
  const asOther = await drive(handler, "/api/auth/sessions", "GET", { kind: "admin", scopes: [] });

  expect(asSession.sent[0]?.status).toBe(200);
  expect(asSession.sent[0]?.body).toEqual({ sessions: [{ id: "s1" }, { id: "s2" }], current: "s2" });
  expect(asOther.sent[0]?.body).toEqual({ sessions: [{ id: "s1" }, { id: "s2" }], current: null });
});

test("revoking your own device clears the cookie that named it", async () => {
  const { deps, revoked } = store();
  const { sent, cookies } = await drive(
    createAuthSessionRoutes(deps),
    "/api/auth/sessions/s2",
    "DELETE",
    { kind: "session", session: { id: "s2" } },
  );

  expect(revoked).toEqual(["s2"]);
  expect(sent).toEqual([{ status: 200, body: { ok: true } }]);
  expect(cookies).toEqual([clearSessionCookie(COOKIE)]);
});

test("revoking another device, or from a non-session caller, leaves the cookie alone", async () => {
  const { deps } = store();
  const handler = createAuthSessionRoutes(deps);
  const other = await drive(handler, "/api/auth/sessions/s1", "DELETE", { kind: "session", session: { id: "s2" } });
  const admin = await drive(handler, "/api/auth/sessions/s2", "DELETE", { kind: "admin", scopes: [] });

  expect(other.sent[0]?.status).toBe(200);
  expect(admin.sent[0]?.status).toBe(200);
  expect(other.cookies).toEqual([]);
  expect(admin.cookies).toEqual([]);
});

test("an unknown device answers 404", async () => {
  const { deps } = store();
  const { sent } = await drive(createAuthSessionRoutes(deps), "/api/auth/sessions/gone", "DELETE");

  expect(sent).toEqual([{ status: 404, body: { error: "no such session" } }]);
});