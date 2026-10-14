// HTTP extension for the workspace Composio module. Mount this BEFORE
// `createPlatformRoutes` — the platform handler claims every
// /api/colonie/platform path with a 404 fallback. Every route resolves the
// session first; the service then enforces membership and role. The raw
// project key never appears in a response.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { json, readBody } from "../../harness/http.ts";
import type { PlatformAuth } from "./contracts.ts";
import { PlatformError } from "./contracts.ts";
import type { WorkspaceComposioService } from "./composio.ts";

const BASE = "/api/colonie/platform/workspaces/";

const keySchema = z.object({ apiKey: z.string().min(1) }).strict();
const provisionSchema = z.object({ name: z.string().trim().min(1).max(120).optional() }).strict();
const startSchema = z.object({ toolkit: z.string().trim().min(1).max(80), audience: z.enum(["personal", "shared"]).optional() }).strict();
const completeSchema = z.object({ state: z.string().min(1), sessionUri: z.string().min(1) }).strict();

function respondError(res: ServerResponse, error: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  if (error instanceof PlatformError) {
    json(res, error.status, { error: error.message, code: error.code });
    return;
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && status >= 400 && status < 600) {
    json(res, status, { error: error instanceof Error ? error.message : "Request rejected.", code: "bad_request" });
    return;
  }
  json(res, 500, { error: "Something went wrong on the server.", code: "internal" });
}

async function body<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readBody(req));
  if (!parsed.success) throw new PlatformError(400, "The request body is not valid.", "invalid_body");
  return parsed.data;
}

export interface ComposioRoutesDeps {
  service: WorkspaceComposioService;
  auth: PlatformAuth;
}

/** Returns true when it answered; false means "not a Composio request". */
export function createComposioRoutes(deps: ComposioRoutesDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { service, auth } = deps;
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const match = url.pathname.match(/^\/api\/colonie\/platform\/workspaces\/([\w-]+)\/composio(?:\/(.*))?$/);
    if (!match) return false;
    const workspaceId = match[1]!;
    const rest = match[2] ?? "";

    const human = await auth.session(req);
    if (!human) {
      json(res, 401, { error: "Sign in to continue.", code: "unauthenticated" });
      return true;
    }
    const accountId = human.id;

    try {
      if (rest === "" && method === "GET") {
        json(res, 200, await service.status(accountId, workspaceId));
        return true;
      }
      if (rest === "key" && method === "PUT") {
        const input = await body(req, keySchema);
        json(res, 200, await service.setProjectKey(accountId, workspaceId, input.apiKey));
        return true;
      }
      if (rest === "key" && method === "DELETE") {
        await service.removeProjectKey(accountId, workspaceId);
        json(res, 200, { ok: true });
        return true;
      }
      if (rest === "provision" && method === "POST") {
        const input = await body(req, provisionSchema);
        json(res, 200, await service.provisionProjectKey(accountId, workspaceId, input.name));
        return true;
      }
      if (rest === "connections" && method === "GET") {
        json(res, 200, { links: await service.listLinks(accountId, workspaceId) });
        return true;
      }
      if (rest === "connections" && method === "POST") {
        const input = await body(req, startSchema);
        const started = input.audience === "shared"
          ? await service.startSharedLink(accountId, workspaceId, input.toolkit)
          : await service.startPersonalLink(accountId, workspaceId, input.toolkit);
        json(res, 200, started);
        return true;
      }
      if (rest === "connections/complete" && method === "POST") {
        const input = await body(req, completeSchema);
        json(res, 200, { link: await service.completeLink(accountId, workspaceId, input) });
        return true;
      }
      const link = rest.match(/^connections\/([\w-]+)$/);
      if (link && method === "DELETE") {
        json(res, 200, { link: await service.disconnectLink(accountId, workspaceId, link[1]!) });
        return true;
      }
      json(res, 404, { error: "No such endpoint.", code: "not_found" });
      return true;
    } catch (error) {
      respondError(res, error);
      return true;
    }
  };
}

export { BASE as COMPOSIO_ROUTES_BASE };
