import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { writeFileAtomic } from "../../persistence/atomic.ts";
import type { McpServerSpec } from "../../contracts.ts";
import { isRemoteMcpServer } from "../../mcp-registry.ts";
import { connectorCallFromFrame, serviceSlugForCandidates } from "../../connector-verdict.ts";
import { McpHttpError, type RemoteMcpClient } from "../../mcp-http.ts";
import { policyHash, type BotAppPolicies } from "./policy.ts";
import { createComposioSession, sessionClient, type ComposioSession } from "./composio-client.ts";
import type { AcpToolMount } from "./contracts.ts";
import type { ConnectedToolCall } from "../../../shared/connected-apps.ts";
import { toolResultFailed } from "./outcome.ts";

const META_TOOLS = new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_GET_TOOL_SCHEMAS"]);
const persisted = z.object({ revision: z.string(), session: z.object({ session_id: z.string(), mcp: z.object({ url: z.string(), type: z.enum(["http", "sse"]) }) }) }).strict();
interface Dependencies {
  origin: string;
  policies: BotAppPolicies;
  /** Where Composio sessions are kept between turns, one file per lease. */
  sessions: string;
  credentials(): { key: string; userId?: string } | null;
  recordUserId(userId: string): void;
  owns(botId: string, threadId: string): boolean;
}
interface Lease {
  botId: string;
  threadId: string;
  instanceId: string;
  key: string;
  userId: string;
  revision: string;
  policyRevision: string;
  token: string;
  active: boolean;
  released: boolean;
  controller: AbortController;
  lifetime: AbortController;
  client?: RemoteMcpClient;
  connecting?: Promise<RemoteMcpClient>;
  mount: AcpToolMount;
  calls: ConnectedToolCall[];
}
const rpcError = (id: unknown, message: string) => ({ jsonrpc: "2.0", id: typeof id === "number" || typeof id === "string" ? id : null, error: { code: -32000, message } });
const object = z.record(z.string(), z.unknown());

/** General ACP mounts plus a private Composio relay. No legacy agent context. */
export class ConnectedTools {
  private readonly deps: Dependencies;
  private readonly leases = new Map<string, Lease>();
  private readonly tokens = new Map<string, Lease>();
  constructor(deps: Dependencies) { this.deps = deps; }

  mount(botId: string, threadId: string, instanceId: string, custom: Record<string, McpServerSpec>): AcpToolMount {
    const policy = this.deps.policies.read(botId);
    const credential = policy.toolkits.length ? this.deps.credentials() : null;
    if (policy.toolkits.length && !credential?.key) throw new Error("Connect Composio in app settings before using these apps.");
    let userId = credential?.userId ?? "";
    if (credential && !userId) { userId = `colonie_${randomUUID()}`; this.deps.recordUserId(userId); }
    const revision = policyHash([policy, custom, credential?.key ?? "", userId]);
    const slot = `${threadId}:${instanceId}`;
    const previous = this.leases.get(slot);
    if (previous?.revision === revision && !previous.released) return previous.mount;
    const token = randomBytes(32).toString("hex");
    const servers: McpServer[] = Object.entries(custom).map(([name, server]) => isRemoteMcpServer(server)
      ? { name, type: server.type, url: server.url, headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })) }
      : { name, command: server.command, args: server.args, env: Object.entries(server.env).map(([name, value]) => ({ name, value })) });
    if (credential) servers.push({ name: "colonie_composio", type: "http", url: `${this.deps.origin}/api/internal/colonie-mcp`, headers: [{ name: "Authorization", value: `Bearer ${token}` }] });
    let mount!: AcpToolMount;
    const lease: Lease = { botId, threadId, instanceId, key: credential?.key ?? "", userId, revision, token,
      policyRevision: policyHash(policy), active: false, released: false, controller: new AbortController(), calls: [],
      lifetime: new AbortController(),
      get mount() { return mount; },
    };
    const release = () => {
      if (lease.released) return;
      lease.released = true; lease.active = false; lease.controller.abort(); lease.lifetime.abort();
      this.tokens.delete(token);
      if (this.leases.get(slot) === lease) this.leases.delete(slot);
      void lease.client?.close().catch(() => {});
    };
    mount = { servers, revision, receipt: { policyHash: lease.policyRevision, composioToolkits: [...policy.toolkits],
      servers: servers.map((server) => ({ name: server.name, source: server.name === "colonie_composio" ? "composio" : "custom", transport: "type" in server ? server.type as "http" | "sse" : "stdio" })) },
      activate: () => { this.assertCurrent(lease); if (lease.controller.signal.aborted) lease.controller = new AbortController(); lease.active = true; lease.calls = []; },
      deactivate: () => { lease.active = false; for (const call of lease.calls) if (call.status === "started") call.status = "cancelled"; lease.controller.abort(); }, release,
      calls: () => lease.calls.map((call) => ({ ...call, targets: [...call.targets] })) };
    // Old transports are revoked before a newly selected policy can be mounted.
    previous?.mount.release();
    this.leases.set(slot, lease);
    if (credential) this.tokens.set(token, lease);
    return lease.mount;
  }

  cancel(threadId: string) { for (const lease of this.leases.values()) if (lease.threadId === threadId) lease.mount.deactivate(); }
  invalidateBot(botId: string) { for (const lease of this.leases.values()) if (lease.botId === botId) lease.mount.release(); }
  dispose() { for (const lease of this.leases.values()) lease.mount.release(); }
  private assertCurrent(lease: Lease) {
    const credential = this.deps.credentials();
    if (lease.released || !this.deps.owns(lease.botId, lease.threadId) || policyHash(this.deps.policies.read(lease.botId)) !== lease.policyRevision
      || (lease.key && (credential?.key !== lease.key || credential.userId !== lease.userId))) throw new Error("Connected app access changed. Send a new message to refresh the connection.");
  }
  private async client(lease: Lease): Promise<RemoteMcpClient> {
    if (lease.client) return lease.client;
    if (lease.connecting) return lease.connecting;
    lease.connecting = (async () => {
      const directory = this.deps.sessions;
      const file = join(directory, `${policyHash([lease.botId, lease.threadId, lease.instanceId])}.json`);
      let session: ComposioSession | undefined;
      try {
        const saved = persisted.parse(JSON.parse(readFileSync(file, "utf8")));
        if (saved.revision === lease.revision) session = saved.session;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const signal = AbortSignal.any([lease.lifetime.signal, ...(lease.active ? [lease.controller.signal] : []), AbortSignal.timeout(30_000)]);
      const persist = () => {
        this.assertCurrent(lease);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileAtomic(file, JSON.stringify({ revision: lease.revision, session }, null, 2), { mode: 0o600 });
      };
      if (!session) {
        session = await createComposioSession(lease.key, lease.userId, this.deps.policies.read(lease.botId).toolkits, signal);
        persist();
      }
      let client = sessionClient(lease.key, session);
      try {
        try { await client.initialize("Colonie", signal); }
        catch (error) {
          if (!(error instanceof McpHttpError) || (error.status !== 404 && error.status !== 410)) throw error;
          // Only a missing remote session is recreated, with the same user/scope.
          // Authentication/network failures never fall back to broader access.
          await client.close().catch(() => {});
          this.assertCurrent(lease);
          session = await createComposioSession(lease.key, lease.userId, this.deps.policies.read(lease.botId).toolkits, signal);
          persist(); client = sessionClient(lease.key, session);
          await client.initialize("Colonie", signal);
        }
        this.assertCurrent(lease); lease.client = client; return client;
      }
      catch (error) { await client.close().catch(() => {}); throw error; }
    })().finally(() => { lease.connecting = undefined; });
    return lease.connecting;
  }

  /** Dedicated bearer route, invoked before the public API auth gate. */
  async handle(req: IncomingMessage, res: ServerResponse, body: unknown) {
    const remote = req.socket.remoteAddress;
    const token = /^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization ?? ""))?.[1];
    const lease = token ? this.tokens.get(token) : undefined;
    const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    if (!lease || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote ?? "") || req.headers.origin) return json(401, { error: "Unauthorized MCP connection" });
    if (req.method === "GET") { res.writeHead(405, { allow: "POST, DELETE" }); res.end(); return; }
    if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
    if (req.method !== "POST") return json(405, { error: "Unsupported MCP method" });
    const parsed = object.safeParse(body);
    if (!parsed.success) return json(400, rpcError(null, "Invalid MCP frame"));
    const frame = parsed.data;
    if (frame.id === undefined) { res.writeHead(202); res.end(); return; }
    let observed: ConnectedToolCall | undefined;
    try {
      this.assertCurrent(lease);
      if (frame.method === "initialize") return json(200, { jsonrpc: "2.0", id: frame.id, result: { protocolVersion: (frame.params as any)?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Colonie connected apps", version: "1" } } });
      if (frame.method === "ping") return json(200, { jsonrpc: "2.0", id: frame.id, result: {} });
      if (frame.method !== "tools/list" && frame.method !== "tools/call") throw new Error("Unsupported connected-app request");
      const signal = AbortSignal.any([lease.lifetime.signal, ...(frame.method === "tools/call" ? [lease.controller.signal] : []), AbortSignal.timeout(60_000)]);
      if (frame.method === "tools/call") {
        if (!lease.active) throw new Error("This conversation has no active request");
        const name = (frame.params as any)?.name;
        if (typeof name !== "string") throw new Error("Tool name is required");
        const policy = this.deps.policies.read(lease.botId);
        const classified = connectorCallFromFrame(frame);
        if (name.startsWith("COMPOSIO_") && !META_TOOLS.has(name)) throw new Error("This Composio helper is not enabled");
        if (classified.kind === "unrecognized" || (classified.kind === "tools" && classified.names.some((tool) => !policy.toolkits.includes(serviceSlugForCandidates(tool, policy.toolkits) ?? "")))) throw new Error("This app is not enabled for this bot");
        if (name === "COMPOSIO_MANAGE_CONNECTIONS") {
          const toolkits = (frame.params as any)?.arguments?.toolkits;
          if (!Array.isArray(toolkits) || toolkits.some((entry: any) => !policy.toolkits.includes(typeof entry === "string" ? entry : entry?.toolkit ?? entry?.name))) throw new Error("This app is not enabled for this bot");
        }
        observed = { server: "colonie_composio", tool: name, targets: classified.kind === "tools" ? [...classified.names] : [], status: "started" };
        lease.calls.push(observed);
      }
      const client = await this.client(lease);
      this.assertCurrent(lease);
      if (frame.method === "tools/call" && !lease.active) throw new Error("This conversation has no active request");
      let result = await client.request(String(frame.method), frame.params ?? {}, signal);
      if (observed) {
        observed.status = toolResultFailed(result) ? "failed" : "completed";
      }
      if (frame.method === "tools/list") {
        const listed = z.object({ tools: z.array(z.object({ name: z.string() }).passthrough()) }).passthrough().parse(result);
        const policy = this.deps.policies.read(lease.botId);
        result = { ...listed, tools: listed.tools.filter((tool) => META_TOOLS.has(tool.name) || policy.toolkits.includes(serviceSlugForCandidates(tool.name, policy.toolkits) ?? "")) };
      }
      const safeResult = JSON.parse(JSON.stringify(result).split(lease.key).join("[redacted]"));
      return json(200, { jsonrpc: "2.0", id: frame.id, result: safeResult });
    } catch (error) {
      if (observed) observed.status = lease.controller.signal.aborted ? "cancelled" : "failed";
      // Do not forward credential-bearing upstream diagnostics to the agent.
      const message = (error as Error).message;
      const safe = /^(Connected app access changed|This conversation|This app|This Composio|Tool name|Unsupported)/.test(message) ? message : "The connected-app request failed. Check Composio in app settings, then try again.";
      return json(200, rpcError(frame.id, safe));
    }
  }
}
