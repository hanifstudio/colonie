import { expect, test } from "vitest";
import { PASS } from "./table.ts";
import { teamLibraryRoutes } from "./team-library.ts";
import { callRoute } from "../testing/route-context.ts";

test("declines paths and methods that are not its own", async () => {
  expect(await teamLibraryRoutes(callRoute("/api/bots").ctx)).toBe(PASS);
  expect(await teamLibraryRoutes(callRoute("/api/teams/scout", "POST").ctx)).toBe(PASS);
});

test("the scout refuses an unusable folder instead of guessing one", async () => {
  const missing = callRoute("/api/teams/scout");
  const broken = callRoute("/api/teams/scout?cwd=/definitely/not/here");

  await teamLibraryRoutes(missing.ctx);
  await teamLibraryRoutes(broken.ctx);

  expect(missing.sent[0]?.status).toBe(400);
  expect(broken.sent[0]?.status).toBe(400);
});

test("a GitHub import without a URL is a 400 before any network call", async () => {
  const { ctx, sent } = callRoute("/api/team-library/github", "POST", {});

  await teamLibraryRoutes(ctx);

  expect(sent[0]?.status).toBe(400);
});

test("scouting the current folder answers a profile and a suggestion", async () => {
  const { ctx, sent } = callRoute(`/api/teams/scout?cwd=${encodeURIComponent(process.cwd())}`);

  await teamLibraryRoutes(ctx);

  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toMatchObject({ profile: expect.any(Object), suggestion: expect.any(Object) });
});