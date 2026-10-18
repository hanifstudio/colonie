// Custom MCP servers: the list, add, paste-to-add import, edit, delete, the
// connection test, and the sign-in flow for servers reached by URL.
//
// Secrets stay write-only: `mcpServerResponse()` never echoes a stored header
// or token back, and the sign-in flow belongs to one owner (a session, or the
// loopback) and one address. Both mutations are serialized behind one busy
// flag, and the connection test behind a small concurrency limit, so a slow
// probe cannot pile up.
import { hostedWorkspaceConfiguration } from "../enterprise.ts";
import { isLoopbackHost, isProxied, provesSameOrigin, requestOrigin } from "../request-auth.ts";
import {
  MAX_MCP_SERVERS,
  isRemoteMcpServer,
  listMcpServers,
  parseMcpServerMutation,
  parseMcpServersImport,
  parseStoredMcpServer,
} from "../mcp-registry.ts";
import {
  McpOAuthError,
  McpSignInError,
  mcpCallbackOrigin,
  mcpOAuthRedirectUri,
  withMcpSignIn,
  type McpOAuthManager,
} from "../mcp-oauth.ts";
import { probeMcpServer } from "../mcp-probe.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { AppConfig } from "../config.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Two probes at once is already more than a person can read. */
const MAX_CONCURRENT_MCP_PROBES = 2;
let mcpProbesInFlight = 0;

export interface McpServerRouteDeps {
  cfg: AppConfig;
  mcpOAuth: McpOAuthManager;
  sessions: SessionRegistry;
  /** One busy flag, owned by index.ts: these routes and the legacy internal
   * peer route must never edit the same config section at once. */
  mcpConfigLock: { acquire: () => boolean; release: () => void };
  /** Writes the `mcpServers` section through the same path every other
   * config write takes; index.ts owns it so config reload stays in one place. */
  persistMcpServers: (next: Record<string, unknown>) => void;
  savedCustomDomain: () => string | null;
  fallbackPublicUrl: string | null;
}

/** The fields a new server may set, in whichever shape the form sent — a
 * command to run or a URL to reach. Absent keys stay absent, so the strict
 * schema of one shape never sees the other shape's `undefined`s. */
function mcpServerBody(body: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!body || typeof body !== "object") return out;
  const record = body as Record<string, unknown>;
  for (const key of ["command", "args", "env", "type", "url", "headers", "oauth", "enabled"]) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

export function createMcpServerRoutes(deps: McpServerRouteDeps): RouteHandler {
  const { cfg, mcpOAuth } = deps;

  function mcpServerResponse() {
    const servers = listMcpServers(cfg.mcpServers).map((server) => {
      if (!("url" in server)) return server;
      const auth = mcpOAuth.authState(server.name, server.url);
      // the redirect URI to register with a pre-registered sign-in app
      const listed = server.oauth ? { ...server, oauth: { ...server.oauth, redirectUri: mcpOAuthRedirectUri(server.url) } } : server;
      return auth === "none" ? listed : { ...listed, auth };
    });
    return { servers };
  }

  return async ({ req, res, path, method, auth, json, readBody }) => {
    const { persistMcpServers } = deps;
    if (method === "GET" && path === "/api/mcp/servers") {
      return json(res, 200, mcpServerResponse());
    }

    const mcpTest = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})\/test$/.exec(path);
    if (method === "POST" && mcpTest) {
      const raw = cfg.mcpServers?.[mcpTest[1]];
      if (raw === undefined) return json(res, 404, { error: "MCP server not found." });
      const parsed = parseStoredMcpServer(mcpTest[1], raw);
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      if (mcpProbesInFlight >= MAX_CONCURRENT_MCP_PROBES) {
        return json(res, 429, { error: "Two MCP connection tests are already running." });
      }
      const controller = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", disconnect);
      mcpProbesInFlight += 1;
      try {
        const name = mcpTest[1];
        let target = parsed.server;
        if (isRemoteMcpServer(target) && mcpOAuth.authState(name, target.url) === "signed-in") {
          const signedIn = (await withMcpSignIn({ [name]: target }, mcpOAuth))[name];
          if (signedIn) target = { ...signedIn, enabled: target.enabled } as typeof target;
        }
        const result = await probeMcpServer(target, undefined, controller.signal);
        if (!result.ok && result.auth === "required" && isRemoteMcpServer(target)) mcpOAuth.markNeedsSignIn(name, target.url);
        return json(res, 200, result);
      } finally {
        res.off("close", disconnect);
        mcpProbesInFlight -= 1;
      }
    }

    // The loopback listener, the public callback and authenticated paste-back complete the same flow.
    const mcpSignIn = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})\/(sign-in|sign-out)(?:\/([0-9a-f-]{36}))?$/.exec(path);
    if (mcpSignIn) {
      const [, name, action, flowId] = mcpSignIn;
      const raw = cfg.mcpServers?.[name!];
      const parsed = raw === undefined ? null : parseStoredMcpServer(name!, raw);
      if (!parsed?.ok) return json(res, 404, { error: "MCP server not found." });
      if (!isRemoteMcpServer(parsed.server)) return json(res, 400, { error: "Only servers reached by URL can be signed in to." });
      const url = parsed.server.url;
      if (action === "sign-out" && method === "POST" && !flowId) {
        await mcpOAuth.signOut(name!, url);
        return json(res, 200, mcpServerResponse());
      }
      const owner = auth.kind === "session" ? auth.session.id : "loopback";
      res.setHeader("Cache-Control", "no-store");
      try {
        if (action === "sign-in" && method === "GET" && flowId) {
          const status = mcpOAuth.status(name!, flowId, owner);
          return status ? json(res, 200, { auth: status }) : json(res, 404, { error: "This sign-in is no longer available in this browser. Start again." });
        }
        if (action === "sign-in" && method === "DELETE") {
          mcpOAuth.cancelFlow(name!, owner, flowId);
          return json(res, 200, { ok: true });
        }
        if (action === "sign-in" && method === "POST" && flowId) {
          if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
            return json(res, 415, { error: "content-type must be application/json" });
          }
          const body = await readBody(req, 20_480);
          if (typeof body?.callbackUrl !== "string") return json(res, 400, { error: "A complete callbackUrl is required." });
          return json(res, 200, { auth: await mcpOAuth.completeCallback(name!, flowId, body.callbackUrl, owner) });
        }
        if (action === "sign-in" && method === "POST" && !flowId) {
          // A browser on another computer cannot reach this machine's
          // loopback: it comes back to the https address it is using now,
          // when that is one this server vouches for (mcpCallbackOrigin).
          const remote = auth.kind === "session" && (isProxied(req) || !isLoopbackHost(req.headers.host));
          const origin = remote
            ? mcpCallbackOrigin(provesSameOrigin(req) ? requestOrigin(req) : null,
              [hostedWorkspaceConfiguration()?.tenant.origin, deps.savedCustomDomain(), deps.fallbackPublicUrl])
            : null;
          const started = await mcpOAuth.start(name!, url, undefined, owner, { remote, origin });
          if (auth.kind === "session" && !deps.sessions.isLive(auth.session.id)) {
            mcpOAuth.revokeOwner(owner);
            return json(res, 401, { error: "Your session ended. Start a new sign-in." });
          }
          return json(res, 200, { auth: started });
        }
      } catch (error) {
        if (error instanceof McpSignInError) return json(res, error.status, { error: error.message });
        if (error instanceof McpOAuthError) return json(res, 400, { error: error.message, code: error.code });
        if (method === "POST" && !flowId) return json(res, 502, { error: error instanceof Error ? error.message : "Sign-in could not start." });
        throw error;
      }
      return json(res, 405, { error: "method not allowed" });
    }

    if (method === "POST" && path === "/api/mcp/servers") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      if (!deps.mcpConfigLock.acquire()) return json(res, 409, { error: "MCP servers are already being updated." });
      try {
        const body = await readBody(req);
        const name = typeof body?.name === "string" ? body.name : "";
        const current = cfg.mcpServers ?? {};
        if (Object.hasOwn(current, name)) return json(res, 409, { error: "An MCP server with that name already exists." });
        if (Object.keys(current).length >= MAX_MCP_SERVERS) {
          return json(res, 400, { error: `You can add at most ${MAX_MCP_SERVERS} MCP servers.` });
        }
        const parsed = parseMcpServerMutation(name, mcpServerBody(body));
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        persistMcpServers({ ...current, [name]: parsed.server });
        return json(res, 201, mcpServerResponse());
      } finally {
        deps.mcpConfigLock.release();
      }
    }

    // Paste-to-add: the {"mcpServers": {...}} block every other agent tool
    // writes. Same rules as POST: disabled until explicitly enabled.
    if (method === "POST" && path === "/api/mcp/servers/import") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      if (!deps.mcpConfigLock.acquire()) return json(res, 409, { error: "MCP servers are already being updated." });
      try {
        const body = await readBody(req);
        const text = typeof body?.json === "string" ? body.json : "";
        if (auth.kind === "session" && !deps.sessions.isLive(auth.session.id)) {
          return json(res, 401, { error: "unauthorized: this session has expired or was revoked" });
        }
        if (!text.trim()) return json(res, 400, { error: "Paste the JSON block first." });
        const parsed = parseMcpServersImport(text);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        const current = cfg.mcpServers ?? {};
        const names = Object.keys(parsed.servers);
        const taken = names.filter((name) => Object.hasOwn(current, name));
        if (taken.length) {
          return json(res, 409, { error: `Already added: ${taken.join(", ")}. Remove or rename ${taken.length === 1 ? "it" : "them"} first.` });
        }
        if (Object.keys(current).length + names.length > MAX_MCP_SERVERS) {
          return json(res, 400, { error: `You can add at most ${MAX_MCP_SERVERS} MCP servers.` });
        }
        persistMcpServers({ ...current, ...parsed.servers });
        return json(res, 201, { ...mcpServerResponse(), added: names });
      } finally {
        deps.mcpConfigLock.release();
      }
    }

    const mcpServerRoute = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})$/.exec(path);
    if (mcpServerRoute && ["PUT", "PATCH", "DELETE"].includes(method)) {
      if (method !== "DELETE" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      if (!deps.mcpConfigLock.acquire()) return json(res, 409, { error: "MCP servers are already being updated." });
      try {
        const name = mcpServerRoute[1];
        const current = cfg.mcpServers ?? {};
        if (!Object.hasOwn(current, name)) return json(res, 404, { error: "MCP server not found." });
        if (method === "DELETE") {
          const next = { ...current };
          delete next[name];
          persistMcpServers(next);
          mcpOAuth.forget(name);
          return json(res, 200, mcpServerResponse());
        }

        const existing = parseStoredMcpServer(name, current[name]);
        if (!existing.ok) return json(res, 400, { error: existing.error });
        const body = await readBody(req);
        if (method === "PATCH") {
          if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") {
            return json(res, 400, { error: "Only an enabled boolean can be changed here." });
          }
          persistMcpServers({ ...current, [name]: { ...existing.server, enabled: body.enabled } });
          return json(res, 200, mcpServerResponse());
        }

        const parsed = parseMcpServerMutation(name, body, existing.server);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        persistMcpServers({ ...current, [name]: parsed.server });
        // a sign-in belongs to one address; a token never follows the entry elsewhere
        const before = isRemoteMcpServer(existing.server) ? existing.server.url : null;
        const after = isRemoteMcpServer(parsed.server) ? parsed.server.url : null;
        // ...and to one sign-in app with its scopes; a new secret for the same app keeps it
        const app = (server: typeof existing.server) => isRemoteMcpServer(server) && server.oauth
          ? JSON.stringify([server.oauth.clientId, server.oauth.scopes ?? []]) : null;
        // Any other edit (a new header, say) drops a sign-in request that has
        // no tokens behind it; the next Test asks again if it still applies.
        if (before !== after || app(existing.server) !== app(parsed.server)
          || (after && mcpOAuth.authState(name, after) === "needs-sign-in")) mcpOAuth.forget(name);
        return json(res, 200, mcpServerResponse());
      } finally {
        deps.mcpConfigLock.release();
      }
    }
    return PASS;
  };
}