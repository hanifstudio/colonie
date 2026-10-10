import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export async function fakeComposio() {
  const key = "ak_colonie_fixture_only";
  const sessions = new Map<string, { user_id: string; toolkits?: { enable?: string[] }; [key: string]: any }>();
  const calls: Array<{ sessionId: string; name: string; arguments: any }> = [];
  let cancelledCalls = 0;
  let origin = "";
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const path = new URL(req.url!, origin).pathname.replace(/^\/api\/v3(?:\.1)?/, "");
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers["x-api-key"] !== key) return json({ error: "Invalid fixture credential" }, 401);
    if (path === "/auth_configs") return json({ items: [] });
    if (path === "/connected_accounts") return json({ items: [] });
    if (path === "/toolkits") return json({ items: [{ slug: "hackernews", name: "Hacker News", is_no_auth: true, meta: { description: "Public news", logo: "https://example.com/news.png" } }, { slug: "gmail", name: "Gmail", is_no_auth: false, meta: { description: "Email" } }] });
    if (path === "/tool_router/session" && req.method === "POST") {
      const session_id = `session_${crypto.randomUUID()}`;
      sessions.set(session_id, body);
      return json({ session_id, mcp: { type: "http", url: `${origin}/sessions/${session_id}/mcp` }, config: body });
    }
    const sessionPath = path.match(/^\/tool_router\/session\/([^/]+)(?:\/(toolkits|auth_link))?$/);
    if (sessionPath) {
      const config = sessions.get(sessionPath[1]!);
      if (!config) return json({}, 404);
      if (sessionPath[2] === "toolkits") return json({ items: [{ slug: "hackernews", is_no_auth: true }] });
      if (sessionPath[2] === "auth_link") return json({ url: "https://example.com/fixture-sign-in", redirect_url: "https://example.com/fixture-sign-in" });
      return json({ session_id: sessionPath[1], mcp: { type: "http", url: `${origin}/sessions/${sessionPath[1]}/mcp` }, config });
    }
    const mcp = path.match(/^\/sessions\/([^/]+)\/mcp$/);
    if (mcp && sessions.has(mcp[1]!)) {
      if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
      if (!body.id) { res.writeHead(202); res.end(); return; }
      if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Fixture Composio", version: "1" } } });
      if (body.method === "tools/list") return json({ jsonrpc: "2.0", id: body.id, result: { tools: [
        { name: "COMPOSIO_SEARCH_TOOLS", description: "Find app tools", inputSchema: { type: "object" } },
        { name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "Run selected app tools", inputSchema: { type: "object" } },
        { name: "COMPOSIO_REMOTE_BASH_TOOL", inputSchema: { type: "object" } },
        { name: "HACKERNEWS_READ", inputSchema: { type: "object" } }, { name: "GMAIL_SEND_EMAIL", inputSchema: { type: "object" } },
      ] } });
      if (body.method === "tools/call") {
        calls.push({ sessionId: mcp[1]!, name: body.params.name, arguments: body.params.arguments });
        if (body.params.arguments?.hang) { res.on("close", () => { cancelledCalls++; }); return; }
        return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `COMPOSIO_FIXTURE_OK ${key}` }] } });
      }
    }
    return json({ error: "No such fixture endpoint" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, key, sessions, calls, get cancelledCalls() { return cancelledCalls; }, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
