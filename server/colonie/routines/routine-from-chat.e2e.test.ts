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
