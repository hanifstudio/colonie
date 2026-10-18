// Settings and the model picker, where "unknown instance" must never be
// confused with "nothing to show": these guard the front door — what a body
// must look like, that an engine Colonie cannot reach is a 404, and that a
// credential is never asked for through a route that echoes settings back.
import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS } from "./table.ts";
import { createProviderInstanceRoutes, type ProviderInstanceRouteDeps } from "./provider-instances.ts";

const JSON_HEADERS = { "content-type": "application/json" };

const deps = (over: Partial<Record<string, unknown>> = {}) => {
  const persisted: unknown[] = [];
  const fake = {
    store: { bots: [], tasks: () => [], bot: () => undefined },
    cfg: {},
    registry: {
      refreshModels: async () => false,
      installRuntime: async () => false,
      get: () => null,
    },
    providerAuthSessions: {
      status: async () => ({ kind: "none" }),
      start: async () => ({ kind: "none" }),
      revokeOwner: () => {},
      signOut: async () => {},
      complete: async () => {},
      cancel: async () => {},
    },
    sessions: { isLive: () => true },
    providerInstancesChanging: new Set<string>(),
    providerWrite: { busy: false },
    botForThread: () => null,
    threadBusy: () => false,
    describeInstances: async () => [{ instanceId: "codex-acp", driverKind: "codex" }],
    persistProviderInstance: async (...args: unknown[]) => { persisted.push(args); },
    configStatus: () => ({}),
    broadcast: () => {},
    ...over,
  } as unknown as ProviderInstanceRouteDeps;
  return { deps: fake, persisted };
};

const call = async (
  handler: ReturnType<typeof createProviderInstanceRoutes>,
  path: string,
  method = "GET",
  body: unknown = {},
  headers: Record<string, string> = JSON_HEADERS,
) => {
  const { ctx, sent } = callRoute(path, method, body, headers);
  return { out: await handler(ctx), sent };
};

const errorOf = (sent: Array<{ body: unknown }>) => (sent[0]?.body as { error?: string } | undefined)?.error;

test("another route, or another verb, is left to the next handler", async () => {
  const handler = createProviderInstanceRoutes(deps().deps);
  const elsewhere = await call(handler, "/api/health", "POST");
  const wrongVerb = await call(handler, "/api/instances", "DELETE");

  expect(elsewhere.out).toBe(PASS);
  expect(wrongVerb.out).toBe(PASS);
  expect(elsewhere.sent).toEqual([]);
});

test("the model picker lists instances without ever sending a credential", async () => {
  const { sent } = await call(createProviderInstanceRoutes(deps().deps), "/api/instances");

  expect(sent).toEqual([{ status: 200, body: { instances: [{ instanceId: "codex-acp", driverKind: "codex" }] } }]);
});

test("an engine Colonie cannot reach is a 404, not an empty list", async () => {
  const handler = createProviderInstanceRoutes(deps().deps);
  const refresh = await call(handler, "/api/instances/gone/refresh-models", "POST");
  const signIn = await call(handler, "/api/instances/gone/acp-auth", "POST");

  expect(refresh.sent).toEqual([{ status: 404, body: { error: "unknown instance" } }]);
  expect(signIn.sent).toEqual([{ status: 404, body: { error: "no such sign-in-able ACP connection" } }]);
});

test("signing in refuses a form post from another page", async () => {
  const { sent } = await call(createProviderInstanceRoutes(deps().deps), "/api/instances/gone/acp-auth", "POST", {}, {});
  const formPost = await call(
    createProviderInstanceRoutes(deps().deps),
    "/api/instances/gone/acp-auth",
    "POST",
    {},
    { "content-type": "application/x-www-form-urlencoded" },
  );

  expect(sent).toEqual([{ status: 415, body: { error: "content-type must be application/json" } }]);
  expect(formPost.sent[0]?.status).toBe(415);
});

test("an account without a name is refused before anything is written", async () => {
  const { deps: fake, persisted } = deps();
  const { sent } = await call(createProviderInstanceRoutes(fake), "/api/instances/claude-accounts", "POST", {});

  expect(sent[0]?.status).toBe(400);
  expect(errorOf(sent)).toBeTruthy();
  expect(persisted).toEqual([]);
});