// Every bot can schedule its own routines from chat, through the workspace
// tools the engine reaches over loopback MCP.
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { ColonieChief, type ChiefDeps } from "./manager.ts";

function chief(proposals: unknown[]) {
  const bots = [{ id: "chief", name: "Sage", title: "", description: "", chiefOfStaff: true, modelSelection: { instanceId: "codex-acp", model: "m" } },
    { id: "b1", name: "Nova", title: "", description: "", modelSelection: { instanceId: "codex-acp", model: "m" } }];
  const deps = {
    origin: "http://127.0.0.1:1",
    bots: () => bots, bot: (id: string) => bots.find((bot) => bot.id === id), chiefId: () => "chief",
    owns: () => true, currentTurn: () => "turn-1", busy: () => false,
    skills: { list: () => [], readEnabled: () => null, save: () => null, setEnabled: () => null, remove: () => null },
    routines: {
      list: (botId: string) => [{ id: "r1", name: "News", owner: botId }],
      propose: async (botId: string, threadId: string, proposal: unknown) => { proposals.push({ botId, threadId, proposal }); return { state: "applied", summary: "Scheduled News" }; },
      now: () => ({ time: "2026-10-23T08:00:00.000Z", timeZone: "Asia/Jakarta" }),
    },
  } as unknown as ChiefDeps;
  return new ColonieChief(deps, mkdtempSync(join(tmpdir(), "colonie-chief-")));
}

/** One MCP request as the engine sends it, with the mount's bearer token. */
async function rpc(manager: ColonieChief, token: string, method: string, params: unknown = {}) {
  let body = "";
  const req = { method: "POST", headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
  const res = { writeHead: () => res, end: (text: string) => { body = text; } } as unknown as ServerResponse;
  await manager.handle(req, res, { jsonrpc: "2.0", id: 1, method, params });
  return JSON.parse(body) as { result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } };
}

test("a bot that is not the Chief, with no guides, can still list and schedule its own routines", async () => {
  const proposals: unknown[] = [];
  const manager = chief(proposals);
  const mount = manager.mount("b1", "thread-1", "codex-acp");
  expect(mount).not.toBeNull();
  mount!.activate();
  const server = mount!.servers[0] as { headers: Array<{ name: string; value: string }> };
  const token = server.headers.find((header) => header.name === "Authorization")!.value.slice("Bearer ".length);

  const tools = (await rpc(manager, token, "tools/list")).result.tools!.map((tool) => tool.name);
  expect(tools).toEqual(expect.arrayContaining(["list_routines", "schedule_routine", "change_routine", "save_my_skill", "read_skill"]));
  expect(tools).not.toContain("create_bot");

  const listed = await rpc(manager, token, "tools/call", { name: "list_routines", arguments: {} });
  expect(listed.result.content![0]!.text).toContain("Asia/Jakarta");
  expect(listed.result.content![0]!.text).toContain("\"owner\":\"b1\"");

  const scheduled = await rpc(manager, token, "tools/call", { name: "schedule_routine", arguments: {
    name: "News", instructions: "Sum up the news.", requestId: "r-1",
    // a stray timezone on a weekly schedule is dropped, not refused
    schedule: { type: "weekly", time: "08:00", weekdays: ["monday", "friday"], timeZone: "Asia/Jakarta" },
  } });
  expect(scheduled.result.isError).toBeUndefined();
  expect(scheduled.result.content![0]!.text).toContain("applied");
  expect(proposals).toEqual([{ botId: "b1", threadId: "thread-1", proposal: { action: "create", routine: {
    name: "News", instructions: "Sum up the news.", schedule: { type: "weekly", time: "08:00", weekdays: ["monday", "friday"] },
  } } }]);

  await rpc(manager, token, "tools/call", { name: "change_routine", arguments: { routineId: "r1", action: "pause", requestId: "r-2" } });
  expect(proposals.at(-1)).toEqual({ botId: "b1", threadId: "thread-1", proposal: { action: "pause", routineId: "r1" } });
  manager.dispose();
});
