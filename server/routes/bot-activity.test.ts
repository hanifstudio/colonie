import { expect, test } from "vitest";
import { PASS } from "./table.ts";
import { createBotActivityRoutes } from "./bot-activity.ts";
import { callRoute } from "../testing/route-context.ts";
import { DEFAULT_OUTBOUND_POLICY } from "../../shared/outbound.ts";

// An existing bot and no tasks: enough to answer without touching the disk.
const routes = () =>
  createBotActivityRoutes({
    store: {
      bot: (id: string) => (id === "b1" ? { id: "b1", threadId: "t1" } : undefined),
      tasks: () => [],
    } as never,
    outboundCounts: { today: () => 3 } as never,
  });

test("declines paths and methods that are not its own", async () => {
  expect(await routes()(callRoute("/api/bots/b1").ctx)).toBe(PASS);
  expect(await routes()(callRoute("/api/bots/b1/activity", "POST").ctx)).toBe(PASS);
  expect(await routes()(callRoute("/api/bots/b1/outbound", "PUT").ctx)).toBe(PASS);
});

test("an unknown bot is a 404, not an empty report", async () => {
  const { ctx: a, sent: sa } = callRoute("/api/bots/nope/activity");
  const { ctx: o, sent: so } = callRoute("/api/bots/nope/outbound");

  await routes()(a);
  await routes()(o);

  expect(sa[0]?.status).toBe(404);
  expect(so[0]?.status).toBe(404);
});

test("outbound reports the stored policy and today's count", async () => {
  const { ctx, sent } = callRoute("/api/bots/b1/outbound");

  await routes()(ctx);

  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toMatchObject({ policy: DEFAULT_OUTBOUND_POLICY, today: 3 });
});

test("a bot with no threads yet reports no activity", async () => {
  const { ctx, sent } = callRoute("/api/bots/b1/activity");

  await routes()(ctx);

  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toMatchObject({ rows: [] });
});

test("activity rejects a limit that is not a positive whole number", async () => {
  const { ctx, sent } = callRoute("/api/bots/b1/activity?limit=-1");

  await routes()(ctx);

  expect(sent[0]?.status).toBe(400);
});