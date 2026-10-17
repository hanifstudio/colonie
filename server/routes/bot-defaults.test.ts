import { expect, test } from "vitest";
import { PASS } from "./table.ts";
import { createBotDefaultRoutes } from "./bot-defaults.ts";
import { callRoute } from "../testing/route-context.ts";

const routes = (cfg: unknown = {}) =>
  createBotDefaultRoutes({
    cfg: cfg as never,
    store: { bots: [] } as never,
    defaultSelection: async () => ({ instanceId: "i1", model: "m1" }) as never,
  });

test("declines paths and methods that are not its own", async () => {
  expect(await routes()(callRoute("/api/bots").ctx)).toBe(PASS);
  expect(await routes()(callRoute("/api/bot-defaults", "PUT").ctx)).toBe(PASS);
});

test("a fresh install still answers complete defaults", async () => {
  const { ctx, sent } = callRoute("/api/bot-defaults");

  await routes()(ctx);

  expect(sent[0]?.status).toBe(200);
  const body = sent[0]?.body as { defaults: unknown; modelSelection: unknown; suggestedName: unknown };
  expect(body.defaults).toBeTypeOf("object");
  expect(body.modelSelection).toMatchObject({ instanceId: "i1", model: "m1" });
  expect(body.suggestedName).toBeTypeOf("string");
});

test("a skills preview without a source is a 400", async () => {
  const { ctx, sent } = callRoute("/api/bot-defaults/skills/preview", "POST", {});

  await routes()(ctx);

  expect(sent[0]?.status).toBe(400);
});

test("an avatar preview with a broken profile is refused before any generation", async () => {
  const notAnObject = callRoute("/api/bot-defaults/avatar", "POST", { prompt: "a cat", profile: 7 });

  await routes()(notAnObject.ctx);

  expect(notAnObject.sent[0]?.status).toBe(400);
});