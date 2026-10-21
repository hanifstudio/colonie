// A bot's activity and the decision log in a Shared workspace: each person
// sees tool runs and approvals from their own conversations only, an admin
// included. Step five of privacy by person.
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

// Both are admins: admins see every bot, never another person's conversation.
const ADA = "ada@x.com";
const BOB = "bob@x.com";

let ws: SharedWorkspace;
let botId: string;
let adaThread: string;
let bobThread: string;

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send a line that asks for a tool call, answer its card, wait for the turn. */
async function permissionTurn(email: string, text: string): Promise<string> {
  const sent = await ws.as(email, `/api/bots/${botId}/messages`, { method: "POST", body: { text } });
  if (sent.status !== 202) throw new Error(`send failed ${sent.status}: ${JSON.stringify(sent.body)}`);
  const threadId = sent.body.threadId as string;
  let requestId: string | undefined;
  const untilCard = Date.now() + 20_000;
  while (!requestId) {
    const messages = await ws.as(email, `/api/threads/${threadId}/messages`);
    requestId = messages.body.messages?.find((message: any) => message.card?.requestId)?.card.requestId;
    if (requestId) break;
    if (Date.now() > untilCard) throw new Error(`no card appeared:\n${ws.log().slice(-2000)}`);
    await settle(100);
  }
  const answered = await ws.as(email, `/api/threads/${threadId}/respond`, { method: "POST", body: { behavior: "allow", requestId } });
  if (answered.status !== 200) throw new Error(`answer failed ${answered.status}: ${JSON.stringify(answered.body)}`);
  const untilDone = Date.now() + 20_000;
  for (;;) {
    const bot = (await ws.as(email, "/api/bots")).body.bots.find((entry: any) => entry.id === botId);
    const task = bot?.tasks?.find((entry: any) => entry.threadId === threadId);
    if (task && !task.busy) return threadId;
    if (Date.now() > untilDone) throw new Error(`turn did not finish:\n${ws.log().slice(-2000)}`);
    await settle(100);
  }
}

beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: ADA, admin: true }, { email: BOB, admin: true }]);
  botId = (await ws.as(BOB, "/api/bots")).body.bots[0].id;
  adaThread = await permissionTurn(ADA, "permission ada-tool-marker");
  bobThread = await permissionTurn(BOB, "permission bob-tool-marker");
  // the decision log writes without waiting for the request to finish
  await settle(500);
}, 90_000);
afterAll(async () => { await ws?.stop(); });

test("a bot's activity lists only the person's own conversations", async () => {
  const bob = await ws.as(BOB, `/api/bots/${botId}/activity?limit=100`);
  expect(bob.status).toBe(200);
  expect(bob.body.rows.length).toBeGreaterThan(0);
  for (const row of bob.body.rows) expect(row.threadId).toBe(bobThread);
  expect(JSON.stringify(bob.body)).not.toContain(adaThread);

  const ada = await ws.as(ADA, `/api/bots/${botId}/activity?limit=100`);
  expect(ada.status).toBe(200);
  expect(ada.body.rows.length).toBeGreaterThan(0);
  for (const row of ada.body.rows) expect(row.threadId).toBe(adaThread);
  expect(JSON.stringify(ada.body)).not.toContain(bobThread);
});

test("the decision log lists only the person's own conversations, admins included", async () => {
  const bob = await ws.as(BOB, "/api/decisions?limit=100");
  expect(bob.status).toBe(200);
  expect(bob.body.decisions.length).toBeGreaterThan(0);
  for (const row of bob.body.decisions) expect(row.threadId).toBe(bobThread);
  expect(JSON.stringify(bob.body)).not.toContain(adaThread);

  const ada = await ws.as(ADA, "/api/decisions?limit=100");
  expect(ada.status).toBe(200);
  expect(ada.body.decisions.length).toBeGreaterThan(0);
  for (const row of ada.body.decisions) expect(row.threadId).toBe(adaThread);
  expect(JSON.stringify(ada.body)).not.toContain(bobThread);
});

test("the activity list carries only the person's own approvals", async () => {
  const bob = await ws.as(BOB, "/api/admin-activity?what=decisions");
  expect(bob.status).toBe(200);
  expect(bob.body.entries.length).toBeGreaterThan(0);
  for (const entry of bob.body.entries) expect(entry.threadId).toBe(bobThread);
  expect(JSON.stringify(bob.body)).not.toContain(adaThread);
});
