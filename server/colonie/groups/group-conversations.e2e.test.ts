// Groups and DMs between people, where people and bots work together. On a
// throwaway Shared workspace with three people and a stand-in engine: a group
// of two people and a bot, the bot answering in the group when mentioned, a
// DM between two people, and nobody else seeing any of it. Then a Local
// workspace, where its owner makes a group with their bots.
import { afterAll, beforeAll, describe, expect, test } from "vitest";

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
  const personalBefore = (await ws.as(ADA, "/api/bots")).body.bots.find((entry: any) => entry.id === bot.id);
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
  const personalAfter = adaBots.body.bots.find((entry: any) => entry.id === bot.id);
  expect(personalAfter.threadId).toBe(personalBefore.threadId);
  expect(personalAfter.messages).toEqual(personalBefore.messages);
  expect(adaBots.body.bots.find((entry: any) => entry.id === bot.id).tasks.map((task: any) => task.title)).toContain("Work for Launch");
  // marked as the group's, so it is not listed with the bot's own conversations
  expect(adaBots.body.bots.find((entry: any) => entry.id === bot.id).tasks.find((task: any) => task.title === "Work for Launch").forConversation).toBe(group.id);
  const worker = personalAfter.tasks.find((task: any) => task.forConversation === group.id);
  const execution = (await ws.as(ADA, `/api/threads/${worker.threadId}/messages`)).body.messages;
  expect(execution.findLast((message: any) => message.role === "user").text).toBe(`@${bot.name} please summarise the plan`);
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

test("a bot that stops for a person in a group asks them there, and carries on once they answer", async () => {
  const bot = (await ws.as(ADA, "/api/bots")).body.bots[0];
  // Bob left in an earlier test; he is back for these
  await ws.as(ADA, `/api/conversations/${group.id}/members`, { method: "POST", body: { emails: [BOB] } });
  await ws.as(BOB, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: `@${bot.name} Bob's group context` } });
  await until(() => messagesOf(BOB), (messages) => {
    const line = messages.filter((message) => message.from?.botId === bot.id && !message.relay).at(-1);
    return Boolean(line && !line.working && line.text.includes("Bob's group context"));
  }, "Bob's group answer before Ana's approval");
  await ws.as(ADA, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: `@${bot.name} permission please` } });
  const find = async () => (await messagesOf(ADA)).find((message) => message.relay && message.card?.requestId && !message.card.answered);
  let card: any;
  const deadline = Date.now() + 20_000;
  while (!card && Date.now() < deadline) { card = await find(); if (!card) await new Promise((r) => setTimeout(r, 150)); }
  // the card is in the group, for the person who asked; the line says who it waits for
  expect(card.relay.askedBy).toBeTruthy();
  expect(card.from.botId).toBe(bot.id);
  const waitingLine = (await messagesOf(ADA)).filter((message) => message.from?.botId === bot.id && !message.relay).at(-1);
  expect(waitingLine.text).toMatch(/is waiting for .+ \(an OK\)\./);
  // the others in the group see the card too
  expect((await messagesOf(BOB)).some((message) => message.id === card.id)).toBe(true);
  expect((await ws.as(BOB, `/api/threads/${card.relay.threadId}/respond`, { method: "POST", body: { behavior: "allow", requestId: card.card.requestId } })).status).toBe(403);
  // answered from the group, against the bot's own work
  expect((await ws.as(ADA, `/api/threads/${card.relay.threadId}/respond`, { method: "POST", body: { behavior: "allow", requestId: card.card.requestId } })).status).toBe(200);
  let line: any;
  const answered = Date.now() + 20_000;
  while (Date.now() < answered) {
    line = (await messagesOf(ADA)).find((message) => message.id === waitingLine.id);
    if (!line.working && !/is waiting for/.test(line.text)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  expect(line.text).not.toMatch(/is waiting for|working on it/);
  expect((await messagesOf(ADA)).find((message) => message.id === card.id).card.answered).toBeTruthy();
}, 60_000);

test("a second mention hands the bot only what was said since it last spoke", async () => {
  const bot = (await ws.as(ADA, "/api/bots")).body.bots[0];
  await ws.as(BOB, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: "the venue moved to Friday" } });
  await ws.as(ADA, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: `@${bot.name} what changed?` } });
  let answer: any;
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    answer = (await messagesOf(ADA)).filter((message) => message.from?.botId === bot.id && !message.relay).at(-1);
    if (answer && !answer.working && /what changed/.test(answer.text)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  // the stand-in answers with what it was handed
  expect(answer.text).toContain("Said since you last spoke:");
  expect(answer.text).toContain("the venue moved to Friday");
  expect(answer.text).not.toContain("plan for Friday?");
}, 60_000);

describe("a group with several bots", () => {
  let second: { id: string; name: string };
  let crew: { id: string; threadId: string };
  const lines = async () => (await ws.as(ADA, `/api/conversations/${crew.id}/messages`)).body.messages as Array<any>;
  const settled = async (count: number, ms = 30_000) => {
    const end = Date.now() + ms;
    let found: any[] = [];
    while (Date.now() < end) {
      found = (await lines()).filter((message) => message.from && !message.notice && !message.relay);
      if (found.length >= count && found.every((message) => !message.working)) return found;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`bots did not settle: ${JSON.stringify(found.map((m) => [m.from?.name, m.working, (m.text ?? "").slice(0, 60)]))}`);
  };

  beforeAll(async () => {
    const made = await ws.as(ADA, "/api/bots", { method: "POST", body: { name: "Quill", title: "Researcher" } });
    second = made.body.bot ?? made.body;
    const first = (await ws.as(ADA, "/api/bots")).body.bots.find((entry: any) => entry.id !== second.id);
    bot = { id: first.id, name: first.name };
    crew = (await ws.as(ADA, "/api/conversations", { method: "POST", body: { kind: "group", name: "Crew", emails: [BOB], bots: [bot.id, second.id] } })).body;
    await ws.as(ADA, `/api/conversations/${crew.id}`, { method: "PATCH", body: { instructions: "Answer in Indonesian." } });
  }, 60_000);

  test("each bot is told who is here, the other bots and their roles, and the group's instructions", async () => {
    await ws.as(ADA, `/api/conversations/${crew.id}/messages`, { method: "POST", body: { text: `@${second.name} hello` } });
    const [answer] = await settled(1);
    // the stand-in answers with what it was handed
    expect(answer.text).toContain('This is the group "Crew".');
    expect(answer.text).toContain(`${bot.name}`);
    expect(answer.text).toContain(`${second.name} (you)`);
    expect(answer.text).toContain("Instructions for this group:");
    expect(answer.text).toContain("Answer in Indonesian.");
  }, 60_000);

  test("two bots in one message answer in turn, the second seeing the first's answer", async () => {
    const before = (await lines()).length;
    await ws.as(ADA, `/api/conversations/${crew.id}/messages`, { method: "POST", body: { text: `@${bot.name} @${second.name} plan the launch` } });
    const end = Date.now() + 40_000;
    let mine: any[] = [];
    while (Date.now() < end) {
      mine = (await lines()).slice(before).filter((message) => message.from && !message.notice);
      const firstDone = mine.find((message) => message.from.botId === bot.id && !message.working);
      const secondDone = mine.find((message) => message.from.botId === second.id && !message.working);
      if (firstDone && secondDone) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const firstAnswer = mine.find((message) => message.from.botId === bot.id);
    const secondAnswer = mine.find((message) => message.from.botId === second.id);
    expect(mine.indexOf(firstAnswer)).toBeLessThan(mine.indexOf(secondAnswer));
    // the second was handed what the first said
    expect(secondAnswer.text).toContain(`${bot.name}: `);
    // asked once by the message, not again because the first named it
    expect(mine.filter((message) => message.from.botId === second.id && message.from && !message.relay)).toHaveLength(1);
  }, 90_000);

  test("a bot that @mentions another bot hands it on, and the chain stops after three", async () => {
    const before = (await lines()).length;
    // the stand-in answers "hand over to <name>" with "@<name> over to you"
    await ws.as(ADA, `/api/conversations/${crew.id}/messages`, { method: "POST", body: { text: `@${bot.name} hand over to ${second.name}` } });
    const end = Date.now() + 60_000;
    let mine: any[] = [];
    while (Date.now() < end) {
      mine = (await lines()).slice(before).filter((message) => message.from && !message.notice && !message.relay);
      if (mine.length >= 2 && mine.every((message) => !message.working)) {
        await new Promise((r) => setTimeout(r, 2000));
        const again = (await lines()).slice(before).filter((message) => message.from && !message.notice && !message.relay);
        if (again.length === mine.length && again.every((message) => !message.working)) break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(mine[0].from.botId).toBe(bot.id);
    expect(mine[0].text).toBe(`@${second.name} over to you`);
    const handed = mine.find((message) => message.from.botId === second.id);
    expect(handed.text).toContain(`${bot.name} (a bot) asked you, for`);
    // the stand-in echoes every mention back, so it would go on: one ask and three hand-offs at most
    expect(mine.length).toBeLessThanOrEqual(4);
  }, 120_000);
});

test("a member stops only their own group work while the bot's personal chat stays unchanged", async () => {
  const made = await ws.as(BOB, "/api/conversations", { method: "POST", body: { name: "Stop here", emails: [ADA], bots: [bot.id] } });
  expect(made.status).toBe(201);
  const id = made.body.id;
  const before = (await ws.as(BOB, "/api/bots")).body.bots.find((entry: any) => entry.id === bot.id);
  await ws.as(BOB, `/api/conversations/${id}/messages`, { method: "POST", body: { text: `@${bot.name} permission please` } });
  await until(async () => (await ws.as(BOB, `/api/conversations/${id}/messages`)).body.messages as any[],
    (messages) => messages.some((message) => message.relay && message.card?.requestId), "the group's approval before stopping");
  expect((await ws.as(ADA, `/api/conversations/${id}/stop`, { method: "POST" })).body).toEqual({ stopped: 0 });
  expect((await ws.as(BOB, `/api/conversations/${id}/stop`, { method: "POST" })).body).toEqual({ stopped: 1 });
  const messages = (await ws.as(BOB, `/api/conversations/${id}/messages`)).body.messages;
  expect(messages.some((message: any) => message.text === "Stopped by the person who asked.")).toBe(true);
  expect((await ws.as(BOB, "/api/conversations")).body.conversations.find((entry: any) => entry.id === id).canStop).toBe(false);
  const after = (await ws.as(BOB, "/api/bots")).body.bots.find((entry: any) => entry.id === bot.id);
  expect(after.threadId).toBe(before.threadId);
  expect(after.messages).toEqual(before.messages);
}, 60_000);
