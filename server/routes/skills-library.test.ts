import { expect, test } from "vitest";
import { PASS } from "./table.ts";
import { createSkillsLibraryRoutes } from "./skills-library.ts";
import { callRoute } from "../testing/route-context.ts";

const cfg = (on: boolean) => ({ features: on ? { skillsLibrary: true } : {} }) as never;
const store = {
  bots: [],
  bot: (id: string) => (id === "b1" ? { id: "b1", name: "Ada" } : undefined),
  patchBot: () => {},
} as never;

const routes = (on = true) => createSkillsLibraryRoutes({ cfg: cfg(on), store });

test("declines paths and methods that are not its own", async () => {
  expect(await routes()(callRoute("/api/bots").ctx)).toBe(PASS);
  expect(await routes()(callRoute("/api/skills-library", "DELETE").ctx)).toBe(PASS);
  expect(await routes()(callRoute("/api/skills-library/nope", "PUT").ctx)).toBe(PASS);
});

test("the feature being off is a 404 on every surface, not an empty list", async () => {
  const list = callRoute("/api/skills-library");
  const read = callRoute("/api/skills-library/some-skill");
  const assign = callRoute("/api/bots/b1/skills-library", "PUT", { skills: [] });

  await routes(false)(list.ctx);
  await routes(false)(read.ctx);
  await routes(false)(assign.ctx);

  expect(list.sent[0]?.status).toBe(404);
  expect(read.sent[0]?.status).toBe(404);
  expect(assign.sent[0]?.status).toBe(404);
});

test("the list answers an empty library without inventing entries", async () => {
  const { ctx, sent } = callRoute("/api/skills-library");

  await routes()(ctx);

  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toEqual({ skills: [] });
});

test("an import without SKILL.md text is a 400", async () => {
  const { ctx, sent } = callRoute("/api/skills-library", "POST", {});

  await routes()(ctx);

  expect(sent[0]?.status).toBe(400);
});

test("assigning a skill that is not in the library is refused", async () => {
  const { ctx, sent } = callRoute("/api/bots/b1/skills-library", "PUT", { skills: ["ghost"] });

  await routes()(ctx);

  expect(sent[0]?.status).toBe(422);
});

test("assigning to an unknown bot is a 404 before anything else", async () => {
  const { ctx, sent } = callRoute("/api/bots/nope/skills-library", "PUT", { skills: [] });

  await routes()(ctx);

  expect(sent[0]?.status).toBe(404);
});