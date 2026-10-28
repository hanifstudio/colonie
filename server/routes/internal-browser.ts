// The built-in browser's tool calls, from the harness proxy a bot's engine
// mounts (harness-mcp-proxy.ts, kind "browser"). The turn's bearer is the
// authority: it names the bot, the thread and the browser session, and is
// honoured only while that turn runs. Each call goes to the bot's own
// session; a call waits for no other thread, it is refused while another
// thread holds the same browser. The fetch-style read tool is not offered
// (BROWSER_TOOLS_HIDDEN): the engine's own web reading does that job.
import type { IncomingMessage } from "node:http";

import { BROWSER_TOOLS_HIDDEN } from "../colonie/computer/browser-engine.ts";
import type { BrowserRuntime, BrowserSpawnSpec } from "../colonie/computer/browser-runtime.ts";
import { PASS, type RouteHandler } from "./table.ts";

interface Capability { botId: string; threadId: string; generation: string; kind: string; browserSession?: string }

export function createInternalBrowserRoute(deps: {
  authorize: (header: IncomingMessage["headers"]["authorization"]) => Capability | null;
  isActive: (capability: Capability) => boolean;
  bot: (id: string) => { id: string; browser?: boolean; browserProfile?: string } | undefined;
  browserEnabled: () => boolean;
  browserIntegration: (botId: string, profile: string | undefined) => Promise<{ session: string; spec: BrowserSpawnSpec } | null>;
  currentBrowserSession: (botId: string, profile: string | undefined) => string;
  claimTurnResource: (owner: { threadId: string; generation: string }, resource: string) => boolean;
  runtime: Pick<BrowserRuntime, "agentRpc">;
}): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== "/api/internal/browser/mcp") return PASS;
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const capability = deps.authorize(req.headers.authorization);
    if (!capability || !deps.bot(capability.botId)) return json(res, 401, { error: "unauthorized" });
    if (capability.kind !== "browser") return json(res, 403, { error: "this internal capability cannot access that service" });
    const expired = () => Object.assign(new Error("the internal turn capability has expired"), { status: 401 });
    const body = await readBody(req);
    if (!deps.isActive(capability)) throw expired();
    const enabled = (bot: ReturnType<typeof deps.bot>) => Boolean(bot && bot.browser !== false && deps.browserEnabled());
    const bot = deps.bot(capability.botId);
    if (!enabled(bot)) return json(res, 403, { error: "browser tools are not enabled for this bot" });
    const browser = await deps.browserIntegration(bot!.id, bot!.browserProfile);
    if (!browser || browser.session !== capability.browserSession) return json(res, 409, { error: "this browser profile changed; start a new turn" });
    if (body?.method !== "tools/list" && body?.method !== "tools/call") return json(res, 400, { error: "unsupported browser method" });
    if (body.method === "tools/call" && BROWSER_TOOLS_HIDDEN.has(String(body.params?.name))) return json(res, 404, { error: "no such browser tool" });
    const result = await deps.runtime.agentRpc(browser.session, browser.spec, body.method, body.params, () => {
      if (!deps.isActive(capability)) throw expired();
      const current = deps.bot(capability.botId);
      if (!enabled(current) || deps.currentBrowserSession(current!.id, current!.browserProfile) !== browser.session) {
        throw Object.assign(new Error("Browser access changed while connecting."), { status: 409 });
      }
      if (body.method === "tools/call" && !deps.claimTurnResource(capability, `browser:${browser.session}`)) {
        throw Object.assign(new Error("another thread is using this browser — pause browser work until that thread finishes"), { status: 409 });
      }
    });
    if (!deps.isActive(capability)) throw expired();
    const listed = result as { tools?: Array<{ name?: string }> } | null;
    if (body.method === "tools/list" && Array.isArray(listed?.tools)) {
      return json(res, 200, { result: { ...listed, tools: listed.tools.filter((tool) => !BROWSER_TOOLS_HIDDEN.has(String(tool.name))) } });
    }
    return json(res, 200, { result });
  };
}
