// Owner/admin HTTP surface for the single Chief role: read the current role and
// its work, or transfer the role to another bot. A model-facing bearer never
// reaches this route — it is loopback owner (not service) or an admin session.
// Body reading can yield while a turn starts, so the bot's existence and the
// Chief's busy state are rechecked at the write boundary.
import { z } from "zod";
import { PASS, type RouteHandler } from "../../routes/table.ts";
import type { ColonieChief } from "./manager.ts";

interface Dependencies {
  chief: ColonieChief;
  exists(botId: string): boolean;
  changed?(): void;
}

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : 400;
}

export function createChiefRoutes(deps: Dependencies): RouteHandler {
  return async (ctx) => {
    if (ctx.path !== "/api/colonie/chief" || !["GET", "PUT"].includes(ctx.method)) return PASS;
    const owner = ctx.auth.kind === "loopback" ? ctx.auth.trust !== "service" : ctx.auth.scopes.includes("admin");
    if (!owner) {
      ctx.json(ctx.res, 403, { error: "Only the workspace owner/admin can manage the Chief role." });
      return;
    }
    if (ctx.method === "GET") {
      const threadId = ctx.url.searchParams.get("threadId");
      if (threadId && !deps.chief.ownsSource(threadId)) {
        ctx.json(ctx.res, 403, { error: "That conversation does not belong to the Chief." });
        return;
      }
      ctx.json(ctx.res, 200, deps.chief.view(threadId ?? undefined));
      return;
    }
    const parsed = z.object({ botId: z.string().min(1).max(128), expectedRevision: z.string() }).strict().safeParse(await ctx.readBody(ctx.req));
    if (!parsed.success) {
      ctx.json(ctx.res, 400, { error: "A botId and expectedRevision are required." });
      return;
    }
    if (!deps.exists(parsed.data.botId)) {
      ctx.json(ctx.res, 404, { error: "No such bot" });
      return;
    }
    try {
      deps.chief.transfer(parsed.data.botId, parsed.data.expectedRevision);
    } catch (error) {
      ctx.json(ctx.res, statusOf(error), { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    deps.changed?.();
    ctx.json(ctx.res, 200, deps.chief.view());
  };
}