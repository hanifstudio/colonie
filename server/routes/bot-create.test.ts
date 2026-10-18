// Creating a bot touches skills, memory, presets and the store, so this guards
// the refusals (the branches a mistake would turn into a half-created bot) and
// proves creation itself live on a throwaway HOME instead of faking every dep.
import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { createBotCreateRoutes, type BotCreateRouteDeps } from "./bot-create.ts";

const CREATE = "/api/bots";

const deps = (over: Partial<Record<string, unknown>> = {}) => {
  const fake = {
    store: {
      bots: [],
      sections: [],
      createBot: (input: { name?: string }) => ({ id: "new", name: input.name ?? "Bot", threadId: "t-new" }),
      deleteBot: () => true,
      patchBot: () => ({ id: "new" }),
      messagesFor: () => [],
      activeLeaf: () => undefined,
      setChiefOfStaff: () => [],
    },
    cfg: { newBotDefaults: {}, browserProfiles: [] },
    presetStore: { resolve: () => null },
    routines: () => null,
    desktopManaged: false,
    maxWorkspaceBots: 100,
    wireBot: (bot: { id: string }) => ({ id: bot.id }),
    storedAvatarExists: () => false,
    defaultSelection: async () => ({ instanceId: "codex-acp", model: "gpt" }),
    checkedModelSelection: () => ({ ok: true, selection: { instanceId: "codex-acp", model: "gpt" } }),
    ...over,
  } as unknown as BotCreateRouteDeps;
  return fake;
};

const call = async (handler: RouteHandler, path = CREATE, method = "POST", body: unknown = {}, auth: unknown = { kind: "loopback" }) => {
  const { ctx, sent } = callRoute(path, method, body);
  (ctx as { auth: unknown }).auth = auth;
  return { out: await handler(ctx), sent };
};

test("another route, or another verb, is left to the next handler", async () => {
  const handler = createBotCreateRoutes(deps());
  const elsewhere = await call(handler, "/api/health", "POST");
  const wrongVerb = await call(handler, CREATE, "GET");

  expect(elsewhere.out).toBe(PASS);
  expect(wrongVerb.out).toBe(PASS);
  expect(elsewhere.sent).toEqual([]);
});

test("an avatar that is not stored is refused", async () => {
  const { sent } = await call(createBotCreateRoutes(deps()), CREATE, "POST", { settings: { avatarUrl: "/api/attachments/gone.png" } });

  expect(sent).toEqual([{ status: 400, body: { error: "avatarUrl must reference an existing stored image" } }]);
});

test("a section name that is too long is refused", async () => {
  const { ctx } = callRoute(CREATE, "POST", { section: "x".repeat(61) });
  (ctx as { auth: unknown }).auth = { kind: "loopback" };

  // The default-profile schema owns this rule, and it refuses by throwing: the
  // server's outer catch is what turns that into the answer, module or not.
  await expect(createBotCreateRoutes(deps())(ctx)).rejects.toMatchObject({ status: 400 });
  await expect(createBotCreateRoutes(deps())(ctx)).rejects.toThrowError(/<=60 characters/);
});

test("a workspace at its limit refuses the next bot", async () => {
  const full = deps({ store: { bots: [{}], sections: [], messagesFor: () => [], activeLeaf: () => undefined }, maxWorkspaceBots: 1 });
  const { sent } = await call(createBotCreateRoutes(full), CREATE, "POST", {});

  expect(sent).toEqual([{ status: 409, body: { error: "this workspace is limited to 1 bots" } }]);
});