import { expect, test } from "vitest";
import { PASS } from "./table.ts";
import { createMcpServerRoutes } from "./mcp-servers.ts";
import { callRoute } from "../testing/route-context.ts";

const json = { "content-type": "application/json" };

function world(opts: { locked?: boolean } = {}) {
  const cfg = { mcpServers: {} } as { mcpServers: Record<string, unknown> };
  const forgotten: string[] = [];
  const routes = createMcpServerRoutes({
    cfg: cfg as never,
    mcpOAuth: { authState: () => "none", forget: (name: string) => forgotten.push(name) } as never,
    sessions: { isLive: () => true } as never,
    persistMcpServers: (next) => { cfg.mcpServers = next; },
    mcpConfigLock: { acquire: () => !opts.locked, release: () => {} },
    savedCustomDomain: () => null,
    fallbackPublicUrl: null,
  });
  return { routes, cfg, forgotten };
}

test("declines paths and methods that are not its own", async () => {
  const { routes } = world();

  expect(await routes(callRoute("/api/bots").ctx)).toBe(PASS);
  expect(await routes(callRoute("/api/mcp/servers", "PUT").ctx)).toBe(PASS);
});

test("the list answers an empty registry", async () => {
  const { routes } = world();
  const { ctx, sent } = callRoute("/api/mcp/servers");

  await routes(ctx);

  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toEqual({ servers: [] });
});

test("a mutation without a JSON content-type is a 415", async () => {
  const { routes, cfg } = world();
  const { ctx, sent } = callRoute("/api/mcp/servers", "POST", { name: "demo", command: "npx" });

  await routes(ctx);

  expect(sent[0]?.status).toBe(415);
  expect(cfg.mcpServers).toEqual({});
});

test("adding a command server stores it and lists it back", async () => {
  const { routes, cfg } = world();
  const { ctx, sent } = callRoute("/api/mcp/servers", "POST", { name: "demo", command: "npx", args: ["-y", "some-server"] }, json);

  await routes(ctx);

  expect(sent[0]?.status).toBe(201);
  expect(cfg.mcpServers).toHaveProperty("demo");
  const body = sent[0]?.body as { servers: Array<{ name: string }> };
  expect(body.servers.map((server) => server.name)).toEqual(["demo"]);
});

test("a second server with the same name is a 409", async () => {
  const { routes } = world();
  await routes(callRoute("/api/mcp/servers", "POST", { name: "demo", command: "npx" }, json).ctx);

  const { ctx, sent } = callRoute("/api/mcp/servers", "POST", { name: "demo", command: "npx" }, json);
  await routes(ctx);

  expect(sent[0]?.status).toBe(409);
});

test("a mutation while the shared lock is held is a 409", async () => {
  const { routes, cfg } = world({ locked: true });
  const { ctx, sent } = callRoute("/api/mcp/servers", "POST", { name: "demo", command: "npx" }, json);

  await routes(ctx);

  expect(sent[0]?.status).toBe(409);
  expect(cfg.mcpServers).toEqual({});
});

test("deleting an unknown server is a 404", async () => {
  const { routes } = world();
  const { ctx, sent } = callRoute("/api/mcp/servers/ghost", "DELETE");

  await routes(ctx);

  expect(sent[0]?.status).toBe(404);
});

test("patching anything but enabled is refused", async () => {
  const { routes } = world();
  await routes(callRoute("/api/mcp/servers", "POST", { name: "demo", command: "npx" }, json).ctx);

  const { ctx, sent } = callRoute("/api/mcp/servers/demo", "PATCH", { enabled: true, command: "rm" }, json);
  await routes(ctx);

  expect(sent[0]?.status).toBe(400);
});

test("deleting a stored server removes it and forgets its sign-in", async () => {
  const { routes, cfg, forgotten } = world();
  await routes(callRoute("/api/mcp/servers", "POST", { name: "demo", command: "npx" }, json).ctx);

  const { ctx, sent } = callRoute("/api/mcp/servers/demo", "DELETE");
  await routes(ctx);

  expect(sent[0]?.status).toBe(200);
  expect(cfg.mcpServers).toEqual({});
  expect(forgotten).toEqual(["demo"]);
});