/** Isolated ACP fixture. Never authenticates or contacts a model provider. */
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, type NewSessionRequest } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

let options: NewSessionRequest | undefined;
let stop: (() => void) | undefined;
agent({ name: "Colonie Cloud fixture" })
  .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
  .onRequest(methods.agent.session.new, ({ params }) => {
    options = params;
    return { sessionId: "isolated-session" };
  })
  .onNotification(methods.agent.session.cancel, () => { stop?.(); })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    const outcome = await client.request(methods.client.session.requestPermission, {
      sessionId: params.sessionId, toolCall: { toolCallId: "permission", title: "Run a command", kind: "execute", status: "pending" },
      options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }],
    });
    let reply = "CLOUD_FIXTURE_OK";
    if (text.includes("USE_CONNECTED_TOOL_FIXTURE")) {
      const server = options?.mcpServers[0];
      if (!server || server.type !== "http") throw new Error("No fixture read tool was mounted");
      const rpc = async (method: string, params: unknown = {}) => (await fetch(server.url, {
        method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(server.headers.map((header) => [header.name, header.value])) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })).json();
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Cloud ACP fixture", version: "1" } });
      const list = await rpc("tools/list");
      const name = list.result.tools[0].name as string;
      const permission = await client.request(methods.client.session.requestPermission, {
        sessionId: params.sessionId, toolCall: { toolCallId: "connected-read", name: `mcp__colonie_apps__${name}`, title: "Read app", kind: "read", status: "pending" },
        options: [{ optionId: "read-once", kind: "allow_once", name: "Allow" }],
      });
      if (permission.outcome.outcome !== "selected") throw new Error("The approved read tool was denied");
      const result = await rpc("tools/call", { name, arguments: { query: "fixture" } });
      if (result.error) throw new Error("The fixture read tool failed");
      reply = result.result.content[0].text;
    }
    writeFileSync(join(process.cwd(), "fixture-state.json"), JSON.stringify({ options, text, outcome,
      leakedEnvironment: ["DATABASE_URL", "COMPOSIO_API_KEY", "OPENAI_API_KEY", "R2_SECRET_ACCESS_KEY"].filter((key) => process.env[key]),
    }));
    if (text.includes("HANG_FIXTURE")) {
      await new Promise<void>((done) => { stop = done; });
      return { stopReason: "cancelled" as const };
    }
    await client.notify(methods.client.session.update, { sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } });
    return { stopReason: "end_turn" as const };
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
process.stdin.on("end", () => process.exit(0));
