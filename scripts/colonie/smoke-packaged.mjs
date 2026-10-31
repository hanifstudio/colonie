// Boot a packaged Mac with disposable settings; never open the owner's data.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const app = resolve(process.argv[2] ?? "release/colonie/mac-arm64/Colonie.app");
const resources = join(app, "Contents", "Resources");
const executable = join(app, "Contents", "MacOS", "Colonie");
await access(executable, constants.X_OK);
for (const retired of ["cua-driver", "cua-sdk", "cua-linux-x64", "android-platform-tools"]) {
  if (existsSync(join(resources, retired))) throw new Error(`Retired Computer helper is packaged: ${retired}`);
}
for (const binary of ["codex-acp/dist/index.js", "claude-acp/index.js", "claude-acp/claude-native", "server/desktop-entry.mjs"]) {
  await access(join(resources, binary), constants.R_OK);
}
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const home = await mkdtemp(join(tmpdir(), "colonie-packaged-home-"));
const data = join(home, "workspace");
await mkdir(data);
// This smoke check never calls an engine or needs a provider login.
await writeFile(join(data, "config.json"), JSON.stringify({ instances: {}, features: { llmThreadTitles: false, autoRecall: false } }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("COLONIE_") && !["COMPOSIO_API_KEY", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"].includes(key)));
Object.assign(env, {
  HOME: home, COLONIE_HOME: home, COLONIE_DATA_DIR: data,
  COLONIE_USER_DATA: join(home, "app"), COLONIE_PROFILE: "1",
  COLONIE_PORT: String(port), COLONIE_SMOKE_TEST: "1",
});
let log = "";
let spawnFailure;
const child = spawn(executable, [], { env, stdio: ["ignore", "pipe", "pipe"] });
const closed = once(child, "close").catch((error) => { spawnFailure = error; });
child.stdout.on("data", (chunk) => { log += chunk; });
child.stderr.on("data", (chunk) => { log += chunk; });
try {
  const deadline = Date.now() + 120_000;
  while (!log.includes("[smoke] renderer-ready ")) {
    if (spawnFailure) throw spawnFailure;
    if (log.includes("[smoke] renderer-failed") || child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      throw new Error(`Packaged renderer did not become ready:\n${log.slice(-6000)}`);
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  const line = log.split("\n").find((entry) => entry.includes("[smoke] renderer-ready "));
  const result = JSON.parse(line.split("[smoke] renderer-ready ")[1]);
  if (result.capabilities.localComputer?.available !== false) throw new Error("Desktop control is still available");
  if (!result.browserOnly) throw new Error("Retired desktop controls remain in the renderer or server config");
  console.log("Packaged Mac renderer, preload, server, browser-only settings, and adapter payloads: passed");
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try { await closed; } finally { clearTimeout(timeout); await rm(home, { recursive: true, force: true }); }
}
