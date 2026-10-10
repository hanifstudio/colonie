import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { initializeColonieData, colonieDataDir } from "../../electron/colonie-config.mjs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Colonie needs Node 24+. Run `nvm use`, or `npm exec --yes --package=node@24.13.1 -- node scripts/devone/start.ts`.");
const root = join(import.meta.dirname, "../..");
const dataDir = colonieDataDir(homedir());
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
const env = { ...process.env, COLONIE_PROFILE: "1", DEVONE_PROFILE: "1", OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(webhookPort), OMB_UI_PORT: String(uiPort),
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
const launch = (command: string, args: string[]) => {
  const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
  children.push(child);
  child.on("error", (error) => { console.error(error); process.exitCode = 1; stop(); });
  child.on("exit", (code) => { if (!stopping) { process.exitCode = code ?? 0; stop(); } });
  return child;
};
launch(process.execPath, [join(root, "server", "index.ts")]);
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
