// Explicit, bounded HTTP -> ACP -> real-provider check; never initiates login.
// Run under a read-only systemd sandbox for the authentication donor directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (!process.argv.includes("--real")) throw new Error("Pass --real to request one bounded turn per provider using existing CLI authentication.");
const authIndex = process.argv.indexOf("--auth-root");
if (authIndex < 0 || !process.argv[authIndex + 1]) throw new Error("An explicit --auth-root is required.");
const authRoot = resolve(process.argv[authIndex + 1]);
const providerIndex = process.argv.indexOf("--provider");
const providers = providerIndex < 0 ? ["codex-acp", "claude-acp"] : [process.argv[providerIndex + 1]];
assert.ok(providers.every((provider) => ["codex-acp", "claude-acp"].includes(provider)), "--provider must be codex-acp or claude-acp");
const root = await mkdtemp(join(tmpdir(), "colonie-real-turn-"));
const dataDir = join(root, "data");
const home = join(root, "home");
const report = (check, result) => console.log(JSON.stringify({ check, ...result }));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let child;
let log = "";
let base;
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function api(method, path, body) {
  const response = await fetch(base + path, {
    method, headers: { "content-type": "application/json", origin: base },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}: ${result.error ?? "request failed"}`);
  return result;
}
try {
  await mkdir(home);
  for (const dir of ["codex", "claude"]) await mkdir(join(dataDir, "native", dir), { recursive: true });
  // The native CLIs read their existing login files through these links.
  // No credential bytes are read, copied, logged or handled by this script.
  await symlink(join(authRoot, "codex", "auth.json"), join(dataDir, "native", "codex", "auth.json"));
  await symlink(join(authRoot, "claude", ".credentials.json"), join(dataDir, "native", "claude", ".credentials.json"));
  await writeFile(join(dataDir, "config.json"), JSON.stringify({
    defaultModelSelection: { instanceId: "codex-acp", model: "agent-default" },
    instances: {
      "codex-acp": { driver: "codex-acp", displayName: "Codex real-turn fixture" },
      "claude-acp": { driver: "claude-acp", displayName: "Claude real-turn fixture" },
    },
  }));
  const port = await freePort();
  const webhookPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin", HOME: home, TMPDIR: root,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"),
      NODE_ENV: "production", COLONIE_PROFILE: "1", OMB_TEST_SEALED_PATH: "1",
      OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(webhookPort), OMB_LOOPBACK_TRUST: "owner",
      OMB_STATIC_DIR: join(process.cwd(), "dist"),
    },
  });
  child.stdout.on("data", (chunk) => { log = (log + chunk).slice(-100_000); });
  child.stderr.on("data", (chunk) => { log = (log + chunk).slice(-100_000); });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`fixture server exited ${child.exitCode}`);
    try { if ((await api("GET", "/api/health")).app === "openmausbot") { ready = true; break; } } catch { /* startup */ }
    await delay(250);
  }
  assert.ok(ready, "fixture server must become ready");
  report("fixture", { platform: process.platform, arch: process.arch, node: process.version, root, dataDir, port, webhookPort, authRoot });
  const instances = (await api("GET", "/api/instances")).instances;
  report("engine-status", { instances: instances.map((entry) => ({ instanceId: entry.instanceId, state: entry.snapshot.state, authenticated: entry.snapshot.authenticated })) });
  for (const provider of providers) {
    const workspace = join(root, `${provider}-workspace`);
    await mkdir(workspace);
    const { bot } = await api("POST", "/api/bots", {
      name: `${provider} commissioning fixture`, cwd: workspace,
      modelSelection: { instanceId: provider, model: "agent-default" },
    });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", approvalMode: "ask" });
    const marker = provider === "codex-acp" ? "COLONIE_CODEX_LINUX_OK" : "COLONIE_CLAUDE_LINUX_OK";
    const text = `Reply with exactly ${marker}. Do not use tools, read files, write files, or make network requests. This is a bounded connectivity test.`;
    const previousIds = new Set((await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages.map((row) => row.id));
    const started = Date.now();
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
    let receipt;
    let messages;
    while (Date.now() - started < 90_000) {
      const receipts = (await api("GET", `/api/bots/${bot.id}/acp-inputs?threadId=${bot.threadId}`)).receipts;
      receipt = receipts.at(-1);
      messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages;
      const request = messages.find((row) => row.card?.requestId && !row.card.answered);
      if (request) {
        await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: request.card.requestId, behavior: "deny" });
        throw new Error(`${provider} unexpectedly requested tool permission`);
      }
      if (receipt && receipt.status !== "dispatching") break;
      await delay(300);
    }
    if (!receipt || receipt.status === "dispatching") {
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
      throw new Error(`${provider} exceeded the 90-second bound`);
    }
    const answer = messages.filter((row) => !previousIds.has(row.id) && row.role === "bot" && row.kind === "text").map((row) => row.text).join("\n").trim();
    report("real-turn", { provider, elapsedMs: Date.now() - started, input: text, answer, receipt });
    assert.equal(receipt.status, "completed", receipt.error ?? `${provider} did not complete`);
    assert.ok(receipt.cwd.startsWith(root + "/"), "provider workspace must remain disposable");
    assert.deepEqual(receipt.prompt.at(-1), { type: "text", text });
    assert.equal(answer, marker);
  }
  report("result", { ok: true, realProviders: providers, renderer: false, desktop: false, productionConversation: false });
} catch (error) {
  report("result", { ok: false, error: error.message, serverLogRetainedInMemoryOnly: log.length > 0 });
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    await exited;
    clearTimeout(timer);
  }
  await rm(root, { recursive: true, force: true });
  report("fixture-cleanup", { removed: root });
}
