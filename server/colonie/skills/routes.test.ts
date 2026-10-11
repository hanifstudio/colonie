import { describe, expect, it, vi } from "vitest";

import { createColonieSkillsRoutes } from "./routes.ts";
import { ColonieSkills, type SkillsBot } from "./service.ts";
import { installLibrarySkill } from "../../skill-library.ts";
import { PASS, type RouteContext } from "../../routes/table.ts";

const SKILL_MD = (name: string) =>
  `---\nname: ${name}\ndescription: Use when the user asks for the weekly report.\n---\n\nDo the thing.\n`;

interface CtxResult {
  status: number;
  payload: unknown;
}

function harness(options: {
  method: string;
  path: string;
  body?: unknown;
  auth?: unknown;
  exists?: (botId: string) => boolean;
  onReadBody?: () => void;
}) {
  const out: CtxResult = { status: 0, payload: undefined };
  const url = new URL(`http://localhost${options.path}`);
  const ctx = {
    req: {} as RouteContext["req"],
    res: {} as RouteContext["res"],
    url,
    path: url.pathname,
    method: options.method,
    auth: options.auth ?? { kind: "loopback", trust: "owner" },
    json: (_res: unknown, status: number, payload: unknown) => {
      out.status = status;
      out.payload = payload;
    },
    readBody: async () => {
      options.onReadBody?.();
      return options.body;
    },
  } as unknown as RouteContext;
  return { ctx, out };
}

function setup(exists: (botId: string) => boolean = () => true) {
  const bots = new Map<string, SkillsBot>();
  const botId = `bot-${Math.random().toString(36).slice(2, 10)}`;
  bots.set(botId, { id: botId, assignedSkills: [] });
  const service = new ColonieSkills({
    bot: (id) => bots.get(id),
    setAssigned: (id, names) => {
      const bot = bots.get(id);
      if (bot) bot.assignedSkills = [...names];
    },
    busy: () => false,
  });
  const changed = vi.fn();
  const route = createColonieSkillsRoutes({ service, exists, changed });
  return { service, route, botId, changed };
}

async function view(route: ReturnType<typeof createColonieSkillsRoutes>, botId: string) {
  const { ctx, out } = harness({ method: "GET", path: `/api/bots/${botId}/colonie-skills` });
  await route(ctx);
  return out.payload as { revision: string; skills: Array<{ name: string; enabled: boolean }> };
}

describe("createColonieSkillsRoutes", () => {
  it("returns PASS for unrelated requests", async () => {
    const { route } = setup();
    const { ctx } = harness({ method: "GET", path: "/api/other" });
    expect(await route(ctx)).toBe(PASS);
  });

  it("403s a session-less service caller", async () => {
    const { route, botId } = setup();
    const { ctx, out } = harness({
      method: "GET",
      path: `/api/bots/${botId}/colonie-skills`,
      auth: { kind: "loopback", trust: "service" },
    });
    await route(ctx);
    expect(out.status).toBe(403);
  });

  it("answers an admin-scoped session", async () => {
    const { route, botId } = setup();
    const { ctx, out } = harness({
      method: "GET",
      path: `/api/bots/${botId}/colonie-skills`,
      auth: { kind: "device", scopes: ["admin"] },
    });
    await route(ctx);
    expect(out.status).toBe(200);
  });

  it("404s an unknown bot", async () => {
    const { route } = setup(() => false);
    const { ctx, out } = harness({ method: "GET", path: "/api/bots/missing/colonie-skills" });
    await route(ctx);
    expect(out.status).toBe(404);
  });

  it("creates, reads, toggles and deletes a guide with a fresh view each time", async () => {
    const { route, botId } = setup();
    const first = await view(route, botId);
    const create = harness({
      method: "POST",
      path: `/api/bots/${botId}/colonie-skills`,
      body: { skill: { name: "route-guide", description: "Use it.", instructions: "X.", enabled: true }, expectedRevision: first.revision },
    });
    await route(create.ctx);
    expect(create.out.status).toBe(200);
    const created = create.out.payload as { revision: string };

    const read = harness({ method: "GET", path: `/api/bots/${botId}/colonie-skills/route-guide` });
    await route(read.ctx);
    expect(read.out.status).toBe(200);
    expect((read.out.payload as { text: string }).text).toContain("X.");

    const toggle = harness({
      method: "PATCH",
      path: `/api/bots/${botId}/colonie-skills/route-guide`,
      body: { enabled: false, expectedRevision: created.revision },
    });
    await route(toggle.ctx);
    expect(toggle.out.status).toBe(200);
    expect((toggle.out.payload as { skills: Array<{ enabled: boolean }> }).skills[0]!.enabled).toBe(false);

    const revision = (toggle.out.payload as { revision: string }).revision;
    const remove = harness({
      method: "DELETE",
      path: `/api/bots/${botId}/colonie-skills/route-guide?expectedRevision=${encodeURIComponent(revision)}`,
    });
    await route(remove.ctx);
    expect(remove.out.status).toBe(200);
    expect((remove.out.payload as { skills: unknown[] }).skills).toHaveLength(0);
  });

  it("rejects a stale revision with 409", async () => {
    const { route, botId } = setup();
    await view(route, botId);
    const create = harness({
      method: "POST",
      path: `/api/bots/${botId}/colonie-skills`,
      body: { skill: { name: "stale", description: "Use it.", instructions: "X.", enabled: true }, expectedRevision: "nope" },
    });
    await route(create.ctx);
    expect(create.out.status).toBe(409);
  });

  it("rechecks the bot after reading the body", async () => {
    let present = true;
    const { route, botId } = setup(() => present);
    const create = harness({
      method: "POST",
      path: `/api/bots/${botId}/colonie-skills`,
      body: { skill: { name: "gone", description: "Use it.", instructions: "X.", enabled: true }, expectedRevision: "1" },
      onReadBody: () => {
        present = false;
      },
    });
    await route(create.ctx);
    expect(create.out.status).toBe(404);
  });

  it("matches assign and import before the generic name route", async () => {
    const { route, botId } = setup();
    installLibrarySkill({ name: "lib-route", instructions: SKILL_MD("lib-route"), source: "test", reviewState: "approved" });
    const base = await view(route, botId);

    const assign = harness({
      method: "PUT",
      path: `/api/bots/${botId}/colonie-skills/assign`,
      body: { names: ["lib-route"], expectedRevision: base.revision },
    });
    await route(assign.ctx);
    expect(assign.out.status).toBe(200);
    expect((assign.out.payload as { assignedSkills: string[] }).assignedSkills).toEqual(["lib-route"]);

    const afterAssign = (assign.out.payload as { revision: string }).revision;
    const imported = harness({
      method: "POST",
      path: `/api/bots/${botId}/colonie-skills/import`,
      body: { text: SKILL_MD("pasted-route"), expectedRevision: afterAssign },
    });
    await route(imported.ctx);
    expect(imported.out.status).toBe(200);
    expect((imported.out.payload as { skills: Array<{ name: string; enabled: boolean }> }).skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "pasted-route", enabled: false })]),
    );
  });

  it("requires expectedRevision on delete", async () => {
    const { route, botId } = setup();
    const remove = harness({ method: "DELETE", path: `/api/bots/${botId}/colonie-skills/any` });
    await route(remove.ctx);
    expect(remove.out.status).toBe(400);
  });
});