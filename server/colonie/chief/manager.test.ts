// Every bot can schedule its own routines from chat, through the workspace
// tools the engine reaches over loopback MCP.
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import { ColonieChief, type ChiefDeps } from "./manager.ts";

function chief(proposals: unknown[], extra: Partial<ChiefDeps> = {}) {
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
    ...extra,
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

test("the Chief makes a group for the person and sets a bot's approval level, but never Full access", async () => {
  const groups: unknown[] = [];
  const levels: unknown[] = [];
  const manager = chief([], {
    createGroup: (threadId, input) => { groups.push({ threadId, ...input }); return { made: input.name, groupId: "g1" }; },
    setApprovalLevel: (botId, level) => { levels.push({ botId, level }); return { bot: botId, level }; },
  });
  const mount = manager.mount("chief", "thread-1", "codex-acp");
  mount!.activate();
  const token = (mount!.servers[0] as { headers: Array<{ name: string; value: string }> }).headers.find((header) => header.name === "Authorization")!.value.slice("Bearer ".length);
  const tools = (await rpc(manager, token, "tools/list")).result.tools!.map((tool) => tool.name);
  expect(tools).toEqual(expect.arrayContaining(["create_group", "set_approval_level"]));

  const made = await rpc(manager, token, "tools/call", { name: "create_group", arguments: { name: "IGRS", botIds: ["b1"], emails: ["hilmi@x.com"], instructions: "Answer in Indonesian.", requestId: "g-1" } });
  expect(made.result.isError).toBeUndefined();
  expect(groups).toEqual([{ threadId: "thread-1", name: "IGRS", botIds: ["b1"], emails: ["hilmi@x.com"], instructions: "Answer in Indonesian." }]);
  // a bot that is not here is refused before anything is made
  expect((await rpc(manager, token, "tools/call", { name: "create_group", arguments: { name: "X", botIds: ["nobody"], requestId: "g-2" } })).result.isError).toBe(true);
  expect(groups).toHaveLength(1);

  expect((await rpc(manager, token, "tools/call", { name: "set_approval_level", arguments: { botId: "b1", level: "auto", requestId: "l-1" } })).result.isError).toBeUndefined();
  expect(levels).toEqual([{ botId: "b1", level: "auto" }]);
  const full = await rpc(manager, token, "tools/call", { name: "set_approval_level", arguments: { botId: "b1", level: "full", requestId: "l-2" } });
  expect(full.result.isError).toBe(true);
  expect(full.result.content![0]!.text).toContain("Full access is the person's");
  expect(levels).toHaveLength(1);
  manager.dispose();
});

test("a DM can start a group assignment once, and a group cannot create a hidden private consultation", async () => {
  const assignments: unknown[] = [];
  const manager = chief([], {
    listGroups: () => [{ id: "group-1", name: "Project" }],
    groupForThread: (threadId) => threadId === "group-work" ? { id: "group-1", name: "Project" } : undefined,
    sendGroupMessage: (botId, sourceThreadId, groupId, message) => {
      assignments.push({ botId, sourceThreadId, groupId, message });
      return { state: "accepted", groupId };
    },
  });
  const mount = manager.mount("chief", "private-dm", "codex-acp")!;
  mount.activate();
  const tokenOf = (entry: typeof mount) => (entry.servers[0] as { headers: Array<{ name: string; value: string }> }).headers[0]!.value.slice("Bearer ".length);
  const token = tokenOf(mount);
  expect((await rpc(manager, token, "tools/call", { name: "list_groups" })).result.content![0]!.text).toContain("Project");
  const params = { name: "send_group_message", arguments: { groupId: "group-1", message: "@Nova inspect the project", requestId: "begin" } };
  expect((await rpc(manager, token, "tools/call", params)).result.content![0]!.text).toContain("accepted");
  await rpc(manager, token, "tools/call", params);
  expect(assignments).toEqual([{ botId: "chief", sourceThreadId: "private-dm", groupId: "group-1", message: "@Nova inspect the project" }]);
  // Ending the DM's turn has no cancellation authority over the accepted group work.
  mount.deactivate();
  expect(assignments).toHaveLength(1);
  const group = manager.mount("chief", "group-work", "codex-acp")!;
  group.activate();
  const tools = (await rpc(manager, tokenOf(group), "tools/list")).result.tools!.map((tool) => tool.name);
  expect(tools).not.toContain("ask_bot");
  expect(tools).not.toContain("send_group_message");
  expect((await rpc(manager, tokenOf(group), "tools/call", { name: "ask_bot", arguments: { targetBotId: "b1", message: "hidden", requestId: "private" } })).result.isError).toBe(true);
  manager.dispose();
});

test("a private consultation deadline reports an unconfirmed result, distinct from a person's Stop", async () => {
  vi.useFakeTimers();
  const manager = chief([], {
    createAssignmentThread: () => "consultation",
    runAssignment: (_job, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("Stopped"), { name: "AbortError" })), { once: true });
    }),
  });
  try {
    const mount = manager.mount("chief", "private-dm", "codex-acp")!;
    mount.activate();
    const token = (mount.servers[0] as { headers: Array<{ value: string }> }).headers[0]!.value.slice("Bearer ".length);
    const result = rpc(manager, token, "tools/call", { name: "ask_bot", arguments: { targetBotId: "b1", message: "Short question", requestId: "consult" } });
    await vi.advanceTimersByTimeAsync(120_000);
    const response = await result;
    expect(response.result.isError).toBe(true);
    expect(response.result.content![0]!.text).toContain("two-minute limit");
    expect(manager.view("private-dm").assignments[0]).toMatchObject({ status: "failed", error: expect.stringContaining("unconfirmed") });
  } finally { manager.dispose(); vi.useRealTimers(); }
});
