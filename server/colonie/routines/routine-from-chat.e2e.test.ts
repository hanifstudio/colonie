// A person asks a bot in chat for scheduled work, and the bot schedules it:
// the engine calls schedule_routine on the workspace tools, the routine is
// made for that bot, and the conversation shows it with an Undo. Driven on a
// throwaway Shared workspace whose stand-in engine calls a tool when a
// message says "mcp call <server> <tool> <json>".
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ANA = "ana@x.com";
let ws: SharedWorkspace;
let botId: string;

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: ANA, admin: true }]);
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

  // the engine asks before using a tool (the stand-in always does); the
  // person allows it in the conversation
  let requestId = "";
  const asked = Date.now() + 20_000;
  while (!requestId && Date.now() < asked) {
    const messages = (await ws.as(ANA, `/api/threads/${threadId}/messages`)).body.messages ?? [];
    requestId = messages.find((message: any) => message.card?.requestId && !message.card?.routineRequest)?.card.requestId ?? "";
    if (!requestId) await settle(100);
  }
  expect(requestId).not.toBe("");
  expect((await ws.as(ANA, `/api/threads/${threadId}/respond`, { method: "POST", body: { behavior: "allow", requestId } })).status).toBe(200);

  let routine: any;
  const until = Date.now() + 30_000;
  while (!routine && Date.now() < until) {
    routine = (await ws.as(ANA, "/api/routines")).body.routines?.find((entry: any) => entry.name === "Morning news");
    if (!routine) await settle(200);
  }
  if (!routine) throw new Error(`no routine was made:\n${JSON.stringify((await ws.as(ANA, `/api/threads/${threadId}/messages`)).body.messages?.map((m: any) => m.text ?? m.card?.title)).slice(0, 1500)}\n${ws.log().slice(-3000)}`);
  expect(routine).toMatchObject({ botId, enabled: true, schedule: { type: "daily", time: "08:00", weekdays: [1, 2, 3, 4, 5] } });
  expect(routine.nextRunAt).toBeGreaterThan(Date.now());

  const messages = (await ws.as(ANA, `/api/threads/${threadId}/messages`)).body.messages ?? [];
  const receipt = messages.find((message: any) => message.card?.routineRequest);
  expect(receipt?.card).toMatchObject({ autoApplied: true });
  // the engine was told it applied, so it can say so honestly
  expect(JSON.stringify(messages)).toMatch(/applied/);
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
  await ws.as(ANA, `/api/bots/${botId}/messages`, { method: "POST", body: { threadId: workThread, text: `mcp call colonie_workspace schedule_routine ${JSON.stringify({
    name: "Launch check", instructions: "Say how the launch is going.", requestId: "group-1", schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] },
  })}` } });
  let requestId = "";
  const asked = Date.now() + 20_000;
  while (!requestId && Date.now() < asked) {
    const messages = (await ws.as(ANA, `/api/threads/${workThread}/messages`)).body.messages ?? [];
    requestId = messages.find((message: any) => message.card?.requestId && !message.card?.routineRequest && !message.card?.answered)?.card.requestId ?? "";
    if (!requestId) await settle(100);
  }
  await ws.as(ANA, `/api/threads/${workThread}/respond`, { method: "POST", body: { behavior: "allow", requestId } });
  let routine: any;
  const until = Date.now() + 20_000;
  while (!routine && Date.now() < until) {
    routine = (await ws.as(ANA, "/api/routines")).body.routines?.find((entry: any) => entry.name === "Launch check");
    if (!routine) await settle(200);
  }
  expect(routine).toBeTruthy();

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
}, 120_000);
