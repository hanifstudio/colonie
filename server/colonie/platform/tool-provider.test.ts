import { describe, expect, it } from "vitest";
import { createComposioToolResolver, toolInputSchema } from "./tool-provider.ts";
import type { BotTurnRequest } from "./contracts.ts";
import type { ComposioToolAccess } from "./composio.ts";
import { Ajv } from "ajv";

const key = "ak_SYNTHETIC_PARENT_ONLY";
const request = { workspaceId: "ws", conversationId: "private", botId: "bot", botPrincipalId: "bot-principal", initiatorAccountId: "human", trigger: "dm" } as BotTurnRequest;

function fixture(kind: "dm" | "group") {
  const scopes: string[] = [];
  const calls: Array<{ url: string; body?: Record<string, unknown>; key: string | null }> = [];
  let authorized = true;
  const resolve = createComposioToolResolver({
    platform: { getConversation: async () => ({ conversation: { workspaceId: "ws", kind }, messages: [] }) as any, canPublish: async () => authorized },
    apps: {
      resolveToolAccess: async (accountId, workspaceId, scope) => {
        scopes.push(scope);
        return { key, accountId, workspaceId, scope, keyRef: "key-ref", keyVersion: 1, userId: `${scope}-identity`, resolvedAt: "fixture",
          connections: [{ id: `${scope}-link`, userId: `${scope}-identity`, toolkit: "gmail", providerAccountId: `${scope}-account` }] } satisfies ComposioToolAccess;
      },
      checkToolAccess: async () => authorized,
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, body, key: new Headers(init?.headers).get("x-api-key") });
      if (body) return Response.json({ successful: true, data: { items: ["read result"], echo: key }, log_id: "private-vendor-metadata" });
      return Response.json({ slug: url.split("/tools/")[1]!.split("?")[0], toolkit: { slug: "gmail" }, version: "20261010_00", description: "Read messages", input_parameters: { type: "object", properties: { query: { type: "string" }, user_id: { type: "string" } }, required: ["query"] } });
    },
  });
  return { resolve, scopes, calls, revoke: () => { authorized = false; } };
}

describe("Cloud connected-app provider boundary", () => {
  it("pins personal/shared identities and versions in the parent, without exposing keys in model schemas/results", async () => {
    const f = fixture("dm");
    const tools = await f.resolve(request);
    expect(f.scopes).toEqual(["personal", "shared"]);
    expect(tools).toHaveLength(6);
    expect(JSON.stringify(tools)).not.toContain(key);
    expect(tools[0]!.inputSchema).toMatchObject({ properties: { query: { type: "string" } }, additionalProperties: false });
    expect((tools[0]!.inputSchema.properties as Record<string, unknown>).user_id).toBeUndefined();
    const result = await tools[0]!.execute({ query: "unread" });
    expect(result).toEqual({ items: ["read result"], echo: "[private workspace key]" });
    expect(f.calls.at(-1)).toMatchObject({ key, body: { connected_account_id: "personal-account", user_id: "personal-identity", version: "20261010_00", arguments: { query: "unread", user_id: "me" } } });
    expect(JSON.stringify(result)).not.toContain("private-vendor-metadata");
  });

  it("offers only deliberately shared accounts in Groups, and withdraws tools after revocation", async () => {
    const f = fixture("group");
    const tools = await f.resolve({ ...request, trigger: "mention" });
    expect(f.scopes).toEqual(["shared"]);
    expect(tools).toHaveLength(3);
    expect(await tools[0]!.authorize()).toBe(true);
    f.revoke();
    expect(await tools[0]!.authorize()).toBe(false);
    await expect(tools[0]!.execute({})).rejects.toThrow(/no longer available/);
    expect(f.calls.every((call) => call.body === undefined)).toBe(true);
  });

  it("rejects credential/account overrides and never offers write or meta-execution actions", async () => {
    const f = fixture("dm");
    const tools = await f.resolve(request);
    for (const args of [{ connected_account_id: "foreign" }, { user_id: "other@example.test" }, { custom_connection_data: {} }, { apiKey: "foreign" }]) {
      await expect(tools[0]!.execute(args)).rejects.toThrow(/different account/);
    }
    expect(f.calls.every((call) => call.body === undefined)).toBe(true);
    expect(tools.some((tool) => /SEND|DELETE|EXECUTE|MANAGE/.test(tool.name))).toBe(false);
    const schema = toolInputSchema({ query: { type: "string", required: true }, api_key: { type: "string", required: true } });
    expect(schema).toMatchObject({ required: ["query"], properties: { query: { type: "string" } } });
    const validate = new Ajv().compile(schema);
    expect(validate({ query: "read my inbox" })).toBe(true);
    expect(validate({})).toBe(false);
  });
});
