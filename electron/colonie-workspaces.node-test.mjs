import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LOCAL_WORKSPACE_MODE,
  WORKSPACE_OWNER_MESSAGE,
  activeWorkspaceId,
  adoptWorkspace,
  childProcessLauncher,
  createColonieWorkspaces,
  createLocalWorkspaceSupervisor,
  deliverOwnerCapability,
  emptyWorkspaceRegistry,
  localWorkspaceEnvironment,
  nativeProvidersDir,
  newOwnerToken,
  parseWorkspaceRegistry,
  pickLoopbackPort,
  readWorkspaceRegistry,
  registerWorkspace,
  serializeWorkspaceRegistry,
  setActiveWorkspace,
  stopWorkspaceProcess,
  workspaceForAccount,
  workspaceRootPath,
  workspaceSummary,
  workspacesForAccount,
  writeWorkspaceRegistry,
} from "./colonie-workspaces.mjs";

const FIXTURE = new URL("../scripts/colonie/local-workspaces/fixture-server.mjs", import.meta.url).pathname;
const TOKEN = "T".repeat(43);
const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
const roots = [];

function temporaryDirectory(name = "workspaces") {
  const root = mkdtempSync(join(tmpdir(), "colonie-workspaces-"));
  roots.push(root);
  const baseDir = join(root, name);
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  return { root, baseDir };
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const registryFile = (dir) => join(dir, "workspace-registry.json");
const fixtureEntry = join(FIXTURE);
// Set by the failure-mode tests; the environment builder forwards it explicitly
// because nothing outside the allowlist reaches the child.
let fixtureMode = "serve";

function fixtureEnvironment({ root, port }) {
  return localWorkspaceEnvironment({
    port,
    root,
    // A throwaway static marker: the fixture answers `static: true` itself.
    staticDir: join(root, "ui"),
    extra: { COLONIE_FIXTURE_MODE: fixtureMode },
  });
}

/** A supervisor wired to the isolated fixture server on an ephemeral port. */
function fixtureSupervisor({ ownerToken = TOKEN, desktopManaged = true, ipc = true, bootTimeoutMs = 10_000 } = {}) {
  return createLocalWorkspaceSupervisor({
    launch: childProcessLauncher({ entry: fixtureEntry, ipc, stdio: ["ignore", "ignore", "ignore", "ipc"] }),
    environment: fixtureEnvironment,
    ownerToken,
    desktopManaged,
    bootTimeoutMs,
    probe: async ({ port, pid, bootTimeoutMs: budget, isExited }) => {
      const started = Date.now();
      for (;;) {
        if (isExited()) return { outcome: "exited" };
        if (Date.now() - started > budget) return { outcome: "timeout" };
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(250) });
          const body = await res.json();
          if (res.ok && body.app === "openmausbot" && body.pid === pid() && body.static) return { outcome: "ready" };
          return { outcome: "foreign-owner" };
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    },
  });
}

test("a damaged or hostile registry file is no registry, and never a path leak", () => {
  assert.deepEqual(parseWorkspaceRegistry("{ not json"), emptyWorkspaceRegistry());
  assert.deepEqual(parseWorkspaceRegistry(null), emptyWorkspaceRegistry());
  assert.deepEqual(parseWorkspaceRegistry({ version: 9, workspaces: "nope" }), emptyWorkspaceRegistry());
  const parsed = parseWorkspaceRegistry({
    version: 1,
    accounts: { [ACCOUNT_A]: { activeWorkspaceId: "w1" }, "bad account": { activeWorkspaceId: "w1" } },
    workspaces: [
      { id: "w1", accountId: ACCOUNT_A, name: "  Work   laptop  ", root: "/tmp/a", mode: "cloud" },
      { id: "w1", accountId: ACCOUNT_A, name: "duplicate", root: "/tmp/b" },
      { id: "w2", accountId: "bad account", name: "bad account id", root: "/tmp/c" },
      { id: "w3", accountId: ACCOUNT_A, name: "relative", root: "tmp/d" },
      { id: "w4", accountId: ACCOUNT_A, name: "newline", root: "/tmp/e\nf" },
      { id: "w5", accountId: ACCOUNT_B, name: "", root: "/tmp/g" },
      null,
    ],
  });
  // Mode is Local here: this module never registers a Cloud workspace.
  assert.deepEqual(parsed.workspaces.map((entry) => [entry.id, entry.name, entry.mode]), [
    ["w1", "Work laptop", LOCAL_WORKSPACE_MODE],
    ["w5", "Local workspace", LOCAL_WORKSPACE_MODE],
  ]);
  assert.deepEqual(parsed.accounts, { [ACCOUNT_A]: { activeWorkspaceId: "w1" } });
  // An active pick that names another account's workspace is dropped.
  const crossed = parseWorkspaceRegistry({
    accounts: { [ACCOUNT_A]: { activeWorkspaceId: "w9" } },
    workspaces: [{ id: "w9", accountId: ACCOUNT_B, name: "B only", root: "/tmp/b" }],
  });
  assert.deepEqual(crossed.accounts, {});
  assert.equal(activeWorkspaceId(crossed, ACCOUNT_A), null);
  assert.equal(activeWorkspaceId(crossed, ACCOUNT_B), null);
});

test("registering is stable and idempotent per account and root", () => {
  const { baseDir } = temporaryDirectory();
  const root = workspaceRootPath(baseDir, "w1");
  const first = registerWorkspace(null, { accountId: ACCOUNT_A, name: "First", root }, () => "w1");
  assert.equal(first.changed, true);
  assert.equal(first.workspace.mode, LOCAL_WORKSPACE_MODE);
  // The first registered workspace becomes the account's active one.
  assert.equal(activeWorkspaceId(first.state, ACCOUNT_A), "w1");
  const again = registerWorkspace(first.state, { accountId: ACCOUNT_A, name: "Renamed", root }, () => "w2");
  assert.equal(again.changed, false);
  assert.equal(again.workspace.id, "w1");
  assert.equal(again.workspace.name, "First");
  assert.deepEqual(again.state, first.state);
  // A second account cannot adopt the first account's private data root.
  assert.throws(() => registerWorkspace(first.state, { accountId: ACCOUNT_B, name: "Second", root }, () => "w2"), /another account/);
  const other = registerWorkspace(first.state, { accountId: ACCOUNT_B, name: "Second", root: workspaceRootPath(baseDir, "w2") }, () => "w2");
  assert.equal(other.workspace.id, "w2");
  assert.equal(activeWorkspaceId(other.state, ACCOUNT_B), "w2");
  assert.equal(activeWorkspaceId(other.state, ACCOUNT_A), "w1");
  assert.throws(() => registerWorkspace(first.state, { accountId: "", name: "x", root }, () => "w3"), /signed-in account/);
  assert.throws(() => registerWorkspace(first.state, { accountId: ACCOUNT_A, name: "x", root: "rel" }, () => "w3"), /directory/);
  assert.throws(() => registerWorkspace(first.state, { accountId: ACCOUNT_A, name: "x", root: "/tmp/x" }, () => "not valid!"), /stable id/);
  assert.throws(() => registerWorkspace(first.state, { accountId: ACCOUNT_A, name: "x", root: "/tmp/x" }, () => "w1"), /stable id/);
  assert.throws(() => workspaceRootPath(baseDir, "bad id"), /base directory/);
});

test("an adopted workspace keeps its directory in place and is never moved", () => {
  const { root: parent, baseDir } = temporaryDirectory();
  const legacy = join(parent, "legacy-local-data");
  mkdirSync(join(legacy, "native"), { recursive: true });
  writeFileSync(join(legacy, "config.json"), "{}\n", { mode: 0o600 });
  const { state, workspace } = adoptWorkspace(null, { accountId: ACCOUNT_A, name: "This computer", root: legacy }, () => "legacy");
  assert.equal(workspace.root, legacy);
  assert.equal(workspace.adopted, true);
  assert.equal(activeWorkspaceId(state, ACCOUNT_A), "legacy");
  // Nothing moved and nothing was read out of it.
  assert.equal(readFileSync(join(legacy, "config.json"), "utf8"), "{}\n");
  assert.equal(nativeProvidersDir(legacy), join(legacy, "native"));
  assert.equal(workspaceRootPath(baseDir, "legacy"), join(baseDir, "legacy"));
});

test("an account change does not surface the previous account's Local roots", () => {
  const { baseDir } = temporaryDirectory();
  const a = registerWorkspace(null, { accountId: ACCOUNT_A, name: "A", root: workspaceRootPath(baseDir, "wa") }, () => "wa");
  const b = registerWorkspace(a.state, { accountId: ACCOUNT_B, name: "B", root: workspaceRootPath(baseDir, "wb") }, () => "wb");
  assert.deepEqual(workspacesForAccount(b.state, ACCOUNT_A), [{ id: "wa", name: "A", mode: "local", active: true }]);
  assert.deepEqual(workspacesForAccount(b.state, ACCOUNT_B), [{ id: "wb", name: "B", mode: "local", active: true }]);
  // A summary carries no root: a renderer is told where to load, not where data lives.
  assert.equal(JSON.stringify(workspacesForAccount(b.state, ACCOUNT_A)).includes(baseDir), false);
  assert.equal(workspaceForAccount(b.state, ACCOUNT_B, "wa"), null);
  assert.equal(workspaceForAccount(b.state, ACCOUNT_A, "wb"), null);
  assert.throws(() => setActiveWorkspace(b.state, ACCOUNT_B, "wa"), /not available in this account/);
  assert.deepEqual(workspacesForAccount(b.state, "nobody"), []);
  assert.equal(workspaceSummary(b.state, ACCOUNT_A, "wb"), null);
  assert.deepEqual(workspaceSummary(b.state, ACCOUNT_A, "wa"), { id: "wa", name: "A", mode: "local", active: true });
});

test("the registry file round-trips atomically and tolerates a missing file", () => {
  const { root } = temporaryDirectory();
  const file = registryFile(root);
  assert.deepEqual(readWorkspaceRegistry(file), emptyWorkspaceRegistry());
  const state = registerWorkspace(null, { accountId: ACCOUNT_A, name: "One", root: "/tmp/one" }, () => "w1").state;
  writeWorkspaceRegistry(file, state);
  assert.deepEqual(readWorkspaceRegistry(file), state);
  assert.match(readFileSync(file, "utf8"), /"activeWorkspaceId": "w1"/);
  // Only complete files ever appear under the registry's own name.
  writeWorkspaceRegistry(file, parseWorkspaceRegistry(serializeWorkspaceRegistry(state)));
  assert.deepEqual(readWorkspaceRegistry(file).workspaces.map((w) => w.id), ["w1"]);
});

test("the child environment is built from an allowlist, never inherited secrets", () => {
  const env = localWorkspaceEnvironment({
    port: 18799,
    root: "/tmp/workspace-root",
    env: {
      PATH: "/usr/bin", HOME: "/Users/person", TMPDIR: "/var/tmp", LANG: "en_US.UTF-8",
      // This app's and the launch shell's secrets must not reach the child.
      COMPOSIO_API_KEY: "app-global-key", OPENAI_API_KEY: "provider-key", ANTHROPIC_API_KEY: "provider-key",
      COLONIE_COMPOSIO_CREDENTIAL_SOURCE: "secure-store", OMB_DESKTOP_PARENT: "0", DEVONE_PROFILE: "1",
      GITHUB_TOKEN: "platform-token", AWS_SECRET_ACCESS_KEY: "platform-token", OMB_USER_DATA: "/Users/person/Library",
    },
    staticDir: "/Applications/Colonie.app/Contents/Resources/ui",
    resourcesPath: "/Applications/Colonie.app/Contents/Resources",
    skillsDir: "/Applications/Colonie.app/Contents/Resources/skills",
    appVersion: "0.1.0",
    extra: { DEVONE_ACP_ENTRY: "/res/codex-acp/dist/index.js" },
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "COLONIE_PROFILE", "DEVONE_ACP_ENTRY", "HOME", "LANG", "OMB_APP_VERSION", "OMB_DATA_DIR",
    "OMB_DESKTOP_PARENT", "OMB_PORT", "OMB_RESOURCES_PATH", "OMB_SKILLS_DIR", "OMB_STATIC_DIR",
    "PATH", "TMPDIR",
  ]);
  assert.equal(env.COLONIE_PROFILE, "1");
  assert.equal(env.OMB_DATA_DIR, "/tmp/workspace-root");
  assert.equal(env.OMB_PORT, "18799");
  // Secure default: the child starts fail-closed until the owner capability arrives.
  assert.equal(env.OMB_DESKTOP_PARENT, "1");
  assert.equal(env.DEVONE_PROFILE, undefined, "the child is Colonie, not the legacy profile");
  assert.ok(Object.isFrozen(env));
  assert.throws(() => localWorkspaceEnvironment({ port: 1, root: "/tmp/r", extra: { COMPOSIO_API_KEY: "x" } }), /must not inherit COMPOSIO_API_KEY/);
  assert.throws(() => localWorkspaceEnvironment({ port: 1, root: "/tmp/r", extra: { OPENAI_API_KEY: "x" } }), /must not inherit OPENAI_API_KEY/);
  assert.throws(() => localWorkspaceEnvironment({ port: 0, root: "/tmp/r" }), /loopback port/);
  assert.throws(() => localWorkspaceEnvironment({ port: 18799, root: "rel" }), /data directory/);
  // Control values cannot be redirected through `extra`.
  const widened = localWorkspaceEnvironment({ port: 18799, root: "/tmp/r", extra: { OMB_DATA_DIR: "/tmp/other", OMB_DESKTOP_PARENT: "0" } });
  assert.equal(widened.OMB_DATA_DIR, "/tmp/r");
  assert.equal(widened.OMB_DESKTOP_PARENT, "1");
  assert.equal(localWorkspaceEnvironment({ port: 18799, root: "/tmp/r", desktopManaged: false }).OMB_DESKTOP_PARENT, undefined);
});

test("only this workspace's own vault secrets reach the child environment", () => {
  const appEnv = { PATH: "/usr/bin", COMPOSIO_API_KEY: "app-global-key", XAI_API_KEY: "app-global-xai" };
  // With no workspace vault record, no secret at all is present.
  const bare = localWorkspaceEnvironment({ port: 18799, root: "/tmp/r", env: appEnv });
  assert.equal(bare.COMPOSIO_API_KEY, undefined);
  assert.equal(bare.XAI_API_KEY, undefined);
  // With this workspace's vault, only its own values arrive.
  const env = localWorkspaceEnvironment({
    port: 18799,
    root: "/tmp/r",
    env: appEnv,
    credentials: { xaiApiKey: "xai-workspace", composioApiKey: "ak_workspace" },
  });
  assert.equal(env.COMPOSIO_API_KEY, "ak_workspace");
  assert.equal(env.XAI_API_KEY, "xai-workspace");
  assert.equal(env.COLONIE_COMPOSIO_CREDENTIAL_SOURCE, "workspace-vault");
  assert.equal(env.COLONIE_COMPOSIO_CREDENTIAL_ORIGIN, "local-workspace");
});

test("the owner capability travels over the child's private port only", () => {
  assert.equal(deliverOwnerCapability({ postMessage: (m) => assert.deepEqual(m, { type: WORKSPACE_OWNER_MESSAGE, token: TOKEN }) }, TOKEN), "postMessage");
  const sent = [];
  assert.equal(deliverOwnerCapability({ send: (m) => sent.push(m) }, TOKEN), "send");
  assert.deepEqual(sent, [{ type: WORKSPACE_OWNER_MESSAGE, token: TOKEN }]);
  assert.throws(() => deliverOwnerCapability({}, TOKEN), /cannot receive the desktop owner capability/);
  assert.throws(() => deliverOwnerCapability({ postMessage: () => {} }, "short"), /desktop owner token/);
  assert.match(newOwnerToken(), /^[A-Za-z0-9_-]{43}$/);
});

test("a supervisor without an injector or owner token refuses to exist", async () => {
  assert.throws(() => createLocalWorkspaceSupervisor({}), /process injector/);
  assert.throws(() => createLocalWorkspaceSupervisor({ launch: () => {} }), /environment builder/);
  assert.throws(() => createLocalWorkspaceSupervisor({ launch: () => {}, environment: () => ({}) }), /desktop owner token/);
  // Tests may opt out of the desktop protocol explicitly.
  const supervisor = createLocalWorkspaceSupervisor({ launch: () => {}, environment: () => ({}), desktopManaged: false });
  assert.equal(supervisor.running("w1"), false);
  assert.equal(supervisor.origin("w1"), null);
  assert.equal(await supervisor.stopAll(), false);
});

test("one controlled server child per Local workspace, started and reaped safely", async (t) => {
  const { baseDir } = temporaryDirectory();
  const supervisor = fixtureSupervisor({ root: baseDir });
  t.after(() => supervisor.stopAll());
  const workspace = { id: "w1", root: join(baseDir, "w1") };
  mkdirSync(workspace.root, { recursive: true, mode: 0o700 });

  const started = await supervisor.start(workspace);
  assert.equal(started.origin, `http://127.0.0.1:${started.port}`);
  assert.ok(started.pid > 0);
  assert.equal(supervisor.running("w1"), true);
  assert.equal(supervisor.origin("w1"), started.origin);
  // The owner capability reached the real child over its private port.
  assert.deepEqual(JSON.parse(readFileSync(join(workspace.root, "fixture-message"), "utf8")), { type: WORKSPACE_OWNER_MESSAGE, token: TOKEN });
  // The environment the child saw carried only workspace control values.
  assert.equal(readFileSync(join(workspace.root, "fixture-started"), "utf8").trim(), String(started.pid));
  assert.deepEqual(JSON.parse(readFileSync(join(workspace.root, "fixture-env"), "utf8")), {
    dataDir: workspace.root,
    profile: "1",
    desktopParent: "1",
    hasXai: null,
    hasComposio: null,
  });

  // Opening the same workspace again rejoins the same child: no sibling.
  const again = await supervisor.start(workspace);
  assert.deepEqual(again, started);
  // A concurrent open joins one boot rather than forking twice.
  assert.deepEqual(await Promise.all([supervisor.start(workspace), supervisor.start(workspace)]), [started, started]);

  const pid = started.pid;
  assert.equal(await supervisor.stop("w1"), true);
  assert.equal(supervisor.running("w1"), false);
  assert.equal(await supervisor.stop("w1"), false);
  assert.equal(await exited(pid), true, "the child is gone, not merely detached");
});

async function exited(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test("a workspace server that dies is not reused, and a failed boot leaves nothing behind", async (t) => {
  const { baseDir } = temporaryDirectory();
  const supervisor = fixtureSupervisor({ root: baseDir });
  t.after(() => supervisor.stopAll());
  const workspace = { id: "w1", root: join(baseDir, "w1") };
  mkdirSync(workspace.root, { recursive: true, mode: 0o700 });
  const first = await supervisor.start(workspace);
  process.kill(first.pid, "SIGKILL");
  await exited(first.pid);
  assert.equal(await until(() => supervisor.running("w1") === false), true);
  const second = await supervisor.start(workspace);
  assert.notEqual(second.pid, first.pid);

  // A child that exits before it listens: refused, and its port is free again.
  const dead = { id: "w2", root: join(baseDir, "w2") };
  mkdirSync(dead.root, { recursive: true, mode: 0o700 });
  const launching = createLocalWorkspaceSupervisor({
    launch: childProcessLauncher({ entry: fixtureEntry, ipc: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }),
    environment: fixtureEnvironment,
    ownerToken: TOKEN,
    bootTimeoutMs: 2_000,
  });
  fixtureMode = "exit";
  await assert.rejects(launching.start(dead), /did not start/);
  fixtureMode = "serve";
  assert.equal(launching.running("w2"), false);
  assert.equal(await launching.stopAll(), false);
});

test("a child that cannot take the owner capability is refused and reaped", async () => {
  const { baseDir } = temporaryDirectory();
  const supervisor = createLocalWorkspaceSupervisor({
    // No ipc channel: the child has no private port for the capability.
    launch: childProcessLauncher({ entry: fixtureEntry }),
    environment: fixtureEnvironment,
    ownerToken: TOKEN,
    bootTimeoutMs: 2_000,
  });
  const workspace = { id: "w1", root: join(baseDir, "w1") };
  mkdirSync(workspace.root, { recursive: true, mode: 0o700 });
  await assert.rejects(supervisor.start(workspace), /cannot receive the desktop owner capability/);
  assert.equal(supervisor.running("w1"), false);
});

test("a boot that never answers is abandoned instead of leaving a child behind", async () => {
  const { baseDir } = temporaryDirectory();
  const supervisor = createLocalWorkspaceSupervisor({
    launch: childProcessLauncher({ entry: fixtureEntry, ipc: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }),
    environment: fixtureEnvironment,
    ownerToken: TOKEN,
    bootTimeoutMs: 300,
  });
  const workspace = { id: "w1", root: join(baseDir, "w1") };
  mkdirSync(workspace.root, { recursive: true, mode: 0o700 });
  fixtureMode = "hang";
  await assert.rejects(supervisor.start(workspace), /did not start/);
  fixtureMode = "serve";
  assert.equal(supervisor.running("w1"), false);
});

test("stopping is safe for a child that already exited on its own", async () => {
  assert.equal(await stopWorkspaceProcess(null), true);
  assert.equal(await stopWorkspaceProcess({ kill: () => { throw new Error("gone"); } }), true);
  const port = await pickLoopbackPort();
  assert.ok(port > 1024 && port < 65536);
});

test("only this workspace's own vault secrets reach its child, read before the start", async (t) => {
  const { baseDir } = temporaryDirectory();
  const supervisor = createLocalWorkspaceSupervisor({
    launch: childProcessLauncher({ entry: fixtureEntry, ipc: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }),
    // A caller reads this workspace's vault first, so the environment may be async.
    environment: async ({ root, port }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return localWorkspaceEnvironment({
        port,
        root,
        staticDir: join(root, "ui"),
        env: { PATH: process.env.PATH, COMPOSIO_API_KEY: "app-global-key" },
        extra: { COLONIE_FIXTURE_MODE: "serve" },
        credentials: { xaiApiKey: "xai-workspace", composioApiKey: "ak_workspace" },
      });
    },
    ownerToken: TOKEN,
  });
  t.after(() => supervisor.stopAll());
  const workspace = { id: "w1", root: join(baseDir, "w1") };
  mkdirSync(workspace.root, { recursive: true, mode: 0o700 });
  const started = await supervisor.start(workspace);
  assert.deepEqual(supervisor.origins(), [started.origin]);
  const seen = JSON.parse(readFileSync(join(workspace.root, "fixture-env"), "utf8"));
  assert.equal(seen.dataDir, workspace.root);
  assert.equal(seen.profile, "1");
  // This workspace's own keys arrived; the app's global key did not.
  assert.equal(seen.hasXai, "xai-workspace");
  assert.equal(seen.hasComposio, "ak_workspace");
  assert.equal(readFileSync(join(workspace.root, "fixture-started"), "utf8").trim(), String(started.pid));
});

function localWorkspaces({ baseDir, account = () => ACCOUNT_A, ownerToken = TOKEN } = {}) {
  const file = registryFile(baseDir);
  const supervisor = fixtureSupervisor({ ownerToken, root: baseDir });
  const workspaces = createColonieWorkspaces({ file, baseDir, supervisor, accountId: account });
  return { file, workspaces, supervisor };
}

test("create, list and open one account's Local workspaces, with only origin/id/name", async (t) => {
  const { baseDir } = temporaryDirectory();
  const { file, workspaces } = localWorkspaces({ baseDir });
  t.after(() => workspaces.shutdown());

  assert.deepEqual(workspaces.list(), []);
  const created = workspaces.create({ name: "  Work   laptop " });
  assert.equal(created.name, "Work laptop");
  assert.equal(created.active, true);
  assert.deepEqual(workspaces.list(), [{ id: created.id, name: "Work laptop", mode: "local", active: true }]);
  assert.equal(workspaces.activeWorkspaceId(), created.id);
  // The root and its own native provider state exist; the registry file holds
  // the root, and no summary ever does.
  assert.ok(readFileSync(file, "utf8").includes(created.id));
  assert.equal(existsSync(join(baseDir, created.id, "config.json")), true);
  assert.equal(existsSync(join(baseDir, created.id, "native")), true);
  const opened = await workspaces.open(created.id);
  assert.deepEqual(Object.keys(opened).sort(), ["id", "name", "origin"]);
  assert.equal(JSON.stringify(opened).includes(baseDir), false);

  const second = workspaces.create({ name: "Research" });
  assert.deepEqual(workspaces.list().map((entry) => entry.active), [false, true]);
  assert.equal(workspaces.activeWorkspaceId(), second.id);
  // Selected Local workspace survives a restart of the app.
  const reloaded = readWorkspaceRegistry(file);
  assert.equal(activeWorkspaceId(reloaded, ACCOUNT_A), second.id);
  assert.equal(await workspaces.shutdown(), true);
  assert.deepEqual(workspaces.list().map((entry) => entry.id), [created.id, second.id]);
});

test("no verified account means no Local workspaces at all, and no Local root exposure", async (t) => {
  const { baseDir } = temporaryDirectory();
  let account = ACCOUNT_A;
  const { workspaces } = localWorkspaces({ baseDir, account: () => account });
  t.after(() => workspaces.shutdown());
  const mine = workspaces.create({ name: "Mine" });
  assert.equal(workspaces.list().length, 1);

  account = ACCOUNT_B;
  // The other account sees nothing, and cannot open or reach what it never owned.
  assert.deepEqual(workspaces.list(), []);
  assert.equal(workspaces.activeWorkspaceId(), null);
  await assert.rejects(workspaces.open(mine.id), /not available in this account/);
  const theirs = workspaces.create({ name: "Theirs" });
  assert.equal(workspaces.list().length, 1);

  // Signed out: the bridge answers nothing and refuses to create.
  account = null;
  assert.deepEqual(workspaces.list(), []);
  assert.equal(workspaces.activeWorkspaceId(), null);
  assert.throws(() => workspaces.create({ name: "Nope" }), /Sign in/);
  await assert.rejects(workspaces.open(theirs.id), /not available in this account/);

  // Back as the first account: exactly its own workspace, still active.
  account = ACCOUNT_A;
  assert.deepEqual(workspaces.list().map((entry) => entry.id), [mine.id]);
  assert.equal(workspaces.activeWorkspaceId(), mine.id);
});

test("adopting this computer's existing Local data reuses it as the account's workspace", async (t) => {
  const { root: parent, baseDir } = temporaryDirectory();
  const legacy = join(parent, ".colonie");
  mkdirSync(join(legacy, "native"), { recursive: true, mode: 0o700 });
  const { file, workspaces } = localWorkspaces({ baseDir });
  t.after(() => workspaces.shutdown());
  const adopted = workspaces.adopt({ root: legacy });
  assert.equal(adopted.active, true);
  assert.equal(readWorkspaceRegistry(file).workspaces[0].root, legacy);
  assert.equal(readWorkspaceRegistry(file).workspaces[0].adopted, true);
  // The data directory was not moved: its own native state is still there.
  assert.equal(existsSync(join(legacy, "native")), true);
  const opened = await workspaces.open(adopted.id);
  assert.equal(opened.name, "This computer");
  // Adopting again is the same workspace, not a second copy.
  assert.equal(workspaces.adopt({ root: legacy }).id, adopted.id);
  assert.equal(workspaces.list().length, 1);
});
