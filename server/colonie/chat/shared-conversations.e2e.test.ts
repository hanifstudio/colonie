// Two people in one Shared workspace, talking to the same bot. Each person's
// conversation is their own: the first message opens it, later messages
// continue it, and the other person — an admin included — cannot see, open,
// switch to, or post into it. Step three of privacy by person.
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ADA = "ada@x.com"; // admin
const BOB = "bob@x.com"; // member

let ws: SharedWorkspace;
let botId: string;

beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: ADA, admin: true }, { email: BOB }]);
  const bots = await ws.as(ADA, "/api/bots");
  botId = bots.body.bots[0].id;
}, 60_000);
afterAll(async () => { await ws?.stop(); });

const send = (email: string, text: string, threadId?: string) =>
  ws.as(email, `/api/bots/${botId}/messages`, { method: "POST", body: { text, ...(threadId ? { threadId } : {}) } });
const botFor = async (email: string) => (await ws.as(email, "/api/bots")).body.bots.find((bot: any) => bot.id === botId);

let adaThread: string;
let bobThread: string;

test("a person's first message opens a conversation of their own", async () => {
  const before = await botFor(ADA);
  const sent = await send(ADA, "ada-secret-1");
  expect(sent.status, ws.log().slice(-2000)).toBe(202);
  adaThread = sent.body.threadId;
  expect(adaThread).not.toBe(before.threadId);

  const bob = await send(BOB, "bob-secret-1");
  expect(bob.status).toBe(202);
  bobThread = bob.body.threadId;
  expect(bobThread).not.toBe(adaThread);
});

test("the next message continues the same conversation", async () => {
  expect((await send(ADA, "ada-secret-2")).body.threadId).toBe(adaThread);
  expect((await send(BOB, "bob-secret-2")).body.threadId).toBe(bobThread);
});

test("the bot list shows each person only their own conversation", async () => {
  const ada = await ws.as(ADA, "/api/bots");
  const bob = await ws.as(BOB, "/api/bots");
  const adaText = JSON.stringify(ada.body);
  const bobText = JSON.stringify(bob.body);
  expect(adaText).toContain("ada-secret-1");
  expect(adaText).not.toContain("bob-secret");
  expect(adaText).not.toContain(bobThread);
  expect(bobText).toContain("bob-secret-1");
  expect(bobText).not.toContain("ada-secret");
  expect(bobText).not.toContain(adaThread);
  expect(ada.body.bots.find((bot: any) => bot.id === botId).threadId).toBe(adaThread);
  expect(bob.body.bots.find((bot: any) => bot.id === botId).threadId).toBe(bobThread);
});

test("another person's conversation cannot be read, even by an admin", async () => {
  expect((await ws.as(BOB, `/api/threads/${adaThread}/messages`)).status).toBe(404);
  expect((await ws.as(ADA, `/api/threads/${bobThread}/messages`)).status).toBe(404);
});

test("another person's conversation cannot be switched to", async () => {
  const switched = await ws.as(BOB, `/api/bots/${botId}/tasks/${adaThread}`, { method: "POST" });
  expect(switched.status).toBe(404);
  expect(JSON.stringify(switched.body)).not.toContain("ada-secret");
  // and switching does not change what the owner of that thread sees
  expect((await botFor(ADA)).threadId).toBe(adaThread);
});

test("another person's conversation cannot be posted into", async () => {
  const intruded = await send(BOB, "bob-intrudes", adaThread);
  expect(intruded.status).toBe(404);
  const adas = await ws.as(ADA, `/api/threads/${adaThread}/messages`);
  expect(JSON.stringify(adas.body)).not.toContain("bob-intrudes");
});
