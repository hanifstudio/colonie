/** Parent-only Composio read tools. Direct execution fixes the connection and
 * user in the request envelope; no tool router meta tool can switch accounts.
 * Schemas and versions come from the maintained vendor catalog.
 * https://docs.composio.dev/reference/api-reference/tools/getToolsByToolSlug
 * https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteByToolSlug
 */
import { createHash } from "node:crypto";
import { PlatformError, type BotTurnRequest } from "./contracts.ts";
import type { PlatformService } from "./service.ts";
import type { WorkspaceComposioService } from "./composio.ts";
import type { CloudTool } from "./tools.ts";

// Reviewed read actions from the vendor toolkit catalog, not a name heuristic
// or a model-selected permission. Sending/editing/deleting is unavailable.
export const CLOUD_READ_ACTIONS: Record<string, readonly string[]> = {
  gmail: ["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"],
  googlecalendar: ["GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_EVENTS_GET", "GOOGLECALENDAR_LIST_CALENDARS", "GOOGLECALENDAR_FREE_BUSY_QUERY"],
  googledrive: ["GOOGLEDRIVE_FIND_FILE", "GOOGLEDRIVE_FIND_FOLDER", "GOOGLEDRIVE_GET_FILE_METADATA", "GOOGLEDRIVE_GET_DOCUMENT", "GOOGLEDRIVE_GET_SPREADSHEET_VALUES"],
};
const reserved = new Set(["connected_account_id", "connectedAccountId", "custom_auth_params", "custom_connection_data", "api_key", "apiKey", "access_token", "refresh_token", "authorization", "entity_id"]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function toolInputSchema(parameters: unknown): Record<string, unknown> {
  if (!record(parameters)) throw new Error("The app did not return a tool schema.");
  const schema = parameters.type === "object" && record(parameters.properties)
    ? structuredClone(parameters)
    : { type: "object", properties: Object.fromEntries(Object.entries(parameters).map(([name, value]) => {
      if (!record(value)) return [name, value];
      const { required: _required, ...property } = value;
      return [name, structuredClone(property)];
    })), required: Object.entries(parameters).filter(([, value]) => record(value) && value.required === true).map(([name]) => name) };
  const properties = schema.properties as Record<string, unknown>;
  const omitted = new Set([...reserved, "user_id"]);
  for (const name of omitted) delete properties[name];
  if (Array.isArray(schema.required)) schema.required = schema.required.filter((name) => typeof name === "string" && !omitted.has(name));
  schema.additionalProperties = false;
  return schema;
}

function fixedArguments(args: Record<string, unknown>, toolkit: string): Record<string, unknown> {
  if (Object.keys(args).some((name) => reserved.has(name) || name === "user_id")) throw new Error("This tool cannot select a different account.");
  return toolkit === "gmail" ? { ...args, user_id: "me" } : args;
}

export function createComposioToolResolver(options: {
  platform: Pick<PlatformService, "getConversation" | "canPublish">;
  apps: Pick<WorkspaceComposioService, "resolveToolAccess" | "checkToolAccess">;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): (request: BotTurnRequest) => Promise<CloudTool[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? "https://backend.composio.dev/api/v3.1";
  const destination = new URL(base);
  if (destination.protocol !== "https:" || destination.username || destination.password) throw new Error("A trusted HTTPS app service is required.");

  async function call(key: string, path: string, body?: unknown): Promise<unknown> {
    const response = await doFetch(`${base.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "x-api-key": key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error("The connected app could not complete this request.");
    const text = await response.text();
    if (Buffer.byteLength(text) > 1_000_000) throw new Error("The app returned too much data. Narrow the request.");
    // A vendor error or echo must not expose the parent-held project key.
    return JSON.parse(text.split(key).join("[private workspace key]"));
  }

  return async (request) => {
    const { conversation } = await options.platform.getConversation(request.initiatorAccountId, request.conversationId);
    if (conversation.workspaceId !== request.workspaceId || !(await options.platform.canPublish(request))) return [];
    const scopes = conversation.kind === "dm" ? ["personal", "shared"] as const : ["shared"] as const;
    const tools: CloudTool[] = [];
    for (const scope of scopes) {
      let snapshot;
      try { snapshot = await options.apps.resolveToolAccess(request.initiatorAccountId, request.workspaceId, scope); }
      catch (error) {
        if (error instanceof PlatformError && error.status === 409) continue;
        throw error;
      }
      for (const connection of snapshot.connections) {
        for (const slug of CLOUD_READ_ACTIONS[connection.toolkit] ?? []) {
          try {
            const definition = await call(snapshot.key, `/tools/${slug}?toolkit_versions=latest`);
            if (!record(definition) || definition.slug !== slug || !record(definition.toolkit) || definition.toolkit.slug !== connection.toolkit ||
                typeof definition.version !== "string" || !/^\d{8}_\d{2}$/.test(definition.version)) continue;
            const version = definition.version;
            const schema = toolInputSchema(definition.input_parameters);
            const suffix = createHash("sha256").update(connection.id).digest("hex").slice(0, 8);
            tools.push({
              name: `${slug}_${suffix}`,
              description: `${typeof definition.description === "string" ? definition.description.slice(0, 1500) : slug}. Read only. Uses ${scope === "personal" ? "your personal app in this private DM" : "the workspace's explicitly shared app"}.`,
              inputSchema: schema,
              authorize: async () => await options.platform.canPublish(request) && await options.apps.checkToolAccess(snapshot, connection),
              execute: async (args) => {
                if (!(await options.apps.checkToolAccess(snapshot, connection))) throw new Error("This app connection is no longer available.");
                const value = await call(snapshot.key, `/tools/execute/${slug}`, {
                  connected_account_id: connection.providerAccountId, user_id: connection.userId,
                  version, arguments: fixedArguments(args, connection.toolkit),
                });
                if (!record(value) || value.successful !== true) throw new Error("The connected app did not complete this request.");
                // Execution metadata contains provider identity/log IDs. Only
                // the result data is relevant to the conversation.
                return value.data;
              },
            });
          } catch {
            // An unavailable schema does not turn a plain chat into an error.
            // Absent tools cannot support a claim that an app was checked.
          }
        }
      }
    }
    return tools;
  };
}
