import { expect, test } from "vitest";
import { PASS } from "./table.ts";
import { createServerInfoRoutes } from "./server-info.ts";
import { callRoute } from "../testing/route-context.ts";

const routes = (staticDir: string | null = null, shared = false) =>
  createServerInfoRoutes({ staticDir, sharedWorkspaceFullAccessEnabled: () => shared });

test("declines paths and methods that are not its own", async () => {
  expect(await routes()(callRoute("/api/bots").ctx)).toBe(PASS);
  expect(await routes()(callRoute("/api/health", "POST").ctx)).toBe(PASS);
  expect(await routes()(callRoute("/api/brandx").ctx)).toBe(PASS);
});

test("health identifies this server with its own pid", async () => {
  const { ctx, sent } = callRoute("/api/health");

  await routes()(ctx);

  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toMatchObject({ app: "colonie", pid: process.pid, static: false });
});

test("health advertises shared-workspace full access only when it is on", async () => {
  const off = callRoute("/api/health");
  await routes()(off.ctx);
  const on = callRoute("/api/health");
  await routes(null, true)(on.ctx);

  const capsOf = (body: unknown) => (body as { capabilities: Record<string, number> }).capabilities;
  expect(capsOf(off.sent[0]?.body).sharedWorkspaceFullAccess).toBeUndefined();
  expect(capsOf(on.sent[0]?.body).sharedWorkspaceFullAccess).toBe(1);
});

test("health reports a static dir only when the server serves a client build", async () => {
  const { ctx, sent } = callRoute("/api/health");

  await routes("/tmp/some-build")(ctx);

  expect(sent[0]?.body).toMatchObject({ static: true });
});

test("edition and brand answer without a provider", async () => {
  const edition = callRoute("/api/edition");
  const brand = callRoute("/api/brand");

  await routes()(edition.ctx);
  await routes()(brand.ctx);

  expect(edition.sent[0]?.status).toBe(200);
  expect(brand.sent[0]?.status).toBe(200);
});