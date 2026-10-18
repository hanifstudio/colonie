// Settings is the route that writes to the live app, so this guards the two
// decisions that must happen before anything is applied: who may see the admin
// half of the config, and that a second settings write is refused rather than
// allowed to race the first.
import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS } from "./table.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "./config.ts";

const CONFIG = "/api/config";

const deps = (over: Partial<Record<string, unknown>> = {}) => {
  const seen: unknown[] = [];
  const fake = {
    store: { bots: [], tasks: () => [] },
    cfg: {},
    registry: { get: () => ({ enabled: true }) },
    sessions: { revalidateEmailSessions: () => {} },
    providerWrite: { busy: false },
    localVmFlags: { imageBusy: false, modeChangeBusy: false },
    localVmIdles: new Map(),
    localVmActiveThreads: new Map(),
    localVmLifecycleBusy: new Set(),
    browserCleanup: { prepare: () => null, abort: () => {}, commit: () => null, ensure: () => {}, hasPendingProfile: () => false },
    browserLive: { closeAll: () => {}, closeForSession: () => {} },
    browserRuntime: { heldBy: () => false },
    decider: { testKey: async () => ({ ok: true }) },
    sharedComputers: { close: () => {} },
    sharedComputerControl: { close: () => {} },
    broadcast: () => {},
    configStatus: () => ({ version: "test" }),
    configForAccess: (...args: unknown[]) => { seen.push(args); return { version: "test", safe: args[1] }; },
    checkedModelSelection: () => ({ ok: true, selection: {} }),
    lendingEnabled: () => false,
    localVmIdleMs: () => 60_000,
    perBotLocalVmCountForModeChange: () => 0,
    reloadProviders: async () => {},
    revokeAllInternalCapabilities: () => {},
    drainComputerResumes: () => {},
    drainConnectorResumes: () => {},
    drainDelegationWakes: () => {},
    drainQueuedSends: () => {},
    drainSecretResumes: () => {},
    drainTeamSetupResumes: () => {},
    ...over,
  } as unknown as ConfigRouteDeps;
  return { deps: fake, seen };
};

const call = async (
  handler: ReturnType<typeof createConfigRoutes>,
  path = CONFIG,
  method = "GET",
  body: unknown = {},
  scopes: string[] = [],
) => {
  const { ctx, sent } = callRoute(path, method, body);
  (ctx as { auth: { scopes: string[] } }).auth = { scopes };
  return { out: await handler(ctx), sent };
};

test("another route is left to the next handler", async () => {
  const handler = createConfigRoutes(deps().deps);
  const elsewhere = await call(handler, "/api/health", "POST");
  const wrongVerb = await call(handler, CONFIG, "DELETE");

  expect(elsewhere.out).toBe(PASS);
  expect(wrongVerb.out).toBe(PASS);
  expect(elsewhere.sent).toEqual([]);
});

test("reading the config asks for the admin half only for an admin", async () => {
  const { deps: fake, seen } = deps();
  const handler = createConfigRoutes(fake);

  await call(handler, CONFIG, "GET", {}, []);
  await call(handler, CONFIG, "GET", {}, ["admin"]);

  expect(seen).toEqual([[{ version: "test" }, false], [{ version: "test" }, true]]);
});

test("a patch that changes nothing is refused", async () => {
  const { sent } = await call(createConfigRoutes(deps().deps), CONFIG, "PUT", {});

  expect(sent).toEqual([{ status: 400, body: { error: "nothing to save" } }]);
});

test("a second settings write is refused while the first is in flight", async () => {
  const { deps: fake, seen } = deps({ providerWrite: { busy: true } });
  const { sent } = await call(createConfigRoutes(fake), CONFIG, "PUT", { tts: { voice: "abc" } });

  expect(sent).toEqual([{ status: 409, body: { error: "provider settings are already being updated" } }]);
  // Nothing was read on the way in either: the refusal comes before the write.
  expect(seen).toEqual([]);
});