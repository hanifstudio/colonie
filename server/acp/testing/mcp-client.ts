/** Fixture-only MCP peer used by the official-SDK fake ACP agent. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { McpServer } from "@agentclientprotocol/sdk";
import { RemoteMcpClient } from "../../colonie/mcp/mcp-http.ts";

export interface FixtureMcpClient { request(method: string, params: unknown, signal: AbortSignal): Promise<any>; close(): Promise<void> }
export async function fixtureMcpClient(server: McpServer): Promise<FixtureMcpClient> {
  if ("type" in server && (server.type === "http" || server.type === "sse")) {
    const client = new RemoteMcpClient({ type: server.type, url: server.url, headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) });
    await client.initialize("Colonie SDK fixture", AbortSignal.timeout(10_000));
    return { request: (method, params, signal) => client.request(method, params, signal), close: () => client.close() };
  }
  if ("type" in server) throw new Error("Unsupported fixture MCP transport");
  const child = spawn(server.command, server.args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])) }, stdio: ["pipe", "pipe", "ignore"] });
  let next = 1;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line); const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);
    if (frame.error) waiter.reject(new Error(frame.error.message)); else waiter.resolve(frame.result);
  });
  child.once("error", (error) => { for (const waiter of pending.values()) waiter.reject(error); });
  const request = (method: string, params: unknown, signal: AbortSignal) => new Promise<any>((resolve, reject) => {
    const id = next++;
    const abort = () => { pending.delete(id); reject(new Error("Fixture MCP request cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    pending.set(id, { resolve: (value) => { signal.removeEventListener("abort", abort); resolve(value); }, reject: (error) => { signal.removeEventListener("abort", abort); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Fixture", version: "1" } }, AbortSignal.timeout(10_000));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { request, close: async () => { child.stdin.end(); child.kill("SIGTERM"); } };
}
