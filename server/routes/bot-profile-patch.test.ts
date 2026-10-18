import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { createBotProfilePatchRoutes, type BotProfilePatchRouteDeps } from "./bot-profile-patch.ts";

const PROFILE = "/api/bots/b1/profile";

const call = async (handler: RouteHandler, path = PROFILE, method = "PATCH", body: unknown = { name: "Rapi" }) => {
  const { ctx, sent } = callRoute(path, method, body);
  return { out: await handler(ctx), sent };
};

const deps = (over: Partial<Record<string, unknown>> = {}) => {
  const patched: Array<[string, unknown]> = [];
  const events: unknown[] = [];
  const fake = {
    store: {
      bot: (id: string) => (id === "b1" ? { id, name: "Old", avatarUrl: "old.png" } : undefined),
      patchBotProfile: (id: string, patch: unknown) => {
        if (id !== "b1") return undefined;
        patched.push([id, patch]);
        return { id, name: "Rapi", avatarUrl: "old.png" };
      },
    },
    storedAvatarExists: () => true,
    wireBot: (bot: { id: string; name: string }) => ({ id: bot.id, name: bot.name }),
    broadcast: (payload: Record<string, unknown>) => events.push(payload),
    ...over,
  } as unknown as BotProfilePatchRouteDeps;
  return { deps: fake, patched, events };
};

test("a request that is not a profile edit is left to the next handler", async () => {
  const { deps: fake } = deps();
  const handler = createBotProfilePatchRoutes(fake);
  const elsewhere = await call(handler, "/api/health", "PATCH");
  const wrongVerb = await call(handler, PROFILE, "GET");

  expect(elsewhere.out).toBe(PASS);
  expect(wrongVerb.out).toBe(PASS);
});

test("a field the profile does not have is refused rather than ignored", async () => {
  const { deps: fake, patched } = deps();
  const { sent } = await call(createBotProfilePatchRoutes(fake), PROFILE, "PATCH", { nickname: "Rapi" });

  expect((sent[0]?.body as { error?: string } | undefined)?.error).toMatch(/unsupported profile field: nickname/);
  expect(sent[0]?.status).toBe(400);
  expect(patched).toEqual([]);
});

test("an accepted edit is stored, answered and told to the room", async () => {
  const { deps: fake, patched, events } = deps();
  const { sent } = await call(createBotProfilePatchRoutes(fake), PROFILE, "PATCH", { name: "Rapi" });

  expect(patched).toEqual([["b1", { name: "Rapi" }]]);
  expect(events).toEqual([{ kind: "bot", bot: { id: "b1", name: "Rapi" } }]);
  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toEqual({ bot: { id: "b1", name: "Rapi" } });
});

test("an avatar that is not stored is refused, and an unknown bot is a 404", async () => {
  const refused = deps({ storedAvatarExists: () => false });
  const badAvatar = await call(createBotProfilePatchRoutes(refused.deps), PROFILE, "PATCH", { avatarUrl: "/api/attachments/gone.png" });
  const missing = deps();
  const unknownBot = await call(createBotProfilePatchRoutes(missing.deps), "/api/bots/nope/profile", "PATCH", { name: "Rapi" });

  expect(badAvatar.sent).toEqual([{ status: 400, body: { error: "avatarUrl must reference an existing stored image" } }]);
  expect(unknownBot.sent).toEqual([{ status: 404, body: { error: "no such bot" } }]);
  expect(missing.patched).toEqual([]);
});