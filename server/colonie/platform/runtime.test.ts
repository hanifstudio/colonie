import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CloudAcpRuntime, cloudRuntimeEnvironment, type CloudFailure, type CloudTurnState, type CloudRuntimeOptions } from "./runtime.ts";
import type { BotTurnRequest, PlatformTurnSink } from "./contracts.ts";
import { CloudToolBroker } from "./tools.ts";

const roots: string[] = [];
const runtimes: CloudAcpRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]))).flat();
}

function request(id = "private-one", body = "PRIVATE_ONE"): BotTurnRequest {
  const message = { id: `${id}-message`, workspaceId: "workspace", conversationId: id,
    senderPrincipalId: `person-${id}`, senderKind: "human" as const, senderName: "Person", sequence: 1, body, createdAt: new Date().toISOString() };
  return { workspaceId: "workspace", conversationId: id, botId: "same-bot", botPrincipalId: "bot-principal",
    initiatorAccountId: `account-${id}`, trigger: "dm", message, history: [message] };
}

async function fixture(authorize = async () => true, toolBroker?: CloudToolBroker, botProfile?: CloudRuntimeOptions["botProfile"]) {
  const root = await mkdtemp(join(tmpdir(), "colonie-cloud-runtime-"));
  roots.push(root);
  const posted: Array<{ conversationId: string; body: string; initiatorAccountId?: string }> = [];
  const states: Array<{ conversationId: string; state: CloudTurnState; message?: string }> = [];
  const failures: CloudFailure[] = [];
  const sink: PlatformTurnSink = {
    canPublish: async () => true,
    postBotMessage: async (input) => { posted.push(input); return { ...request(input.conversationId).message, senderKind: "bot", body: input.body }; },
    publishTurnState: async () => {},
  };
  const runtime = new CloudAcpRuntime({ root, claudeConfigDir: join(root, "unused-native-auth"), sink,
    authorize, toolBroker, botProfile, adapterEntry: resolve("scripts/colonie/testing/cloud-chat-agent.ts"), timeoutMs: 8_000,
    state: async (value, state, message) => { states.push({ conversationId: value.conversationId, state, message }); },
    failure: (failure) => failures.push(failure),
  });
  runtimes.push(runtime);
  return { root, runtime, posted, states, failures };
}

describe("Cloud conversation ACP boundary", () => {
  it("dispatches the saved identity and SOUL on each turn and records the exact profile input", async () => {
    let soul = "SAVED_SOUL_ONE: answer briefly";
    const f = await fixture(async () => true, undefined, async () => ({ name: "Scout", title: "Researcher", description: "Find useful sources", soul, purpose: "LEGACY_PURPOSE_NOT_USED" }));
    f.runtime.onTurn(request("profile-one"));
    await expect.poll(() => f.states.filter((item) => item.state === "completed").length, { timeout: 10_000 }).toBe(1);
    soul = "SAVED_SOUL_TWO: ask before sending";
    f.runtime.onTurn(request("profile-two"));
    await expect.poll(() => f.states.filter((item) => item.state === "completed").length, { timeout: 10_000 }).toBe(2);
    const paths = await files(f.root);
    const receipts = await Promise.all(paths.filter((path) => path.endsWith("input-receipt.json")).map(async (path) => JSON.parse(await readFile(path, "utf8"))));
    const dispatched = await Promise.all(paths.filter((path) => path.endsWith("fixture-state.json")).map(async (path) => JSON.parse(await readFile(path, "utf8"))));
    expect(receipts.map((value) => value.applicationPrompt).sort()).toEqual(dispatched.map((value) => value.text).sort());
    expect(receipts.some((value) => value.applicationPrompt.includes("SAVED_SOUL_ONE") && !value.applicationPrompt.includes("SAVED_SOUL_TWO"))).toBe(true);
    expect(receipts.some((value) => value.applicationPrompt.includes("SAVED_SOUL_TWO") && !value.applicationPrompt.includes("SAVED_SOUL_ONE"))).toBe(true);
    for (const receipt of receipts) {
      expect(receipt.applicationPrompt).toContain("Role: Researcher");
      expect(receipt.applicationPrompt).toContain("Find useful sources");
      expect(receipt.applicationPrompt).not.toContain("LEGACY_PURPOSE_NOT_USED");
    }
    expect(f.posted.map((message) => message.body)).toEqual(["CLOUD_FIXTURE_OK", "CLOUD_FIXTURE_OK"]);
  });
  it.each([
    ["AUTH_FAILURE_FIXTURE", "authentication", "connection needs attention"],
    ["QUOTA_FAILURE_FIXTURE", "quota", "usage limit"],
  ])("reports %s without exposing native error/account details", async (body, reason, publicMessage) => {
    const f = await fixture();
    f.runtime.onTurn(request("private-failure", body));
    await expect.poll(() => f.states.some((state) => state.state === "failed"), { timeout: 10_000 }).toBe(true);
    expect(f.posted).toEqual([]);
    expect(f.states.find((state) => state.state === "failed")?.message).toContain(publicMessage);
    expect(f.failures).toEqual([{ phase: "prompt", reason, exitCode: null }]);
    expect(JSON.stringify([f.states, f.failures])).not.toContain("fixture-private");
  });
  it("uses its leased read tool through the SDK, publishes the result and revokes the lease after the turn", async () => {
    const broker = new CloudToolBroker({ authorize: async () => true, resolve: async () => [{
      name: "read_fixture", description: "Read a synthetic item", inputSchema: { type: "object", properties: { query: { type: "string" } } },
      authorize: async () => true, execute: async (args) => ({ item: "PRIVATE_APP_FIXTURE", query: args.query }),
    }] });
    try {
      const f = await fixture(async () => true, broker);
      f.runtime.onTurn(request("private-tool", "USE_CONNECTED_TOOL_FIXTURE"));
      await expect.poll(() => f.posted.length, { timeout: 10_000 }).toBe(1);
      await expect.poll(() => f.states.some((item) => item.state === "completed")).toBe(true);
      expect(JSON.parse(f.posted[0]!.body)).toEqual({ item: "PRIVATE_APP_FIXTURE", query: "fixture" });
      const paths = await files(f.root);
      const state = JSON.parse(await readFile(paths.find((path) => path.endsWith("fixture-state.json"))!, "utf8"));
      expect(state.outcome.outcome.outcome).toBe("cancelled");
      const mount = state.options.mcpServers[0];
      const response = await fetch(mount.url, { method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(mount.headers.map((header: { name: string; value: string }) => [header.name, header.value])) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      expect(response.status).toBe(401);
      const receipt = JSON.parse(await readFile(paths.find((path) => path.endsWith("input-receipt.json"))!, "utf8"));
      expect(receipt.policy.connectedTools).toEqual(["read_fixture"]);
      expect(JSON.stringify(receipt)).not.toContain(mount.headers[0].value);
    } finally { await broker.close(); }
  });
  it("keeps each DM's prompt separate, disables native tools, rejects permissions, and records exact input", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "fixture-secret");
    vi.stubEnv("DATABASE_URL", "fixture-secret");
    const f = await fixture();
    f.runtime.onTurn(request());
    f.runtime.onTurn(request("private-two", "PRIVATE_TWO"));
    await expect.poll(() => f.posted.length, { timeout: 10_000 }).toBe(2);
    await expect.poll(() => f.states.filter((item) => item.state === "completed").length).toBe(2);
    const artifacts = await files(f.root);
    const fixtureStates = await Promise.all(artifacts.filter((path) => path.endsWith("fixture-state.json")).map(async (path) => JSON.parse(await readFile(path, "utf8"))));
    expect(fixtureStates).toHaveLength(2);
    for (const state of fixtureStates) {
      expect(state.options._meta.claudeCode.options).toMatchObject({ tools: [], settingSources: [], strictMcpConfig: true, persistSession: false });
      expect(state.options.mcpServers).toEqual([]);
      expect(state.outcome.outcome.outcome).toBe("cancelled");
      expect(state.leakedEnvironment).toEqual([]);
      expect(state.text.includes("PRIVATE_ONE") && state.text.includes("PRIVATE_TWO")).toBe(false);
    }
    const receipts = await Promise.all(artifacts.filter((path) => path.endsWith("input-receipt.json")).map(async (path) => JSON.parse(await readFile(path, "utf8"))));
    expect(receipts.map((receipt) => receipt.status)).toEqual(["completed", "completed"]);
    expect(receipts.map((receipt) => receipt.applicationPrompt).sort()).toEqual(fixtureStates.map((state) => state.text).sort());
    expect(f.posted.every((item) => item.body === "CLOUD_FIXTURE_OK" && item.initiatorAccountId)).toBe(true);
  });

  it("refuses a result after the initiating member's access is revoked during dispatch", async () => {
    let checks = 0;
    const f = await fixture(async () => ++checks < 4);
    f.runtime.onTurn(request());
    await expect.poll(() => f.states.some((item) => item.state === "cancelled"), { timeout: 10_000 }).toBe(true);
    expect(f.posted).toEqual([]);
    expect((await files(f.root)).some((path) => path.endsWith("fixture-state.json"))).toBe(true);
  });

  it("stops a running native turn and discards queued work for that conversation", async () => {
    const f = await fixture();
    f.runtime.onTurn(request("private-one", "HANG_FIXTURE"));
    f.runtime.onTurn(request("private-one", "QUEUED_MESSAGE"));
    await expect.poll(async () => (await files(f.root)).some((path) => path.endsWith("fixture-state.json")), { timeout: 10_000 }).toBe(true);
    await f.runtime.cancelConversation("private-one");
    await expect.poll(() => f.states.some((item) => item.state === "cancelled")).toBe(true);
    expect(f.posted).toEqual([]);
  });

  it("does not include ambient platform secrets in the provider environment", () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-secret");
    vi.stubEnv("COMPOSIO_API_KEY", "fixture-secret");
    expect(cloudRuntimeEnvironment("/isolated/auth", "/isolated/home")).not.toHaveProperty("OPENAI_API_KEY");
    expect(cloudRuntimeEnvironment("/isolated/auth", "/isolated/home")).not.toHaveProperty("COMPOSIO_API_KEY");
  });
});
