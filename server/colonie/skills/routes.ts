// Owner/admin HTTP surface for a bot's Colonie guides. Small factory with
// explicit deps and strict Zod bodies; `exists` is asked again after
// readBody, because reading a body can yield while a bot deletion lands.
// assign/import are matched before the generic :name route so a guide can
// never swallow them. Read routes are owner-gated too: a session-less
// service caller cannot reach a bot's guides.
import { z } from "zod";
import { PASS, type RouteHandler } from "../../routes/table.ts";
import type { ColonieSkills } from "./service.ts";

interface Dependencies {
  service: ColonieSkills;
  exists(botId: string): boolean;
  changed?(botId: string): void;
}

const BASE = /^\/api\/bots\/([\w-]+)\/colonie-skills$/;
const ITEM = /^\/api\/bots\/([\w-]+)\/colonie-skills\/([\w-]+)$/;
const MAX_IMPORT_CHARS = 300_000;

const saveSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    instructions: z.string(),
    enabled: z.boolean(),
  })
  .strict();
const createBody = z.object({ skill: saveSchema, expectedRevision: z.string().min(1) }).strict();
const editBody = z
  .object({ skill: saveSchema, expectedRevision: z.string().min(1), expectedSha256: z.string().optional() })
  .strict();
const enableBody = z.object({ enabled: z.boolean(), expectedRevision: z.string().min(1) }).strict();
const assignBody = z.object({ names: z.array(z.string()).max(500), expectedRevision: z.string().min(1) }).strict();
const importBody = z
  .object({
    source: z.string().max(2_000).optional(),
    text: z.string().max(MAX_IMPORT_CHARS).optional(),
    expectedRevision: z.string().min(1),
  })
  .strict();

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : 400;
}

export function createColonieSkillsRoutes(deps: Dependencies): RouteHandler {
  return async (ctx) => {
    let botId: string | undefined;
    let name: string | undefined;
    let route: "view" | "create" | "read" | "edit" | "delete" | "assign" | "import" | undefined;
    const base = BASE.exec(ctx.path);
    const item = ITEM.exec(ctx.path);
    if (ctx.method === "GET" && base) {
      botId = base[1];
      route = "view";
    } else if (ctx.method === "POST" && base) {
      botId = base[1];
      route = "create";
    } else if (ctx.method === "PUT" && item && item[2] === "assign") {
      botId = item[1];
      route = "assign";
    } else if (ctx.method === "POST" && item && item[2] === "import") {
      botId = item[1];
      route = "import";
    } else if (ctx.method === "GET" && item) {
      botId = item[1];
      name = item[2];
      route = "read";
    } else if (ctx.method === "PATCH" && item) {
      botId = item[1];
      name = item[2];
      route = "edit";
    } else if (ctx.method === "DELETE" && item) {
      botId = item[1];
      name = item[2];
      route = "delete";
    }
    if (!route || !botId) return PASS;

    const owner = ctx.auth.kind === "loopback" ? ctx.auth.trust !== "service" : ctx.auth.scopes.includes("admin");
    if (!owner) {
      ctx.json(ctx.res, 403, { error: "Only the workspace owner/admin can manage guides." });
      return;
    }
    if (!deps.exists(botId)) {
      ctx.json(ctx.res, 404, { error: "No such bot" });
      return;
    }

    try {
      const changed = () => deps.changed?.(botId!);
      if (route === "view") {
        ctx.json(ctx.res, 200, deps.service.view(botId));
        return;
      }
      if (route === "read") {
        const content = deps.service.read(botId, name!);
        if (!content) {
          ctx.json(ctx.res, 404, { error: "No such guide" });
          return;
        }
        ctx.json(ctx.res, 200, content);
        return;
      }
      if (route === "create") {
        const parsed = createBody.safeParse(await ctx.readBody(ctx.req));
        if (!parsed.success) {
          ctx.json(ctx.res, 400, { error: "Invalid guide." });
          return;
        }
        if (!deps.exists(botId)) {
          ctx.json(ctx.res, 404, { error: "No such bot" });
          return;
        }
        ctx.json(ctx.res, 200, deps.service.save(botId, parsed.data.skill, parsed.data.expectedRevision));
        changed();
        return;
      }
      if (route === "edit") {
        const body = await ctx.readBody(ctx.req);
        const toggle = enableBody.safeParse(body);
        if (toggle.success) {
          if (!deps.exists(botId)) {
            ctx.json(ctx.res, 404, { error: "No such bot" });
            return;
          }
          ctx.json(ctx.res, 200, deps.service.setEnabled(botId, name!, toggle.data.enabled, toggle.data.expectedRevision));
          changed();
          return;
        }
        const parsed = editBody.safeParse(body);
        if (!parsed.success || parsed.data.skill.name !== name) {
          ctx.json(ctx.res, 400, { error: "Invalid guide edit." });
          return;
        }
        if (!deps.exists(botId)) {
          ctx.json(ctx.res, 404, { error: "No such bot" });
          return;
        }
        ctx.json(
          ctx.res,
          200,
          deps.service.save(
            botId,
            { ...parsed.data.skill, ...(parsed.data.expectedSha256 ? { expectedSha256: parsed.data.expectedSha256 } : {}) },
            parsed.data.expectedRevision,
          ),
        );
        changed();
        return;
      }
      if (route === "delete") {
        const expectedRevision = ctx.url.searchParams.get("expectedRevision");
        if (!expectedRevision) {
          ctx.json(ctx.res, 400, { error: "expectedRevision is required." });
          return;
        }
        ctx.json(ctx.res, 200, deps.service.remove(botId, name!, expectedRevision));
        changed();
        return;
      }
      if (route === "assign") {
        const parsed = assignBody.safeParse(await ctx.readBody(ctx.req));
        if (!parsed.success) {
          ctx.json(ctx.res, 400, { error: "Invalid assignment." });
          return;
        }
        if (!deps.exists(botId)) {
          ctx.json(ctx.res, 404, { error: "No such bot" });
          return;
        }
        ctx.json(ctx.res, 200, deps.service.assign(botId, parsed.data.names, parsed.data.expectedRevision));
        changed();
        return;
      }
      // import
      const parsed = importBody.safeParse(await ctx.readBody(ctx.req));
      if (!parsed.success || (!parsed.data.source && !parsed.data.text)) {
        ctx.json(ctx.res, 400, { error: "Paste a guide URL or SKILL.md text." });
        return;
      }
      if (!deps.exists(botId)) {
        ctx.json(ctx.res, 404, { error: "No such bot" });
        return;
      }
      const view = await deps.service.importSource(botId, parsed.data.source ?? "", parsed.data.expectedRevision, parsed.data.text);
      ctx.json(ctx.res, 200, view);
      changed();
    } catch (error) {
      ctx.json(ctx.res, statusOf(error), { error: error instanceof Error ? error.message : String(error) });
    }
  };
}