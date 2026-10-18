// Importing writes bots into the workspace, so this guards what must be decided
// before the file is trusted at all: who may see the bots, which folder a
// template may project into, and that a file the app does not recognize is
// refused rather than half-imported.
import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { createTeamsImportRoutes, type TeamsImportRouteDeps } from "./teams-import.ts";

const IMPORT = "/api/teams/import";

const deps = (over: Partial<Record<string, unknown>> = {}) => {
  const imported: unknown[] = [];
  const fake = {
    store: { bots: [], sections: [], saveAll: () => {} },
    routines: () => null,
    broadcast: (...args: unknown[]) => imported.push(args),
    publicBot: (bot: { id: string }) => ({ id: bot.id }),
    defaultSelection: async () => ({ instanceId: "codex-acp", model: "gpt" }),
    packageImportDeps: () => ({}),
    ...over,
  } as unknown as TeamsImportRouteDeps;
  return { deps: fake, imported };
};

const errorOf = (sent: Array<{ body: unknown }>) => (sent[0]?.body as { error?: string } | undefined)?.error;

const call = async (handler: RouteHandler, path = IMPORT, method = "POST", body: unknown = {}) => {
  const { ctx, sent } = callRoute(path, method, body);
  return { out: await handler(ctx), sent };
};

test("another route, or another verb, is left to the next handler", async () => {
  const handler = createTeamsImportRoutes(deps().deps);
  const elsewhere = await call(handler, "/api/health", "POST");
  const wrongVerb = await call(handler, IMPORT, "GET");

  expect(elsewhere.out).toBe(PASS);
  expect(wrongVerb.out).toBe(PASS);
  expect(elsewhere.sent).toEqual([]);
});

test("a folder a template may not project into is refused", async () => {
  const { deps: fake } = deps();
  const { sent } = await call(createTeamsImportRoutes(fake), `${IMPORT}?mode=project&cwd=/etc`, "POST", {});

  expect(sent[0]?.status).toBe(400);
  expect(errorOf(sent)).toBeTruthy();
});

test("an audience nobody can parse is refused", async () => {
  const { deps: fake } = deps();
  const { sent } = await call(createTeamsImportRoutes(fake), `${IMPORT}?visibility=nonsense`, "POST", {});

  expect(sent[0]?.status).toBe(400);
  expect(errorOf(sent)).toMatch(/visibility/);
});

test("a file the app does not recognize is refused, not half-imported", async () => {
  const { deps: fake, imported } = deps();
  const { sent } = await call(createTeamsImportRoutes(fake), IMPORT, "POST", {});

  expect(sent[0]?.status).toBe(400);
  expect(sent[0]?.body).toEqual({ error: "Team file version is not supported" });
  expect(imported).toEqual([]);
});

test("a backup may not be imported in project mode", async () => {
  const { deps: fake, imported } = deps();
  const { sent } = await call(createTeamsImportRoutes(fake), `${IMPORT}?mode=project`, "POST", { format: "colonie.backup" });

  expect(sent[0]?.status).toBe(400);
  expect(sent[0]?.body).toEqual({
    error: "Import backups alongside your existing bots; project mode is only for templates",
  });
  expect(imported).toEqual([]);
});