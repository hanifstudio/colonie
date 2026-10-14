/** Parent-host loopback MCP broker for Cloud bot turns.
 *
 * One broker owns one loopback HTTP listener; each turn gets its own lease: a
 * random bearer token, a per-turn tool set resolved by the injected resolver,
 * and a 10-minute expiry. The ACP-facing surface carries only the loopback URL
 * and that opaque token — never a provider key, connected-app id, or Composio
 * credential. Credentials live in the resolver's own closures in this parent
 * process, so nothing credential-bearing ever reaches the agent.
 *
 * Only initialize, ping, tools/list and tools/call exist here. The agent's
 * native builtins stay disabled (the runtime passes `tools: []`); a permission
 * request is approved only when its tool call names this lease's
 * `mcp__colonie_apps__<tool>`, so Bash/Read/Write/Edit can never be approved
 * through this path.
 *
 * Which apps and tools a turn may use is the resolver's decision (the API side
 * resolves the bot's active app access). The broker only enforces what the
 * resolver returned, plus a per-call `authorize` callback so revoked access is
 * caught on every call — before and after the tool runs.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { BotTurnRequest } from "./contracts.ts";

/** The MCP server name the agent sees; tool names become `mcp__<name>__<tool>`. */
export const CLOUD_TOOL_SERVER_NAME = "colonie_apps";

/** The exact ACP tool-name prefix a permission request must carry. */
export const CLOUD_TOOL_PREFIX = `mcp__${CLOUD_TOOL_SERVER_NAME}__`;

/** The single loopback path the agent posts MCP frames to. */
export const CLOUD_TOOL_PATH = "/mcp";

const DEFAULT_LEASE_TTL_MS = 10 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;
const DEFAULT_RESULT_LIMIT_BYTES = 1024 * 1024;
/** How long close() waits for an in-flight request before dropping sockets. */
const CLOSE_GRACE_MS = 1_000;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const LEASE_TOKEN = /^[a-f0-9]{64}$/;
const TIMEOUT_MESSAGE = "connected-app tool timeout";

/** One tool the resolver offers for a turn. Read actions only by policy. */
export interface CloudTool {
  /** Bare MCP tool name; the agent sees `mcp__colonie_apps__<name>`. */
  name: string;
  description: string;
  /** JSON Schema for the tool arguments, passed through to the agent. */
  inputSchema: Record<string, unknown>;
  /** Runs in this parent process; provider credentials stay in its closure. */
  execute(args: Record<string, unknown>): Promise<unknown>;
  /** The tool's own grant, re-checked before and after execution. */
  authorize(): Promise<boolean>;
}

export interface CloudToolBrokerOptions {
  /**
   * Resolves the tools a turn may use: the candidate read-only tools for the
   * bot's active app access. An empty list means no MCP server is mounted.
   * Credentials, app selection and DM/Group policy live in this closure.
   */
  resolve(request: BotTurnRequest): Promise<CloudTool[]>;
  /**
   * Re-checks the turn's current access on every call. The host wires this to
   * the platform's `canPublish`, so revoked access stops reaching tools even
   * mid-turn.
   */
  authorize(request: BotTurnRequest): Promise<boolean>;
  /** Test seam for the lease clock. */
  now?(): number;
  leaseTtlMs?: number;
  requestTimeoutMs?: number;
  bodyLimitBytes?: number;
  resultLimitBytes?: number;
  log?(message: string): void;
}

/** What one turn receives. `release()` revokes the lease immediately. */
export interface CloudToolLease {
  /** ACP MCP server config: loopback URL and an opaque bearer token only. */
  servers: McpServer[];
  /** Bare MCP tool names this turn may call, and nothing outside them. */
  toolNames: string[];
  /** true only for this lease's `mcp__colonie_apps__<allowed>` tool call. */
  authorizePermission(params: RequestPermissionRequest): Promise<boolean>;
  release(): Promise<void>;
}

interface LeaseRecord {
  request: BotTurnRequest;
  token: string;
  tools: Map<string, CloudTool>;
  expiresAt: number;
  released: boolean;
}

const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id: typeof id === "number" || typeof id === "string" ? id : null,
  error: { code, message },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The tool name on a maintained-adapter permission request. The adapter's
 * renderer puts the raw tool name on `toolCall.name`
 * (`@agentclientprotocol/claude-agent-acp` dist/tool-calls/renderer.js
 * `permissionToolCall`: `name: toolUse.name`); `rawInput` carries the tool
 * *arguments*, not the name. Anything without that exact name fails closed,
 * which is what keeps native builtins (Bash, Read, Write, Edit, …) out.
 */
function permissionToolName(params: RequestPermissionRequest | undefined | null): string | undefined {
  const toolCall = (params as { toolCall?: unknown } | null | undefined)?.toolCall;
  if (!isRecord(toolCall)) return undefined;
  return typeof toolCall.name === "string" && toolCall.name ? toolCall.name : undefined;
}

/** The bare tool name when, and only when, it belongs to this lease. */
function allowedToolName(params: RequestPermissionRequest | undefined | null, lease: LeaseRecord): string | undefined {
  const name = permissionToolName(params);
  if (!name || !name.startsWith(CLOUD_TOOL_PREFIX)) return undefined;
  const bare = name.slice(CLOUD_TOOL_PREFIX.length);
  return lease.tools.has(bare) ? bare : undefined;
}

function serializedSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** One broker: one loopback listener, one lease per turn. */
export class CloudToolBroker {
  private readonly options: CloudToolBrokerOptions;
  private readonly leases = new Map<string, LeaseRecord>();
  private server: Server | null = null;
  private port = 0;
  private listening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;

  constructor(options: CloudToolBrokerOptions) {
    if (typeof options?.resolve !== "function") throw new Error("A Cloud tool broker needs a tool resolver.");
    if (typeof options?.authorize !== "function") throw new Error("A Cloud tool broker needs an access callback.");
    this.options = options;
  }

  /** The loopback origin while a listener is open, else null. */
  get origin(): string | null {
    return this.server && this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /**
   * Opens one turn's lease. Resolves the turn's tools first; when the resolver
   * offers none, no listener is started and no MCP server is mounted.
   */
  async open(request: BotTurnRequest): Promise<CloudToolLease> {
    if (this.closed) throw new Error("This Cloud tool broker is closed.");
    const resolved = await this.options.resolve(request);
    if (!Array.isArray(resolved)) throw new Error("A Cloud tool resolver must return an array of tools.");
    const tools = new Map<string, CloudTool>();
    for (const tool of resolved) {
      if (!TOOL_NAME.test(tool?.name ?? "")) throw new Error("A connected tool needs a simple MCP tool name.");
      if (tools.has(tool.name)) throw new Error(`Connected tool "${tool.name}" was offered twice.`);
      if (typeof tool.execute !== "function" || typeof tool.authorize !== "function") {
        throw new Error(`Connected tool "${tool.name}" is not callable.`);
      }
      if (!isRecord(tool.inputSchema)) throw new Error(`Connected tool "${tool.name}" needs an input schema.`);
      tools.set(tool.name, tool);
    }

    const token = randomBytes(32).toString("hex");
    const lease: LeaseRecord = {
      request,
      token,
      tools,
      expiresAt: this.now() + (this.options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS),
      released: false,
    };
    if (tools.size) {
      await this.listen();
      this.leases.set(token, lease);
    }

    return {
      servers: tools.size && this.origin
        ? [{ type: "http", name: CLOUD_TOOL_SERVER_NAME, url: `${this.origin}${CLOUD_TOOL_PATH}`,
            headers: [{ name: "Authorization", value: `Bearer ${token}` }] }]
        : [],
      toolNames: [...tools.keys()],
      authorizePermission: async (params) => {
        const name = allowedToolName(params, lease);
        if (!name) return false;
        if (!(await this.current(lease))) return false;
        return this.granted(tools.get(name)!);
      },
      release: async () => {
        if (lease.released) return;
        lease.released = true;
        this.leases.delete(lease.token);
        this.log(`Cloud tool lease released (${lease.tools.size} tools)`);
      },
    };
  }

  /** Revokes every lease and stops the listener. Safe to call more than once. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.closing) return this.closing;
    for (const lease of this.leases.values()) lease.released = true;
    this.leases.clear();
    const server = this.server;
    this.server = null;
    this.listening = null;
    this.port = 0;
    if (!server) return;
    this.closing = new Promise<void>((resolve) => {
      // The MCP client reuses one keep-alive socket. Without dropping the idle
      // connections, server.close() never calls back and shutdown hangs, so the
      // idle ones go immediately. A bounded grace then drops whatever is still
      // stuck: every lease is already revoked, so a request cut short here could
      // not have returned a result anyway.
      let timer: NodeJS.Timeout | undefined;
      const done = () => { if (timer) clearTimeout(timer); resolve(); };
      timer = setTimeout(() => { server.closeAllConnections(); done(); }, CLOSE_GRACE_MS);
      timer.unref?.();
      server.close(done);
      server.closeIdleConnections();
    });
    return this.closing;
  }

  private async listen(): Promise<void> {
    if (this.server) return;
    if (this.listening) return this.listening;
    this.listening = new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500, { "content-type": "application/json", connection: "close" });
          res.end(JSON.stringify({ error: "The connected-app broker failed." }));
        });
      });
      server.on("clientError", (_error, socket) => socket.destroy());
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.server = server;
        this.port = (server.address() as { port: number }).port;
        this.log(`Cloud tool broker listening on ${CLOUD_TOOL_PATH}`);
        resolve();
      });
    });
    return this.listening;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, value: unknown, close = false) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store",
        ...(close ? { connection: "close" } : {}) });
      res.end(JSON.stringify(value));
    };

    // Loopback only, and the exact Host/Origin of this listener: a DNS-rebinding
    // or cross-site caller is refused before any frame is read.
    const expected = this.origin;
    if (!expected || !LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "")) {
      return json(403, { error: "Forbidden" }, true);
    }
    if (String(req.headers.host ?? "") !== expected.slice("http://".length)) {
      return json(403, { error: "Forbidden" }, true);
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== expected) return json(403, { error: "Forbidden" }, true);
    if ((req.url ?? "").split("?")[0] !== CLOUD_TOOL_PATH) return json(404, { error: "Not found" }, true);
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "cache-control": "no-store" });
      res.end();
      return;
    }

    const token = /^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization ?? ""))?.[1];
    const lease = token ? this.leases.get(token) : undefined;
    if (!token || !LEASE_TOKEN.test(token) || !lease || lease.released || this.closed || this.now() >= lease.expiresAt) {
      return json(401, { error: "Unauthorized" }, true);
    }
    if (!String(req.headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
      return json(415, { error: "Expected JSON" }, true);
    }

    const body = await this.read(req, this.options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES);
    if (body === null) return json(413, { error: "Request too large" }, true);
    let frame: unknown;
    try {
      frame = JSON.parse(body);
    } catch {
      return json(200, rpcError(null, -32700, "Invalid JSON"));
    }
    if (!isRecord(frame) || typeof frame.method !== "string") {
      return json(200, rpcError(isRecord(frame) ? frame.id : null, -32600, "Invalid request"));
    }
    if (frame.id === undefined) {
      // A notification (the adapter sends notifications/initialized). No reply.
      res.writeHead(202, { "cache-control": "no-store" });
      res.end();
      return;
    }

    const request = await this.dispatch(frame, lease);
    if (!request.ok) return json(200, rpcError(frame.id, request.code, request.message));
    return json(200, { jsonrpc: "2.0", id: frame.id, result: request.result });
  }

  private async dispatch(
    frame: Record<string, unknown>,
    lease: LeaseRecord,
  ): Promise<{ ok: true; result: unknown } | { ok: false; code: number; message: string }> {
    const params = isRecord(frame.params) ? frame.params : {};
    if (frame.method === "initialize") {
      return { ok: true, result: {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "Colonie connected apps", version: "1" },
      } };
    }
    if (frame.method === "ping") return { ok: true, result: {} };
    if (frame.method === "tools/list") {
      return { ok: true, result: { tools: [...lease.tools.values()].map((tool) => ({
        name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
      })) } };
    }
    if (frame.method !== "tools/call") return { ok: false, code: -32601, message: "Unsupported request" };

    const name = typeof params.name === "string" ? params.name : "";
    const tool = lease.tools.get(name);
    if (!tool) return { ok: false, code: -32602, message: "This tool is not available for this turn" };
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isRecord(args)) return { ok: false, code: -32602, message: "Tool arguments must be an object" };

    // Access is checked before the call and again after it: a lease revoked or
    // an account that lost access while the tool ran never returns its result.
    if (!(await this.current(lease)) || !(await this.granted(tool))) {
      return { ok: false, code: -32001, message: "Connected app access was revoked" };
    }

    let value: unknown;
    try {
      value = await this.run(tool, args);
    } catch (error) {
      const message = error instanceof Error && error.message === TIMEOUT_MESSAGE
        ? "The connected-app tool timed out"
        : "The connected-app tool failed";
      return { ok: true, result: { content: [{ type: "text", text: message }], isError: true } };
    }
    if (!(await this.current(lease)) || !(await this.granted(tool))) {
      return { ok: false, code: -32001, message: "Connected app access was revoked" };
    }
    if (serializedSize(value) > (this.options.resultLimitBytes ?? DEFAULT_RESULT_LIMIT_BYTES)) {
      return { ok: true, result: { content: [{ type: "text", text: "The connected-app result was too large" }], isError: true } };
    }
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    return { ok: true, result: { content: [{ type: "text", text }] } };
  }

  private async current(lease: LeaseRecord): Promise<boolean> {
    if (lease.released || this.closed || this.now() >= lease.expiresAt) return false;
    try {
      return (await this.options.authorize(lease.request)) === true;
    } catch {
      return false;
    }
  }

  private async granted(tool: CloudTool): Promise<boolean> {
    try {
      return (await tool.authorize()) === true;
    } catch {
      return false;
    }
  }

  private run(tool: CloudTool, args: Record<string, unknown>): Promise<unknown> {
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), timeoutMs);
      timer.unref?.();
      Promise.resolve()
        .then(() => tool.execute(args))
        .then((value) => { clearTimeout(timer); resolve(value); },
              (error) => { clearTimeout(timer); reject(error); });
    });
  }

  private async read(req: IncomingMessage, limit: number): Promise<string | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > limit) return null;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
