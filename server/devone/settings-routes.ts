import { PASS, type RouteHandler } from "../routes/table.ts";
import { nativeSettingChangeSchema } from "./settings.ts";
import type { AcpRuntime } from "./acp-runtime.ts";
import type { SendTurnInput } from "../contracts.ts";

interface SettingsRoutes {
  resolve(botId: string, threadId: string): { adapter: AcpRuntime; input: SendTurnInput } | Promise<{ adapter: AcpRuntime; input: SendTurnInput }>;
  assertCurrent(botId: string, threadId: string, adapter: AcpRuntime, input: SendTurnInput): void;
  recordSession(botId: string, threadId: string, instanceId: string, sessionId: string): void;
  recordModel(botId: string, threadId: string, model: string): void;
}

/** Registered behind the existing auth/visibility/desktop-mutation gate. */
export function createAcpSettingsRoutes(deps: SettingsRoutes): RouteHandler {
  return async (ctx) => {
    const match = ctx.path.match(/^\/api\/bots\/([\w-]+)\/acp-settings$/);
    if (!match || !["POST", "PATCH"].includes(ctx.method)) return PASS;
    const owner = ctx.auth.kind === "loopback" ? ctx.auth.trust !== "service" : ctx.auth.scopes.includes("admin");
    if (!owner) { ctx.json(ctx.res, 403, { error: "Only the workspace owner/admin can configure native agent execution." }); return; }
    const body = await ctx.readBody(ctx.req);
    const threadId = typeof body?.threadId === "string" ? body.threadId : "";
    if (!/^[\w-]{1,128}$/.test(threadId)) { ctx.json(ctx.res, 400, { error: "An explicit threadId is required" }); return; }
    const target = await deps.resolve(match[1]!, threadId);
    const parsed = ctx.method === "PATCH" ? nativeSettingChangeSchema.safeParse(body) : null;
    if (parsed && !parsed.success) { ctx.json(ctx.res, 400, { error: "Invalid native setting change" }); return; }
    const state = ctx.method === "POST" ? await target.adapter.prepareSettings(target.input)
      : await target.adapter.changeSettings(target.input, parsed!.data!);
    deps.assertCurrent(match[1]!, threadId, target.adapter, target.input);
    deps.recordSession(match[1]!, threadId, state.instanceId, state.sessionId);
    if (ctx.method === "PATCH") {
      const change = parsed!.data!;
      const option = change.kind === "option" ? state.options.find((entry) => entry.id === change.configId) : undefined;
      if (option && (option.category === "model" || option.id === "model") && typeof option.currentValue === "string") deps.recordModel(match[1]!, threadId, option.currentValue);
    }
    ctx.json(ctx.res, 200, state);
  };
}
