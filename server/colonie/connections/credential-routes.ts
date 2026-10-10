import { PASS, type RouteHandler } from "../../routes/table.ts";
import type { ComposioCredentialStatus } from "../../../shared/composio-credential.ts";

export function composioCredentialRoutes(status: () => ComposioCredentialStatus): RouteHandler {
  return async (ctx) => {
    if (ctx.path !== "/api/colonie/composio/credential" || ctx.method !== "GET") return PASS;
    const owner = ctx.auth.kind === "loopback" ? ctx.auth.trust !== "service" : ctx.auth.scopes.includes("admin");
    if (!owner) { ctx.json(ctx.res, 403, { error: "Only the workspace owner/admin can inspect credential metadata." }); return; }
    ctx.res.setHeader("cache-control", "no-store");
    ctx.json(ctx.res, 200, status());
  };
}
