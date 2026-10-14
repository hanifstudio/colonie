// HTTP-only Linux commissioning check. No agent turn or engine sign-in is requested.
// Run from the app root; all state, homes and sessions are disposable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "colonie-headless-pairing-"));
let child;
let output = "";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (name, details) => console.log(JSON.stringify({ check: name, ...details }));
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const portArg = process.argv.indexOf("--port");
const port = portArg < 0 ? await freePort() : Number(process.argv[portArg + 1]);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
const publicArg = process.argv.indexOf("--public-origin");
const publicOrigin = publicArg < 0 ? null : process.argv[publicArg + 1];
if (publicOrigin) assert.ok(publicOrigin.startsWith("https://"));
const webhookPort = await freePort();
const base = `http://127.0.0.1:${port}`;
async function api(method, path, body, headers = {}, origin = base) {
  const response = await fetch(origin + path, {
    method, headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const setCookie = response.headers.get("set-cookie");
  const bodyText = await response.text();
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { parsed = { raw: bodyText }; }
  return { status: response.status, body: parsed, cookie: setCookie?.split(";", 1)[0], setCookie };
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  await exited;
  clearTimeout(timer);
}
async function start(trust, cli = false) {
  output = "";
  const env = {
    PATH: "/usr/bin:/bin", HOME: root,
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"), TMPDIR: root,
    COLONIE_PROFILE: "1", NODE_ENV: "production", OMB_TEST_SEALED_PATH: "1",
    OMB_DATA_DIR: join(root, cli ? "cli-data" : "data"),
    OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(webhookPort),
    OMB_STATIC_DIR: join(process.cwd(), "dist"), OMB_LOOPBACK_TRUST: trust,
  };
  const args = cli
    ? ["--experimental-strip-types", "server/openmausbot.ts", "serve", "--port", String(port), "--data-dir", env.OMB_DATA_DIR, "--local", "--no-open", "--label", "Disposable pairing fixture"]
    : ["--experimental-strip-types", "server/index.ts"];
  child = spawn(process.execPath, args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`fixture exited: ${child.exitCode}`);
    try {
      if ((await api("GET", "/api/health")).status === 200) return;
    } catch { /* startup */ }
    await delay(250);
  }
  throw new Error("fixture startup timed out");
}
try {
  await mkdir(join(root, "data"));
  report("fixture", { platform: process.platform, arch: process.arch, node: process.version, root, port, webhookPort });
  await start("service");
  for (const path of ["/api/config", "/api/instances", "/api/sessions", "/api/usage"]) {
    const result = await api("GET", path);
    assert.equal(result.status, 403);
    report("service-without-session", { path, status: result.status });
  }
  const refused = await api("POST", "/api/auth/pairing", { label: "Disposable fixture" });
  assert.equal(refused.status, 403);
  report("raw-service-bootstrap", { status: refused.status, error: refused.body.error });
  await stop();

  await start("owner");
  const cookies = {};
  for (const [label, scopes] of [["admin", ["admin", "client"]], ["client", ["client"]]]) {
    const opened = await api("POST", "/api/auth/pairing", { label: `Disposable ${label}`, scopes });
    assert.equal(opened.status, 200);
    const paired = await api("POST", "/api/auth/pair", { code: opened.body.code, label: `Disposable browser ${label}`, cookie: true });
    assert.equal(paired.status, 200);
    assert.ok(paired.cookie);
    assert.deepEqual(paired.body.session.scopes, scopes);
    cookies[label] = paired.cookie;
    report("headless-browser-cookie-pairing", { label, createStatus: opened.status, exchangeStatus: paired.status, scopes });
  }
  assert.equal((await api("GET", "/api/config")).status, 200);
  await stop();

  await start("service");
  assert.equal((await api("GET", "/api/config")).status, 403);
  const admin = await api("GET", "/api/config", undefined, { cookie: cookies.admin });
  assert.equal(admin.status, 200);
  const client = await api("GET", "/api/bots", undefined, { cookie: cookies.client });
  assert.equal(client.status, 200);
  const denied = await api("POST", "/api/auth/pairing", {}, { cookie: cookies.client });
  assert.equal(denied.status, 403);
  const allowed = await api("POST", "/api/auth/pairing", { scopes: ["client"] }, { cookie: cookies.admin });
  assert.equal(allowed.status, 200);
  report("paired-cookies-after-service-restart", { adminConfig: admin.status, clientBots: client.status, clientCreatePairing: denied.status, adminCreatePairing: allowed.status });
  await stop();

  await start("service", true);
  let code;
  for (let attempt = 0; attempt < 40; attempt++) {
    code = output.match(/pairing code:\s+([A-Z0-9-]+)/i)?.[1];
    if (code) break;
    await delay(250);
  }
  assert.ok(code, "CLI serve must print a bootstrap pairing code");
  const paired = await api("POST", "/api/auth/pair", { code, label: "Disposable CLI browser", cookie: true });
  assert.equal(paired.status, 200);
  assert.ok(paired.cookie);
  const cliAdmin = await api("GET", "/api/config", undefined, { cookie: paired.cookie });
  assert.equal(cliAdmin.status, 200);
  assert.equal((await api("POST", "/api/auth/pairing", {})).status, 403);
  report("cli-serve-service-bootstrap", { exchangeStatus: paired.status, pairedConfig: cliAdmin.status, scopes: paired.body.session.scopes, sessionlessCreatePairing: 403 });
  if (publicOrigin) {
    const opened = await api("POST", "/api/auth/pairing", {}, { cookie: paired.cookie });
    assert.equal(opened.status, 200);
    const browser = await api("POST", "/api/auth/pair", { code: opened.body.code, label: "Disposable HTTPS browser", cookie: true }, { origin: publicOrigin }, publicOrigin);
    assert.equal(browser.status, 200);
    assert.ok(browser.cookie);
    assert.match(browser.setCookie, /; Secure\b/i);
    assert.match(browser.setCookie, /; HttpOnly\b/i);
    const headers = { origin: publicOrigin, cookie: browser.cookie };
    assert.equal((await api("GET", "/api/config", undefined, headers, publicOrigin)).status, 200);
    assert.equal((await api("GET", "/api/config", undefined, {}, publicOrigin)).status, 403);
    assert.equal((await api("POST", "/api/auth/pairing", {}, {}, publicOrigin)).status, 403);
    const spoofed = await api("GET", "/api/config", undefined, { host: "localhost", "x-forwarded-proto": "http" }, publicOrigin);
    assert.ok([403, 404, 421].includes(spoofed.status) || (spoofed.status === 200 && spoofed.body.raw === ""), "a spoofed Host must never expose config");
    assert.equal((await api("POST", "/api/auth/pairing", {}, { ...headers, origin: "https://foreign.example.test" }, publicOrigin)).status, 403);
    report("public-https-pairing", { origin: publicOrigin, exchange: browser.status, secureHttpOnlyCookie: true, pairedConfig: 200, sessionlessConfig: 403, sessionlessCreatePairing: 403, spoofedHostStatus: spoofed.status, spoofedHostConfigExposed: false, crossOriginMutation: 403 });
  }
  report("limitations", { realProvider: false, engineSignIn: false, renderer: false, desktop: false, ownerDataAccess: false });
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
  report("fixture-cleanup", { removed: root });
}
