// Cloud tool broker checks: a real loopback HTTP listener, per-turn leases, and
// the exact adapter permission field. Every fixture is local; no provider key,
// no Composio call, no network beyond 127.0.0.1.
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerHttp, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { RemoteMcpClient } from "../../mcp-http.ts";
import { CLOUD_TOOL_PREFIX, CloudToolBroker, type CloudTool, type CloudToolLease } from "./tools.ts";
import type { BotTurnRequest, PlatformMessage } from "./contracts.ts";

// The credential a resolver would hold in its own closure. It must never reach
// the ACP surface, a broker response, or a permission request.
const FAKE_KEY = "composio_fixture_key_do_not_leak";
const CONNECTED_ID = "ca_fixture_connected_id";

const brokers: CloudToolBroker[] = [];
afterEach(async () => {
  for (const broker of brokers.splice(0)) {
    // Bound cleanup: a regression in close() must fail the test, not hang the run.
    await Promise.race([broker.close(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  }
});

const message = (body: string): PlatformMessage => ({
  id: "m-1", workspaceId: "ws", conversationId: "conv", senderPrincipalId: "human",
  senderKind: "human", senderName: "Clive", sequence: 1, body, createdAt: "2026-10-14T09:00:00.000Z",
});

const REQUEST: BotTurnRequest = {
  workspaceId: "ws", conversationId: "conv", botId: "bot", botPrincipalId: "bp",
  trigger: "dm", initiatorAccountId: "acct", message: message("list the open pull requests"), history: [message("list the open pull requests")],
};

interface ToolOptions {
  description?: string;
  inputSchema?: Record<string, unknown>;
  execute?(args: Record<string, unknown>): Promise<unknown>;
  authorize?(): Promise<boolean>;
}

/** What a real resolver would send to the provider: the credential stays here. */
function providerCall(): { authorization: string; userId: string } {
  return { authorization: `Bearer ${FAKE_KEY}`, userId: CONNECTED_ID };
}

/** A read-only tool fixture; the fake key and connected id stay in this closure. */
function tool(name: string, options: ToolOptions = {}): CloudTool {
  return {
    name,
    description: options.description ?? `Read ${name.replace(/_/g, " ")}`,
    inputSchema: options.inputSchema ?? { type: "object", properties: { query: { type: "string" } } },
    execute: options.execute ?? (async (args) => {
      const provider = providerCall();
      return { query: args.query ?? null, authorized: provider.authorization.startsWith("Bearer ") };
    }),
    authorize: options.authorize ?? (async () => true),
  };
}

function brokerWith(resolve: () => Promise<CloudTool[]>, options: Partial<{ authorize(request: BotTurnRequest): Promise<boolean>; now(): number; leaseTtlMs: number; requestTimeoutMs: number; bodyLimitBytes: number; resultLimitBytes: number }> = {}) {
  const broker = new CloudToolBroker({ resolve: async () => resolve(), authorize: options.authorize ?? (async () => true), ...options });
  brokers.push(broker);
  return broker;
}

/** Narrow the ACP server union to the one loopback HTTP entry this broker emits. */
function httpServer(lease: CloudToolLease): McpServerHttp & { type: "http" } {
  const [server] = lease.servers;
  if (!server || !("type" in server) || server.type !== "http") {
    throw new Error("expected exactly one loopback HTTP MCP server");
  }
  return server;
}

const tokenOf = (lease: CloudToolLease): string => httpServer(lease).headers[0].value.replace("Bearer ", "");
const portOf = (broker: CloudToolBroker): number => Number(new URL(broker.origin!).port);

/** A maintained-adapter permission request naming one tool, fully typed. */
const permission = (name: string): RequestPermissionRequest => ({
  sessionId: "session-1",
  toolCall: { toolCallId: "tc-1", name },
  options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
});

/** A permission request for this broker's own tool, named as ACP reports it. */
const mcpPermission = (tool: string): RequestPermissionRequest => permission(`${CLOUD_TOOL_PREFIX}${tool}`);

interface Frame { status: number; text: string; json: any }

function post(port: number, body: string, headers: Record<string, string>, method = "POST"): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text, json: safeJson(text) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return undefined; }
}

const frame = (method: string, params: unknown, id: unknown = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

const call = (port: number, token: string, method: string, params: unknown, id: unknown = 1) =>
  post(port, frame(method, params, id), { "content-type": "application/json", authorization: `Bearer ${token}` });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("CloudToolBroker: loopback handshake", () => {
  it("mounts one loopback MCP server carrying only the opaque lease token", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests")]);
    const lease = await broker.open(REQUEST);
    expect(lease.toolNames).toEqual(["list_pull_requests"]);
    expect(lease.servers).toEqual([{
      type: "http", name: "colonie_apps", url: `${broker.origin}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${tokenOf(lease)}` }],
    }]);
    expect(broker.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("answers initialize, ping, tools/list and tools/call over real HTTP", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests")]);
    const lease = await broker.open(REQUEST);
    const port = portOf(broker);
    const token = tokenOf(lease);

    const initialize = await call(port, token, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "1" } });
    expect(initialize.status).toBe(200);
    expect(initialize.json.result.capabilities.tools).toEqual({ listChanged: false });
    expect(initialize.json.result.serverInfo.name).toBe("Colonie connected apps");
    expect(initialize.json.result.protocolVersion).toBe("2025-06-18");

    const notified = await post(port, frame("notifications/initialized", {}).replace('"id":1,', ""), { "content-type": "application/json", authorization: `Bearer ${token}` });
    expect(notified.status).toBe(202);
    expect(notified.text).toBe("");

    expect((await call(port, token, "ping", {})).json.result).toEqual({});

    const list = await call(port, token, "tools/list", {});
    expect(list.json.result.tools).toEqual([{
      name: "list_pull_requests", description: "Read list pull requests",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    }]);

    const callResult = await call(port, token, "tools/call", { name: "list_pull_requests", arguments: { query: "open" } });
    expect(callResult.status).toBe(200);
    expect(callResult.json.result.content[0].type).toBe("text");
    expect(JSON.parse(callResult.json.result.content[0].text)).toEqual({ query: "open", authorized: true });
    // tools/list carries exactly the resolver's declared fields, nothing else.
    expect(Object.keys(list.json.result.tools[0]).sort()).toEqual(["description", "inputSchema", "name"]);
  });

  it("is directly consumable by the maintained MCP HTTP client", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests")]);
    const lease = await broker.open(REQUEST);
    const server = httpServer(lease);
    const client = new RemoteMcpClient({
      type: "http",
      url: server.url,
      headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
    });
    const signal = AbortSignal.timeout(5_000);
    const initialized = await client.initialize("Colonie test", signal) as { serverInfo: { name: string } };
    expect(initialized.serverInfo.name).toBe("Colonie connected apps");
    const listed = await client.request("tools/list", {}, signal) as { tools: { name: string }[] };
    expect(listed.tools.map((entry) => entry.name)).toEqual(["list_pull_requests"]);
    const called = await client.request("tools/call", { name: "list_pull_requests", arguments: { query: "open" } }, signal) as { content: { text: string }[] };
    expect(JSON.parse(called.content[0]!.text)).toEqual({ query: "open", authorized: true });
    await client.close();
  });
});

describe("CloudToolBroker: lease, host and origin are refused", () => {
  it("refuses a foreign or missing lease token", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests")]);
    await broker.open(REQUEST);
    const port = portOf(broker);
    expect((await call(port, "0".repeat(64), "tools/list", {})).status).toBe(401);
    expect((await post(port, frame("tools/list", {}), { "content-type": "application/json" })).status).toBe(401);
  });

  it("refuses a foreign Host and any foreign Origin", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests")]);
    const lease = await broker.open(REQUEST);
    const port = portOf(broker);
    const token = tokenOf(lease);
    const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
    expect((await post(port, frame("tools/list", {}), { ...headers, host: "evil.example" })).status).toBe(403);
    expect((await post(port, frame("tools/list", {}), { ...headers, origin: "https://evil.example" })).status).toBe(403);
    expect((await post(port, frame("tools/list", {}), { ...headers, origin: "null" })).status).toBe(403);
    expect((await post(port, frame("tools/list", {}), { ...headers, origin: broker.origin! })).status).toBe(200);
  });

  it("refuses an expired lease on HTTP and in the permission handler", async () => {
    let now = 1_000;
    const broker = brokerWith(async () => [tool("list_pull_requests")], { now: () => now, leaseTtlMs: 10 * 60_000 });
    const lease = await broker.open(REQUEST);
    now += 10 * 60_000;
    expect((await call(portOf(broker), tokenOf(lease), "tools/list", {})).status).toBe(401);
    expect(await lease.authorizePermission(mcpPermission("list_pull_requests"))).toBe(false);
  });
});

describe("CloudToolBroker: request bounds", () => {
  it("refuses non-POST, wrong path, wrong content type, bad JSON, batches and unknown methods", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests")], { bodyLimitBytes: 64 * 1024 });
    const lease = await broker.open(REQUEST);
    const port = portOf(broker);
    const token = tokenOf(lease);
    const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
    expect((await post(port, "", headers, "GET")).status).toBe(405);
    expect((await post(port, "", headers, "DELETE")).status).toBe(405);
    expect((await call(port, token, "tools/list", {})).status).toBe(200);
    expect((await post(port, frame("tools/list", {}), { authorization: `Bearer ${token}`, "content-type": "text/plain" })).status).toBe(415);
    expect((await post(port, "{not json", headers)).json.error.code).toBe(-32700);
    expect((await post(port, JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]), headers)).json.error.code).toBe(-32600);
    expect((await call(port, token, "resources/list", {})).json.error.code).toBe(-32601);
    expect((await post(port, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(70 * 1024) } }), headers)).status).toBe(413);
  });

  it("reports an oversized result as a tool error instead of returning it", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests", { execute: async () => ({ body: "x".repeat(2_000) }) })], { resultLimitBytes: 512 });
    const lease = await broker.open(REQUEST);
    const response = await call(portOf(broker), tokenOf(lease), "tools/call", { name: "list_pull_requests", arguments: {} });
    expect(response.json.result.isError).toBe(true);
    expect(response.text).not.toContain("xxxx");
  });

  it("reports a timed-out tool as a tool error", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests", { execute: () => new Promise(() => {}) })], { requestTimeoutMs: 25 });
    const lease = await broker.open(REQUEST);
    const response = await call(portOf(broker), tokenOf(lease), "tools/call", { name: "list_pull_requests", arguments: {} });
    expect(response.json.result).toEqual({ content: [{ type: "text", text: "The connected-app tool timed out" }], isError: true });
  });
});

describe("CloudToolBroker: revocation wins over an in-flight result", () => {
  it("does not return the result when the lease is released while the tool runs", async () => {
    const started = deferred<void>();
    const gate = deferred<unknown>();
    const broker = brokerWith(async () => [tool("list_pull_requests", { execute: () => { started.resolve(); return gate.promise; } })]);
    const lease = await broker.open(REQUEST);
    const pending = call(portOf(broker), tokenOf(lease), "tools/call", { name: "list_pull_requests", arguments: {} });
    await started.promise;
    await lease.release();
    gate.resolve({ leaked: "SHOULD_NOT_APPEAR" });
    const response = await pending;
    expect(response.json.result).toBeUndefined();
    expect(response.json.error.code).toBe(-32001);
    expect(response.text).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("does not return the result when access is revoked while the tool runs", async () => {
    const started = deferred<void>();
    const gate = deferred<unknown>();
    let allowed = true;
    const broker = brokerWith(async () => [tool("list_pull_requests", { execute: () => { started.resolve(); return gate.promise; } })],
      { authorize: async () => allowed });
    const lease = await broker.open(REQUEST);
    const pending = call(portOf(broker), tokenOf(lease), "tools/call", { name: "list_pull_requests", arguments: {} });
    await started.promise;
    allowed = false;
    gate.resolve({ leaked: "SHOULD_NOT_APPEAR" });
    const response = await pending;
    expect(response.json.error.code).toBe(-32001);
    expect(response.text).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("refuses the tool when its own grant was revoked before the call", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests", { authorize: async () => false })]);
    const lease = await broker.open(REQUEST);
    const response = await call(portOf(broker), tokenOf(lease), "tools/call", { name: "list_pull_requests", arguments: {} });
    expect(response.json.error.code).toBe(-32001);
  });

  it("rejects a tool this turn was not offered", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests")]);
    const lease = await broker.open(REQUEST);
    const response = await call(portOf(broker), tokenOf(lease), "tools/call", { name: "delete_repository", arguments: {} });
    expect(response.json.error.code).toBe(-32602);
  });
});

describe("CloudToolBroker: release, close and no-tool turns", () => {
  it("revokes the token on release and stays safe when repeated", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests")]);
    const lease = await broker.open(REQUEST);
    const port = portOf(broker);
    const token = tokenOf(lease);
    await lease.release();
    await lease.release();
    expect((await call(port, token, "tools/list", {})).status).toBe(401);
    expect(await lease.authorizePermission(mcpPermission("list_pull_requests"))).toBe(false);
  });

  it("stops the listener on close, repeatedly", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests")]);
    const lease = await broker.open(REQUEST);
    const port = portOf(broker);
    await broker.close();
    await broker.close();
    await expect(call(port, tokenOf(lease), "tools/list", {})).rejects.toThrow();
    expect(await lease.authorizePermission(mcpPermission("list_pull_requests"))).toBe(false);
  });

  it("closes promptly while an idle keep-alive connection is open", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests")]);
    const lease = await broker.open(REQUEST);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await new Promise<void>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1", port: portOf(broker), path: "/mcp", method: "POST", agent,
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenOf(lease)}` },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve());
      });
      request.on("error", reject);
      request.end(frame("tools/list", {}));
    });
    await Promise.race([
      broker.close(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("close hung on an idle keep-alive connection")), 2_000)),
    ]);
    agent.destroy();
    await broker.close();
  });

  it("bounds close while a tool call is still running", async () => {
    const started = deferred<void>();
    const gate = deferred<unknown>();
    const broker = brokerWith(async () => [tool("list_pull_requests", { execute: () => { started.resolve(); return gate.promise; } })]);
    const lease = await broker.open(REQUEST);
    const pending = call(portOf(broker), tokenOf(lease), "tools/call", { name: "list_pull_requests", arguments: {} });
    await started.promise;
    const began = Date.now();
    await broker.close();
    expect(Date.now() - began).toBeLessThan(3_000);
    gate.resolve({ leaked: "SHOULD_NOT_APPEAR" });
    await expect(pending).rejects.toThrow();
  });

  it("mounts nothing when the resolver offers no tools", async () => {
    const broker = brokerWith(async () => []);
    const lease = await broker.open(REQUEST);
    expect(lease.servers).toEqual([]);
    expect(lease.toolNames).toEqual([]);
    expect(broker.origin).toBeNull();
    expect(await lease.authorizePermission(mcpPermission("list_pull_requests"))).toBe(false);
  });
});

describe("CloudToolBroker: permission covers only this lease's MCP tools", () => {
  it("approves only mcp__colonie_apps__<allowed> and rejects native builtins", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests"), tool("get_issue")]);
    const lease = await broker.open(REQUEST);
    const allowed = mcpPermission("list_pull_requests");
    expect(await lease.authorizePermission(allowed)).toBe(true);
    for (const name of ["Bash", "Read", "Write", "Edit", "Glob", "WebFetch", "Task", "mcp__other_server__list_pull_requests", `${CLOUD_TOOL_PREFIX}delete_repository`, "list_pull_requests"]) {
      expect(await lease.authorizePermission(permission(name))).toBe(false);
    }
    expect(await lease.authorizePermission(undefined as unknown as RequestPermissionRequest)).toBe(false);
    expect(await lease.authorizePermission({} as RequestPermissionRequest)).toBe(false);
  });

  it("rejects a permission request when the tool's grant or the turn's access is gone", async () => {
    const tools = [tool("list_pull_requests"), tool("get_issue", { authorize: async () => false })];
    const broker = brokerWith(async () => tools);
    const lease = await broker.open(REQUEST);
    expect(await lease.authorizePermission(mcpPermission("get_issue"))).toBe(false);
    await lease.release();
    expect(await lease.authorizePermission(mcpPermission("list_pull_requests"))).toBe(false);
  });

  it("only lists this turn's tools", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests")]);
    const lease = await broker.open(REQUEST);
    const list = await call(portOf(broker), tokenOf(lease), "tools/list", {});
    expect(list.json.result.tools.map((entry: { name: string }) => entry.name)).toEqual(["list_pull_requests"]);
  });
});

describe("CloudToolBroker: no credential on any broker surface", () => {
  it("keeps the resolver's key and connected id out of the ACP surface and every response", async () => {
    const broker = brokerWith(async () => [tool("list_pull_requests")]);
    const lease = await broker.open(REQUEST);
    const request = mcpPermission("list_pull_requests");
    expect(await lease.authorizePermission(request)).toBe(true);

    const surfaces = [
      JSON.stringify(lease.servers),
      JSON.stringify(lease.toolNames),
      JSON.stringify(request),
      (await call(portOf(broker), tokenOf(lease), "tools/list", {})).text,
      (await call(portOf(broker), tokenOf(lease), "tools/call", { name: "list_pull_requests", arguments: {} })).text,
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(FAKE_KEY);
      expect(surface).not.toContain(CONNECTED_ID);
    }
    // The token itself is opaque: a 32-byte hex lease, never the provider key.
    expect(tokenOf(lease)).toMatch(/^[a-f0-9]{64}$/);
  });
});
