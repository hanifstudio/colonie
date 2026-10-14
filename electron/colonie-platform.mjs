/** Account-checked Local workspace IPC. No renderer can supply an account,
 * filesystem root, provider credential, port, or Cloud origin. */
import { createColonieWorkspaces, readWorkspaceRegistry, workspaceForAccount } from "./colonie-workspaces.mjs";

export const DEFAULT_COLONIE_PLATFORM_ORIGIN = "https://172.104.33.55";

export function coloniePlatformOrigin(raw = DEFAULT_COLONIE_PLATFORM_ORIGIN) {
  const url = new URL(raw);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))) {
    throw new Error("Colonie requires an HTTPS platform origin.");
  }
  return url.origin;
}

export function coloniePlatformSenderAllowed(event, contents, { platformOrigin, localOrigin }) {
  if (!contents || event?.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) return false;
  let origin;
  try { origin = new URL(event.senderFrame.url).origin; } catch { return false; }
  return origin === platformOrigin || Boolean(localOrigin && origin === localOrigin);
}

export function colonieAppAuthorizationUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password ||
      !["connect.composio.dev", "backend.composio.dev"].includes(url.hostname)) {
    throw new Error("The app connection did not return a trusted sign-in page.");
  }
  return url.toString();
}

export function createColoniePlatformController(options) {
  const origin = coloniePlatformOrigin(options.origin);
  let accountId = null;
  let currentLocal = null;
  let currentRoot = null;
  let accountGeneration = 0;
  const registry = createColonieWorkspaces({
    file: options.registryFile, baseDir: options.workspaceDir,
    supervisor: options.supervisor, accountId: () => accountId,
  });

  async function account() {
    const previous = accountId;
    let response;
    try {
      response = await options.fetch(`${origin}/api/colonie/auth/get-session`, {
        method: "GET", credentials: "include", redirect: "error", signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // A network outage is not evidence of sign-out. Preserve the running
      // Local workspace and fail this account-dependent operation clearly.
      throw new Error("Colonie cannot reach your account right now. Your open Local workspace is still available.");
    }
    if (!response.ok && ![401, 403].includes(response.status)) {
      throw new Error("Colonie cannot check your account right now. Try again shortly.");
    }
    const value = response.ok ? await response.json() : null;
    if (!value?.user?.id || typeof value.user.id !== "string") {
      const hadLocal = Boolean(currentLocal);
      options.invalidateLocal?.();
      accountId = null;
      accountGeneration++;
      currentLocal = null;
      currentRoot = null;
      await options.supervisor.stopAll();
      if (hadLocal) await options.openCloud?.(origin);
      throw new Error("Sign in to Colonie to use this workspace.");
    }
    accountId = value.user.id;
    if (previous && previous !== accountId) {
      const hadLocal = Boolean(currentLocal);
      options.invalidateLocal?.();
      accountGeneration++;
      currentLocal = null;
      currentRoot = null;
      await options.supervisor.stopAll();
      if (hadLocal) await options.openCloud?.(origin);
    }
    return accountId;
  }

  async function allowed(event) {
    if (!options.senderAllowed(event, { platformOrigin: origin, localOrigin: currentLocal?.origin ?? null })) {
      throw new Error("This page cannot manage Local workspaces.");
    }
    await account();
  }

  return {
    origin,
    info: () => ({ origin, local: currentLocal ? { id: currentLocal.id, name: currentLocal.name, origin: currentLocal.origin } : null }),
    ownsLocalOrigin: (value) => Boolean(currentLocal && currentLocal.origin === value),
    localRoot: () => currentRoot,
    async list(event) { await allowed(event); return registry.list(); },
    async create(event, input) { await allowed(event); return registry.create({ name: input?.name }); },
    async adoptExisting(event) {
      await allowed(event);
      if (!options.legacyRoot || !options.legacyAvailable?.()) throw new Error("There is no existing Local workspace to add.");
      const workspace = registry.adopt({ root: options.legacyRoot, name: "Existing Local workspace" });
      await options.adoptLocal?.(options.legacyRoot);
      return workspace;
    },
    async authorizeApp(event, url) {
      await allowed(event);
      if (currentLocal) throw new Error("Open your Cloud workspace to connect its apps.");
      await options.openApp?.(colonieAppAuthorizationUrl(url));
    },
    async open(event, id) {
      await allowed(event);
      const generation = accountGeneration;
      const owner = accountId;
      const result = await registry.open(id);
      if (generation !== accountGeneration || owner !== accountId) {
        if (options.supervisor.stop) await options.supervisor.stop(id);
        else await options.supervisor.stopAll();
        throw new Error("Your account changed while this workspace was opening.");
      }
      const entry = workspaceForAccount(readWorkspaceRegistry(options.registryFile), accountId, id);
      if (!entry) throw new Error("That workspace is not available in this account.");
      currentRoot = entry.root;
      currentLocal = result;
      await options.openLocal?.(result);
      return result;
    },
    async cloud(event) {
      await allowed(event);
      options.invalidateLocal?.();
      currentLocal = null;
      currentRoot = null;
      await options.supervisor.stopAll();
      await options.openCloud?.(origin);
    },
    async signOut(event) {
      if (!options.senderAllowed(event, { platformOrigin: origin, localOrigin: currentLocal?.origin ?? null })) throw new Error("This page cannot sign out.");
      const hadLocal = Boolean(currentLocal);
      options.invalidateLocal?.();
      accountId = null;
      accountGeneration++;
      currentLocal = null;
      currentRoot = null;
      await options.supervisor.stopAll();
      if (hadLocal) await options.openCloud?.(origin);
    },
    shutdown: () => registry.shutdown(),
  };
}
