// Groups and DMs between people, where people and bots work together. On a
// throwaway Shared workspace with three people and a stand-in engine: a group
// of two people and a bot, the bot answering in the group when mentioned, a
// DM between two people, and nobody else seeing any of it. Then a Local
// workspace, where its owner makes a group with their bots.
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ADA = "ada@x.com"; // admin
const BOB = "bob@x.com";
const CICI = "cici@x.com";

let ws: SharedWorkspace;
let local: SharedWorkspace;
let bot: { id: string; name: string };
let group: { id: string; threadId: string };

beforeAll(async () => {
  [ws, local] = await Promise.all([
    startSharedWorkspace([{ email: ADA, admin: true }, { email: BOB }, { email: CICI }]),
    startSharedWorkspace([]),
  ]);
  bot = (await ws.as(ADA, "/api/bots")).body.bots[0];
}, 90_000);
afterAll(async () => { await ws?.stop(); await local?.stop(); });

const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> => {
  const end = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 400)}\n${ws.log().slice(-1500)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
const messagesOf = async (email: string) => (await ws.as(email, `/api/conversations/${group.id}/messages`)).body.messages as Array<any>;

test("a person makes a group with another person and a bot; both see it in their list", async () => {
  const people = await ws.as(BOB, "/api/people");
  expect(people.body.people.map((person: any) => person.email)).toEqual(expect.arrayContaining([ADA, BOB, CICI]));
  const made = await ws.as(ADA, "/api/conversations", { method: "POST", body: { kind: "group", name: "Launch", emails: [BOB], bots: [bot.id] } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  group = made.body;
  expect(made.body).toMatchObject({ kind: "group", title: "Launch", bots: [bot.id] });
  expect(made.body.people.map((person: any) => person.email)).toEqual([ADA, BOB]);
  const bobs = await ws.as(BOB, "/api/conversations");
  expect(bobs.body.conversations.map((entry: any) => entry.id)).toContain(group.id);
  // A line says what happened, and reaches every member's app as it is written.
  const first = (await messagesOf(BOB))[0];
  expect(first).toMatchObject({ notice: true, text: `ada@x.com made the group with bob@x.com, ${bot.name}.` });
});

test("@naming a person marks the conversation for them", async () => {
  await ws.as(ADA, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: "@bob@x.com can you check the budget?" } });
  const bobs = (await ws.as(BOB, "/api/conversations")).body.conversations.find((entry: any) => entry.id === group.id);
  expect(bobs).toMatchObject({ unread: true, mentioned: true });
  await ws.as(BOB, `/api/conversations/${group.id}/read`, { method: "POST" });
  expect((await ws.as(BOB, "/api/conversations")).body.conversations.find((entry: any) => entry.id === group.id).mentioned).toBe(false);
});

test("people write in it, and a bot answers there when mentioned", async () => {
  expect((await ws.as(BOB, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: "hi all, plan for Friday?" } })).status).toBe(201);
  const asked = await ws.as(ADA, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: `@${bot.name} please summarise the plan` } });
  expect(asked.status).toBe(201);
  const messages = await until(() => messagesOf(BOB), (list) => {
    const line = list.find((message) => message.from?.botId === bot.id);
    return Boolean(line && !/working on it/.test(line.text));
  }, "the bot's answer in the group");
  expect(messages.filter((message) => !message.notice).map((message) => message.sender?.name ?? message.from?.name)).toEqual(["ada@x.com", "bob@x.com", "ada@x.com", bot.name]);
  expect(messages.at(-1).text).not.toMatch(/could not/);
  // The bot's own work for this group is open to whoever asked it.
  const adaBots = await ws.as(ADA, "/api/bots");
  expect(adaBots.body.bots.find((entry: any) => entry.id === bot.id).tasks.map((task: any) => task.title)).toContain("Work for Launch");
  // marked as the group's, so it is not listed with the bot's own conversations
  expect(adaBots.body.bots.find((entry: any) => entry.id === bot.id).tasks.find((task: any) => task.title === "Work for Launch").forConversation).toBe(group.id);
});

test("someone not in the group sees nothing of it", async () => {
  expect((await ws.as(CICI, `/api/conversations/${group.id}/messages`)).status).toBe(404);
  expect((await ws.as(CICI, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: "let me in" } })).status).toBe(404);
  expect(JSON.stringify((await ws.as(CICI, "/api/conversations")).body)).not.toContain(group.id);
  expect((await ws.as(CICI, `/api/threads/${group.threadId}/messages`)).status).toBe(404);
});

test("two people have one DM between them, private to them", async () => {
  const made = await ws.as(BOB, "/api/conversations", { method: "POST", body: { kind: "dm", emails: [CICI] } });
  expect(made.status).toBe(201);
  expect(made.body).toMatchObject({ kind: "dm", title: CICI });
  const again = await ws.as(CICI, "/api/conversations", { method: "POST", body: { kind: "dm", emails: [BOB] } });
  expect(again.body.id).toBe(made.body.id);
  expect(again.body.title).toBe(BOB);
  await ws.as(BOB, `/api/conversations/${made.body.id}/messages`, { method: "POST", body: { text: "lunch?" } });
  const cicis = await ws.as(CICI, "/api/conversations");
  expect(cicis.body.conversations.find((entry: any) => entry.id === made.body.id).unread).toBe(true);
  expect((await ws.as(ADA, `/api/conversations/${made.body.id}/messages`)).status).toBe(404);
});

test("only people of the workspace can be added, and a person can leave", async () => {
  const outsider = await ws.as(ADA, `/api/conversations/${group.id}/members`, { method: "POST", body: { emails: ["mallory@evil.example"] } });
  expect(outsider.status).toBe(400);
  expect((await ws.as(BOB, `/api/conversations/${group.id}/members/me`, { method: "DELETE" })).status).toBe(200);
  expect((await ws.as(BOB, `/api/conversations/${group.id}/messages`)).status).toBe(404);
});

test("on a Local workspace its owner makes a group with their bots", async () => {
  const localBot = ((await (await fetch(`${local.url}/api/bots`)).json()) as { bots: Array<{ id: string }> }).bots[0]!;
  const made = await fetch(`${local.url}/api/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "group", name: "My team", bots: [localBot.id] }) });
  expect(made.status).toBe(201);
  const list = await (await fetch(`${local.url}/api/conversations`)).json() as { conversations: Array<{ title: string }> };
  expect(list.conversations.map((entry: any) => entry.title)).toEqual(["My team"]);
});

test("a bot that stops for a person in a group says so there, with the way to its work, then answers", async () => {
  const bot = (await ws.as(ADA, "/api/bots")).body.bots[0];
  await ws.as(ADA, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: `@${bot.name} permission please` } });
  const waitingLine = async () => (await messagesOf(ADA)).filter((message) => message.from?.botId === bot.id).at(-1);
  const until = Date.now() + 20_000;
  let line: any;
  while (Date.now() < until) {
    line = await waitingLine();
    if (line?.workThread) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  expect(line.text).toMatch(/needs .* for an OK before it can go on/);
  const work = line.workThread.threadId;
  // the card is in the bot's work, where the person who asked answers it
  const card = (await ws.as(ADA, `/api/threads/${work}/messages`)).body.messages.find((message: any) => message.card?.requestId && !message.card.answered);
  expect(card).toBeTruthy();
  expect((await ws.as(ADA, `/api/threads/${work}/respond`, { method: "POST", body: { behavior: "allow", requestId: card.card.requestId } })).status).toBe(200);
  const answered = Date.now() + 20_000;
  while (Date.now() < answered) {
    line = (await messagesOf(ADA)).find((message) => message.id === line.id);
    if (!line.workThread) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  expect(line.workThread).toBeUndefined();
  expect(line.text).not.toMatch(/needs .* before it can go on|working on it/);
}, 60_000);

test("a second mention while the bot is busy gets its own answer; no line is left working", async () => {
  const bot = (await ws.as(ADA, "/api/bots")).body.bots[0];
  await ws.as(ADA, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: `@${bot.name} permission again` } });
  const lines = async () => (await messagesOf(ADA)).filter((message) => message.from?.botId === bot.id);
  let first: any;
  const asked = Date.now() + 20_000;
  while (Date.now() < asked) { first = (await lines()).at(-1); if (first?.workThread) break; await new Promise((r) => setTimeout(r, 150)); }
  await ws.as(ADA, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: `@${bot.name} and one more thing` } });
  await new Promise((r) => setTimeout(r, 500));
  const second = (await lines()).at(-1);
  expect(second.id).not.toBe(first.id);
  const work = first.workThread.threadId;
  const card = (await ws.as(ADA, `/api/threads/${work}/messages`)).body.messages.find((message: any) => message.card?.requestId && !message.card.answered);
  await ws.as(ADA, `/api/threads/${work}/respond`, { method: "POST", body: { behavior: "allow", requestId: card.card.requestId } });
  // the stand-in's answer echoes recent messages, so compare whole lines
  const stillWaiting = (text: string) => text === `${bot.name} is working on it…` || /^\S+ needs \S+ for an OK before it can go on\.$/.test(text);
  const done = Date.now() + 30_000;
  let texts: string[] = [];
  while (Date.now() < done) {
    const now = await lines();
    texts = [first.id, second.id].map((id) => now.find((message) => message.id === id)?.text ?? "");
    if (!texts.some(stillWaiting)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(texts.some(stillWaiting)).toBe(false);
}, 90_000);
