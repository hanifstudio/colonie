import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createComputerHost, type ContainerBackend } from "../colonie/computer/computer-host.ts";
import { createComputerRoutes } from "./computer.ts";
import { PASS } from "./table.ts";

const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const listen = (server: Server) => new Promise<number>((resolve) => { servers.push(server); server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)); });

/** Stands in for the container's websockify: echoes frames, and only for the right token. */
async function fakeWebsockify(acceptedToken: string) {
  const seen: string[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://x");
    seen.push(`${url.pathname}?token=${url.searchParams.get("token")} cookie=${req.headers.cookie ?? "none"} auth=${req.headers.authorization ?? "none"}`);
    if (url.pathname !== "/websockify" || url.searchParams.get("token") !== acceptedToken) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => { ws.send("RFB 003.008\n"); ws.on("message", (data) => ws.send(data)); });
  });
  return { port: await listen(server), seen };
}

async function app(options: { scopes?: string[]; viewerPort?: number | null; live?: () => boolean } = {}) {
  const backend: ContainerBackend = {
    facts: async () => ({ runtime: "docker", daemonUp: true, imageReady: true, container: "running", foreign: false, stale: false, viewerPort: options.viewerPort ?? null, problem: null }),
    startRuntime: async () => {}, prepareImage: async () => {}, create: async () => {}, start: async () => {}, stop: async () => {}, remove: async () => {},
    exec: async () => "", mcp: () => ({ command: "node", args: [], env: {} }),
  };
  const host = createComputerHost({ backend, token: () => "tokenAAAAAAAAAAAAAAAAAAAAAAAA", gateUrl: () => "http://127.0.0.1:1/api/internal/computer-gate" });
  const routes = createComputerRoutes({ host, botExists: (id) => id === "botA", live: options.live ?? (() => true) });
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "", "http://x");
    const out = await routes.route({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: options.scopes ?? ["admin"] } as never, json: json as never, readBody: (async () => ({})) as never });
    if (out === PASS) json(res, 404, { error: "unrouted" });
  };
  const server = createServer((req, res) => { void handle(req, res); });
  routes.attach(server, handle);
  return { port: await listen(server), host, routes };
}

test("state, on and off are for the owner only, and say what the computer is doing", async () => {
  const { port, host } = await app();
  await host.screen("botA").catch(() => undefined);
  const view = await (await fetch(`http://127.0.0.1:${port}/api/computer`)).json();
  expect(view).toMatchObject({ state: "on" });
  const member = await app({ scopes: ["read"] });
  for (const [method, path] of [["GET", "/api/computer"], ["POST", "/api/computer/on"], ["POST", "/api/computer/off"], ["POST", "/api/computer/screens/botA"]] as const) {
    expect((await fetch(`http://127.0.0.1:${member.port}${path}`, { method })).status, `${method} ${path}`).toBe(403);
  }
  expect((await fetch(`http://127.0.0.1:${port}/api/computer`, { method: "POST" })).status).toBe(405);
  expect((await fetch(`http://127.0.0.1:${port}/api/computer/screens/nobody`, { method: "POST" })).status).toBe(404);
});

test("a screen opens for a real bot and the viewer carries pixels through the server with the secret token kept inside", async () => {
  const upstream = await fakeWebsockify("tokenAAAAAAAAAAAAAAAAAAAAAAAA");
  const { port, host } = await app({ viewerPort: upstream.port });
  expect((await fetch(`http://127.0.0.1:${port}/api/computer/screens/botA`, { method: "POST" })).status).toBe(200);
  expect(host.holds("botA")).toBe(true);
  // noVNC offers "binary"; a browser drops the connection unless the answer names it
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/computer/screens/botA/websockify?token=guess`, ["binary"], { headers: { cookie: "session=secret", authorization: "Bearer secret" } });
  const messages: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on("message", (data) => { messages.push(String(data)); if (messages.length === 1) ws.send("hello"); else resolve(); });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("no data")), 4000);
  });
  expect(messages).toEqual(["RFB 003.008\n", "hello"]);
  expect(ws.protocol).toBe("binary");
  // the browser's own cookie, bearer and query never reach the container; the token is the server's
  expect(upstream.seen).toEqual(["/websockify?token=tokenAAAAAAAAAAAAAAAAAAAAAAAA cookie=none auth=none"]);
  ws.close();
});

test("a viewer for a screen that is not open, or a signed-out session, gets nothing", async () => {
  const upstream = await fakeWebsockify("tokenAAAAAAAAAAAAAAAAAAAAAAAA");
  const closed = await app({ viewerPort: upstream.port });
  const refused = (url: string) => new Promise<string>((resolve) => {
    const ws = new WebSocket(url);
    ws.on("unexpected-response", (_req, res) => resolve(`http ${res.statusCode}`));
    ws.on("open", () => resolve("open"));
    ws.on("error", () => undefined);
    setTimeout(() => resolve("timeout"), 3000);
  });
  expect(await refused(`ws://127.0.0.1:${closed.port}/api/computer/screens/botA/websockify`)).toBe("http 409");
  expect(await refused(`ws://127.0.0.1:${closed.port}/api/computer/screens/nobody/websockify`)).toBe("http 404");
  const expired = await app({ viewerPort: upstream.port, live: () => false });
  await expired.host.screen("botA");
  expect(await refused(`ws://127.0.0.1:${expired.port}/api/computer/screens/botA/websockify`)).toBe("http 401");
  expect(upstream.seen).toEqual([]);
});

test("taking over needs an open viewer; the bot's screen key then says held, and the last viewer closing hands it back", async () => {
  const upstream = await fakeWebsockify("tokenAAAAAAAAAAAAAAAAAAAAAAAA");
  const { port, host } = await app({ viewerPort: upstream.port });
  await host.screen("botA");
  const key = host.mcp("botA")!.env.COLONIE_CONTROL_TOKEN!;
  const ask = async (token: string) => ((await (await fetch(`http://127.0.0.1:${port}/api/internal/computer-gate`, { headers: { authorization: `Bearer ${token}` } })).json()) as { held: boolean }).held;
  const post = (path: string) => fetch(`http://127.0.0.1:${port}/api/computer/screens/botA/${path}`, { method: "POST" });
  // no viewer yet: a hold would have nothing to release it
  expect((await post("take")).status).toBe(409);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/computer/screens/botA/websockify`, ["binary"]);
  await new Promise<void>((resolve, reject) => { ws.on("message", () => resolve()); ws.on("error", reject); setTimeout(() => reject(new Error("no data")), 4000); });
  const taken = (await (await post("take")).json()) as { screens: unknown[] };
  expect(taken.screens).toEqual([{ botId: "botA", taken: true }]);
  expect(host.taken("botA")).toBe(true);
  expect(await ask(key)).toBe(true);
  ws.close();
  await vi.waitFor(() => expect(host.taken("botA")).toBe(false));
  expect(await ask(key)).toBe(false);
});

test("the gate answers only to a screen's own key, and only for GET", async () => {
  const { port, host } = await app();
  await host.screen("botA");
  const gate = (init: RequestInit) => fetch(`http://127.0.0.1:${port}/api/internal/computer-gate`, init);
  expect((await gate({})).status).toBe(401);
  expect((await gate({ headers: { authorization: "Bearer wrongwrongwrongwrongwrong" } })).status).toBe(401);
  expect((await gate({ method: "POST", headers: { authorization: "Bearer wrongwrongwrongwrongwrong" } })).status).toBe(405);
  const member = await app({ scopes: ["read"] });
  expect((await fetch(`http://127.0.0.1:${member.port}/api/computer/screens/botA/take`, { method: "POST" })).status).toBe(403);
  expect((await fetch(`http://127.0.0.1:${member.port}/api/computer/screens/botA/hand-back`, { method: "POST" })).status).toBe(403);
});
