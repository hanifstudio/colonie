// A person asks a bot in chat for scheduled work, and the bot schedules it:
// the engine calls schedule_routine on the workspace tools, the routine is
// made for that bot, and the conversation shows it with an Undo. Driven on a
// throwaway Shared workspace whose stand-in engine calls a tool when a
// message says "mcp call <server> <tool> <json>".
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ANA = "ana@x.com";
const BOB = "bob@x.com";
let ws: SharedWorkspace;
let botId: string;

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: ANA, admin: true }, { email: BOB, admin: true }]);
  botId = (await ws.as(ANA, "/api/bots")).body.bots[0].id;
}, 90_000);
afterAll(async () => { await ws?.stop(); });

test("a bot schedules a routine for itself from chat, and the person sees it with an Undo", async () => {
  const call = (tool: string, args: unknown) => `mcp call colonie_workspace ${tool} ${JSON.stringify(args)}`;
  const sent = await ws.as(ANA, `/api/bots/${botId}/messages`, { method: "POST", body: { text: call("schedule_routine", {
    name: "Morning news", instructions: "Sum up the morning news in five lines.", requestId: "chat-1",
    schedule: { type: "weekly", time: "08:00", weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"] },
  }) } });
  expect(sent.status).toBeLessThan(300);
  const threadId = sent.body.threadId;
  // what the engine was sent: who is asking and where, before the message
  const until0 = Date.now() + 15_000;
  let sentText = "";
  while (!sentText && Date.now() < until0) {
    const receipts = (await ws.as(ANA, `/api/bots/${botId}/acp-inputs?threadId=${threadId}`)).body.receipts ?? [];
    sentText = receipts.flatMap((receipt: any) => receipt.prompt ?? []).map((block: any) => block.text ?? "").join("\n");
    if (!sentText) await settle(100);
  }
  expect(sentText).toMatch(/Now: \w+day, /);
  expect(sentText).toContain("This is the Shared workspace");
  expect(sentText).toContain("about_colonie");

  let routine: any;
  const until = Date.now() + 30_000;
  while (!routine && Date.now() < until) {
    routine = (await ws.as(ANA, "/api/routines")).body.routines?.find((entry: any) => entry.name === "Morning news");
    if (!routine) await settle(200);
  }
  if (!routine) throw new Error(`no routine was made:\n${JSON.stringify((await ws.as(ANA, `/api/threads/${threadId}/messages`)).body.messages?.map((m: any) => m.text ?? m.card?.title)).slice(0, 1500)}\n${ws.log().slice(-3000)}`);
  expect(routine).toMatchObject({ botId, enabled: true, schedule: { type: "daily", time: "08:00", weekdays: [1, 2, 3, 4, 5] } });
  expect(routine.nextRunAt).toBeGreaterThan(Date.now());
  expect(routine.conversation).toMatchObject({ threadId, requestedBy: { name: ANA } });
  expect((await ws.as(BOB, "/api/routines")).body.routines.some((entry: any) => entry.id === routine.id)).toBe(false);
  expect((await ws.as(BOB, `/api/routines/${routine.id}/run`, { method: "POST" })).status).toBe(404);

  const messages = (await ws.as(ANA, `/api/threads/${threadId}/messages`)).body.messages ?? [];
  const receipt = messages.find((message: any) => message.card?.routineRequest);
  expect(receipt?.card).toMatchObject({ autoApplied: true });
  // the engine was told it applied, so it can say so honestly
  expect(JSON.stringify(messages)).toMatch(/applied/);
}, 60_000);

test("a completed DM routine retains its report card on the active branch", async () => {
  const routine = (await ws.as(ANA, "/api/routines")).body.routines.find((entry: any) => entry.name === "Morning news");
  const live = await ws.stream(ANA);
  expect((await ws.as(ANA, `/api/routines/${routine.id}/run`, { method: "POST" })).status).toBeLessThan(300);
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const page = (await ws.as(ANA, `/api/threads/${routine.conversation.threadId}/messages`)).body;
    const report = page.messages.find((message: any) => message.routineRun?.routineId === routine.id && message.routineRun?.status === "completed");
    if (report) {
      expect(report.kind).toBe("routine.run");
      const publicBot = (await ws.as(ANA, "/api/bots")).body.bots.find((entry: any) => entry.id === botId);
      expect(publicBot.messages.find((message: any) => message.id === report.id)).toMatchObject({ kind: "routine.run", routineRun: { status: "completed" } });
      const frames = live.text().split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
      const frame = frames.findLast((frame) => frame.message?.id === report.id);
      live.close();
      expect(frame.message).toMatchObject({ kind: "routine.run", routineRun: { status: "completed" } });
      const byId = new Map(page.messages.map((message: any) => [message.id, message]));
      let cursor: any = byId.get(page.activeLeafId);
      const path = [];
      while (cursor) { path.push(cursor.id); cursor = byId.get(cursor.parentId); }
      expect(path).toContain(report.id);
      return;
    }
    await settle(100);
  }
  throw new Error(`No DM report card:\n${ws.log().slice(-2000)}`);
}, 60_000);

test("a routine a bot schedules while working for a group reports each run to that group", async () => {
  const group = (await ws.as(ANA, "/api/conversations", { method: "POST", body: { kind: "group", name: "Launch", emails: [], bots: [botId] } })).body;
  const bot = (await ws.as(ANA, "/api/bots")).body.bots.find((entry: any) => entry.id === botId);
  // an @mention gives the bot its work thread for this group
  await ws.as(ANA, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: `@${bot.name} hello` } });
  let workThread = "";
  const made = Date.now() + 20_000;
  while (!workThread && Date.now() < made) {
    const tasks = (await ws.as(ANA, "/api/bots")).body.bots.find((entry: any) => entry.id === botId).tasks ?? [];
    workThread = tasks.find((task: any) => task.title === "Work for Launch")?.threadId ?? "";
    if (!workThread) await settle(100);
  }
  expect(workThread).not.toBe("");
  await settle(1500);

  // the engine schedules from that work (the stand-in needs the call spelled out)
  const scheduled = await ws.as(ANA, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: `@${bot.name} mcp call colonie_workspace schedule_routine ${JSON.stringify({
    name: "Launch check", instructions: "Say how the launch is going.", requestId: "group-1", schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] },
  })}` } });
  expect(scheduled.status).toBe(201);
  let routine: any;
  const until = Date.now() + 20_000;
  while (!routine && Date.now() < until) {
    routine = (await ws.as(ANA, "/api/routines")).body.routines?.find((entry: any) => entry.name === "Launch check");
    if (!routine) await settle(200);
  }
  expect(routine).toBeTruthy();
  expect(routine.conversation).toMatchObject({ id: group.id, threadId: group.threadId });
  expect((await ws.as(BOB, "/api/routines")).body.routines.some((entry: any) => entry.id === routine.id)).toBe(false);

  // a run reports into the group, from the bot, and is announced
  const live = await ws.stream(ANA);
  expect((await ws.as(ANA, `/api/routines/${routine.id}/run`, { method: "POST" })).status).toBeLessThan(300);
  let report: any;
  const ran = Date.now() + 40_000;
  while (!report && Date.now() < ran) {
    const messages = (await ws.as(ANA, `/api/conversations/${group.id}/messages`)).body.messages ?? [];
    report = messages.find((message: any) => message.from?.botId === botId && !/working on it|hello/.test(message.text ?? "") && /launch is going/i.test(message.text ?? ""));
    if (!report) await settle(250);
  }
  const announced = Date.now() + 10_000;
  while (!live.text().includes("finished a routine") && Date.now() < announced) await settle(100);
  live.close();
  expect(live.text()).toContain("finished a routine");
  if (!report) throw new Error(`no report in the group:\n${JSON.stringify((await ws.as(ANA, `/api/conversations/${group.id}/messages`)).body.messages?.map((m: any) => m.text)).slice(0, 1500)}`);
  const runId = report.routineRun?.runId;
  expect(runId).toBeTruthy();
  const reports = (await ws.as(ANA, `/api/conversations/${group.id}/messages`)).body.messages.filter((message: any) => message.routineRun?.runId === runId);
  expect(reports).toHaveLength(1);
  expect(reports[0].routineRun.status).toBe("completed");
  const personal = (await ws.as(ANA, "/api/bots")).body.bots.find((entry: any) => entry.id === botId);
  for (const task of (personal.tasks ?? []).filter((entry: any) => !entry.forConversation && !entry.routineRunId)) {
    expect((await ws.as(ANA, `/api/threads/${task.threadId}/messages`)).body.messages.some((message: any) => message.routineRun?.runId === runId)).toBe(false);
  }
}, 120_000);

test("a calendar-created routine belongs to its creator's DM, including when another admin uses the same bot", async () => {
  const bob = await ws.as(BOB, `/api/bots/${botId}/messages`, { method: "POST", body: { text: "Bob's separate DM" } });
  expect(bob.status).toBeLessThan(300);
  const bobThread = bob.body.threadId;
  const input = { name: "Calendar brief", prompt: "Report from the chosen conversation.", botId, schedule: { type: "daily", time: "10:00", weekdays: [1] } };
  expect((await ws.as(ANA, "/api/routines", { method: "POST", body: { ...input, resultsThreadId: bobThread } })).status).toBe(404);
  const created = await ws.as(ANA, "/api/routines", { method: "POST", body: input });
  expect(created.status).toBe(201);
  expect(created.body.routine.conversation.requestedBy.name).toBe(ANA);
  expect(created.body.routine.conversation.threadId).not.toBe(bobThread);
  expect((await ws.as(BOB, "/api/routines")).body.routines.some((entry: any) => entry.id === created.body.routine.id)).toBe(false);
}, 30_000);
