/** Standalone Cloud host. Owns accounts and collaboration, independent of the
 * legacy single-owner server/pairing gateway. Binds loopback behind HTTPS. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Pool } from "pg";
import { PLATFORM_AVATAR_MAX_BODY_BYTES } from "../../../shared/colonie-bot-profile.ts";
import { PLATFORM_AUTH_BASE, PLATFORM_API_BASE } from "../../../shared/colonie-platform.ts";
import { initPlatformAuth } from "./auth.ts";
import { createPgPlatformRepository } from "./pg-repository.ts";
import { createPlatformApp } from "./app.ts";
import { CloudAcpRuntime } from "./runtime.ts";
import { WorkspaceComposioService, platformAccess, type ComposioProvider } from "./composio.ts";
import { createPgComposioStore } from "./composio-store.ts";
import { createComposioRoutes } from "./composio-routes.ts";
import { httpComposioProvider } from "./composio-provider.ts";
import { SecretBox } from "./secrets.ts";
import { CloudToolBroker, type CloudTool } from "./tools.ts";
import type { BotTurnRequest } from "./contracts.ts";
import { createComposioToolResolver } from "./tool-provider.ts";

export interface PlatformHostConfig {
  databaseUrl: string;
  schema: string;
  publicOrigin: string;
  authSecret: string;
  secretKey: string;
  runtimeRoot: string;
  claudeConfigDir: string;
  claudeAdapterEntry?: string;
  claudeExecutable?: string;
  port?: number;
  staticDir?: string;
  /** Testing only: do not dispatch paid provider calls in ordinary fixtures. */
  disableRuntime?: boolean;
  composioOrgKey?: string;
}

export function directDatabaseUrl(raw: string): string {
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error("A PostgreSQL connection is required.");
  // Dedicated schemas rely on connection-local search_path. Neon documents
  // that session SET state is unsuitable for a transaction-pooled connection.
  url.hostname = url.hostname.replace(/-pooler\./, ".");
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

export function validateHostConfig(config: PlatformHostConfig): PlatformHostConfig {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(config.schema) || ["public", "pg_catalog", "information_schema"].includes(config.schema)) throw new Error("A dedicated Colonie schema is required.");
  const origin = new URL(config.publicOrigin);
  if (origin.origin !== config.publicOrigin || (origin.protocol !== "https:" && !(origin.protocol === "http:" && origin.hostname === "127.0.0.1"))) throw new Error("An HTTPS platform origin is required.");
  if (config.authSecret.length < 32 || Buffer.from(config.secretKey, "base64").length !== 32) throw new Error("Private platform encryption keys are required.");
  return config;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function platformRequestAllowed(req: IncomingMessage, origin: string, localOrigin: string): boolean {
  const allowed = new Set([new URL(origin).host, new URL(localOrigin).host]);
  if (!req.headers.host || !allowed.has(req.headers.host)) return false;
  if (req.headers.origin && ![origin, localOrigin].includes(req.headers.origin)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") {
    // Invitations and OAuth return by top-level navigation from another site.
    // Their page may load; cross-site API calls and writes remain refused.
    const path = new URL(req.url ?? "/", origin).pathname;
    if (!["GET", "HEAD"].includes(req.method ?? "GET") || path.startsWith("/api/") ||
        req.headers["sec-fetch-mode"] !== "navigate" || req.headers["sec-fetch-dest"] !== "document") return false;
  }
  return true;
}

const CONTENT_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" };

export async function startPlatformHost(input: PlatformHostConfig, dependencies: { composioProvider?: ComposioProvider; toolResolver?: (request: BotTurnRequest) => Promise<CloudTool[]> } = {}) {
  const config = validateHostConfig(input);
  const databaseUrl = directDatabaseUrl(config.databaseUrl);
  const bootstrap = new Pool({ connectionString: databaseUrl, max: 1 });
  try { await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`); }
  finally { await bootstrap.end(); }
  const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 15_000,
    options: `-c search_path=${config.schema}` });
  const authOptions = { database: pool, secret: config.authSecret, baseURL: config.publicOrigin,
    trustedOrigins: [config.publicOrigin] };
  const authInit = await initPlatformAuth(authOptions);
  await authInit.runMigrations();
  const auth = authInit.auth;
  const { repository } = await createPgPlatformRepository({ pool });
  let runtime: CloudAcpRuntime | undefined;
  let composioService: WorkspaceComposioService | undefined;
  const app = createPlatformApp({ repository, auth, secretKey: Buffer.from(config.secretKey, "base64"), publicOrigin: config.publicOrigin,
    workspaceCreated: async (workspace, actorId) => {
      if (config.composioOrgKey && composioService) await composioService.provisionProjectKey(actorId, workspace.id, workspace.name);
    },
    runtime: {
      onTurn: (request) => {
        if (!runtime) return app.service.publishTurnState({ botPrincipalId: request.botPrincipalId, conversationId: request.conversationId,
          state: "error", error: "The workspace AI service is not available yet." });
        runtime.onTurn(request);
      },
      cancelConversation: (id) => runtime?.cancelConversation(id),
    },
  });
  const { store: composioStore } = await createPgComposioStore({ pool });
  composioService = new WorkspaceComposioService({
    repository, store: composioStore, secrets: new SecretBox(Buffer.from(config.secretKey, "base64")),
    provider: dependencies.composioProvider ?? httpComposioProvider(), access: platformAccess(app.service),
    callbackUrl: `${config.publicOrigin}/composio/callback`, orgKey: config.composioOrgKey,
  });
  const composioRoutes = createComposioRoutes({ service: composioService, auth });
  const toolBroker = new CloudToolBroker({
    resolve: dependencies.toolResolver ?? createComposioToolResolver({ platform: app.service, apps: composioService }),
    authorize: (request) => app.service.canPublish(request),
  });
  if (!config.disableRuntime) runtime = new CloudAcpRuntime({
    root: config.runtimeRoot, claudeConfigDir: config.claudeConfigDir, adapterEntry: config.claudeAdapterEntry, claudeExecutable: config.claudeExecutable,
    sink: app.service,
    toolBroker,
    failure: (failure) => console.warn(JSON.stringify({ event: "cloud-turn-failed", ...failure })),
    authorize: (request) => app.service.canPublish({ botPrincipalId: request.botPrincipalId, conversationId: request.conversationId, initiatorAccountId: request.initiatorAccountId }),
    botProfile: async (request) => {
      const bot = await repository.getBot(request.botId);
      if (!bot || bot.workspaceId !== request.workspaceId) throw new Error("This bot is unavailable.");
      return bot;
    },
    history: async (request) => {
      const last = await repository.lastSequence(request.conversationId);
      return (await app.service.getConversation(request.initiatorAccountId, request.conversationId, { after: Math.max(last - 60, 0), limit: 60 })).messages;
    },
    state: (request, state, message) => app.service.publishTurnState({ botPrincipalId: request.botPrincipalId, conversationId: request.conversationId,
      state: state === "working" ? "typing" : state === "failed" ? "error" : state, ...(message ? { error: message } : {}) }),
  });
  const staticRoot = resolve(config.staticDir ?? "dist");
  let localOrigin = "";
  const server = createServer({ maxHeaderSize: 16_384 }, async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    if (!platformRequestAllowed(req, config.publicOrigin, localOrigin)) return json(res, 403, { error: "This request is not from Colonie." });
    const path = new URL(req.url ?? "/", localOrigin).pathname;
    try {
      if (path === "/api/colonie/bootstrap" && req.method === "GET") return json(res, 200, { mode: "platform", origin: config.publicOrigin });
      if (path === "/api/health" && req.method === "GET") return json(res, 200, { app: "colonie-platform", version: 1 });
      if (path.startsWith(PLATFORM_AUTH_BASE) || path.startsWith(PLATFORM_API_BASE)) {
        const avatarUpload = req.method === "POST" && /^\/api\/colonie\/platform\/workspaces\/[\w-]+\/bots\/[\w-]+\/avatars$/.test(path);
        if (Number(req.headers["content-length"] ?? 0) > (avatarUpload ? PLATFORM_AVATAR_MAX_BODY_BYTES : 128_000)) return json(res, 413, { error: "This request is too large." });
        if (await composioRoutes(req, res) || await app.handle(req, res)) return;
        return json(res, 404, { error: "This page could not be found." });
      }
      if (path.startsWith("/api/")) return json(res, 404, { error: "This page could not be found." });
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "This page is read-only." });
      const requested = resolve(staticRoot, `.${decodeURIComponent(path)}`);
      if (requested !== staticRoot && !requested.startsWith(staticRoot + sep)) return json(res, 404, { error: "This page could not be found." });
      let file = requested;
      if (!(await stat(file).catch(() => null))?.isFile()) {
        if (extname(path)) return json(res, 404, { error: "This file could not be found." });
        file = resolve(staticRoot, "index.html");
      }
      const body = await readFile(file);
      res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
        "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'" });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      if (!res.headersSent) {
        if ((error as { status?: unknown }).status === 413) json(res, 413, { error: "This request is too large." });
        else json(res, 500, { error: "Colonie could not complete this request." });
      } else res.end();
    }
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(config.port ?? 19091, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The platform did not bind its loopback port.");
  localOrigin = `http://127.0.0.1:${address.port}`;
  return {
    origin: localOrigin, server, app, repository, composioService,
    async close() {
      await runtime?.dispose();
      await toolBroker.close();
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
