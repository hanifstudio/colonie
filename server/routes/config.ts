// Settings: one GET that answers the whole config (credentials reduced to
// booleans, admin-only where that matters), and one PUT/PATCH that applies a
// patch, reloads the providers it affects, and drains what the change unblocked.
// One write at a time, through the shared `providerWrite` flag, and a Local VM
// mode change holds `localVmFlags.modeChangeBusy` for the same reason: the patch
// is applied to a live fleet, not to a database.
import { browserSessionId } from "../colonie/computer/browser-engine.ts";
import * as composio from "../colonie/mcp/composio.ts";
import * as tts from "../tts/index.ts";
import { finalizeBrowserCleanupMutation, requireBrowserCleanupAcknowledged, type BrowserCleanupRequest } from "../colonie/computer/browser-lifecycle-cleanup.ts";
import { composioCredentialStatus } from "../colonie/connections/credential-status.ts";
import { PROVIDER_KEY_KINDS } from "../colonie/providers/provider-key-check.ts";
import { forgetKey } from "../colonie/providers/key-rejections.ts";
import { parseSkillMd } from "../colonie/skills/skills.ts";
import {
  type AppConfig, browserProfilePartitionTarget, browserProfileReplacementConflict, builtInBrowserEnabled,
  loadConfig, localVmMode, mergeOpenCodeProviderKeys, parseConfigPatch, providerReloadKeys, saveConfig,
  syncCredentialEnv,
} from "../config.ts";
import { deciderSavePatch } from "../decider/index.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import type { Store } from "../persistence/store.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Helpers whose own signatures are wide; the module only forwards to them. */
type Helper = (...args: any[]) => any;

export interface ConfigRouteDeps {
  store: Store;
  cfg: AppConfig;
  registry: ProviderRegistry;
  sessions: { revalidateEmailSessions: Helper };
  /** One settings write at a time, shared with the routes that own them. */
  providerWrite: { busy: boolean };
  /** One Local VM mode change at a time, for the same reason. */
  localVmFlags: { imageBusy: boolean; modeChangeBusy: boolean };
  localVmIdles: Map<string, any>;
  localVmActiveThreads: Map<string, string>;
  localVmLifecycleBusy: Set<string>;
  browserCleanup: { prepare: Helper; abort: Helper; commit: Helper; ensure: Helper; hasPendingProfile: Helper };
  browserLive: { closeAll: Helper; closeForSession: Helper };
  browserRuntime: { heldBy: Helper };
  decider: { testKey: Helper };
  sharedComputers: { close: Helper };
  sharedComputerControl: { close: Helper };
  broadcast: (payload: Record<string, unknown>) => void;
  configStatus: () => Record<string, unknown>;
  configForAccess: Helper;
  checkedModelSelection: Helper;
  lendingEnabled: Helper;
  localVmIdleMs: () => number;
  perBotLocalVmCountForModeChange: Helper;
  reloadProviders: Helper;
  revokeAllInternalCapabilities: Helper;
  drainComputerResumes: Helper;
  drainConnectorResumes: Helper;
  drainDelegationWakes: Helper;
  drainQueuedSends: Helper;
  drainSecretResumes: Helper;
  drainTeamSetupResumes: Helper;
}

export function createConfigRoutes(deps: ConfigRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    const {
      store, cfg, registry, sessions, providerWrite, localVmFlags, localVmIdles, localVmActiveThreads,
      localVmLifecycleBusy, browserCleanup, browserLive, browserRuntime, decider, sharedComputers,
      sharedComputerControl, broadcast, configStatus, configForAccess, checkedModelSelection,
      lendingEnabled, localVmIdleMs, perBotLocalVmCountForModeChange, reloadProviders,
      revokeAllInternalCapabilities, drainComputerResumes, drainConnectorResumes, drainDelegationWakes,
      drainQueuedSends, drainSecretResumes, drainTeamSetupResumes,
    } = deps;
    if (method === "GET" && path === "/api/config") {
      return json(res, 200, configForAccess(configStatus(), auth.scopes.includes("admin")));
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);

      const patch = parseConfigPatch(body);
      if (patch.newBotDefaults) {
        if (patch.newBotDefaults.profile.modelSelection) {
          const checked = checkedModelSelection(patch.newBotDefaults.profile.modelSelection);
          if (!checked.ok) return json(res, checked.status, { error: checked.error });
          patch.newBotDefaults.profile.modelSelection = checked.selection;
        }
        for (const skill of patch.newBotDefaults.skills) {
          const parsed = parseSkillMd(skill.text);
          if ("error" in parsed || parsed.name !== skill.name) return json(res, 400, { error: "Skill name does not match its contents" });
        }
      }

      if (patch.automaticRecovery?.enabled) {
        const checked = checkedModelSelection(patch.automaticRecovery.backup, undefined, true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        const target = registry.get(checked.selection.instanceId)!;
        if (!target.enabled) return json(res, 400, { error: "Enable the backup engine before selecting it for recovery." });
        patch.automaticRecovery.backup = checked.selection;
      }
      if (!Object.keys(patch).length) return json(res, 400, { error: "nothing to save" });
      if (patch.decider) {
        // Saving a key is the "turn it on"; clearing it turns it off, or
        // falls back to Cloud Pro's included decisions where there are some.
        const planned = deciderSavePatch(patch.decider, cfg.decider);
        if (!planned.ok) return json(res, 400, { error: planned.error });
        patch.decider = planned.patch;
      }
      const changingVoiceProvider = patch.tts?.provider !== undefined
        && patch.tts.provider !== tts.voiceProvider(cfg);
      if (changingVoiceProvider && patch.tts?.voice === undefined) {
        // Voice ids are provider-owned opaque values. Never carry a default
        // from one catalog into another. A caller may explicitly supply a
        // voice for the newly selected provider in this same atomic patch.
        patch.tts = { ...patch.tts, voice: "" };
      }
      if (providerWrite.busy) return json(res, 409, { error: "provider settings are already being updated" });
      if (patch.browserProfiles !== undefined && body.expectedBrowserProfiles !== undefined) {
        const current = (cfg.browserProfiles ?? []).map(({ id, name }) => ({ id, name }));
        if (JSON.stringify(body.expectedBrowserProfiles) !== JSON.stringify(current)) {
          return json(res, 409, { error: "Browser profiles changed in another window. Review the refreshed list and try again." });
        }
      }
      const disablingBuiltInBrowser = patch.features?.browser === false && builtInBrowserEnabled(cfg);
      const removedBrowserProfileIds = patch.browserProfiles === undefined
        ? []
        : (cfg.browserProfiles ?? [])
            .map((profile) => profile.id)
            .filter((id) => !patch.browserProfiles!.some((profile) => profile.id === id));
      const profileControlConflict = () => removedBrowserProfileIds.some((id) => {
        const target = browserProfilePartitionTarget(cfg, id);
        return target && browserRuntime.heldBy(browserSessionId("", target.partitionId));
      });
      if (profileControlConflict()) return json(res, 409, { error: "Release browser control before deleting its profile." });
      if (patch.browserProfiles !== undefined) {
        const currentProfiles = new Map((cfg.browserProfiles ?? []).map((profile) => [profile.id, profile]));
        const nextProfiles = patch.browserProfiles.map((profile) => {
          const partitionId = currentProfiles.get(profile.id)?.partitionId;
          return partitionId ? { ...profile, partitionId } : profile;
        });
        const routingConflict = browserProfileReplacementConflict(cfg.browserProfiles ?? [], nextProfiles);
        if (routingConflict) return json(res, 409, { error: routingConflict });
        const currentIds = new Set((cfg.browserProfiles ?? []).map((profile) => profile.id));
        const pendingReuse = patch.browserProfiles.find(
          (profile) => !currentIds.has(profile.id) && browserCleanup.hasPendingProfile(profile.id),
        );
        if (pendingReuse) {
          return json(res, 409, {
            error: `the previous “${pendingReuse.name}” browser session is still being erased — wait before reusing it`,
          });
        }
      }
      if (patch.browserProfiles !== undefined) {
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        const activeReference = store.bots.find(
          (bot) => bot.busy && bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile),
        );
        if (activeReference) {
          return json(res, 409, {
            error: `stop ${activeReference.name}'s turn before removing its browser profile`,
          });
        }
      }
      providerWrite.busy = true;
      const changingLocalVmMode = patch.localVm?.mode !== undefined && patch.localVm.mode !== localVmMode(cfg);
      if (changingLocalVmMode) localVmFlags.modeChangeBusy = true;
      try {
        if (changingLocalVmMode) {
          if (localVmActiveThreads.size > 0 || localVmLifecycleBusy.size > 0 || localVmFlags.imageBusy) {
            return json(res, 409, { error: "stop Local VM turns and setup actions before changing the Local VM isolation mode" });
          }
          if (localVmMode(cfg) === "per-bot" && patch.localVm?.mode === "shared") {
            const existing = await perBotLocalVmCountForModeChange();
            if (existing === null) {
              return json(res, 409, {
                error: "start the container runtime and delete every per-bot VM before switching to shared mode",
              });
            }
            if (existing > 0) {
              return json(res, 409, {
                error: `delete the ${existing} per-bot Local VM${existing === 1 ? "" : "s"} before switching to shared mode`,
              });
            }
          }
        }
      // A project key is useful only if it can create/reuse the Session that
      // powers both the connections UI and the agent MCP. Validate it before
      // persisting, and save the non-secret ids needed to reuse that Session.
      const requestedComposioKey = patch.composio?.apiKey;
      if (requestedComposioKey !== undefined) {
        if (requestedComposioKey.trim()) {
          try {
            const prepared = await composio.prepareProjectSession(requestedComposioKey, cfg.composio);
            patch.composio = { ...patch.composio, ...prepared };
          } catch (error) {
            return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        } else {
          const currentCredential = composioCredentialStatus(cfg);
          if (currentCredential.available && !currentCredential.canRemove) return json(res, 409, { error: currentCredential.source === "environment"
            ? "This Composio key is provided by the environment and cannot be removed from the app."
            : "The credential store could not be read on this launch. Restart after unlocking your keychain before removing saved keys." });
          patch.composio = { ...patch.composio, apiKey: "", sessionId: "" };
        }
      }
      // Each cloud voice provider owns its own credential. Validate the field
      // against that provider rather than whichever provider happens to be
      // selected, so switching engines never sends one service another's key.
      const newTts = patch.tts;
      if (newTts?.key?.trim()) {
        const check = await tts.verifyKey("elevenlabs", newTts.key.trim());
        if (!check.ok) return json(res, 400, { error: check.message });
      }
      if (newTts?.fishKey?.trim()) {
        const check = await tts.verifyKey("fish", newTts.fishKey.trim());
        if (!check.ok) return json(res, 400, { error: check.message });
      }
      // A pasted decision-model key is tried once (one tiny yes/no call).
      // Only a refusal blocks the save: an offline or overloaded service must
      // not stop a person saving a key that may well be fine.
      if (patch.decider?.key) {
        const check = await decider.testKey({ key: patch.decider.key });
        if (!check.ok && check.reason === "rejected") {
          return json(res, 400, { error: "Jev rejected this key. Check it at typesafe.ai and paste it again.", code: "decider_rejected" });
        }
      }
      if (patch.browserProfiles !== undefined) {
        // Provider/credential validation above may await the network. A turn
        // can start during that window and claim a profile which looked idle
        // at the route's first check, so validate again at the mutation
        // boundary. Keep this check and the synchronous save/reference cleanup
        // below free of awaits.
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        const activeReference = store.bots.find(
          (bot) => bot.busy && bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile),
        );
        if (activeReference) {
          return json(res, 409, {
            error: `stop ${activeReference.name}'s turn before removing its browser profile`,
          });
        }
      }
      // A change names only the OpenCode provider keys it saves or removes;
      // the rest stay. Merged with no await before the save below, so it
      // starts from what is saved at that moment.
      if (patch.opencodeGo?.providerKeys) {
        const merged = mergeOpenCodeProviderKeys(cfg, patch.opencodeGo.providerKeys);
        if (!merged.ok) return json(res, 400, { error: merged.error });
        patch.opencodeGo = { ...patch.opencodeGo, providerKeys: merged.keys };
      }
      const browserCleanupRequests: BrowserCleanupRequest[] = [];
      if (profileControlConflict()) return json(res, 409, { error: "Release browser control before deleting its profile." });
      try {
        for (const profileId of removedBrowserProfileIds) {
          const target = browserProfilePartitionTarget(cfg, profileId);
          if (!target) throw new Error(`browser profile cleanup target “${profileId}” is unavailable`);
          browserCleanupRequests.push(
            browserCleanup.prepare("profile", target.profileId, target.partitionId),
          );
        }
      } catch (error) {
        for (const request of browserCleanupRequests) browserCleanup.abort(request);
        throw error;
      }
      // A saved or cleared key starts over: neither it nor the key it
      // replaced stays marked as rejected.
      const resetKeys = PROVIDER_KEY_KINDS.flatMap((kind) => {
        const next = patch[kind]?.key;
        return next === undefined ? [] : [cfg[kind]?.key, next];
      });
      let configWriteCommitted = false;
      const externalSecretStorage = url.searchParams.get("secretStorage") === "external";
      try {
        // Provider-owned voice ids must be invalidated before the provider
        // commit. If bots.json cannot be written, leave the old provider in
        // place rather than committing a new provider with stale bot voices.
        // A later config-write failure may leave voices cleared, which is the
        // safe side of this cross-file mutation: no foreign id can be spoken.
        if (changingVoiceProvider) store.clearVoiceSelections();
        if (externalSecretStorage) {
          // The packaged Electron caller commits supplied credentials to the
          // OS-encrypted store before entering this route. Persist every
          // non-secret sibling in the same request, but replace each supplied
          // credential with an empty tombstone so an older plaintext value can
          // never survive the merge in config.json.
          const persisted = structuredClone(patch);
          if (persisted.xai?.key !== undefined) persisted.xai.key = "";
          if (persisted.composio?.apiKey !== undefined) persisted.composio.apiKey = "";
          if (persisted.box?.token !== undefined) persisted.box.token = "";
          if (persisted.opencodeGo?.apiKey !== undefined) persisted.opencodeGo.apiKey = "";
          if (persisted.tts?.key !== undefined) persisted.tts.key = "";
          if (persisted.tts?.fishKey !== undefined) persisted.tts.fishKey = "";
          if (persisted.decider?.key !== undefined) persisted.decider.key = "";
          if (persisted.imageGen?.key !== undefined) persisted.imageGen.key = "";
          if (persisted.imageGen?.customApiKey !== undefined) persisted.imageGen.customApiKey = "";
          if (persisted.live?.key !== undefined) persisted.live.key = "";
          saveConfig(persisted);
          configWriteCommitted = true;
          syncCredentialEnv(patch, url.searchParams.get("composioSource") === "environment" ? "environment" : "secure-store");
          Object.assign(cfg, loadConfig());
        } else {
          saveConfig(patch);
          configWriteCommitted = true;
          // loadConfig prefers env over the file for credentials, so the env
          // must follow the save — otherwise the value injected at boot would
          // shadow the new key until the next launch
          syncCredentialEnv(patch);
          Object.assign(cfg, loadConfig());
        }
      } catch (error) {
        if (configWriteCommitted) {
          for (const request of browserCleanupRequests) {
            const committed = browserCleanup.commit(request);
            void browserCleanup.ensure(committed);
          }
        } else {
          for (const request of browserCleanupRequests) browserCleanup.abort(request);
        }
        throw error;
      }
      for (const key of resetKeys) if (key) forgetKey(key);
      // Desktops already counting down move to the new window at once, in
      // every isolation mode; busy work still defers its expiry.
      if (patch.localVm?.idleTimeoutMinutes !== undefined) {
        for (const idle of localVmIdles.values()) idle.setIdleMs(localVmIdleMs());
      }
      let browserReferenceCleanupError: unknown = null;
      if (patch.signIn !== undefined) {
        sessions.revalidateEmailSessions();
      }
      if (!lendingEnabled()) {
        sharedComputers.close();
        sharedComputerControl.close();
      }
      if (disablingBuiltInBrowser) browserLive.closeAll();
      for (const request of browserCleanupRequests) {
        if (request.kind === "profile") browserLive.closeForSession(browserSessionId("", request.partitionId));
      }
      if (patch.browserProfiles !== undefined) {
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        try {
          for (const bot of store.bots) {
            if (bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile)) {
              // The profile list and every bot reference change in the same
              // config request. Non-renderer clients therefore cannot leave a
              // bot pointing at a deleted cookie partition.
              store.patchBot(bot.id, { browserProfile: undefined });
            }
          }
        } catch (error) {
          // Config is already durable. Keep the cleanup intent prepared (so
          // it cannot wipe ambiguous state and its id remains locked), but do
          // not let this secondary write failure skip revocation/reload below.
          browserReferenceCleanupError = error;
        }
      }
      // Provider keys change the fleet. Profile, language, voice, VPS, and
      // onboarding progress changes do not rebuild it: no driver
      // reads them, and they should not interrupt in-flight turns.
      const reloadKeys = providerReloadKeys(patch);
      // Config is already durable. A provider credential or runtime change
      // invalidates every old child immediately, including when browser
      // cleanup below has to await Electron before reloadProviders begins.
      if (reloadKeys.length > 0) revokeAllInternalCapabilities();
      // The cleanup marker becomes committed only after both pieces of durable
      // application state agree. Commit/ACK failures are deferred until every
      // mandatory consequence of the config write has run: no journal I/O
      // failure may leave a two-hour bearer or stale provider fleet active.
      const finalized = await finalizeBrowserCleanupMutation({
        requests: browserCleanupRequests,
        referenceError: browserReferenceCleanupError,
        commit: (request) => browserCleanup.commit(request),
        ensure: (request) => browserCleanup.ensure(request),
        mandatory: async () => {
          let mandatoryError: unknown = null;
          if (disablingBuiltInBrowser) {
            try {
            } catch (error) {
              mandatoryError = error;
            }
          }
          if (reloadKeys.length > 0) {
            try {
              await reloadProviders();
            } catch (error) {
              if (!mandatoryError) mandatoryError = error;
            }
          }
          const status = configStatus();
          broadcast({ kind: "config", ...status });
          if (patch.threads !== undefined) {
            drainQueuedSends();
            drainDelegationWakes();
            drainConnectorResumes();
            drainComputerResumes();
            drainSecretResumes();
            drainTeamSetupResumes();
          }
          if (mandatoryError) throw mandatoryError;
          return status;
        },
      });
      // Normal desktop deletes wait for Electron's acknowledgement. If
      // Electron is restarting, the committed journal keeps retrying and the
      // id-reuse guard above prevents stale logins from resurfacing. Delaying
      // this assertion until after every mandatory post-commit effect keeps
      // the runtime aligned with the config even on a truthful 503 response.
      requireBrowserCleanupAcknowledged(
        finalized.acknowledgements.every(Boolean),
        removedBrowserProfileIds.length === 1 ? "The browser profile" : "The browser profiles",
      );
      return json(res, 200, finalized.value);
      } finally {
        if (changingLocalVmMode) localVmFlags.modeChangeBusy = false;
        providerWrite.busy = false;
      }
    }
    return PASS;
  };
}
