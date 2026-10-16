import { readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../../../scripts/control-colonie.ts";
import { waitForExit } from "../../testing/cleanup.ts";
import { startFakeHttpMcp } from "../../testing/fake-http-mcp-server.ts";
import { fakeComposio } from "./testing/fake-composio.ts";
import type { AcpInputReceipt } from "../../../shared/acp.ts";

it.each(["codex-acp", "claude-acp"])("mounts Composio/custom MCP for %s with scope, native continuity, permission and Stop", async (provider) => {
  const composio = await fakeComposio();
  const custom = await startFakeHttpMcp({ tools: [{ name: "read_fixture", inputSchema: { type: "object" } }], callResult: () => ({ content: [{ type: "text", text: "CUSTOM_HTTP_FIXTURE_OK" }] }) });
  const sse = await startFakeHttpMcp({ transport: "sse", tools: [{ name: "read_sse", inputSchema: { type: "object" } }] });
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["colonie"], undefined, composio.origin);
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  const evidence: unknown[] = [fixture.info];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    const value = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value as any;
  };
  try {
    await api("PATCH", "/api/config", { composio: { apiKey: composio.key } });
    const { bot } = await api("POST", "/api/bots", { name: "Connected fixture", modelSelection: { instanceId: provider, model: "agent-default" }, computer: "off" });
    const { bot: other } = await api("POST", "/api/bots", { name: "Unconnected fixture", modelSelection: { instanceId: provider, model: "agent-default" }, computer: "off" });
    const threadId = bot.threadId;
    const receipts = async (): Promise<AcpInputReceipt[]> => (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts;
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
    const idle = () => expect.poll(async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id)?.busy, { timeout: 20_000 }).toBe(false);
    const send = async (text: string) => { await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId }); };
    const policyPath = `/api/bots/${bot.id}/connected-tools`;
    const select = async (toolkits: string[], customServers: string[]) => {
      const view = await api("GET", policyPath);
      return api("PATCH", policyPath, { expectedRevision: view.revision, preferences: { toolkits, customServers } });
    };
    await send("baseline"); await idle();
    const nativeSession = (await receipts())[0]!.sessionId;
    await api("POST", "/api/mcp/servers", { name: "custom_http", type: "http", url: custom.url, enabled: true });
    const stdioLog = join(dataDir, "custom-stdio-calls.jsonl");
    await api("POST", "/api/mcp/servers", { name: "custom_local", command: process.execPath, args: [join(import.meta.dirname, "testing/stdio-tool.ts")], env: { CUSTOM_MCP_FIXTURE_LOG: stdioLog, CUSTOM_FIXTURE_VALUE: "synthetic" }, enabled: true });
    await api("PATCH", "/api/mcp/servers/custom_http", { enabled: true });
    await api("PATCH", "/api/mcp/servers/custom_local", { enabled: true });
    const policy = await select(["hackernews"], ["custom_http", "custom_local"]);
    const stale = await fetch(`${url}${policyPath}`, { method: "PATCH", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ expectedRevision: "stale", preferences: { toolkits: [], customServers: [] } }) });
    expect(stale.status).toBe(409);
    await send("mcp list"); await idle();
    expect((await messages()).some((row) => row.text?.includes("custom_http:read_fixture") && row.text.includes("custom_local:read_fixture") && row.text.includes("colonie_composio:HACKERNEWS_READ"))).toBe(true);
    const mounted = (await receipts()).at(-1)!;
    expect(mounted.sessionId).toBe(nativeSession);
    expect(mounted.connectedTools).toMatchObject({ composioToolkits: ["hackernews"], servers: [{ name: "custom_http", source: "custom", transport: "http" }, { name: "custom_local", source: "custom", transport: "stdio" }, { name: "colonie_composio", source: "composio", transport: "http" }] });
    expect(JSON.stringify(await messages())).not.toContain("GMAIL_SEND_EMAIL");
    const call = async (server: string, name: string, behavior: "allow" | "deny", args: unknown = {}) => {
      await send(`mcp call ${server} ${name} ${JSON.stringify(args)}`);
      await expect.poll(async () => (await messages()).find((row) => row.card?.requestId && !row.card.answered), { timeout: 20_000 }).toBeTruthy();
      const card = (await messages()).find((row) => row.card?.requestId && !row.card.answered)!.card;
      await api("POST", `/api/threads/${threadId}/respond`, { requestId: card.requestId, behavior });
      await idle();
    };
    await call("colonie_composio", "HACKERNEWS_READ", "allow");
    expect(composio.calls).toHaveLength(1);
    expect((await messages()).some((row) => row.text === "COMPOSIO_FIXTURE_OK [redacted]")).toBe(true);
    expect((await receipts()).at(-1)?.connectedToolCalls).toEqual([{ server: "colonie_composio", tool: "HACKERNEWS_READ", targets: ["HACKERNEWS_READ"], status: "completed" }]);
    await call("colonie_composio", "HACKERNEWS_READ", "deny");
    expect(composio.calls).toHaveLength(1);
    await call("colonie_composio", "GMAIL_SEND_EMAIL", "allow");
    expect(composio.calls).toHaveLength(1);
    await call("custom_http", "read_fixture", "allow");
    expect(custom.calls).toHaveLength(1);
    await call("custom_local", "read_fixture", "allow");
    expect(JSON.parse(readFileSync(stdioLog, "utf8").trim())).toEqual({ name: "read_fixture", appKeyPresent: false, customValuePresent: true });
    await api("POST", `/api/bots/${other.id}/messages`, { text: "mcp list", threadId: other.threadId });
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === other.id)?.busy, { timeout: 20_000 }).toBe(false);
    expect((await api("GET", `/api/threads/${other.threadId}/messages`)).messages.some((row: any) => row.text === "MCP tools: None")).toBe(true);
    await send('mcp call colonie_composio HACKERNEWS_READ {"hang":true}');
    await expect.poll(async () => (await messages()).find((row) => row.card?.requestId && !row.card.answered), { timeout: 20_000 }).toBeTruthy();
    const pending = (await messages()).find((row) => row.card?.requestId && !row.card.answered)!.card;
    const busySave = await fetch(`${url}${policyPath}`, { method: "PATCH", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ expectedRevision: policy.revision, preferences: { toolkits: [], customServers: [] } }) });
    expect(busySave.status).toBe(409);
    await api("POST", `/api/threads/${threadId}/respond`, { requestId: pending.requestId, behavior: "allow" });
    await expect.poll(() => composio.calls.length, { timeout: 20_000 }).toBe(2);
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId }); await idle();
    await expect.poll(() => composio.cancelledCalls).toBe(1);
    expect((await receipts()).at(-1)?.status).toBe("cancelled");
    expect((await receipts()).at(-1)?.connectedToolCalls?.[0]?.status).toBe("cancelled");
    await select([], []); await send("mcp list"); await idle();
    expect((await receipts()).at(-1)?.sessionId).toBe(nativeSession);
    expect((await receipts()).at(-1)?.connectedTools?.servers).toEqual([]);
    await select(["hackernews"], ["custom_http"]);
    await send("mcp list"); await idle();
    // Remove only fixture remote sessions; native history must still resume.
    composio.sessions.clear();
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, [join(import.meta.dirname, "../../index.ts")], { env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), COLONIE_PROFILE: "1", COLONIE_COMPOSIO_API: `${composio.origin}/api/v3.1`, COLONIE_COMPOSIO_TOOLKITS_API: `${composio.origin}/api/v3` }, stdio: ["ignore", log, log] }); closeSync(log);
    await expect.poll(async () => { try { return (await api("GET", "/api/health")).app; } catch { return null; } }, { timeout: 20_000 }).toBe("colonie");
    await send("mcp list"); await idle();
    expect((await receipts()).at(-1)?.sessionId).toBe(nativeSession);
    await api("POST", "/api/mcp/servers", { name: "custom_sse", type: "sse", url: sse.url });
    await api("PATCH", "/api/mcp/servers/custom_sse", { enabled: true });
    await select([], ["custom_sse"]);
    const beforeSse = (await receipts()).length;
    await send("mcp list"); await idle();
    if (provider === "claude-acp") {
      expect((await messages()).some((row) => row.text === "MCP tools: custom_sse:read_sse")).toBe(true);
      await call("custom_sse", "read_sse", "allow"); expect(sse.calls).toHaveLength(1);
    } else {
      expect(await receipts()).toHaveLength(beforeSse);
      expect(JSON.stringify(await messages())).toContain("does not support SSE MCP");
    }
    await select([], []); await send("after transport check"); await idle();
    expect((await receipts()).at(-1)?.sessionId).toBe(nativeSession);
    const final = await receipts();
    expect(JSON.stringify(final)).not.toContain(composio.key);
    expect(JSON.stringify(await messages())).not.toContain(composio.key);
    evidence.push({ provider, nativeSession, receipts: final, composioCallCount: composio.calls.length, customCallCount: custom.calls.length, cancelledCalls: composio.cancelledCalls, restarted: true });
  } finally {
    writeFileSync(`${logPath}.connected-tools.json`, JSON.stringify(evidence, null, 2));
    await waitForExit(restarted, { signal: "SIGTERM" }); await fixture.close(); await custom.close(); await sse.close(); await composio.close();
    console.info(JSON.stringify({ logPath, evidence: `${logPath}.connected-tools.json` }));
  }
}, 120_000);
