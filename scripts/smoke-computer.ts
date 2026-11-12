// A check against a real Docker or Podman, for a person to run when the computer changes:
//   COLONIE_DATA_DIR=$HOME/computer-smoke-folder node scripts/smoke-computer.ts
// The folder must sit under HOME (a Mac's container VM mounts only HOME) and its name must
// say it is disposable: throwaway, smoke, spike or scratch. It builds the managed image the
// first time, so allow a few minutes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { WebSocket } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createComputerHost } from "../server/colonie/computer/computer-host.ts";
import { containerBackend } from "../server/colonie/computer/container-backend.ts";
import { createComputerRoutes } from "../server/routes/computer.ts";
import { PASS } from "../server/routes/table.ts";

const folder = process.env.COLONIE_DATA_DIR;
assert(folder && resolve(folder).startsWith(homedir()) && /throwaway|smoke|spike|scratch/i.test(basename(resolve(folder))),
  "set COLONIE_DATA_DIR to a disposable folder under HOME whose name says so (throwaway, smoke, spike or scratch)");

// the server's own routes in front of the host, as the app has them, so a person's take over, the
// viewer, and the gate that the bot's screen tools ask all run for real
let gatePort = 0;
const host = createComputerHost({ backend: containerBackend(), idleMs: 60 * 60_000, gateUrl: () => `http://127.0.0.1:${gatePort}/api/internal/computer-gate` });
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const routes = createComputerRoutes({ host, botExists: () => true, live: () => true });
const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "", "http://x");
  const out = await routes.route({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] } as never, json: json as never, readBody: (async () => ({})) as never });
  if (out === PASS) json(res, 404, { error: "unrouted" });
};
const app = createServer((req, res) => { void handle(req, res); });
routes.attach(app, handle);
await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
gatePort = (app.address() as AddressInfo).port;
try {
  await host.turnOn();
  assert.equal((await host.view()).state, "on");
  const a = await host.screen("botA");
  const b = await host.screen("botB");
  assert.deepEqual([a.number, b.number], [2, 3]);
  console.log("ok: two screens", a.number, b.number);

  const viewer = await host.viewer("botA");
  assert(viewer, "a viewer for botA");
  const greeting = (token: string) => new Promise<string>((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${viewer.port}/websockify?token=${token}`, ["binary"]);
    ws.on("message", (data) => { done(String(data).trim()); ws.close(); });
    ws.on("error", () => done("refused"));
    setTimeout(() => done("timeout"), 8000);
  });
  assert.equal(await greeting(a.token), "RFB 003.008");
  assert.equal(await greeting(b.token), "RFB 003.008");
  assert.equal(await greeting("wrongwrongwrongwrongwrong"), "refused");
  console.log("ok: a viewer per screen, a wrong token refused");

  const spec = host.mcp("botB")!;
  const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending += String(chunk);
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    lines.push(...parts.filter(Boolean));
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`no tool list: ${lines.join("\n")}`)), 15_000);
    const poll = setInterval(() => { if (lines.some((line) => line.includes('"id":2'))) { clearTimeout(timer); clearInterval(poll); done(); } }, 100);
  });
  child.kill();
  const tools = (JSON.parse(lines.find((line) => line.includes('"id":2'))!).result.tools as Array<{ name: string }>).map((tool) => tool.name);
  assert(tools.includes("get_desktop_state"));
  console.log("ok: the engine's own command reaches the driver of its screen (", tools.length, "tools )");

  // a person takes over botA: its screen tools are refused until they hand back, and botB is unaffected
  const toolCall = async (botId: string) => {
    const bot = host.mcp(botId)!;
    const proc = spawn(bot.command, bot.args, { env: { ...process.env, ...bot.env }, stdio: ["pipe", "pipe", "pipe"] });
    const out: string[] = [];
    let buffer = "";
    proc.stdout.on("data", (chunk) => { buffer += String(chunk); const parts = buffer.split("\n"); buffer = parts.pop() ?? ""; out.push(...parts.filter(Boolean)); });
    const write = (message: unknown) => proc.stdin.write(`${JSON.stringify(message)}\n`);
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
    write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_screen_size", arguments: {} } });
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no answer: ${out.join("\n")}`)), 20_000);
      const poll = setInterval(() => { if (out.some((line) => line.includes('"id":2'))) { clearTimeout(timer); clearInterval(poll); done(); } }, 100);
    });
    proc.kill();
    return out.find((line) => line.includes('"id":2'))!;
  };
  const post = (path: string) => fetch(`http://127.0.0.1:${gatePort}/api/computer/screens/${path}`, { method: "POST" });
  assert((await toolCall("botA")).includes("1280"), "botA's screen answers while nobody has taken over");
  const watch = new WebSocket(`ws://127.0.0.1:${gatePort}/api/computer/screens/botA/websockify`, ["binary"]);
  await new Promise<void>((done, fail) => { watch.on("message", () => done()); watch.on("error", fail); setTimeout(() => fail(new Error("no viewer")), 10_000); });
  assert.equal((await post("botA/take")).status, 200);
  const refused = await toolCall("botA");
  assert(/NOT performed/.test(refused), `botA is refused while the person drives: ${refused}`);
  assert((await toolCall("botB")).includes("1280"), "botB is not paused by botA's take over");
  assert.equal((await post("botA/hand-back")).status, 200);
  assert((await toolCall("botA")).includes("1280"), "botA works again once handed back");
  assert.equal((await post("botA/take")).status, 200);
  watch.close();
  await new Promise((done) => setTimeout(done, 1500));
  assert.equal(host.taken("botA"), false, "closing the viewer hands the screen back");
  console.log("ok: take over refuses the bot's calls on its own screen only, hand back and closing the viewer return it");

  await host.closeScreen("botA");
  assert.deepEqual((await host.view()).screens.map((screen) => screen.botId), ["botB"]);
  console.log("ok: a screen given back");
} finally {
  await host.turnOff();
  host.dispose();
  routes.closeAll();
  app.close();
}
assert.equal((await host.view()).state, "off");
console.log("ok: off. All checks passed.");
process.exit(0);
