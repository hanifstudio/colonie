// The provider instances behind the model picker, and the app config they read:
// what is installed, what an account is signed in as, one settings write at a
// time (the shared `providerWrite` flag), and installing or refreshing a runtime
// on demand. Credentials are never echoed here — only booleans and states.
import { providerIconPatchSchema, withInstanceIcon } from "../colonie/providers/provider-icon.ts";
import { providerIconError } from "../../shared/provider-icon.ts";
import { AcpRuntime } from "../acp/acp-runtime.ts";
import { assertSeparateClaudeAccount, configuredAccountDirectory, createClaudeAccountSchema, instanceSettingsSchema, isClaudeAccountDriver, newClaudeAccount, newCodexAccount, setClaudeAccountDirectory } from "../colonie/providers/claude-accounts.ts";
import { type ProviderAuthSessions } from "../colonie/providers/provider-auth-sessions.ts";
import { type AppConfig, persistableInstanceConfigs, saveConfig, withInstanceCli } from "../config.ts";
import { type ProviderRegistry } from "../harness/registry.ts";
import type { BotRecord, Store } from "../persistence/store.ts";
import { isLoopbackHost, isProxied } from "../request-auth.ts";
import { resetPathCache } from "../runtime/env-path.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ProviderInstanceRouteDeps {
  store: Store;
  cfg: AppConfig;
  registry: ProviderRegistry;
  providerAuthSessions: ProviderAuthSessions;
  sessions: { isLive: (sessionId: string) => boolean };
  /** Instances with a settings write in flight, so two cannot overlap. */
  providerInstancesChanging: Set<string>;
  /** The shared one-write-at-a-time flag for provider settings. */
  providerWrite: { busy: boolean };
  botForThread: (botId: string, threadId: string) => BotRecord | null;
  threadBusy: (botId: string, threadId: string) => boolean;
  describeInstances: () => Promise<any[]>;
  persistProviderInstance: (instanceId: string, instances: any) => Promise<void>;
  configStatus: () => Record<string, unknown>;
  broadcast: (payload: Record<string, unknown>) => void;
}

export function createProviderInstanceRoutes(deps: ProviderInstanceRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    const {
      store, cfg, registry, providerAuthSessions, sessions, providerInstancesChanging,
      botForThread, threadBusy, describeInstances, persistProviderInstance, configStatus,
      broadcast,
    } = deps;
    const providerWrite = deps.providerWrite;
    // ── provider instances (model picker) ──
    if (method === "GET" && path === "/api/instances") {
      // Rescan PATH first: this endpoint is how the app answers "what can I
      // run?", and the interesting case is a CLI installed since launch.
      // Windows never pushes PATH changes into a live process, so without
      // this the answer is frozen at boot and "check again" is a no-op.
      resetPathCache();
      return json(res, 200, { instances: await describeInstances() });
    }
    const companyMutation = /^\/api\/instances\/(company\.[\w.-]+)(?:\/|$)/.exec(path);
    
    if (companyMutation && method !== "GET") return json(res, 403, { error: "Company accounts are read-only here. Manage this connection in desktop Settings." });

    const instanceIconPatch = /^\/api\/instances\/([\w.-]+)\/icon$/.exec(path);
    if (method === "PATCH" && instanceIconPatch) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const parsed = providerIconPatchSchema.safeParse(await readBody(req, 192 * 1024));
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        return json(res, 400, { error: detail && detail !== "Invalid input" ? detail : "Choose a built-in icon or upload a PNG, JPEG, or WebP image up to 128 KB." });
      }
      if (parsed.data.icon) {
        const invalid = providerIconError(parsed.data.icon);
        if (invalid) return json(res, 400, { error: invalid });
      }
      if (providerWrite.busy) return json(res, 409, { error: "provider settings are already being updated" });
      providerWrite.busy = true;
      try {
        const changed = withInstanceIcon(cfg, instanceIconPatch[1], parsed.data.icon);
        if (!changed.ok) return json(res, 404, { error: `unknown instance "${instanceIconPatch[1]}"` });
        saveConfig({ instances: changed.instances }, { replaceInstances: true });
        cfg.instances = changed.instances;
        broadcast({ kind: "config", ...configStatus() });
        return json(res, 200, { instances: await describeInstances() });
      } finally { providerWrite.busy = false; }
    }

    if (method === "POST" && path === "/api/instances/chatgpt-accounts") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = createClaudeAccountSchema.pick({ displayName: true }).safeParse(await readBody(req, 8192));
      if (!parsed.success) return json(res, 400, { error: "Enter an account name (up to 80 characters)." });
      if (providerWrite.busy) return json(res, 409, { error: "provider settings are already being updated" });
      providerWrite.busy = true;
      try {
        const { instanceId, instances } = newCodexAccount(cfg, parsed.data.displayName);
        await persistProviderInstance(instanceId, instances);
        return json(res, 201, { instanceId, instances: await describeInstances() });
      } finally { providerWrite.busy = false; }
    }

    if (method === "POST" && path === "/api/instances/claude-accounts") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const parsed = createClaudeAccountSchema.safeParse(await readBody(req, 8192));
      if (!parsed.success) return json(res, 400, { error: "Enter an account name (up to 80 characters) and an optional configuration directory." });
      if (providerWrite.busy) return json(res, 409, { error: "provider settings are already being updated" });
      providerWrite.busy = true;
      try {
        const { instanceId, instances } = newClaudeAccount(cfg, parsed.data);
        await persistProviderInstance(instanceId, instances);
        return json(res, 201, { instanceId, instances: await describeInstances() });
      } finally { providerWrite.busy = false; }
    }

    const authStatus = /^\/api\/instances\/([\w.-]+)\/auth\/status$/.exec(path);
    if (method === "GET" && authStatus) {
      res.setHeader("cache-control", "no-store");
      const state = await providerAuthSessions.status(authStatus[1], auth.kind === "session" ? auth.session.id : "loopback", url.searchParams.get("flowId") ?? "");
      return json(res, 200, { auth: state });
    }
    const instanceAction = /^\/api\/instances\/([\w.-]+)\/(refresh-models|install|auth\/start|auth\/complete|auth\/cancel|auth\/sign-out)$/.exec(path);
    if (method === "POST" && instanceAction) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const instanceId = instanceAction[1];
      const action = instanceAction[2];
      const owner = auth.kind === "session" ? auth.session.id : "loopback";
      if (action.startsWith("auth/")) res.setHeader("cache-control", "no-store");
      try {
        if (action === "refresh-models") {
          if (!(await registry.refreshModels(instanceId))) return json(res, 404, { error: "unknown instance" });
          return json(res, 200, { instances: await describeInstances() });
        }
        if (action === "install") {
          if (!(await registry.installRuntime(instanceId))) return json(res, 404, { error: "Installing this engine from Settings is not available on this server. Use the install command on the machine running Colonie." });
          return json(res, 200, { instances: await describeInstances() });
        }
        if (action === "auth/start") {
          const instance = registry.get(instanceId);
          if (!instance) return json(res, 404, { error: "unknown instance" });
          // The official local OAuth callback terminates on this machine,
          // not a phone or the browser visiting a remotely hosted workspace.
          if (instance.authenticationMethod === "browser-pkce" && (isProxied(req) || !isLoopbackHost(req.socket.remoteAddress))) {
            return json(res, 403, { error: "Continue with ChatGPT on the computer running Colonie. Hosted Pro sign-in requires OpenAI's hosted-app approval." });
          }
          const started = await providerAuthSessions.start(instance, owner);
          // Revocation can arrive while the CLI is obtaining a device code.
          if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
            providerAuthSessions.revokeOwner(owner);
            return json(res, 401, { error: "Your session ended. Start a new sign-in." });
          }
          return json(res, 200, { auth: started });
        }
        if (action === "auth/sign-out") {
          const instance = registry.get(instanceId);
          if (!instance) return json(res, 404, { error: "unknown instance" });
          await providerAuthSessions.signOut(instance, owner);
          return json(res, 200, { instances: await describeInstances() });
        }
        if (action === "auth/complete") {
          const body = await readBody(req);
          const flowId = typeof body?.flowId === "string" ? body.flowId : "";
          // `code` for a pasted sign-in code (Claude), `callbackUrl` for a browser callback
          const callbackUrl = typeof body?.callbackUrl === "string" ? body.callbackUrl : typeof body?.code === "string" ? body.code : "";
          if (!flowId || !callbackUrl) return json(res, 400, { error: "flowId and a code or callbackUrl are required" });
          await providerAuthSessions.complete(instanceId, owner, flowId, callbackUrl);
          return json(res, 200, { ok: true });
        }
        const body = await readBody(req, 4096);
        await providerAuthSessions.cancel(instanceId, owner, typeof body?.flowId === "string" ? body.flowId : "");
        return json(res, 200, { ok: true });
      } catch (error) {
        const requestedStatus = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
        const status = typeof requestedStatus === "number" && [400, 401, 404, 409, 413, 415].includes(requestedStatus) ? requestedStatus : 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    

    // ── in-app sign-in for a Colonie ACP connection ──
    // Runs the adapter's own authenticate (the provider's browser/device flow)
    // with the isolated config dir; never a terminal command.
    const acpAuth = /^\/api\/instances\/([\w.-]+)\/acp-auth$/.exec(path);
    if (method === "POST" && acpAuth) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      const instance = registry.get(acpAuth[1]);
      if (!instance || !(instance.adapter instanceof AcpRuntime) || !instance.enabled) return json(res, 404, { error: "no such sign-in-able ACP connection" });
      // Colonie signs in through the engine's own CLI in a Terminal, with the
      // isolated config dir — the same for Codex and Claude.
      return json(res, 200, { terminal: { command: instance.adapter.signInCommand() }, instances: await describeInstances() });
    }

    const busyProviderSelections = () => store.bots.flatMap((bot) => {
      const busyTasks = store.tasks(bot.id).filter((task) => threadBusy(bot.id, task.threadId));
      const selections = busyTasks.map((task) => botForThread(bot.id, task.threadId)!.modelSelection);
      if (bot.busy && busyTasks.length === 0) selections.push(bot.modelSelection);
      return selections;
    });

    // ── per-instance settings (CLI/account or API tool support) ──
    // PATCH /api/instances/:id {cli: "/path/to/cli" | ""} — "" reverts to the
    // driver default. Only this idle instance is replaced; siblings keep running.
    const instancePatch = /^\/api\/instances\/([\w.-]+)$/.exec(path);
    if (method === "PATCH" && instancePatch) {
      // same non-simple-request gate as the local-VM lifecycle routes
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const parsed = instanceSettingsSchema.safeParse(await readBody(req, 16384));
      if (!parsed.success) return json(res, 400, { error: "Supply a valid CLI path, account name, configuration directory or boolean tools setting." });
      const body = parsed.data;
      const instanceId = instancePatch[1];
      if (providerWrite.busy) return json(res, 409, { error: "provider settings are already being updated" });
      if (busyProviderSelections().some((selection) => selection.instanceId === instanceId)) {
        return json(res, 409, { error: "Wait for bots using this account to finish before changing its settings." });
      }
      providerWrite.busy = true;
      providerInstancesChanging.add(instanceId);
      try {
        const result = body.cli === undefined ? { ok: true, config: cfg } : withInstanceCli(cfg, instanceId, body.cli);
        const instances = persistableInstanceConfigs(result.config);
        if (!result.ok || !Object.hasOwn(instances, instanceId)) return json(res, 404, { error: `unknown instance "${instanceId}"` });
        const entry = instances[instanceId];
        if ((body.displayName !== undefined || body.configDir !== undefined) && !isClaudeAccountDriver(entry.driver)) {
          return json(res, 400, { error: "Account settings are currently available for Claude only." });
        }
        if (body.tools !== undefined) {
          if (!["openai-compat", "grok", "minimax", "mistral", "cerebras"].includes(entry.driver)) {
            return json(res, 400, { error: "The tools setting is available for OpenAI-compatible, Grok API, MiniMax API, Mistral API and Cerebras API instances only." });
          }
          entry.config = { ...entry.config as Record<string, unknown>, tools: body.tools };
        }
        if (body.displayName !== undefined) entry.displayName = body.displayName;
        if (body.configDir !== undefined) {
          let previousDir: string | undefined;
          try { previousDir = configuredAccountDirectory(entry); } catch { /* Allow repairing an unused malformed account. */ }
          setClaudeAccountDirectory(entry, body.configDir);
          if (previousDir !== configuredAccountDirectory(entry)) {
            const used = store.bots.some((bot) => bot.modelSelection.instanceId === instanceId || bot.fallback?.some(candidate => candidate.instanceId === instanceId) || store.tasks(bot.id).some((task) =>
              task.modelSelection?.instanceId === instanceId || task.resumeCursors[instanceId] || task.lastInstanceId === instanceId));
            if (used) return json(res, 409, { error: "This account is used by bots or conversation history. Add another account and select it for the bot instead." });
            assertSeparateClaudeAccount(instances, instanceId, entry);
          }
        }
        await persistProviderInstance(instanceId, instances);
        return json(res, 200, { instances: await describeInstances() });
      } finally {
        providerInstancesChanging.delete(instanceId);
        providerWrite.busy = false;
      }
    }

    if (method === "DELETE" && instancePatch) {
      const instanceId = instancePatch[1];
      if (providerWrite.busy) return json(res, 409, { error: "provider settings are already being updated" });
      const instances = persistableInstanceConfigs(cfg);
      if (!Object.hasOwn(instances, instanceId)) return json(res, 404, { error: "unknown instance" });
      if (instances[instanceId].driver !== "claudeAgent" || instanceId === "claude") {
        return json(res, 400, { error: "Only added Claude accounts can be removed here." });
      }
      if (cfg.defaultModelSelection?.instanceId === instanceId || store.bots.some((bot) =>
        bot.modelSelection.instanceId === instanceId || bot.fallback?.some(candidate => candidate.instanceId === instanceId) || store.tasks(bot.id).some((task) => task.modelSelection?.instanceId === instanceId)) ||
        busyProviderSelections().some((selection) => selection.instanceId === instanceId)) {
        return json(res, 409, { error: "Choose another account for the bots and default model using this account before removing it." });
      }
      providerWrite.busy = true;
      providerInstancesChanging.add(instanceId);
      try {
        delete instances[instanceId];
        await persistProviderInstance(instanceId, instances);
        return json(res, 200, { instances: await describeInstances() });
      } finally {
        providerInstancesChanging.delete(instanceId);
        providerWrite.busy = false;
      }
    }
    return PASS;
  };
}
