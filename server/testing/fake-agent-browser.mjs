// A stand-in for agent-browser, the bots' browser engine: `mcp` serves one
// tools (open, tab close, close) over stdio, and every other command (close,
// session list, set viewport) answers success without a browser. Proves the
// wiring from an engine to the harness's browser proxy, not real browsing.
import { createInterface } from "node:readline";

const [command] = process.argv.slice(2);
if (command !== "mcp") {
  process.stdout.write(`${JSON.stringify(process.argv.includes("list") ? { success: true, data: { sessions: [] } } : { success: true, data: {} })}\n`);
  process.exit(0);
}
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.id === undefined) return;
  if (frame.method === "initialize") send({ id: frame.id, result: { protocolVersion: frame.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-agent-browser", version: "1" } } });
  else if (frame.method === "tools/list") send({ id: frame.id, result: { tools: ["agent_browser_open", "agent_browser_tab_close", "agent_browser_close"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: { url: { type: "string" } } } })) } });
  // like the real engine: the only tab cannot be closed on its own, the browser can
  else if (frame.method === "tools/call" && frame.params?.name === "agent_browser_tab_close") send({ id: frame.id, result: { isError: true, content: [{ type: "text", text: "Cannot close the last tab" }] } });
  else if (frame.method === "tools/call" && frame.params?.name === "agent_browser_close") send({ id: frame.id, result: { isError: false, content: [{ type: "text", text: "Browser closed" }] } });
  else if (frame.method === "tools/call") send({ id: frame.id, result: { content: [{ type: "text", text: `Opened ${frame.params?.arguments?.url} in ${process.env.AGENT_BROWSER_SESSION}` }] } });
  else send({ id: frame.id, result: {} });
});
