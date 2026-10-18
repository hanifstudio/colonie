// Exporting builds a file and may publish it, so this guards the front door:
// which requests are this route's, and that a request without a team, or for a
// team that is gone, never reaches the packing code.
import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { createTeamsExportRoutes, type TeamsExportRouteDeps } from "./teams-export.ts";

const EXPORT = "/api/teams/export";

const deps = (over: Partial<Record<string, unknown>> = {}) => {
  const packed: unknown[] = [];
  const fake = {
    store: { bots: [], team: () => undefined, teamIds: () => [], sections: [], botsForTeam: () => [] },
    cfg: { profile: { name: "Owner" } },
    routines: () => null,
    defaultsPresetFor: () => ({ preset: {}, skipped: [] }),
    starterNotes: () => [],
    checkedExportSkillNames: () => ({ ok: true, names: [] }),
    collectExportSkills: (...args: any[]) => { packed.push(args); return []; },
    collectTeamSkills: (...args: any[]) => { packed.push(args); return []; },
    ...over,
  } as unknown as TeamsExportRouteDeps;
  return { deps: fake, packed };
};

const call = async (handler: RouteHandler, path = EXPORT, method = "POST", body: unknown = {}) => {
  const { ctx, sent } = callRoute(path, method, body);
  return { out: await handler(ctx), sent };
};

test("another route, or another verb, is left to the next handler", async () => {
  const handler = createTeamsExportRoutes(deps().deps);
  const elsewhere = await call(handler, "/api/health", "POST");
  const wrongVerb = await call(handler, EXPORT, "GET");

  expect(elsewhere.out).toBe(PASS);
  expect(wrongVerb.out).toBe(PASS);
  expect(elsewhere.sent).toEqual([]);
});

test("a team package without a team is refused before anything is packed", async () => {
  const { deps: fake, packed } = deps();
  const { sent } = await call(createTeamsExportRoutes(fake), EXPORT, "POST", { format: "package", version: 2 });

  expect(sent[0]?.status).toBe(400);
  expect(sent[0]?.body).toEqual({ error: "Choose a team to share." });
  expect(packed).toEqual([]);
});

test("a team that is gone is a 404", async () => {
  const { deps: fake, packed } = deps();
  const { sent } = await call(createTeamsExportRoutes(fake), EXPORT, "POST", { format: "package", version: 2, team: "gone" });

  expect(sent[0]?.status).toBe(404);
  expect(sent[0]?.body).toEqual({ error: "That team no longer exists." });
  expect(packed).toEqual([]);
});

test("a workspace with no bots is refused before anything is packed", async () => {
  const { deps: fake, packed } = deps();
  const { sent } = await call(createTeamsExportRoutes(fake), EXPORT, "POST", {});

  expect(sent[0]?.status).toBe(400);
  expect(sent[0]?.body).toEqual({ error: "Create a bot before exporting your team" });
  expect(packed).toEqual([]);
});