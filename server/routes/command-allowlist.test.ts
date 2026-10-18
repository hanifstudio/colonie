import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { createCommandAllowlistRoutes, type CommandAllowlistRouteDeps } from "./command-allowlist.ts";

const LIST = "/api/bots/b1/command-allowlist";
const RULE = `${LIST}/r1`;
const candidate = { command: "npm test", cwd: "/tmp/work", providerInstanceId: "claude-1" };

const deps = (over: Partial<Record<string, unknown>> = {}) => {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const fake = {
    store: {},
    allowlist: {
      add: (botId: string, value: unknown) => added.push([botId, value]),
      remove: (botId: string, ruleId: string) => removed.push([botId, ruleId]),
    },
    registry: { get: (id: string) => (id === "claude-1" ? { driverKind: "claudeAgent" } : { driverKind: "openai" }) },
    canManage: () => true,
    requestedTaskBot: (botId: string, rawThreadId: unknown) => ({ id: botId, threadId: rawThreadId ?? "t1" }),
    response: (bot: { id: string }) => ({ rules: [], supported: true, context: { bot: bot.id } }),
    drivers: new Set(["claudeAgent"]),
    ...over,
  } as unknown as CommandAllowlistRouteDeps;
  return { deps: fake, added, removed };
};

const call = async (handler: RouteHandler, path = LIST, method = "GET", body: unknown = {}) => {
  const { ctx, sent } = callRoute(path, method, body);
  return { out: await handler(ctx), sent };
};

test("a request for another route is left to the next handler", async () => {
  const { deps: fake } = deps();
  const handler = createCommandAllowlistRoutes(fake);
  const elsewhere = await call(handler, "/api/health", "GET");
  const notTheList = await call(handler, "/api/bots/b1/always-allow", "GET");

  expect(elsewhere.out).toBe(PASS);
  expect(notTheList.out).toBe(PASS);
});

test("only the owner or an admin may look at the list at all", async () => {
  const { deps: fake } = deps({ canManage: () => false });
  const { sent } = await call(createCommandAllowlistRoutes(fake));

  expect(sent).toEqual([{ status: 403, body: { error: "Only the owner or an admin can manage command permissions." } }]);
});

test("reading the list answers with the bot's rules and whether its provider supports them", async () => {
  const { deps: fake } = deps();
  const { sent } = await call(createCommandAllowlistRoutes(fake));

  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toEqual({ rules: [], supported: true, context: { bot: "b1" } });
});

test("adding a rule checks the candidate, then the provider, then saves it", async () => {
  const { deps: fake, added } = deps();
  const handler = createCommandAllowlistRoutes(fake);
  const incomplete = await call(handler, LIST, "POST", { command: "npm test" });
  const unsupported = await call(handler, LIST, "POST", { ...candidate, providerInstanceId: "other-1" });
  const saved = await call(handler, LIST, "POST", candidate);

  expect(incomplete.sent[0]).toEqual({
    status: 400,
    body: { error: "Enter an exact command without secret values, an absolute working folder, and a provider." },
  });
  expect(unsupported.sent[0]).toEqual({
    status: 400,
    body: { error: "This provider does not supply structured command approvals." },
  });
  expect(saved.sent[0]?.status).toBe(200);
  expect(added).toEqual([["b1", candidate]]);
});

test("removing a rule takes its id, and anything else on the path is refused", async () => {
  const { deps: fake, removed } = deps();
  const handler = createCommandAllowlistRoutes(fake);
  const gone = await call(handler, RULE, "DELETE");
  const noIdPost = await call(handler, RULE, "POST", candidate);
  const patch = await call(handler, LIST, "PATCH");

  expect(gone.sent[0]?.status).toBe(200);
  expect(removed).toEqual([["b1", "r1"]]);
  expect(noIdPost.sent).toEqual([{ status: 405, body: { error: "Unsupported command allowlist operation" } }]);
  expect(patch.sent).toEqual([{ status: 405, body: { error: "Unsupported command allowlist operation" } }]);
});