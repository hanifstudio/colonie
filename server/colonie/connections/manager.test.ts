import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BotAppPolicies, policyHash } from "./policy.ts";
import { ConnectedTools } from "./manager.ts";
import { fakeComposio } from "./testing/fake-composio.ts";

it("permits idle discovery, blocks idle execution, revokes old leases and never forwards a project key", async () => {
  const service = await fakeComposio();
  const previousApi = process.env.COLONIE_COMPOSIO_API;
  process.env.COLONIE_COMPOSIO_API = `${service.origin}/api/v3.1`;
  const root = mkdtempSync(join(tmpdir(), "colonie-connected-apps-"));
  const policies = new BotAppPolicies(join(root, "bots"));
  policies.save("relay-bot", { toolkits: ["hackernews"], customServers: [] }, policyHash(policies.read("relay-bot")));
  let manager!: ConnectedTools;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    await manager.handle(req, res, body ? JSON.parse(body) : null);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let userId = "isolated_fixture_user";
  manager = new ConnectedTools({ origin, policies, sessions: join(root, "sessions"), credentials: () => ({ key: service.key, userId }), recordUserId: (value) => { userId = value; }, owns: () => true });
  try {
    const mount = manager.mount("relay-bot", "relay-thread", "fixture", {});
    const remote = mount.servers[0]!;
    if (!("type" in remote) || remote.type !== "http") throw new Error("Fixture requires HTTP");
    expect(JSON.stringify(mount.servers)).not.toContain(service.key);
    const headers = Object.fromEntries(remote.headers.map(({ name, value }) => [name, value]));
    let id = 1;
    const rpc = async (method: string, params: unknown = {}) => {
      const response = await fetch(`${origin}/api/internal/colonie-mcp`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }), signal: AbortSignal.timeout(10_000) });
      return { status: response.status, body: await response.json() as any };
    };
    expect((await rpc("tools/list")).body.result.tools.map((tool: any) => tool.name)).toContain("HACKERNEWS_READ");
    expect((await rpc("tools/call", { name: "HACKERNEWS_READ", arguments: {} })).body.error.message).toContain("no active request");
    expect(service.calls).toHaveLength(0);
    mount.activate();
    const allowed = await rpc("tools/call", { name: "HACKERNEWS_READ", arguments: {} });
    expect(JSON.stringify(allowed.body)).not.toContain(service.key);
    expect(mount.calls()[0]?.status).toBe("completed");
    mount.deactivate();
    expect((await rpc("tools/list")).body.result.tools.length).toBeGreaterThan(0);
    expect((await rpc("tools/call", { name: "HACKERNEWS_READ", arguments: {} })).body.error).toBeTruthy();
    expect(service.calls).toHaveLength(1);
    const browser = await fetch(`${origin}/api/internal/colonie-mcp`, { method: "POST", headers: { ...headers, "content-type": "application/json", origin }, body: "{}" });
    expect(browser.status).toBe(401);
    manager.invalidateBot("relay-bot");
    expect((await rpc("tools/list")).status).toBe(401);
  } finally {
    manager.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    if (previousApi === undefined) delete process.env.COLONIE_COMPOSIO_API; else process.env.COLONIE_COMPOSIO_API = previousApi;
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps each workspace's app policies in the directory it was given", () => {
  const roots = [mkdtempSync(join(tmpdir(), "colonie-policy-a-")), mkdtempSync(join(tmpdir(), "colonie-policy-b-"))];
  try {
    const [a, b] = roots.map((root) => new BotAppPolicies(join(root, "bots")));
    a!.save("bot", { toolkits: ["gmail"], customServers: [] }, policyHash(a!.read("bot")));
    expect(a!.read("bot").toolkits).toEqual(["gmail"]);
    expect(b!.read("bot")).toEqual({ toolkits: [], customServers: [] });
    expect(() => b!.save("bot", { toolkits: ["slack"], customServers: [] }, policyHash(a!.read("bot")))).toThrow(/changed/);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
