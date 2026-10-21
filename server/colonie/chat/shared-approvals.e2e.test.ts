// Approval cards in a Shared workspace: only the people in a conversation may
// answer the cards a bot raises there, an admin included (step seven of
// privacy by person). No change was needed for it: every respond route already
// resolves the conversation through the person (step three), and the engine
// looks a request up within that conversation only. This guards it. The
// fixture engine raises a permission card when a message says "permission".
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ADA = "ada@x.com"; // member
const BOB = "bob@x.com"; // admin

let ws: SharedWorkspace;
let botId: string;
let adaThread: string;
let requestId: string;

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingCard = async () => (await ws.as(ADA, `/api/threads/${adaThread}/messages`)).body.messages
  ?.find((message: any) => message.card?.requestId === requestId)?.card;

beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: ADA }, { email: BOB, admin: true }]);
  botId = (await ws.as(BOB, "/api/bots")).body.bots[0].id;
  await ws.as(BOB, `/api/bots/${botId}/messages`, { method: "POST", body: { text: "bob says hello" } });
  const sent = await ws.as(ADA, `/api/bots/${botId}/messages`, { method: "POST", body: { text: "permission please" } });
  adaThread = sent.body.threadId;
  const until = Date.now() + 20_000;
  while (!requestId) {
    const messages = (await ws.as(ADA, `/api/threads/${adaThread}/messages`)).body.messages ?? [];
    requestId = messages.find((message: any) => message.card?.requestId)?.card.requestId;
    if (requestId) break;
    if (Date.now() > until) throw new Error(`no card appeared:\n${ws.log().slice(-2000)}`);
    await settle(100);
  }
}, 90_000);
afterAll(async () => { await ws?.stop(); });

test("another person cannot answer the card, by any route, even as an admin", async () => {
  const byThread = await ws.as(BOB, `/api/threads/${adaThread}/respond`, { method: "POST", body: { behavior: "allow", requestId } });
  expect(byThread.status).toBe(404);
  const byBotNamed = await ws.as(BOB, `/api/bots/${botId}/respond`, { method: "POST", body: { behavior: "allow", requestId, threadId: adaThread } });
  expect(byBotNamed.status).toBe(404);
  const byBotUnnamed = await ws.as(BOB, `/api/bots/${botId}/respond`, { method: "POST", body: { behavior: "allow", requestId } });
  // Naming no thread looks the request up in Bob's own conversation, where it
  // does not exist: answered as unavailable, as on a Local workspace, and
  // nothing reaches Ada's.
  expect(byBotUnnamed.status === 200 ? byBotUnnamed.body.outcome : "refused").toMatch(/unavailable|refused/);
  await settle(1000);
  expect((await pendingCard())?.answered).toBeFalsy();
  const always = await ws.as(BOB, `/api/bots/${botId}/always-allow`, { method: "POST", body: { allowKey: "anything", threadId: adaThread } });
  expect(always.status).toBe(404);
  const card = await pendingCard();
  expect(card?.answered).toBeFalsy();
});

test("the person in the conversation answers it", async () => {
  const answered = await ws.as(ADA, `/api/threads/${adaThread}/respond`, { method: "POST", body: { behavior: "allow", requestId } });
  expect(answered.status).toBe(200);
  const until = Date.now() + 10_000;
  while (!(await pendingCard())?.answered && Date.now() < until) await settle(100);
  expect((await pendingCard())?.answered).toBeTruthy();
});
