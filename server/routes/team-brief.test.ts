import { expect, test } from "vitest";
import { PASS } from "./table.ts";
import { createTeamBriefRoutes } from "./team-brief.ts";
import { callRoute } from "../testing/route-context.ts";

const store = {
  sections: ["Design"],
  bots: [],
  groups: [],
} as never;

const memory: Array<{ id: string; name: string }> = [];
const teamMemory = {
  list: () => memory,
  remove: (_section: string, id: string) => memory.some((entry) => entry.id === id),
  resolve: () => ({ claimed: true }),
  update: (_section: string, id: string) => memory.find((entry) => entry.id === id) ?? null,
  propose: () => ({ status: "accepted", entry: { id: "e1", name: "Ada" } }),
} as never;

const routes = () => createTeamBriefRoutes({ store, teamMemory });

test("declines paths and methods that are not its own", async () => {
  expect(await routes()(callRoute("/api/bots").ctx)).toBe(PASS);
  expect(await routes()(callRoute("/api/team-memory", "DELETE").ctx)).toBe(PASS);
  expect(await routes()(callRoute("/api/section-context", "POST").ctx)).toBe(PASS);
});

test("both surfaces demand a section, even for General", async () => {
  const brief = callRoute("/api/section-context");
  const team = callRoute("/api/team-memory");

  await routes()(brief.ctx);
  await routes()(team.ctx);

  expect(brief.sent[0]?.status).toBe(400);
  expect(team.sent[0]?.status).toBe(400);
});

test("General (an explicitly empty section) is a valid, known team", async () => {
  const { ctx, sent } = callRoute("/api/section-context?section=");

  await routes()(ctx);

  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toMatchObject({ section: "", label: expect.any(String), text: "" });
});

test("a team that does not exist is a 404, not an empty brief", async () => {
  const { ctx, sent } = callRoute("/api/section-context?section=Ghosts");

  await routes()(ctx);

  expect(sent[0]?.status).toBe(404);
});

test("a section name longer than 60 characters is refused", async () => {
  const { ctx, sent } = callRoute(`/api/section-context?section=${"x".repeat(61)}`);

  await routes()(ctx);

  expect(sent[0]?.status).toBe(400);
});

test("a memory entry that does not exist is a 404", async () => {
  const { ctx, sent } = callRoute("/api/team-memory/ghost?section=Design", "DELETE");

  await routes()(ctx);

  expect(sent[0]?.status).toBe(404);
});

test("a person's own memory entry is trusted immediately", async () => {
  const { ctx, sent } = callRoute("/api/team-memory?section=Design", "POST", { kind: "person", name: "Ada" });

  await routes()(ctx);

  expect(sent[0]?.status).toBe(201);
});

test("a memory entry with an unknown kind is refused with the allowed kinds", async () => {
  const { ctx, sent } = callRoute("/api/team-memory?section=Design", "POST", { kind: "nonsense", name: "Ada" });

  await routes()(ctx);

  expect(sent[0]?.status).toBe(400);
});