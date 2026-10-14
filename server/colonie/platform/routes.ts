// Application HTTP surface under /api/colonie/platform. Every route resolves
// the session first, then delegates to the service, which enforces workspace
// membership and conversation participation. The handler never trusts a
// workspace or conversation ID from the client as proof of access.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { json, readBody } from "../../harness/http.ts";
import type { PlatformAuth } from "./contracts.ts";
import { PlatformError } from "./contracts.ts";
import type { PlatformService } from "./service.ts";

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  path: string;
  accountId: string;
}

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

const createWorkspaceSchema = z.object({ name: z.string().trim().min(1).max(120), kind: z.enum(["local", "cloud"]) }).strict();
const renameSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const roleSchema = z.object({ role: z.enum(["owner", "admin", "member"]) }).strict();
const botSchema = z.object({ name: z.string().trim().min(1).max(80), purpose: z.string().max(500).optional() }).strict();
const botUpdateSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), purpose: z.string().max(500).optional() }).strict();
const groupSchema = z.object({ title: z.string().trim().min(1).max(120), memberPrincipalIds: z.array(z.string().min(1)).max(500).optional() }).strict();
const openDmSchema = z.object({ kind: z.literal("dm"), withAccountId: z.string().min(1).optional(), withBotId: z.string().min(1).optional() }).strict();
const messageSchema = z.object({ body: z.string().trim().min(1).max(16_384) }).strict();
const readSchema = z.object({ sequence: z.number().int().min(0) }).strict();
const stopSchema = z.object({ botPrincipalId: z.string().min(1).optional() }).strict();
const invitationSchema = z.object({ role: z.enum(["admin", "member"]).optional(), expiresInHours: z.number().int().min(1).max(720).optional() }).strict();
const acceptSchema = z.object({ token: z.string().min(1) }).strict();
const connectionSchema = z.object({ toolkit: z.string().trim().min(1), audience: z.enum(["workspace", "personal"]), actions: z.array(z.string()).max(50).optional(), secret: z.string().min(1).optional(), providerAccountId: z.string().max(200).optional() }).strict();
const rotateSchema = z.object({ secret: z.string().min(1) }).strict();
const memberSchema = z.object({ principalId: z.string().min(1) }).strict();
const recoverSchema = z.object({ recoveryKey: z.string().min(1).max(128), newPassword: z.string().min(8).max(128) }).strict();

/** Build the platform request handler. Returns true when it answered. */
export function createPlatformRoutes(service: PlatformService, auth: PlatformAuth): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname;
    if (!path.startsWith("/api/colonie/platform")) return false;

    // Recovery reset is the only endpoint that runs without a session.
    if (method === "POST" && path === "/api/colonie/platform/account/recover") {
      try {
        const input = await body(req, recoverSchema);
        await service.recoverAccount(input);
        json(res, 200, { ok: true });
      } catch (error) {
        respondError(res, error);
      }
      return true;
    }

    const human = await auth.session(req);
    if (!human) {
      json(res, 401, { error: "Sign in to continue.", code: "unauthenticated" });
      return true;
    }
    const ctx: Ctx = { req, res, url, method, path, accountId: human.id };
    try {
      await dispatch(service, ctx, human);
    } catch (error) {
      respondError(res, error);
    }
    return true;
  };
}

async function dispatch(service: PlatformService, ctx: Ctx, human: { id: string; email: string; name: string }): Promise<void> {
  const { req, res, url, method, path, accountId } = ctx;
  let m: RegExpMatchArray | null;

  // ── account recovery key (signed in) ──
  if (method === "POST" && path === "/api/colonie/platform/account/recovery-key") {
    json(res, 200, await service.createRecoveryKey(accountId));
    return;
  }

  // ── workspaces ──
  if (path === "/api/colonie/platform/workspaces") {
    if (method === "GET") return void json(res, 200, { workspaces: await service.listWorkspaces(accountId) });
    if (method === "POST") {
      const input = await body(req, createWorkspaceSchema);
      return void json(res, 200, { workspace: await service.createWorkspace(accountId, human, input) });
    }
    return void json(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
  }
  if ((m = path.match(/^\/api\/colonie\/platform\/workspaces\/([\w-]+)$/))) {
    const workspaceId = m[1]!;
    if (method === "GET") return void json(res, 200, await service.getWorkspace(accountId, workspaceId));
    if (method === "PATCH") {
      const input = await body(req, renameSchema);
      return void json(res, 200, { workspace: await service.renameWorkspace(accountId, workspaceId, input.name) });
    }
    return void json(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
  }

  // ── members ──
  if ((m = path.match(/^\/api\/colonie\/platform\/workspaces\/([\w-]+)\/members$/))) {
    if (method === "GET") return void json(res, 200, { members: await service.listMembers(accountId, m[1]!) });
    return void json(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
  }
  if ((m = path.match(/^\/api\/colonie\/platform\/workspaces\/([\w-]+)\/members\/([\w-]+)$/))) {
    if (method === "PATCH") {
      const input = await body(req, roleSchema);
      return void json(res, 200, { member: await service.setMemberRole(accountId, m[1]!, m[2]!, input.role) });
    }
    if (method === "DELETE") {
      await service.removeMember(accountId, m[1]!, m[2]!);
      return void json(res, 200, { ok: true });
    }
    return void json(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
  }

  // ── bots ──
  if ((m = path.match(/^\/api\/colonie\/platform\/workspaces\/([\w-]+)\/bots$/))) {
    if (method === "GET") return void json(res, 200, { bots: await service.listBots(accountId, m[1]!) });
    if (method === "POST") {
      const input = await body(req, botSchema);
      return void json(res, 200, { bot: await service.createBot(accountId, m[1]!, input) });
    }
    return void json(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
  }
  if ((m = path.match(/^\/api\/colonie\/platform\/workspaces\/([\w-]+)\/bots\/([\w-]+)$/))) {
    if (method === "PATCH") {
      const input = await body(req, botUpdateSchema);
      return void json(res, 200, { bot: await service.updateBot(accountId, m[1]!, m[2]!, input) });
    }
    if (method === "DELETE") {
      await service.removeBot(accountId, m[1]!, m[2]!);
      return void json(res, 200, { ok: true });
    }
    return void json(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
  }

  // ── groups ──
  if ((m = path.match(/^\/api\/colonie\/platform\/workspaces\/([\w-]+)\/groups$/))) {
    if (method === "GET") {
      const conversations = await service.listConversations(accountId, m[1]!);
      return void json(res, 200, { conversations: conversations.filter((c) => c.kind === "group") });
    }
    if (method === "POST") {
      const input = await body(req, groupSchema);
      return void json(res, 200, { conversation: await service.createGroup(accountId, m[1]!, input) });
    }
    return void json(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
  }

  // ── conversations ──
  if ((m = path.match(/^\/api\/colonie\/platform\/workspaces\/([\w-]+)\/conversations$/)) && method === "GET") {
    return void json(res, 200, { conversations: await service.listConversations(accountId, m[1]!) });
  }
  if ((m = path.match(/^\/api\/colonie\/platform\/workspaces\/([\w-]+)\/conversations\/open$/)) && method === "POST") {
    const input = await body(req, openDmSchema);
    return void json(res, 200, { conversation: await service.openDm(accountId, m[1]!, input) });
  }
  if ((m = path.match(/^\/api\/colonie\/platform\/conversations\/([\w-]+)$/))) {
    if (method === "GET") {
      const raw = url.searchParams.get("after");
      const after = raw === null ? undefined : Number(raw);
      // An absent cursor must reach the service's latest-page default; only a
      // finite explicit cursor keeps cursor semantics.
      return void json(res, 200, await service.getConversation(accountId, m[1]!, after !== undefined && Number.isFinite(after) ? { after } : {}));
    }
    return void json(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
  }
  if ((m = path.match(/^\/api\/colonie\/platform\/conversations\/([\w-]+)\/messages$/))) {
    if (method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      return void json(res, 200, { messages: await service.listMessages(accountId, m[1]!, Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 100) });
    }
    if (method === "POST") {
      const input = await body(req, messageSchema);
      return void json(res, 200, { message: await service.sendMessage(accountId, m[1]!, input.body) });
    }
    return void json(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
  }
  if ((m = path.match(/^\/api\/colonie\/platform\/conversations\/([\w-]+)\/read$/)) && method === "POST") {
    const input = await body(req, readSchema);
    return void json(res, 200, { conversation: await service.markRead(accountId, m[1]!, input.sequence) });
  }
  if ((m = path.match(/^\/api\/colonie\/platform\/conversations\/([\w-]+)\/turns\/stop$/)) && method === "POST") {
    const input = await body(req, stopSchema);
    return void json(res, 200, await service.stopTurns(accountId, m[1]!, input.botPrincipalId));
  }
  if ((m = path.match(/^\/api\/colonie\/platform\/conversations\/([\w-]+)\/members$/)) && method === "POST") {
    const input = await body(req, memberSchema);
    return void json(res, 200, { conversation: await service.addGroupMember(accountId, m[1]!, input.principalId) });
  }
  if ((m = path.match(/^\/api\/colonie\/platform\/conversations\/([\w-]+)\/members\/([\w-]+)$/)) && method === "DELETE") {
    await service.removeGroupMember(accountId, m[1]!, m[2]!);
    return void json(res, 200, { ok: true });
  }

  // ── invitations ──
  if (method === "POST" && path === "/api/colonie/platform/invitations/accept") {
    const input = await body(req, acceptSchema);
    return void json(res, 200, await service.acceptInvitation(accountId, human, input.token));
  }
  if ((m = path.match(/^\/api\/colonie\/platform\/workspaces\/([\w-]+)\/invitations$/))) {
    if (method === "GET") return void json(res, 200, { invitations: await service.listInvitations(accountId, m[1]!) });
    if (method === "POST") {
      const input = await body(req, invitationSchema);
      return void json(res, 200, await service.createInvitation(accountId, m[1]!, input));
    }
    return void json(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
  }
  if ((m = path.match(/^\/api\/colonie\/platform\/workspaces\/([\w-]+)\/invitations\/([\w-]+)$/)) && method === "DELETE") {
    await service.revokeInvitation(accountId, m[1]!, m[2]!);
    return void json(res, 200, { ok: true });
  }

  // ── connections ──
  if ((m = path.match(/^\/api\/colonie\/platform\/workspaces\/([\w-]+)\/connections$/))) {
    if (method === "GET") return void json(res, 200, { connections: await service.listConnections(accountId, m[1]!) });
    if (method === "POST") {
      const input = await body(req, connectionSchema);
      return void json(res, 200, { connection: await service.createConnection(accountId, m[1]!, input) });
    }
    return void json(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
  }
  if ((m = path.match(/^\/api\/colonie\/platform\/workspaces\/([\w-]+)\/connections\/([\w-]+)$/))) {
    if (method === "PATCH") {
      const input = await body(req, rotateSchema);
      return void json(res, 200, { connection: await service.rotateConnection(accountId, m[1]!, m[2]!, input.secret) });
    }
    if (method === "DELETE") {
      await service.deleteConnection(accountId, m[1]!, m[2]!);
      return void json(res, 200, { ok: true });
    }
    return void json(res, 405, { error: "Method not allowed.", code: "method_not_allowed" });
  }

  // ── authorized event stream ──
  if ((m = path.match(/^\/api\/colonie\/platform\/workspaces\/([\w-]+)\/stream$/)) && method === "GET") {
    return openStream(service, ctx, m[1]!);
  }

  json(res, 404, { error: "No such endpoint.", code: "not_found" });
}

async function openStream(service: PlatformService, ctx: Ctx, workspaceId: string): Promise<void> {
  const { req, res, url, accountId } = ctx;
  const conversationId = url.searchParams.get("conversationId");
  const after = Number(url.searchParams.get("after") ?? "0");
  // Validates membership and participation before any bytes are written.
  const replay = await service.replay(accountId, workspaceId, conversationId, Number.isFinite(after) ? after : 0);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const write = (frame: { sequence: number; event: unknown }) => {
    if (res.writableEnded) return;
    res.write(`id: ${frame.sequence}\ndata: ${JSON.stringify(frame)}\n\n`);
  };
  const unsubscribe = service.hub.subscribe({
    workspaceId,
    accountId,
    id: randomUUID(),
    ...(conversationId ? { conversationId } : {}),
    delivery: { deliver: write, close: () => res.end() },
  });
  write({ sequence: after, event: { type: "ready", workspaceId, subscriberAccountId: accountId, at: new Date().toISOString() } });
  for (const frame of replay) write(frame);
  const stop = () => unsubscribe();
  req.on("close", stop);
  res.on("close", stop);
}
