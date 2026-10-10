import { z } from "zod";
import { PASS, type RouteHandler } from "../../routes/table.ts";
import { botAppPolicy, policyHash, policySchema, saveBotAppPolicy } from "./policy.ts";

interface Dependencies {
  exists(botId: string): boolean;
  busy(botId: string): boolean;
  configured(): boolean;
  customNames(): string[];
  invalidateBot(botId: string): void;
}
export function connectedToolsRoutes(deps: Dependencies): RouteHandler {
  return async (ctx) => {
    const match = ctx.path.match(/^\/api\/bots\/([\w-]+)\/connected-tools$/);
    if (!match || !["GET", "PATCH"].includes(ctx.method)) return PASS;
    const owner = ctx.auth.kind === "loopback" ? ctx.auth.trust !== "service" : ctx.auth.scopes.includes("admin");
    if (!owner) { ctx.json(ctx.res, 403, { error: "Only the workspace owner/admin can configure connected tools." }); return; }
    const botId = match[1]!;
    if (!deps.exists(botId)) { ctx.json(ctx.res, 404, { error: "No such bot" }); return; }
    if (ctx.method === "PATCH") {
      const parsed = z.object({ preferences: policySchema, expectedRevision: z.string().min(1) }).strict().safeParse(await ctx.readBody(ctx.req));
      if (!parsed.success) { ctx.json(ctx.res, 400, { error: "Invalid connected tool selection" }); return; }
      const names = new Set(deps.customNames());
      if (parsed.data.preferences.customServers.some((name) => !names.has(name))) { ctx.json(ctx.res, 400, { error: "A selected custom MCP server is unavailable" }); return; }
      // Body reading can yield while a turn/discovery starts; check at the write boundary.
      if (!deps.exists(botId)) { ctx.json(ctx.res, 404, { error: "No such bot" }); return; }
      if (deps.busy(botId)) { ctx.json(ctx.res, 409, { error: "Wait for this bot's conversations to finish before changing app access." }); return; }
      saveBotAppPolicy(botId, parsed.data.preferences, parsed.data.expectedRevision);
      deps.invalidateBot(botId);
    }
    const policy = botAppPolicy(botId);
    ctx.json(ctx.res, 200, { ...policy, revision: policyHash(policy), configured: deps.configured() });
  };
}
