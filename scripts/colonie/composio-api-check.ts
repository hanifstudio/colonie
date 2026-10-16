/** Two bounded MCP calls on a newly allocated Composio user; no personal accounts. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createComposioSession, composioRequest, disposableComposioUser, sessionClient } from "../../server/colonie/connections/composio-client.ts";

const key = process.env.COMPOSIO_API_KEY;
if (!key) throw new Error("COMPOSIO_API_KEY is required for this explicit real-service check");
const userId = disposableComposioUser();
const evidence = resolve(".colonie-dev/evidence");
mkdirSync(evidence, { recursive: true });
const result: Record<string, unknown> = { realComposio: true, realAgent: false, userId, requestBudget: 2 };
let session: Awaited<ReturnType<typeof createComposioSession>> | undefined;
let client: ReturnType<typeof sessionClient> | undefined;
const findTool = (value: unknown): boolean => {
  if (typeof value === "string") return value === "HACKERNEWS_GET_TOP_STORIES";
  if (Array.isArray(value)) return value.some(findTool);
  return value !== null && typeof value === "object" && Object.values(value).some(findTool);
};
const contentJson = (value: any) => (value.content ?? []).flatMap((block: any) => { try { return [JSON.parse(block.text)]; } catch { return []; } });
try {
  session = await createComposioSession(key, userId, ["hackernews"]);
  client = sessionClient(key, session);
  await client.initialize("Colonie bounded verification", AbortSignal.timeout(30_000));
  const tools = await client.request("tools/list", {}, AbortSignal.timeout(30_000)) as any;
  result.toolNames = tools.tools.map((tool: any) => tool.name);
  const search = await client.request("tools/call", { name: "COMPOSIO_SEARCH_TOOLS", arguments: { queries: [{ use_case: "Retrieve public Hacker News top story IDs; no personal account access is needed." }] } }, AbortSignal.timeout(30_000)) as any;
  result.searchError = search.isError === true;
  result.searchShapes = contentJson(search).map((body: any) => Object.keys(body));
  if (search.isError || !findTool(contentJson(search))) throw new Error("Composio discovery did not offer the expected public read-only tool");
  const read = await client.request("tools/call", { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "HACKERNEWS_GET_TOP_STORIES", arguments: {} }], sync_response_to_workbench: false } }, AbortSignal.timeout(30_000)) as any;
  result.readError = read.isError === true;
  const bodies = contentJson(read);
  result.readShapes = bodies.map((body: any) => Object.keys(body));
  // Store only synthetic/public result evidence, never any header or credential.
  const text = JSON.stringify(bodies);
  result.readSuccessfulFlag = /"successful":true|"success":true/.test(text);
  result.publicStoryIdsPresent = /\b\d{7,}\b/.test(text);
  if (read.isError || !result.readSuccessfulFlag || !result.publicStoryIdsPresent) throw new Error("The bounded public Composio read did not succeed");
  result.ok = true;
} catch (error) {
  result.ok = false; result.error = (error as Error).message.split(key).join("[redacted]"); process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  if (session) {
    try { await composioRequest(key, `/tool_router/session/${encodeURIComponent(session.session_id)}`, "DELETE"); result.sessionDeleted = true; }
    catch { result.sessionDeleted = false; }
  }
  writeFileSync(join(evidence, "composio-api-check.json"), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));
