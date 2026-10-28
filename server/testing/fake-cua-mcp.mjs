// A stand-in for Cua Driver behind the Local VM bridge, for tests: one tool,
// screenshot, that first asks the computer-control route (as the real bridge
// does before every action) and answers with what the route said.
import { createInterface } from "node:readline";

const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
const control = async () => {
  const url = process.env.COLONIE_CONTROL_URL;
  if (!url) return "no control";
  const res = await fetch(url, { headers: { authorization: `Bearer ${process.env.COLONIE_CONTROL_TOKEN}` } });
  const body = await res.json().catch(() => ({}));
  return res.ok && body.held === false ? "free" : `refused ${res.status} ${body.blockedReason ?? ""}`.trim();
};
createInterface({ input: process.stdin }).on("line", async (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") send({ id: frame.id, result: { protocolVersion: frame.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-cua", version: "1" } } });
  else if (frame.method === "tools/list") send({ id: frame.id, result: { tools: [{ name: "screenshot", description: "See the desktop", inputSchema: { type: "object", properties: {} } }] } });
  else if (frame.method === "tools/call") send({ id: frame.id, result: { content: [{ type: "text", text: `Desktop with Chrome open; control ${await control()}` }] } });
  else if (frame.id !== undefined) send({ id: frame.id, result: {} });
});
