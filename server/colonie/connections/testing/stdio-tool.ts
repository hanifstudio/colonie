import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.id === undefined) return;
  const send = (result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })}\n`);
  if (frame.method === "initialize") send({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Custom fixture", version: "1" } });
  if (frame.method === "tools/list") send({ tools: [{ name: "read_fixture", description: "Read a synthetic fixture value", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] });
  if (frame.method === "tools/call") {
    if (process.env.CUSTOM_MCP_FIXTURE_LOG) appendFileSync(process.env.CUSTOM_MCP_FIXTURE_LOG, `${JSON.stringify({ name: frame.params.name, appKeyPresent: Boolean(process.env.COMPOSIO_API_KEY), customValuePresent: process.env.CUSTOM_FIXTURE_VALUE === "synthetic" })}\n`);
    send({ content: [{ type: "text", text: "CUSTOM_MCP_FIXTURE_OK" }] });
  }
});
