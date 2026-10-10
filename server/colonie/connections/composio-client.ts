import { z } from "zod";
import { randomUUID } from "node:crypto";
import { RemoteMcpClient } from "../../mcp-http.ts";

const sessionSchema = z.object({ session_id: z.string().min(1), mcp: z.object({ url: z.string().url(), type: z.enum(["http", "sse"]) }) });
export type ComposioSession = z.infer<typeof sessionSchema>;
export function composioApiBase() { return (process.env.OMB_COMPOSIO_API ?? "https://backend.composio.dev/api/v3.1").replace(/\/$/, ""); }
export function disposableComposioUser() { return `colonie_fixture_${randomUUID()}`; }
export async function composioRequest(key: string, path: string, method = "GET", body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`${composioApiBase()}${path}`, { method, redirect: "error", headers: { "x-api-key": key, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: signal ?? AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Composio returned HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}
export async function createComposioSession(key: string, userId: string, toolkits: string[], signal?: AbortSignal) {
  const session = sessionSchema.parse(await composioRequest(key, "/tool_router/session", "POST", {
    user_id: userId, toolkits: { enable: toolkits }, sandbox: { enable: false }, manage_connections: { enable: true, enable_wait_for_connections: false },
  }, signal));
  assertComposioDestination(session.mcp.url);
  if (session.mcp.type !== "http") throw new Error("This Composio session does not offer HTTP MCP");
  return session;
}
export function assertComposioDestination(value: string) {
  const url = new URL(value); const base = new URL(composioApiBase());
  if (url.origin !== base.origin || url.username || url.password || url.hash) throw new Error("Composio returned an unexpected MCP destination");
}
export function sessionClient(key: string, session: ComposioSession) {
  assertComposioDestination(session.mcp.url);
  return new RemoteMcpClient({ type: "http", url: session.mcp.url, headers: { "x-api-key": key } },
    { fetch: (input, init) => fetch(input, { ...init, redirect: "error" }) });
}
