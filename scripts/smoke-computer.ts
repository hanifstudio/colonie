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
import { createComputerHost } from "../server/colonie/computer/computer-host.ts";
import { containerBackend } from "../server/colonie/computer/container-backend.ts";

const folder = process.env.COLONIE_DATA_DIR;
assert(folder && resolve(folder).startsWith(homedir()) && /throwaway|smoke|spike|scratch/i.test(basename(resolve(folder))),
  "set COLONIE_DATA_DIR to a disposable folder under HOME whose name says so (throwaway, smoke, spike or scratch)");

const host = createComputerHost({ backend: containerBackend(), idleMs: 60 * 60_000 });
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

  await host.closeScreen("botA");
  assert.deepEqual((await host.view()).screens.map((screen) => screen.botId), ["botB"]);
  console.log("ok: a screen given back");
} finally {
  await host.turnOff();
  host.dispose();
}
assert.equal((await host.view()).state, "off");
console.log("ok: off. All checks passed.");
process.exit(0);
