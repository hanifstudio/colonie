import { z } from "zod";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { appContextSchema, appContextView, botContextSchema, changeContextPreferences, contextView, type ContextProfile } from "./context.ts";

const identity = { threadId: z.string().regex(/^[\w-]{1,128}$/), expectedRevision: z.string().min(1) };
const changeSchema = z.discriminatedUnion("scope", [
  z.object({ ...identity, scope: z.literal("app"), preferences: appContextSchema }).strict(),
  z.object({ ...identity, scope: z.literal("bot"), preferences: botContextSchema }).strict(),
]);
interface ContextRoutes {
  resolve(botId: string, threadId: string): { profile: ContextProfile; instanceId: string; instructions: string; legacyPlain: boolean };
}
/** Same auth, visibility and desktop mutation gates as native settings. */
export function createAcpContextRoutes(deps: ContextRoutes): RouteHandler {
  return async (ctx) => {
    const match = ctx.path.match(/^\/api\/bots\/([\w-]+)\/acp-context$/);
    const appWide = ctx.path === "/api/acp-context";
    if ((!match && !appWide) || !["GET", "PATCH"].includes(ctx.method)) return PASS;
    const owner = ctx.auth.kind === "loopback" ? ctx.auth.trust !== "service" : ctx.auth.scopes.includes("admin");
    if (!owner) { ctx.json(ctx.res, 403, { error: "Only the workspace owner/admin can inspect or configure agent context." }); return; }
    const body = ctx.method === "PATCH" ? await ctx.readBody(ctx.req) : null;
    if (appWide) {
      if (ctx.method === "PATCH") {
        const parsed = z.object({ expectedRevision: z.string().min(1), preferences: appContextSchema }).strict().safeParse(body);
        if (!parsed.success) { ctx.json(ctx.res, 400, { error: "Invalid shared instructions change" }); return; }
        changeContextPreferences("app", "", parsed.data.expectedRevision, parsed.data.preferences);
      }
      ctx.json(ctx.res, 200, appContextView()); return;
    }
    const threadId = ctx.method === "GET" ? ctx.url.searchParams.get("threadId") ?? "" : body?.threadId;
    if (typeof threadId !== "string" || !/^[\w-]{1,128}$/.test(threadId)) { ctx.json(ctx.res, 400, { error: "An explicit threadId is required" }); return; }
    const target = deps.resolve(match![1]!, threadId);
    if (ctx.method === "PATCH") {
      const parsed = changeSchema.safeParse(body);
      if (!parsed.success) { ctx.json(ctx.res, 400, { error: "Invalid context setting change" }); return; }
      changeContextPreferences(parsed.data.scope, target.profile.id, parsed.data.expectedRevision, parsed.data.preferences);
    }
    ctx.json(ctx.res, 200, contextView(target.profile, threadId, target.instanceId, target.instructions, target.legacyPlain));
  };
}
