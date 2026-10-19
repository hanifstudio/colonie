import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { initializeColonieData, colonieAppData, colonieUserData } from "../../electron/colonie-config.mjs";
import { activeWorkspace } from "../../electron/local-workspaces.mjs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Colonie needs Node 24+. Run `nvm use`, or `npm exec --yes --package=node@24.13.1 -- node scripts/colonie/start.ts`.");
const root = join(import.meta.dirname, "../..");
// This session runs the workspace the person last chose. The list lives in the
// folder Electron computes for itself — electron/colonie.mjs hands Electron the
// same one — and it is read here because the server child has to start in the
// right directory before the app could ask it to move.
const userData = colonieUserData(colonieAppData(homedir()));
const dataDir = activeWorkspace({ home: homedir(), userData }).dir;
initializeColonieData(dataDir);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
const port = await freePort();
const uiPort = await freePort();
const webhookPort = await freePort();
const env = { ...process.env, COLONIE_PROFILE: "1", COLONIE_USER_DATA: userData, COLONIE_PORT: String(port), COLONIE_WEBHOOK_PORT: String(webhookPort), COLONIE_UI_PORT: String(uiPort),
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, ELECTRON_START_URL: `http://127.0.0.1:${uiPort}` };
delete env.ELECTRON_RUN_AS_NODE;
const children: ChildProcess[] = [];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const launch = (command: string, args: string[], extraEnv: Record<string, string | undefined> = {}) => {
  const child = spawn(command, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: "inherit" });
  children.push(child);
  child.on("error", (error) => { console.error(error); process.exitCode = 1; stop(); });
  child.on("exit", (code) => { if (!stopping) { process.exitCode = code ?? 0; stop(); } });
  return child;
};
// Only the server child is told which directory to run. Handing the same value
// to the Electron process would read there as "the default workspace, here", so
// the app would stop seeing the list it is supposed to switch. An explicit
// COLONIE_DATA_DIR in the shell still reaches both, which is what a rig wants.
launch(process.execPath, [join(root, "server", "index.ts")], { COLONIE_DATA_DIR: dataDir });
launch(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--strictPort"]);
async function waitFor(url: string) {
  const until = Date.now() + 30_000;
  while (!stopping && Date.now() < until) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Startup failed: ${url}`);
}
try {
  await Promise.all([waitFor(`http://127.0.0.1:${port}/api/health`), waitFor(env.ELECTRON_START_URL)]);
  console.log(`Colonie: ${env.ELECTRON_START_URL} · ACP agents · data ${dataDir}`);
  if (!process.argv.includes("--web")) {
    const require = createRequire(import.meta.url);
    launch(require("electron") as string, [root]);
  }
} catch (error) { console.error(error); process.exitCode = 1; stop(); }
