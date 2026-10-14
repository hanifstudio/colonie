// Local workspaces for the Colonie desktop app (docs/WORKSPACE-PLAN.md).
//
// A Local workspace is private to one account on one Mac, so every read and
// write here is scoped by an account id that was verified in the main process.
// Nothing in this module accepts an account id from a renderer: callers pass a
// hook (createColonieWorkspaces' `accountId`) that resolves the verified id, and
// a wrong or absent id simply sees no workspaces. An account change therefore
// cannot surface another account's Local roots.
//
// The legacy Local data root is adopted in place, never moved: native sessions
// pin absolute working directories (electron/colonie-config.mjs) and provider
// credentials stay in provider-owned files this module never reads. New
// workspaces get their own root under a caller-chosen base directory, and each
// root carries its own `native/` provider state because the server derives
// NATIVE_DIR from OMB_DATA_DIR (server/config.ts, server/devone/profile.ts).
//
// The server child per workspace is started from the maintained server entry
// (electron/server-child-launch.mjs) with a built-from-scratch environment: the
// child inherits an allowlist, never this app's or the launch shell's Composio,
// provider or platform secrets, and it never signs in to any AI provider.
import { fork, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { pollServerIdentity } from "./server-boot-probe.mjs";
import { initializeColonieData } from "./colonie-config.mjs";
import { serverChildLaunch } from "./server-child-launch.mjs";
import { workspaceCredentialEnvironment } from "./colonie-workspaces-credentials.mjs";

export const LOCAL_WORKSPACE_MODE = "local";
export const WORKSPACE_REGISTRY_VERSION = 1;
export const MAX_WORKSPACE_NAME = 60;
const ID = /^[\w-]{1,64}$/;
const MAX_ROOT = 4096;
// A build-time guard, not a policy: an option that looks like a credential is
// rejected outright, so no caller can widen the child's environment by habit.
const SECRET_KEY = /(api[_-]?key|token|secret|password|passwd|credential|composio)/i;
// Nothing else is inherited by the workspace server child. Everything outside
// this list is dropped by construction rather than filtered by name.
const INHERITED_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL",
]);
export const WORKSPACE_STOP_TIMEOUT_MS = 6_500;

const record = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanName(value, fallback) {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, MAX_WORKSPACE_NAME) : "";
  return name || fallback;
}

function validRoot(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ROOT
    && isAbsolute(value) && !/[\r\n\0]/.test(value);
}

/** One workspace's data root under the caller's base directory. */
export function workspaceRootPath(baseDir, id) {
  if (!validRoot(baseDir) || !ID.test(id ?? "")) throw new Error("A Local workspace needs a base directory and a stable id.");
  return join(baseDir, id);
}

/** Provider-owned native state for one workspace (CODEX_HOME/CLAUDE_CONFIG_DIR
 * live under it because OMB_DATA_DIR points at this workspace's root). */
export function nativeProvidersDir(root) {
  return join(root, "native");
}

export function emptyWorkspaceRegistry() {
  return { version: WORKSPACE_REGISTRY_VERSION, accounts: {}, workspaces: [] };
}

/** Damage yields the empty registry: losing the list costs a workspace pick,
 * never the app. Unknown or malformed entries are dropped, and `mode` is
 * always Local here — Cloud workspaces are not this module's. */
export function parseWorkspaceRegistry(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return emptyWorkspaceRegistry();
  }
  const seen = new Set();
  const workspaces = [];
  for (const entry of Array.isArray(value?.workspaces) ? value.workspaces : []) {
    if (!record(entry) || !ID.test(entry.id ?? "") || !ID.test(entry.accountId ?? "") || !validRoot(entry.root)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    workspaces.push({
      id: entry.id,
      accountId: entry.accountId,
      name: cleanName(entry.name, "Local workspace"),
      mode: LOCAL_WORKSPACE_MODE,
      root: entry.root,
      adopted: entry.adopted === true,
    });
  }
  const accounts = {};
  for (const [accountId, entry] of Object.entries(record(value?.accounts) ? value.accounts : {})) {
    if (!ID.test(accountId)) continue;
    const active = ID.test(entry?.activeWorkspaceId ?? "") ? entry.activeWorkspaceId : null;
    if (active && workspaces.some((workspace) => workspace.id === active && workspace.accountId === accountId)) {
      accounts[accountId] = { activeWorkspaceId: active };
    }
  }
  return { version: WORKSPACE_REGISTRY_VERSION, accounts, workspaces };
}

export function serializeWorkspaceRegistry(state) {
  return `${JSON.stringify({
    version: WORKSPACE_REGISTRY_VERSION,
    accounts: state?.accounts ?? {},
    // The persisted record carries the root; summaries never do.
    workspaces: (state?.workspaces ?? []).map(({ id, accountId, name, mode, root, adopted }) => ({
      id, accountId, name, mode: mode ?? LOCAL_WORKSPACE_MODE, root, ...(adopted ? { adopted: true } : {}),
    })),
  }, null, 2)}\n`;
}

export function readWorkspaceRegistry(file) {
  try {
    return parseWorkspaceRegistry(readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyWorkspaceRegistry();
    throw error;
  }
}

/** Replace the file with one complete write: a reader never sees a half file. */
export function writeWorkspaceRegistry(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const candidate = `${file}.candidate-${process.pid}`;
  writeFileSync(candidate, serializeWorkspaceRegistry(state), { mode: 0o600, flush: true });
  renameSync(candidate, file);
}

export function workspaceForAccount(state, accountId, id) {
  if (!ID.test(accountId ?? "") || !ID.test(id ?? "")) return null;
  return state?.workspaces?.find((workspace) => workspace.accountId === accountId && workspace.id === id) ?? null;
}

export function activeWorkspaceId(state, accountId) {
  if (!ID.test(accountId ?? "")) return null;
  const active = state?.accounts?.[accountId]?.activeWorkspaceId ?? null;
  return workspaceForAccount(state, accountId, active) ? active : null;
}

/** What the renderer may see: no root, no path, no credential, ever. */
export function workspacesForAccount(state, accountId) {
  if (!ID.test(accountId ?? "")) return [];
  const active = activeWorkspaceId(state, accountId);
  return (state?.workspaces ?? [])
    .filter((workspace) => workspace.accountId === accountId)
    .map((workspace) => ({ id: workspace.id, name: workspace.name, mode: LOCAL_WORKSPACE_MODE, active: workspace.id === active }));
}

export function workspaceSummary(state, accountId, id) {
  const workspace = workspaceForAccount(state, accountId, id);
  return workspace ? { id: workspace.id, name: workspace.name, mode: LOCAL_WORKSPACE_MODE, active: id === activeWorkspaceId(state, accountId) } : null;
}

/** Register one Local workspace for an account. The same account and root
 * register once (adopting existing data is idempotent); the first workspace an
 * account registers becomes its active one. */
export function registerWorkspace(state, input, makeId = randomUUID) {
  const base = state ?? emptyWorkspaceRegistry();
  const accountId = ID.test(input?.accountId ?? "") ? input.accountId : null;
  if (!accountId) throw new Error("A Local workspace needs a signed-in account.");
  if (!validRoot(input?.root)) throw new Error("A Local workspace needs a directory.");
  if (base.workspaces.some((workspace) => workspace.root === input.root && workspace.accountId !== accountId)) {
    throw new Error("This Local workspace already belongs to another account on this Mac.");
  }
  const existing = base.workspaces.find((workspace) => workspace.accountId === accountId && workspace.root === input.root);
  if (existing) return { state: base, workspace: existing, changed: false };
  const id = makeId();
  if (!ID.test(id ?? "") || base.workspaces.some((workspace) => workspace.id === id)) {
    throw new Error("A Local workspace needs a stable id.");
  }
  const workspace = {
    id,
    accountId,
    name: cleanName(input?.name, "Local workspace"),
    mode: LOCAL_WORKSPACE_MODE,
    root: input.root,
    adopted: input?.adopted === true,
  };
  let next = { ...base, workspaces: [...base.workspaces, workspace] };
  if (!activeWorkspaceId(next, accountId)) next = setActiveWorkspace(next, accountId, id);
  return { state: next, workspace, changed: true };
}

/** Reuse an existing directory as an account's Local workspace without moving
 * or reading it. Legacy paths keep pinning their absolute working directories. */
export function adoptWorkspace(state, input, makeId = randomUUID) {
  return registerWorkspace(state, { ...input, adopted: true }, makeId);
}

export function setActiveWorkspace(state, accountId, id) {
  if (!workspaceForAccount(state, accountId, id)) throw new Error("That workspace is not available in this account.");
  return { ...state, accounts: { ...state.accounts, [accountId]: { activeWorkspaceId: id } } };
}

/** The environment of one workspace server child, built from nothing.
 *
 * Only the allowlisted parent keys above are copied; the app's or the launch
 * shell's Composio key, provider keys and platform secrets are never in scope.
 * `extra` is for non-secret wiring only (ACP entry paths, static UI dir) and a
 * credential-looking key is refused rather than forwarded. Control values are
 * assigned last so no caller can redirect the data root or the port. */
export function localWorkspaceEnvironment({
  port,
  root,
  env = process.env,
  // Secure default: the child is started with the desktop owner protocol, so
  // every public mutation must prove it came through this app's web session
  // (server/request-auth.ts) once the owner capability is delivered.
  desktopManaged = true,
  staticDir = null,
  resourcesPath = null,
  skillsDir = null,
  appVersion = null,
  extra = {},
  credentials = null,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("A Local workspace server needs a loopback port.");
  if (!validRoot(root)) throw new Error("A Local workspace server needs a data directory.");
  const child = {};
  for (const key of INHERITED_ENV_KEYS) {
    if (typeof env?.[key] === "string" && env[key]) child[key] = env[key];
  }
  for (const [key, value] of Object.entries(record(extra) ? extra : {})) {
    if (SECRET_KEY.test(key)) throw new Error(`A Local workspace server must not inherit ${key}.`);
    if (typeof value === "string" && value) child[key] = value;
  }
  // Secrets enter through one channel only: this workspace's own vault record.
  // The app's global vault never reaches here (see colonie-workspaces-credentials.mjs).
  if (credentials) Object.assign(child, workspaceCredentialEnvironment(credentials));
  if (staticDir) child.OMB_STATIC_DIR = staticDir;
  if (resourcesPath) child.OMB_RESOURCES_PATH = resourcesPath;
  if (skillsDir) child.OMB_SKILLS_DIR = skillsDir;
  if (appVersion) child.OMB_APP_VERSION = appVersion;
  child.COLONIE_PROFILE = "1";
  child.OMB_DATA_DIR = root;
  child.OMB_PORT = String(port);
  if (desktopManaged) child.OMB_DESKTOP_PARENT = "1";
  return Object.freeze(child);
}

/** The message the server child needs to accept mutations (server/index.ts
 * applyDesktopMutationTokenMessage). The token never reaches a renderer. */
export const WORKSPACE_OWNER_MESSAGE = "openmausbot:desktop-mutation-token";
const OWNER_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A fresh capability in the shape server/index.ts accepts (32 random bytes,
 * base64url). The app's own desktopMutationToken is the same shape. */
export function newOwnerToken() {
  return randomBytes(32).toString("base64url");
}

/** Hand the owner capability to the server child over its private port:
 * Electron's `postMessage`, or the IPC channel of a plain forked child. A child
 * with no private port cannot be given the capability, so it is refused. */
export function deliverOwnerCapability(proc, token) {
  if (!OWNER_TOKEN.test(token ?? "")) throw new Error("A Local workspace server needs a desktop owner token.");
  const message = { type: WORKSPACE_OWNER_MESSAGE, token };
  if (typeof proc?.postMessage === "function") {
    proc.postMessage(message);
    return "postMessage";
  }
  if (typeof proc?.send === "function") {
    proc.send(message);
    return "send";
  }
  throw new Error("The server child cannot receive the desktop owner capability.");
}

export function pickLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Terminate one child this process forked. Only the live handle is signalled:
 * no pid is ever read back from a record, so a reused pid is not a risk. */
export async function stopWorkspaceProcess(proc, { timeoutMs = WORKSPACE_STOP_TIMEOUT_MS } = {}) {
  if (!proc || typeof proc.kill !== "function") return true;
  const exited = typeof proc.once === "function"
    ? new Promise((resolve) => { proc.once("exit", () => resolve(true)); })
    : Promise.resolve(false);
  try {
    proc.kill("SIGTERM");
  } catch {
    return true;
  }
  if (await Promise.race([exited, delay(timeoutMs).then(() => false)])) return true;
  try {
    proc.kill("SIGKILL");
  } catch {
    return true;
  }
  await Promise.race([exited, delay(1_000)]);
  return true;
}

/** One controlled server child per selected Local workspace.
 *
 * `launch` is the native injector (Electron's utilityProcess.fork in the app, a
 * plain spawn in tests) and is required: this module never guesses how to start
 * a process. With the default desktopManaged environment an `ownerToken` is
 * required too, and a child that cannot receive it over the private port is
 * stopped again rather than left running as a deny-all server. */
export function createLocalWorkspaceSupervisor({
  launch,
  environment,
  ownerToken = null,
  desktopManaged = true,
  stop = stopWorkspaceProcess,
  probe = pollServerIdentity,
  choosePort = pickLoopbackPort,
  bootTimeoutMs = 120_000,
  log = () => {},
} = {}) {
  if (typeof launch !== "function") throw new Error("A Local workspace supervisor needs a process injector.");
  if (typeof environment !== "function") throw new Error("A Local workspace supervisor needs an environment builder.");
  if (desktopManaged && !OWNER_TOKEN.test(ownerToken ?? "")) {
    throw new Error("A Local workspace supervisor needs a desktop owner token.");
  }
  // id -> { proc, port, origin, exited }; one start per workspace at a time.
  const running = new Map();
  const pending = new Map();

  const snapshot = (entry) => ({ origin: entry.origin, port: entry.port, pid: entry.proc.pid });

  async function boot(workspace) {
    const port = Number.isInteger(workspace?.port) ? workspace.port : await choosePort();
    // `environment` may be async: a caller reads this workspace's own vault
    // before the child starts, so only that workspace's secrets enter it.
    const env = await environment({ id: workspace.id, root: workspace.root, port });
    const proc = await launch({ workspace, env });
    const entry = { proc, port, origin: `http://127.0.0.1:${port}`, exited: false };
    proc.once("exit", (code) => {
      entry.exited = true;
      entry.code = code;
      // A late exit must not clear a replacement's entry.
      if (running.get(workspace.id) === entry) running.delete(workspace.id);
      log(`local workspace ${workspace.id} server exited code=${code}`);
    });
    running.set(workspace.id, entry);
    try {
      if (ownerToken) deliverOwnerCapability(proc, ownerToken);
      const identity = await probe({
        port,
        pid: () => entry.proc.pid,
        bootTimeoutMs,
        isExited: () => entry.exited,
      });
      if (identity.outcome !== "ready") {
        throw new Error(identity.outcome === "foreign-owner"
          ? "Another program is answering on that Local workspace port."
          : "The Local workspace server did not start.");
      }
    } catch (error) {
      // An unreaped child would keep the port and the data-directory lease.
      await stop(proc).catch(() => {});
      throw error;
    }
    log(`local workspace ${workspace.id} server ready pid=${proc.pid} port=${port}`);
    return snapshot(entry);
  }

  async function start(workspace) {
    const entry = running.get(workspace?.id);
    if (entry && !entry.exited) return snapshot(entry);
    if (pending.has(workspace?.id)) return pending.get(workspace.id);
    const attempt = boot(workspace).finally(() => pending.delete(workspace.id));
    pending.set(workspace.id, attempt);
    return attempt;
  }

  async function stopWorkspace(id) {
    const entry = running.get(id);
    if (!entry) return false;
    running.delete(id);
    if (entry.exited) return true;
    return Boolean(await stop(entry.proc).catch(() => false));
  }

  async function stopAll() {
    const ids = [...running.keys()];
    const stopped = await Promise.all(ids.map((id) => stopWorkspace(id)));
    return ids.length > 0 && stopped.every(Boolean);
  }

  return {
    start,
    stop: stopWorkspace,
    stopAll,
    running: (id) => Boolean(running.get(id) && !running.get(id).exited),
    origin: (id) => running.get(id)?.origin ?? null,
    /** Every live workspace origin: the app's web-session header hook needs the
     * full set so a second workspace's page can still make changes. */
    origins: () => [...running.values()].filter((entry) => !entry.exited).map((entry) => entry.origin),
    shutdown: stopAll,
  };
}

/** Electron's private utility-process injector: the only supported child
 * transport in the app. `utilityProcess.fork` keeps the child off the shell and
 * off every inherited descriptor, and gives it the private port the desktop
 * owner capability travels over. */
export function utilityProcessLauncher(utilityProcess, { resourcesPath, userData, stdio = ["ignore", "pipe", "pipe"] } = {}) {
  if (!utilityProcess?.fork) throw new Error("A Local workspace server needs Electron's utilityProcess.");
  // The same entry the app's own server child uses; a packaged tree without the
  // bootstrap falls back to index.js (electron/server-child-launch.mjs).
  const { entry } = serverChildLaunch({ resourcesPath, userData });
  return ({ env }) => utilityProcess.fork(entry, [], { env, stdio });
}

/** Plain-process injector for tests and headless runs. `ipc` gives the child
 * the private channel the owner capability travels over, like Electron's
 * utilityProcess. Electron builds must use utilityProcessLauncher. */
export function childProcessLauncher({ entry, args = [], stdio = ["ignore", "pipe", "pipe"], ipc = false } = {}) {
  if (typeof entry !== "string" || !entry) throw new Error("A Local workspace server needs an entry file.");
  return ({ env }) => (ipc
    ? fork(entry, args, { env, stdio })
    : spawn(process.execPath, [entry, ...args], { env, stdio, detached: false }));
}

/** The Local workspace registry plus its running child, as the bridge main
 * exposes. `accountId` is a hook into the *verified* account (a main-process
 * value: never a renderer argument), and every method re-reads it, so a
 * sign-out or an account switch immediately stops exposing Local roots. */
export function createColonieWorkspaces({
  file,
  baseDir,
  supervisor,
  accountId,
  makeId = randomUUID,
  log = () => {},
  read = readWorkspaceRegistry,
  write = writeWorkspaceRegistry,
} = {}) {
  if (typeof file !== "string" || !file) throw new Error("A Local workspace registry needs a file.");
  if (!validRoot(baseDir)) throw new Error("A Local workspace registry needs a base directory.");
  if (typeof accountId !== "function") throw new Error("A Local workspace registry needs a verified-account hook.");
  let state = null;
  const load = () => (state ??= read(file));
  const verifiedAccount = () => {
    const id = accountId();
    return ID.test(id ?? "") ? id : null;
  };
  const persist = (next) => {
    state = next;
    write(file, next);
    return next;
  };

  return {
    /** No verified account: no Local workspaces, and nothing about any other
     * account's roots. */
    list() {
      const id = verifiedAccount();
      return id ? workspacesForAccount(load(), id) : [];
    },
    activeWorkspaceId() {
      const id = verifiedAccount();
      return id ? activeWorkspaceId(load(), id) : null;
    },
    create(input) {
      const id = verifiedAccount();
      if (!id) throw new Error("Sign in to create a Local workspace.");
      if (workspacesForAccount(load(), id).length >= 20) throw new Error("This account already has 20 Local workspaces on this Mac.");
      const workspaceId = makeId();
      const root = workspaceRootPath(baseDir, workspaceId);
      const { state: next, workspace } = registerWorkspace(load(), { accountId: id, name: input?.name, root }, () => workspaceId);
      // The root and its native provider state exist before the server boots,
      // with a valid config.json (the same helper the app boots through).
      initializeColonieData(root);
      mkdirSync(nativeProvidersDir(root), { recursive: true, mode: 0o700 });
      // Creating a workspace selects it: the person is about to open it.
      persist(setActiveWorkspace(next, id, workspace.id));
      log(`local workspace ${workspace.id} root=${root}`);
      return workspaceSummary(state, id, workspace.id);
    },
    /** Reuse an existing Local data directory (the legacy root) in place. */
    adopt(input) {
      const id = verifiedAccount();
      if (!id) throw new Error("Sign in to use this computer's Local workspace.");
      const { state: next, workspace } = adoptWorkspace(load(), { accountId: id, name: input?.name ?? "This computer", root: input?.root }, makeId);
      persist(next);
      return workspaceSummary(next, id, workspace.id);
    },
    /** Start (or rejoin) one workspace's server and make it the account's
     * active Local workspace. Resolves with the origin only: the renderer is
     * told where to load, never where the data lives. */
    async open(id) {
      const account = verifiedAccount();
      const workspace = account ? workspaceForAccount(load(), account, id) : null;
      if (!workspace) throw new Error("That workspace is not available in this account.");
      if (!workspace.adopted && workspace.root !== workspaceRootPath(baseDir, workspace.id)) throw new Error("This workspace's saved location is not valid.");
      mkdirSync(nativeProvidersDir(workspace.root), { recursive: true, mode: 0o700 });
      const started = await supervisor.start({ id: workspace.id, root: workspace.root });
      persist(setActiveWorkspace(load(), account, id));
      return { id: workspace.id, name: workspace.name, origin: started.origin };
    },
    shutdown: () => supervisor.stopAll(),
  };
}
