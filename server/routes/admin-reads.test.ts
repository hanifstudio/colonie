import { expect, test } from "vitest";
import { PASS } from "./table.ts";
import { createAdminReadRoutes } from "./admin-reads.ts";
import { callRoute } from "../testing/route-context.ts";

const routes = () => createAdminReadRoutes({ cfg: {} as never, adminActivityRecording: () => false });

test("declines paths and methods that are not its own", async () => {
  expect(await routes()(callRoute("/api/bots", "GET").ctx)).toBe(PASS);
  expect(await routes()(callRoute("/api/plan-usage", "POST").ctx)).toBe(PASS);
  expect(await routes()(callRoute("/api/decisions", "POST").ctx)).toBe(PASS);
});

test("decisions rejects a limit that is not a positive whole number", async () => {
  const { ctx, sent } = callRoute("/api/decisions?limit=0");

  await routes()(ctx);

  expect(sent[0]?.status).toBe(400);
});

test("admin activity rejects an unknown filter instead of answering empty", async () => {
  const { ctx, sent } = callRoute("/api/admin-activity?what=nonsense");

  await routes()(ctx);

  expect(sent[0]?.status).toBe(400);
});

test("admin activity rejects a backwards date range", async () => {
  const { ctx, sent } = callRoute("/api/admin-activity?from=2026-10-01&to=2026-09-01");

  await routes()(ctx);

  expect(sent[0]?.status).toBe(400);
});