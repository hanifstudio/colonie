import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createColoniePlatformController, colonieAppAuthorizationUrl, coloniePlatformOrigin, coloniePlatformSenderAllowed } from "./colonie-platform.mjs";

test("the native account check controls ownership; a renderer cannot select another account or a filesystem root", async () => {
  const root = mkdtempSync(join(tmpdir(), "colonie-native-platform-"));
  let account = "first-account";
  let stops = 0;
  let opened;
  const controller = createColoniePlatformController({
    origin: "https://platform.example.test", registryFile: join(root, "registry.json"), workspaceDir: join(root, "roots"),
    supervisor: { start: async () => ({ origin: "http://127.0.0.1:12345" }), stopAll: async () => { stops++; return true; } },
    fetch: async (url, options) => {
      assert.equal(url, "https://platform.example.test/api/colonie/auth/get-session");
      assert.equal(options.redirect, "error");
      return new Response(JSON.stringify(account ? { user: { id: account } } : null));
    },
    senderAllowed: (event) => event.allowed === true,
    openLocal: async (result) => { opened = result; },
  });
  try {
    const event = { allowed: true };
    const first = await controller.create(event, { name: "Private one", accountId: "other-account", root: "/not-authorized" });
    assert.equal((await controller.list(event))[0].id, first.id);
    await controller.open(event, first.id);
    assert.equal(opened.id, first.id);
    assert.equal(controller.ownsLocalOrigin("http://127.0.0.1:12345"), true);
    assert.ok(controller.localRoot().startsWith(join(root, "roots")));
    assert.equal(JSON.stringify(controller.info()).includes(join(root, "roots")), false);
    account = "second-account";
    assert.deepEqual(await controller.list(event), []);
    await assert.rejects(() => controller.open(event, first.id), /not available/);
    assert.equal(controller.localRoot(), null);
    assert.ok(stops >= 1);
    account = null;
    await assert.rejects(() => controller.list(event), /Sign in/);
    await assert.rejects(() => controller.create({ allowed: false }, { name: "Foreign page" }), /cannot manage/);
  } finally { await controller.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("a transient account outage preserves Local access, while a revoked account clears it before stopping the child", async () => {
  const root = mkdtempSync(join(tmpdir(), "colonie-native-outage-"));
  const order = [];
  let mode = "authenticated";
  const controller = createColoniePlatformController({
    origin: "https://platform.example.test", registryFile: join(root, "registry.json"), workspaceDir: join(root, "roots"),
    supervisor: { start: async () => ({ origin: "http://127.0.0.1:12345" }), stopAll: async () => { order.push("stop"); } },
    fetch: async () => {
      if (mode === "outage") throw new Error("synthetic network outage");
      if (mode === "unavailable") return new Response("", { status: 503 });
      return Response.json(mode === "authenticated" ? { user: { id: "account" } } : null);
    },
    senderAllowed: () => true,
    invalidateLocal: () => { order.push("invalidate"); }, openCloud: async () => { order.push("cloud"); },
  });
  try {
    const workspace = await controller.create({}, { name: "Local" });
    await controller.open({}, workspace.id);
    const original = controller.localRoot();
    for (mode of ["outage", "unavailable"]) {
      await assert.rejects(() => controller.list({}), /cannot/);
      assert.equal(controller.localRoot(), original);
      assert.deepEqual(order, []);
    }
    mode = "revoked";
    await assert.rejects(() => controller.list({}), /Sign in/);
    assert.equal(controller.localRoot(), null);
    assert.deepEqual(order, ["invalidate", "stop", "cloud"]);
  } finally { await controller.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("sign-out during a pending Local launch cannot reopen the workspace with stale authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "colonie-native-race-"));
  let finish;
  let started;
  const admitted = new Promise((done) => { started = done; });
  const launch = new Promise((done) => { finish = done; });
  let opened = 0;
  const controller = createColoniePlatformController({
    origin: "https://platform.example.test", registryFile: join(root, "registry.json"), workspaceDir: join(root, "roots"),
    supervisor: { start: async () => { started(); await launch; return { origin: "http://127.0.0.1:12345" }; }, stopAll: async () => {} },
    fetch: async () => Response.json({ user: { id: "account" } }), senderAllowed: () => true,
    openLocal: async () => { opened++; },
  });
  try {
    const workspace = await controller.create({}, { name: "Local" });
    const pending = controller.open({}, workspace.id);
    await admitted;
    await controller.signOut({});
    finish();
    await assert.rejects(() => pending, /account changed/);
    assert.equal(opened, 0);
    assert.equal(controller.localRoot(), null);
  } finally { await controller.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("explicit legacy adoption preserves data in place and cannot assign the same root to another account", async () => {
  const root = mkdtempSync(join(tmpdir(), "colonie-native-adoption-"));
  const legacyRoot = join(root, "existing");
  mkdirSync(legacyRoot);
  writeFileSync(join(legacyRoot, "config.json"), "SYNTHETIC_EXISTING_BYTES");
  let accountId = "owner-one";
  let migrations = 0;
  const controller = createColoniePlatformController({
    origin: "https://platform.example.test", registryFile: join(root, "registry.json"), workspaceDir: join(root, "roots"),
    supervisor: { stopAll: async () => {} }, fetch: async () => Response.json({ user: { id: accountId } }), senderAllowed: () => true,
    legacyRoot, legacyAvailable: () => true, adoptLocal: async () => { migrations++; },
  });
  try {
    const first = await controller.adoptExisting({});
    assert.equal((await controller.adoptExisting({})).id, first.id);
    assert.equal(readFileSync(join(legacyRoot, "config.json"), "utf8"), "SYNTHETIC_EXISTING_BYTES");
    accountId = "owner-two";
    await assert.rejects(() => controller.adoptExisting({}), /another account/);
    assert.equal(migrations, 2);
    assert.deepEqual(await controller.list({}), []);
  } finally { await controller.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("native app sign-in accepts a Composio HTTPS page only after the current account check", async () => {
  assert.equal(new URL(colonieAppAuthorizationUrl("https://connect.composio.dev/link/fixture")).hostname, "connect.composio.dev");
  for (const url of ["https://foreign.example.test", "http://connect.composio.dev", "https://connect.composio.dev@foreign.example.test", "https://user:password@connect.composio.dev/link"]) {
    assert.throws(() => colonieAppAuthorizationUrl(url));
  }
});

test("only the current main frame at the fixed platform or selected Local origin can call native workspace IPC", () => {
  const frame = { url: "https://platform.example.test/invite/hello" };
  const contents = { mainFrame: frame };
  const origins = { platformOrigin: "https://platform.example.test", localOrigin: "http://127.0.0.1:12345" };
  assert.equal(coloniePlatformSenderAllowed({ sender: contents, senderFrame: frame }, contents, origins), true);
  assert.equal(coloniePlatformSenderAllowed({ sender: contents, senderFrame: { url: frame.url } }, contents, origins), false);
  frame.url = "https://foreign.example.test/";
  assert.equal(coloniePlatformSenderAllowed({ sender: contents, senderFrame: frame }, contents, origins), false);
  frame.url = "http://127.0.0.1:12345/";
  assert.equal(coloniePlatformSenderAllowed({ sender: contents, senderFrame: frame }, contents, origins), true);
  frame.url = "http://127.0.0.1:12346/";
  assert.equal(coloniePlatformSenderAllowed({ sender: contents, senderFrame: frame }, contents, origins), false);
  assert.throws(() => coloniePlatformOrigin("http://public.example.test"));
  assert.throws(() => coloniePlatformOrigin("https://platform.example.test/untrusted/path"));
});
