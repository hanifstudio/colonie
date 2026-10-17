// The ACP fixture's scripted tool plan, driven over its real stdio surface:
// one plan step must reach a server mounted through session/new, come back to
// the app as native ACP tool activity, and leave an evidence row.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./cleanup.ts";
import { startFakeHttpMcp } from "./fake-http-mcp-server.ts";

const FAKE_ACP = fileURLToPath(new URL("./fake-acp-cli.ts", import.meta.url));

// A stdio MCP server that records each tools/call in $CALLS.
const STDIO_MCP = `
const { appendFileSync } = require("node:fs");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line);
  if (frame.id === undefined) return;
  const answer = result => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\\n");
  if (frame.method === "initialize") answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "plan-fixture", version: "1" } });
  else if (frame.method === "tools/list") answer({ tools: [{ name: "record_note", inputSchema: { type: "object" } }] });
  else if (frame.method === "tools/call") {
    appendFileSync(process.env.CALLS, JSON.stringify(frame.params) + "\\n");
    answer({ content: [{ type: "text", text: "noted: " + frame.params.arguments.note }] });
  } else answer({});
});
`;

async function withFixture(env: Record<string, string>, test: (acp: {
  request: (method: string, params: unknown) => Promise<any>; updates: any[];
}, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "colonie-tool-plan-"));
  const child = spawn(process.execPath, [FAKE_ACP], {
    env: { ...process.env, FAKE_ACP_MODE: "happy", FAKE_CLAUDE_ROOM_PLAN: "", FAKE_ACP_TOOL_PLAN: "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const updates: any[] = [];
  const waiting = new Map<number, (frame: any) => void>();
  let serial = 0;
  child.stderr.resume();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line);
    if (frame.method === "session/update") updates.push(frame.params);
    else if (frame.id !== undefined) waiting.get(frame.id)?.(frame);
  });
  const request = (method: string, params: unknown) => new Promise<any>((resolve) => {
    const id = ++serial;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await test({ request, updates }, dir);
  } finally {
    await waitForExit(child, { signal: "SIGTERM", graceMs: 500 });
    await removeTempDir(dir);
  }
}

const persona = (name: string, text: string) => [
  { type: "text", text: `### Bot · Persona\nName: ${name}` },
  { type: "text", text },
];

it("runs a plan step against a stdio server mounted by session/new and records evidence", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "colonie-tool-plan-plan-"));
  const plan = join(dir, "plan.json");
  const calls = join(dir, "calls.jsonl");
  writeFileSync(plan, JSON.stringify({
    "bot-1": { botName: "Plan Bot", steps: [{ tool: "record_note", arguments: { note: "hello" } }], reply: "Plan done" },
  }));
  try {
    await withFixture({ FAKE_ACP_TOOL_PLAN: plan }, async ({ request, updates }) => {
      await request("initialize", { protocolVersion: 1 });
      const session = await request("session/new", { cwd: dir, mcpServers: [
        { name: "notes", command: process.execPath, args: ["-e", STDIO_MCP], env: [{ name: "CALLS", value: calls }] },
      ] });
      const sessionId = session.result.sessionId;
      const prompt = persona("Plan Bot", "Write the note.");
      const answer = await request("session/prompt", { sessionId, prompt });
      expect(answer.result?.stopReason, JSON.stringify(answer)).toBe("end_turn");

      expect(readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)))
        .toEqual([{ name: "record_note", arguments: { note: "hello" } }]);
      const kinds = updates.map((entry) => entry.update);
      expect(kinds).toEqual([
        expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "plan-0-0", title: "record_note", rawInput: { note: "hello" } }),
        expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "plan-0-0", status: "completed",
          content: [{ type: "content", content: { type: "text", text: "noted: hello" } }] }),
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Plan done" } },
      ]);
      expect(updates.every((entry) => entry.sessionId === sessionId)).toBe(true);

      const rows = readFileSync(`${plan}.evidence.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ botId: "bot-1", turnIndex: 0, engine: "acp", sessionId, servers: ["notes"], resumed: false, prompt });
      expect(rows[0].evidence).toEqual([
        expect.objectContaining({ server: "notes" }),
        { step: { tool: "record_note", arguments: { note: "hello" } },
          response: expect.objectContaining({ result: { content: [{ type: "text", text: "noted: hello" }] } }) },
      ]);
    });
  } finally {
    await removeTempDir(dir);
  }
});

it("calls an HTTP mount, advances multi-turn plans, and leaves unplanned bots on their mode", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "colonie-tool-plan-plan-"));
  const plan = join(dir, "plan.json");
  const remote = await startFakeHttpMcp({
    tools: [{ name: "remote_tool", inputSchema: { type: "object" } }],
    callResult: () => ({ content: [{ type: "text", text: "remote ok" }] }),
    requireHeader: { name: "authorization", value: "Bearer fixture-only" },
  });
  writeFileSync(plan, JSON.stringify({ "bot-2": { promptIncludes: "PLAN_TURN", turns: [
    { steps: [{ tool: "remote_tool", server: "workspace", arguments: { n: 1 } }], reply: "first" },
    { reply: "second" },
  ] } }));
  try {
    // The launcher's original variable still enables the plan.
    await withFixture({ FAKE_CLAUDE_ROOM_PLAN: plan }, async ({ request, updates }) => {
      await request("initialize", { protocolVersion: 1 });
      const { result: { sessionId } } = await request("session/new", { cwd: dir, mcpServers: [
        { type: "http", name: "workspace", url: remote.url, headers: [{ name: "Authorization", value: "Bearer fixture-only" }] },
      ] });
      const text = () => updates.splice(0).filter((entry) => entry.update.sessionUpdate === "agent_message_chunk").map((entry) => entry.update.content.text);

      expect((await request("session/prompt", { sessionId, prompt: persona("Other", "PLAN_TURN one") })).result?.stopReason).toBe("end_turn");
      expect(remote.calls).toEqual([{ name: "remote_tool", arguments: { n: 1 } }]);
      expect(text()).toEqual(["first"]);

      expect((await request("session/prompt", { sessionId, prompt: persona("Other", "PLAN_TURN two") })).result?.stopReason).toBe("end_turn");
      expect(text()).toEqual(["second"]);

      // Not claimed by the plan: the ordinary happy turn.
      expect((await request("session/prompt", { sessionId, prompt: persona("Other", "chat") })).result?.stopReason).toBe("end_turn");
      expect(text()).toEqual(["hello from fake acp"]);

      // The plan has no third turn for this bot: the prompt fails loudly.
      const extra = await request("session/prompt", { sessionId, prompt: persona("Other", "PLAN_TURN three") });
      expect(extra.error?.message).toContain("Unexpected extra fixture turn 2 for bot-2");

      const rows = readFileSync(`${plan}.evidence.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(rows.map((row) => [row.botId, row.turnIndex])).toEqual([["bot-2", 0], ["bot-2", 1]]);
    });
  } finally {
    await remote.close();
    await removeTempDir(dir);
  }
});
