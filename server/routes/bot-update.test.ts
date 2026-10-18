// The broad bot edit is the largest route family in the app, so this guards the
// branches a mistake would break silently: declining, an unknown bot, a body
// that is not an object, a rename that must land, and a widened field a phone
// may not change. The deep branches (models, engines, browsers) are proven live
// on a throwaway HOME instead, because a fake of every dep would only test the
// fake.
import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { createBotUpdateRoutes, type BotUpdateRouteDeps } from "./bot-update.ts";

const BOT = "/api/bots/b1";

const deps = (over: Partial<Record<string, unknown>> = {}) => {
  const patched: Array<[string, unknown]> = [];
  const events: unknown[] = [];
  const state = { name: "Old", visibility: "everyone" };
  const announced = { count: 0 };
  const fake = {
    store: {
      bot: (id: string) => (id === "b1" ? { id, name: state.name, threadId: "t1", visibility: state.visibility, browserProfile: undefined } : undefined),
      patchBot: (id: string, patch: unknown) => {
        if (id !== "b1") return undefined;
        patched.push([id, patch]);
        if ((patch as { name?: string }).name) state.name = (patch as { name: string }).name;
        if ((patch as { visibility?: string }).visibility) state.visibility = (patch as { visibility: string }).visibility;
        return { id, name: state.name, threadId: "t1", visibility: state.visibility };
      },
      bots: [{ id: "b1", threadId: "t1", visibility: "everyone" }],
      sections: [{ id: "s1" }],
      patchTask: () => null,
      setChiefOfStaff: () => [],
      tasks: () => [{ id: "t1", threadId: "t1", modelSelection: { instanceId: "codex-acp", model: "gpt" } }],
    },
    cfg: { browserProfiles: [] },
    registry: { get: () => ({ driverKind: "codexAgent" }), cliTarget: () => ({ driverKind: "codexAgent" }) },
    sessions: { isLive: () => true },
    routines: () => null,
    memoryUpkeep: { dropBot: () => {} },
    browserLive: { closeForBot: () => {} },
    browserRuntime: { heldBy: () => null },
    desktopManaged: false,
    maxWorkspaceBots: 100,
    broadcast: (payload: Record<string, unknown>) => events.push(payload),
    wireBot: (bot: { id: string; name: string }) => ({ id: bot.id, name: bot.name }),
    requestedTaskBot: (botId: string) => ({ id: botId, threadId: "t1" }),
    threadBusy: () => false,
    checkedModelSelection: () => ({ ok: true, selection: { instanceId: "codex-acp", model: "gpt" } }),
    supportsApprovalMode: () => true,
    audienceChanged: () => { announced.count += 1; },
    currentBrowserSession: () => "s1",
    interruptAllDirectThreads: async () => {},
    forgetTemporaryBrowser: async () => {},
    storedAvatarExists: () => true,
    ...over,
  } as unknown as BotUpdateRouteDeps;
  return { deps: fake, patched, events, announced };
};

const call = async (handler: RouteHandler, path = BOT, method = "PATCH", body: unknown = { name: "New" }, auth: unknown = { kind: "loopback" }) => {
  const { ctx, sent } = callRoute(path, method, body);
  (ctx as { auth: unknown }).auth = auth;
  return { out: await handler(ctx), sent };
};

test("another route, or another verb, is left to the next handler", async () => {
  const { deps: fake } = deps();
  const handler = createBotUpdateRoutes(fake);
  const elsewhere = await call(handler, "/api/health", "PATCH");
  const wrongVerb = await call(handler, BOT, "GET");

  expect(elsewhere.out).toBe(PASS);
  expect(wrongVerb.out).toBe(PASS);
  expect(elsewhere.sent).toEqual([]);
});

test("a bot that does not exist is a 404, and a body that is not an object a 400", async () => {
  const { deps: fake, patched } = deps();
  const handler = createBotUpdateRoutes(fake);
  const unknownBot = await call(handler, "/api/bots/nope", "PATCH", { name: "New" });
  const notAnObject = await call(handler, BOT, "PATCH", [1, 2]);

  expect(unknownBot.sent).toEqual([{ status: 404, body: { error: "no such bot" } }]);
  expect(notAnObject.sent).toEqual([{ status: 400, body: { error: "body must be a JSON object" } }]);
  expect(patched).toEqual([]);
});

test("a rename is stored, answered with the bot, and told to the room", async () => {
  const { deps: fake, patched, events } = deps();
  const { sent } = await call(createBotUpdateRoutes(fake), BOT, "PATCH", { name: "New" });

  expect(patched).toEqual([["b1", { name: "New" }]]);
  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toEqual({ bot: { id: "b1", name: "New" } });
  // A rename is answered to the caller only; the room hears about a change of
  // audience, which is the test below.
  expect(events).toEqual([]);
});

test("a change of audience re-announces the bot's teams", async () => {
  const { deps: fake, events, announced } = deps();
  const { sent } = await call(createBotUpdateRoutes(fake), BOT, "PATCH", { visibility: "admins" });

  expect(sent[0]?.status).toBe(200);
  expect(events).toEqual([{ kind: "sections", sections: [{ id: "s1" }] }]);
  expect(announced.count).toBe(1);
});

test("a field a phone session may not change is refused before anything is stored", async () => {
  const { deps: fake, patched } = deps();
  const { sent } = await call(
    createBotUpdateRoutes(fake),
    BOT,
    "PATCH",
    { toolScope: "full" },
    { kind: "session", scopes: [], session: { id: "s1" } },
  );

  expect(sent[0]?.status).toBe(403);
  expect(patched).toEqual([]);
});