import { expect, test } from "vitest";
import { PASS } from "./table.ts";
import { createTeamSectionRoutes } from "./team-sections.ts";
import { callRoute } from "../testing/route-context.ts";

const store = {
  sections: ["Design"],
  deleteSection: () => null,
  renameSection: () => null,
  updateTeamMembers: () => ({ ok: false, reason: "unavailable" }),
  setBotsSection: () => ({ ok: false, reason: "unavailable" }),
} as never;

const routes = () =>
  createTeamSectionRoutes({ store, teamComputers: { forSection: () => undefined } as never, wireBot: (bot) => bot as never, maxWorkspaceBots: 100 });

test("declines paths and methods that are not its own", async () => {
  expect(await routes()(callRoute("/api/bots").ctx)).toBe(PASS);
  expect(await routes()(callRoute("/api/sidebar-sections", "HEAD").ctx)).toBe(PASS);
});

test("the list answers the stored teams", async () => {
  const { ctx, sent } = callRoute("/api/sidebar-sections");

  await routes()(ctx);

  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toEqual({ sections: ["Design"] });
});

test("renaming or deleting without naming a team is a 400", async () => {
  const rename = callRoute("/api/sidebar-sections", "PATCH", { name: "Product" });
  const remove = callRoute("/api/sidebar-sections", "DELETE");

  await routes()(rename.ctx);
  await routes()(remove.ctx);

  expect(rename.sent[0]?.status).toBe(400);
  expect(remove.sent[0]?.status).toBe(400);
});

test("a rename with an empty name is refused before the store is touched", async () => {
  const { ctx, sent } = callRoute("/api/sidebar-sections?section=Design", "PATCH", { name: "  " });

  await routes()(ctx);

  expect(sent[0]?.status).toBe(400);
});

test("moving members of an unknown team is a 404", async () => {
  const { ctx, sent } = callRoute("/api/sidebar-sections?section=Ghost", "PUT", { addBotIds: [], removeBotIds: [] });

  await routes()(ctx);

  expect(sent[0]?.status).toBe(404);
});

test("a team that the store cannot build is a 404, not a silent success", async () => {
  const { ctx, sent } = callRoute("/api/sidebar-sections", "POST", { name: "Ops", botIds: ["b1"] });

  await routes()(ctx);

  expect(sent[0]?.status).toBe(404);
});

test("a team with neither a name nor bots is refused", async () => {
  const { ctx, sent } = callRoute("/api/sidebar-sections", "POST", { name: "", botIds: [] });

  await routes()(ctx);

  expect(sent[0]?.status).toBe(400);
});