// Acting on a conversation in a Shared workspace: compact, edit, switch branch,
// answer a card, read the engine inputs, cancel a queued message, stop. A
// person who names no thread acts on their own conversation; a person who
// names someone else's thread, or a message in it, gets "not found" and
// changes nothing there. This holds while the bot's shared current thread
// points at the other person's conversation, which is exactly when a route
// that falls back to it would act on the wrong one. Step three, second half.
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ADA = "ada@x.com"; // member
const BOB = "bob@x.com"; // admin: even an admin may not touch Ada's conversation

let ws: SharedWorkspace;
let botId: string;
let adaThread: string;
let adaMessageId: string;
let bobThread: string;

const adaMessages = async () => JSON.stringify((await ws.as(ADA, `/api/threads/${adaThread}/messages`)).body);

beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: ADA }, { email: BOB, admin: true }]);
  botId = (await ws.as(ADA, "/api/bots")).body.bots[0].id;
  // Ada opens a new conversation the way the app does; that also moves the
  // bot's shared current thread to hers.
  const created = await ws.as(ADA, `/api/bots/${botId}/tasks`, { method: "POST", body: { title: "Ada's work" } });
  expect(created.status, ws.log().slice(-2000)).toBeLessThan(300);
  adaThread = created.body.task?.threadId ?? created.body.bot?.threadId;
  const sent = await ws.as(ADA, `/api/bots/${botId}/messages`, { method: "POST", body: { text: "ada-secret-1", threadId: adaThread } });
  expect(sent.status).toBe(202);
  adaMessageId = sent.body.message.id;
  // Wait for the bot's answer to Ada, so her turn's engine inputs exist before
  // anyone else acts: a route that falls back to the wrong thread then has
  // something of hers to show.
  const until = Date.now() + 20_000;
  while (!/"role":"bot"/.test(await adaMessages())) {
    if (Date.now() > until) throw new Error(`the bot never answered Ada:\n${ws.log().slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const bob = await ws.as(BOB, `/api/bots/${botId}/messages`, { method: "POST", body: { text: "bob-hello" } });
  expect(bob.status).toBe(202);
  bobThread = bob.body.threadId;
  expect(bobThread).not.toBe(adaThread);
}, 90_000);
afterAll(async () => { await ws?.stop(); });

const bot = (path: string) => `/api/bots/${botId}${path}`;

test("naming someone else's conversation is not found, on every action", async () => {
  const before = await adaMessages();
  const attempts: Array<[string, string, unknown]> = [
    ["POST", bot("/compact"), { threadId: adaThread }],
    ["POST", bot(`/messages/${adaMessageId}/edit`), { threadId: adaThread, text: "bob-edits" }],
    ["POST", bot("/active-branch"), { threadId: adaThread, messageId: adaMessageId }],
    ["DELETE", bot("/queue/q-anything"), { threadId: adaThread }],
    ["POST", bot("/interrupt"), { threadId: adaThread, expectedThreadId: adaThread }],
  ];
  for (const [method, path, body] of attempts) {
    const answer = await ws.as(BOB, path, { method, body });
    expect(answer.status, `${method} ${path}`).toBe(404);
    expect(JSON.stringify(answer.body), `${method} ${path}`).not.toContain("ada-secret");
  }
  expect((await ws.as(BOB, bot(`/acp-inputs?threadId=${adaThread}`))).status).toBe(404);
  expect(await adaMessages()).toBe(before);
});

test("a message in someone else's conversation cannot be edited, branched to, or answered", async () => {
  const before = await adaMessages();
  const edit = await ws.as(BOB, bot(`/messages/${adaMessageId}/edit`), { method: "POST", body: { text: "bob-edits" } });
  expect(edit.status).toBeGreaterThanOrEqual(400);
  const branch = await ws.as(BOB, bot("/active-branch"), { method: "POST", body: { messageId: adaMessageId } });
  expect(branch.status).toBeGreaterThanOrEqual(400);
  const card = await ws.as(BOB, bot(`/cards/${adaMessageId}`), { method: "PATCH", body: { dismissed: true } });
  expect(card.status).toBeGreaterThanOrEqual(400);
  expect(await adaMessages()).toBe(before);
});

test("an action that names no thread acts on the person's own conversation", async () => {
  // Bob's engine inputs are his own conversation's, never Ada's.
  const inputs = await ws.as(BOB, bot("/acp-inputs"));
  expect(inputs.status).toBe(200);
  expect(JSON.stringify(inputs.body)).not.toContain(adaThread);
  for (const receipt of inputs.body.receipts) expect(receipt.threadId).toBe(bobThread);

  // Compacting and stopping need no thread name: there is no ambiguity, the
  // person's own conversation is meant.
  for (const path of ["/compact", "/interrupt"]) {
    const answer = await ws.as(BOB, bot(path), { method: "POST", body: {} });
    expect(JSON.stringify(answer.body), path).not.toContain(adaThread);
    expect(JSON.stringify(answer.body), path).not.toContain("more than one thread");
    if (answer.body?.threadId) expect(answer.body.threadId, path).toBe(bobThread);
  }
});

test("the owner of the conversation still acts on it normally", async () => {
  const compact = await ws.as(ADA, bot("/compact"), { method: "POST", body: { threadId: adaThread } });
  expect(compact.status).not.toBe(404);
});
