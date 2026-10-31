// Groups and DMs between people, where people and bots work together. On a
// throwaway Shared workspace with three people and a stand-in engine: a group
// of two people and a bot, the bot answering in the group when mentioned, a
// DM between two people, and nobody else seeing any of it. Then a Local
// workspace, where its owner makes a group with their bots.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";
import { removeTempDir } from "../../testing/cleanup.ts";

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

test("the Chief creates and starts work in a group from a DM without copying private history or impersonating the person", async () => {
  const ws = await startSharedWorkspace([{ email: ADA, admin: true }, { email: CICI, admin: true }, { email: BOB }]);
  try {
  const chief = (await ws.as(ADA, "/api/bots", { method: "POST", body: { name: "Coordinator" } })).body.bot;
  const engineer = (await ws.as(ADA, "/api/bots", { method: "POST", body: { name: "Builder" } })).body.bot;
  expect(chief?.id).toBeTruthy();
  const role = (await ws.as(ADA, "/api/colonie/chief")).body;
  expect((await ws.as(ADA, "/api/colonie/chief", { method: "PUT", body: { botId: chief.id, expectedRevision: role.revision } })).status).toBe(200);
  let chiefThread = "";
  async function ask(text: string, person = ADA) {
    const sent = await ws.as(person, `/api/bots/${chief.id}/messages`, { method: "POST", body: { text } });
    expect(sent.status).toBe(202);
    const thread = sent.body.threadId;
    chiefThread = thread;
    const approved = new Set<string>();
    const result = await until(async () => {
      const messages = (await ws.as(person, `/api/threads/${thread}/messages`)).body.messages as Array<any>;
      const at = messages.findLastIndex((message) => message.role === "user" && message.text === text);
      for (const message of messages.slice(at + 1)) {
        const id = message.card?.requestId;
        if (id && !message.card.answered && !approved.has(id)) {
          approved.add(id);
          expect((await ws.as(person, `/api/threads/${thread}/respond`, { method: "POST", body: { behavior: "allow", requestId: id } })).status).toBe(200);
        }
      }
      return messages.slice(at + 1).find((message) => message.turnTerminal)?.text;
    }, (answer) => typeof answer === "string", "the Chief's tool result");
    return result as string;
  }
  await ask("PRIVATE_ONLY_CONTEXT: a personal note that must stay in this DM");
  const made = JSON.parse(await ask(`mcp call colonie_workspace create_group ${JSON.stringify({ name: "Visible project", botIds: [chief.id, engineer.id], requestId: "make-project" })}`));
  expect(made.state).toBe("created");
  const accepted = JSON.parse(await ask(`mcp call colonie_workspace send_group_message ${JSON.stringify({ groupId: made.groupId, message: `@${engineer.name} inspect this project and report here`, requestId: "start-project" })}`));
  expect(accepted.state).toBe("accepted");
  const messages = await until(async () => (await ws.as(ADA, `/api/conversations/${made.groupId}/messages`)).body.messages as Array<any>,
    (rows) => rows.some((message) => message.from?.botId === engineer.id && !message.working), "the Engineer's answer in the new group");
  expect(messages.find((message) => message.from?.botId === chief.id)).toMatchObject({ role: "bot", text: `@${engineer.name} inspect this project and report here` });
  expect(messages.some((message) => message.role === "user")).toBe(false);
  expect(JSON.stringify(messages)).not.toContain("PRIVATE_ONLY_CONTEXT");
  expect(messages.find((message) => message.from?.botId === engineer.id)?.workThread?.threadId).toBeTruthy();
  expect((await ws.as(CICI, `/api/conversations/${made.groupId}/messages`)).status).toBe(404);
  await ask(`mcp call colonie_workspace ask_bot ${JSON.stringify({ targetBotId: engineer.id, message: "PRIVATE_CONSULTATION_RESULT", requestId: "private-question" })}`);
  expect((await ws.as(ADA, `/api/colonie/chief?threadId=${chiefThread}`)).body.assignments).toHaveLength(1);
  expect((await ws.as(CICI, `/api/colonie/chief?threadId=${chiefThread}`)).status).toBe(404);
  expect((await ws.as(CICI, "/api/colonie/chief")).body.assignments).toEqual([]);
  await ask(`mcp call colonie_workspace ask_bot ${JSON.stringify({ targetBotId: engineer.id, message: "Bob's private question", requestId: "member-question" })}`, BOB);
  const memberWork = await ws.as(BOB, `/api/colonie/chief?threadId=${chiefThread}`);
  expect(memberWork.status).toBe(200);
  expect(memberWork.body.assignments).toHaveLength(1);
  expect(memberWork.body.assignments[0].message).toBe("Bob's private question");
  expect((await ws.as(BOB, "/api/colonie/chief")).status).toBe(403);
  expect((await ws.as(BOB, "/api/colonie/chief", { method: "PUT", body: { botId: engineer.id, expectedRevision: role.revision } })).status).toBe(403);
  expect((await ws.as(ADA, "/api/colonie/chief")).body.assignments.map((assignment: any) => assignment.message)).toEqual(["PRIVATE_CONSULTATION_RESULT"]);
  } finally { await ws.stop(); }
}, 90_000);

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

test("an admin can delete a group for every member; a member or outsider cannot", async () => {
  const made = await ws.as(ADA, "/api/conversations", { method: "POST", body: { kind: "group", name: "Temporary group", emails: [BOB], bots: [] } });
  expect(made.status).toBe(201);
  const id = made.body.id;
  await ws.as(BOB, `/api/conversations/${id}/messages`, { method: "POST", body: { text: "A private message" } });
  expect((await ws.as(BOB, `/api/conversations/${id}`, { method: "DELETE" })).status).toBe(403);
  expect((await ws.as(CICI, `/api/conversations/${id}`, { method: "DELETE" })).status).toBe(404);
  expect((await ws.as(ADA, `/api/conversations/${id}`, { method: "DELETE" })).status).toBe(200);
  expect((await ws.as(BOB, `/api/conversations/${id}/messages`)).status).toBe(404);
  expect((await ws.as(BOB, "/api/conversations")).body.conversations.map((item: any) => item.id)).not.toContain(id);
});

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
  // the tests below are about mentions; a lead answering what names no one has its own
  expect((await ws.as(ADA, `/api/conversations/${group.id}`, { method: "PATCH", body: { responder: { kind: "mentions" } } })).status).toBe(200);
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
    const made = await ws.as(ADA, "/api/bots", { method: "POST", body: { name: "Zephyrine", title: "Researcher" } });
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

  test("two bots in one message both answer, once each, without waiting for each other", async () => {
    const before = (await lines()).length;
    await ws.as(ADA, `/api/conversations/${crew.id}/messages`, { method: "POST", body: { text: `@${bot.name} @${second.name} plan the launch` } });
    const end = Date.now() + 40_000;
    let mine: any[] = [];
    while (Date.now() < end) {
      mine = (await lines()).slice(before).filter((message) => message.from && !message.notice && !message.relay);
      if ([bot.id, second.id].every((id) => mine.some((message) => message.from.botId === id && !message.working))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(mine.filter((message) => message.from.botId === bot.id)).toHaveLength(1);
    expect(mine.filter((message) => message.from.botId === second.id)).toHaveLength(1);
  }, 90_000);

  test("while one bot waits on a person, another bot answers, and a message to the busy bot says it is next", async () => {
    const before = (await lines()).length;
    await ws.as(ADA, `/api/conversations/${crew.id}/messages`, { method: "POST", body: { text: `@${bot.name} permission please` } });
    await until(lines, (list) => list.slice(before).some((message) => message.from?.botId === bot.id && /is waiting for/.test(message.text ?? "")), "the first bot waiting for Ada");
    await ws.as(ADA, `/api/conversations/${crew.id}/messages`, { method: "POST", body: { text: `@${bot.name} and after that, the budget` } });
    const queued = await until(lines, (list) => list.slice(before).some((message) => message.from?.botId === bot.id && message.working && !message.workingSince), "a next-in-line note from the busy bot");
    expect(queued.slice(before).find((message: any) => message.from?.botId === bot.id && message.working).text).toContain("this is next");
    await ws.as(ADA, `/api/conversations/${crew.id}/messages`, { method: "POST", body: { text: `@${second.name} are you free?` } });
    await until(lines, (list) => list.slice(before).some((message) => message.from?.botId === second.id && !message.working && !message.relay && /are you free/.test(message.text ?? "")),
      "the second bot answering while the first still waits");
    expect((await lines()).slice(before).some((message) => message.from?.botId === bot.id && /is waiting for/.test(message.text ?? ""))).toBe(true);
    await ws.as(ADA, `/api/conversations/${crew.id}/stop`, { method: "POST" });
    await until(lines, (list) => !list.some((message) => message.working), "Ada's waiting work stopped");
  }, 90_000);

  test("a bot's work in the group follows the bot's level, and an admin sets Full access from the app", async () => {
    const level = async () => (await ws.as(ADA, "/api/bots")).body.bots.find((entry: any) => entry.id === second.id);
    const workLevel = async () => (await level()).tasks.find((task: any) => task.forConversation === crew.id)?.approvalMode;
    expect((await ws.as(BOB, `/api/bots/${second.id}`, { method: "PATCH", body: { approvalMode: "full" } })).status).toBe(403);
    expect((await ws.as(ADA, `/api/bots/${second.id}`, { method: "PATCH", body: { approvalMode: "full" } })).status).toBe(200);
    expect((await level()).approvalMode).toBe("full");
    expect(await workLevel()).toBe("full");
    // back to Always ask: the group's existing work thread follows on the next request
    expect((await ws.as(ADA, `/api/bots/${second.id}`, { method: "PATCH", body: { approvalMode: "ask" } })).status).toBe(200);
    const before = (await lines()).length;
    await ws.as(ADA, `/api/conversations/${crew.id}/messages`, { method: "POST", body: { text: `@${second.name} level check` } });
    await until(lines, (list) => list.slice(before).some((message) => message.from?.botId === second.id && !message.working), "the bot's answer");
    expect(await workLevel()).toBe("ask");
    expect((await ws.as(ADA, `/api/bots/${second.id}`, { method: "PATCH", body: { approvalMode: "auto" } })).status).toBe(200);
  }, 90_000);

  test("@here asks every bot in the group and marks it for every person", async () => {
    await ws.as(BOB, `/api/conversations/${crew.id}/read`, { method: "POST" });
    const before = (await lines()).length;
    expect((await ws.as(ADA, `/api/conversations/${crew.id}/messages`, { method: "POST", body: { text: "@here quick check-in" } })).status).toBe(201);
    expect((await ws.as(BOB, "/api/conversations")).body.conversations.find((entry: any) => entry.id === crew.id)).toMatchObject({ mentioned: true });
    const end = Date.now() + 40_000;
    let mine: any[] = [];
    while (Date.now() < end) {
      mine = (await lines()).slice(before).filter((message) => message.from && !message.notice && !message.relay);
      if ([bot.id, second.id].every((id) => mine.some((message) => message.from.botId === id && !message.working))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(mine.filter((message) => message.from.botId === bot.id)).toHaveLength(1);
    expect(mine.filter((message) => message.from.botId === second.id)).toHaveLength(1);
    // "@hereafter" or an address is not @here
    const quiet = (await lines()).length;
    await ws.as(ADA, `/api/conversations/${crew.id}/messages`, { method: "POST", body: { text: "@hereafter, mail me at a@here.com" } });
    await new Promise((r) => setTimeout(r, 1_500));
    // it names no one, so at most the group's lead takes it, never every bot
    expect(new Set((await lines()).slice(quiet).filter((message) => message.from && !message.notice).map((message) => message.from.botId)).size).toBeLessThanOrEqual(1);
  }, 90_000);

  test("a message that names no one goes to the group's lead, which can be chosen; or to every bot; or to none", async () => {
    const desk = (await ws.as(ADA, "/api/conversations", { method: "POST", body: { kind: "group", name: "Desk", emails: [BOB], bots: [bot.id, second.id] } })).body;
    const deskLines = async () => (await ws.as(ADA, `/api/conversations/${desk.id}/messages`)).body.messages as Array<any>;
    const answersTo = async (text: string, from: string = ADA) => {
      const before = (await deskLines()).length;
      await ws.as(from, `/api/conversations/${desk.id}/messages`, { method: "POST", body: { text } });
      await new Promise((r) => setTimeout(r, 2_500));
      const end = Date.now() + 30_000;
      for (;;) {
        const fresh = (await deskLines()).slice(before).filter((message) => message.from && !message.notice && !message.relay);
        if (fresh.every((message) => !message.working) || Date.now() > end) return fresh.map((message) => message.from.botId).sort();
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    const chief = (await ws.as(ADA, "/api/bots")).body.bots.find((entry: any) => entry.chiefOfStaff)?.id ?? bot.id;
    const listed = (await ws.as(ADA, "/api/conversations")).body.conversations.find((entry: any) => entry.id === desk.id);
    expect(listed).toMatchObject({ responder: { kind: "lead" }, leadBotId: chief });
    expect(await answersTo("who is around today?")).toEqual([chief]);
    // naming only a person is for that person
    expect(await answersTo("@bob@x.com can you take this one?")).toEqual([]);
    const other = chief === bot.id ? second.id : bot.id;
    expect((await ws.as(BOB, `/api/conversations/${desk.id}`, { method: "PATCH", body: { responder: { kind: "lead", botId: other } } })).status).toBe(200);
    expect(await answersTo("and now?", BOB)).toEqual([other]);
    expect((await ws.as(ADA, `/api/conversations/${desk.id}`, { method: "PATCH", body: { responder: { kind: "everyone" } } })).status).toBe(200);
    expect(await answersTo("everyone, a quick status")).toEqual([bot.id, second.id].sort());
    expect((await ws.as(ADA, `/api/conversations/${desk.id}`, { method: "PATCH", body: { responder: { kind: "mentions" } } })).status).toBe(200);
    expect(await answersTo("just thinking out loud")).toEqual([]);
    expect((await ws.as(ADA, `/api/conversations/${desk.id}`, { method: "PATCH", body: { responder: { kind: "lead", botId: "nobody" } } })).status).toBe(400);
    expect((await deskLines()).filter((message) => message.notice).map((message) => message.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("lead this group"), expect.stringContaining("every bot here to answer"), expect.stringContaining("only when named"),
    ]));
  }, 150_000);

  test("one request that names no one gets done together: the lead does its part and hands the rest to another bot, and everyone gets the files", async () => {
    const team = (await ws.as(ADA, "/api/conversations", { method: "POST", body: { kind: "group", name: "Launch crew", emails: [BOB], bots: [bot.id, second.id] } })).body;
    const lead = (await ws.as(ADA, "/api/conversations")).body.conversations.find((entry: any) => entry.id === team.id).leadBotId;
    const helper = lead === bot.id ? second : bot;
    const teamLines = async () => (await ws.as(BOB, `/api/conversations/${team.id}/messages`)).body.messages as Array<any>;
    // Ada names no bot: the lead takes it, writes the plan, and asks the helper for the checklist
    await ws.as(ADA, `/api/conversations/${team.id}/messages`, { method: "POST", body: {
      text: `write file plan.md Launch on Friday at the hall then ask ${helper.name} to write file checklist.md Venue, catering, invitations` } });
    const done = await until(teamLines, (list) => {
      const answers = list.filter((message) => message.from && !message.notice && !message.relay);
      return answers.some((message) => message.from.botId === lead && !message.working && /Wrote plan\.md/.test(message.text))
        && answers.some((message) => message.from.botId === helper.id && !message.working && /Wrote checklist\.md/.test(message.text));
    }, "the lead's part and the helper's part, both in the group");
    const answers = done.filter((message: any) => message.from && !message.notice && !message.relay);
    // in that order, each once, and the helper was handed the lead's words, not Ada's
    expect(answers.map((message: any) => message.from.botId)).toEqual([lead, helper.id]);
    expect(answers[0].text).toContain(`@${helper.name} write file checklist.md`);
    // both files are in the group's project folder, for everyone here
    const files = (await ws.as(BOB, `/api/conversations/${team.id}/files`)).body.files.map((file: any) => file.path).sort();
    expect(files).toEqual(["checklist.md", "plan.md"]);
    const checklist = await ws.as(BOB, `/api/conversations/${team.id}/files/content?path=checklist.md`);
    expect(checklist.status).toBe(200);
    expect(checklist.body).toBe("Venue, catering, invitations");
  }, 120_000);

  test("a member removes a bot from a group; a removed lead gives way to the default", async () => {
    const room = (await ws.as(ADA, "/api/conversations", { method: "POST", body: { kind: "group", name: "Trim", emails: [BOB], bots: [bot.id, second.id] } })).body;
    expect((await ws.as(ADA, `/api/conversations/${room.id}`, { method: "PATCH", body: { responder: { kind: "lead", botId: second.id } } })).status).toBe(200);
    const removed = await ws.as(BOB, `/api/conversations/${room.id}/bots/${second.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ bots: [bot.id], responder: { kind: "lead" }, leadBotId: bot.id });
    expect((await ws.as(BOB, `/api/conversations/${room.id}/bots/${second.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await ws.as(CICI, `/api/conversations/${room.id}/bots/${bot.id}`, { method: "DELETE" })).status).toBe(404);
    const notices = (await ws.as(ADA, `/api/conversations/${room.id}/messages`)).body.messages.filter((message: any) => message.notice).map((message: any) => message.text);
    expect(notices).toContain(`bob@x.com removed ${second.name}.`);
  }, 30_000);

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

  test("the group's bots work in one project folder that its people can download from", async () => {
    // both bots already worked here in their own folders: each moves into the group's
    const answered = async (botId: string, text: string) => {
      await ws.as(ADA, `/api/conversations/${crew.id}/messages`, { method: "POST", body: { text } });
      return until(lines, (messages) => {
        const last = messages.filter((message) => message.from?.botId === botId && !message.relay).at(-1);
        return Boolean(last && !last.working && last.text.includes("Wrote"));
      }, "a bot writing a file");
    };
    await answered(bot.id, `@${bot.name} write file plan.md Launch plan`);
    await answered(second.id, `@${second.name} write file notes.md Notes from Quill`);
    const folder = join(ws.dataDir, "conversation-files", crew.id);
    expect(readFileSync(join(folder, "plan.md"), "utf8")).toBe("Launch plan");
    expect(readFileSync(join(folder, "notes.md"), "utf8")).toBe("Notes from Quill");
    const listed = await ws.as(BOB, `/api/conversations/${crew.id}/files`);
    expect(listed.status).toBe(200);
    expect(listed.body.files.map((file: any) => file.path).sort()).toEqual(["notes.md", "plan.md"]);
    const downloaded = await ws.as(BOB, `/api/conversations/${crew.id}/files/content?path=plan.md`);
    expect(downloaded).toEqual({ status: 200, body: "Launch plan" });
    // nobody outside the group, and nothing outside the folder
    expect((await ws.as(CICI, `/api/conversations/${crew.id}/files`)).status).toBe(404);
    expect((await ws.as(CICI, `/api/conversations/${crew.id}/files/content?path=plan.md`)).status).toBe(404);
    expect((await ws.as(BOB, `/api/conversations/${crew.id}/files/content?path=${encodeURIComponent("../group-conversations.json")}`)).status).toBe(404);
  }, 90_000);

  test("deleting the group deletes its project folder", async () => {
    const folder = join(ws.dataDir, "conversation-files", crew.id);
    expect(existsSync(folder)).toBe(true);
    expect((await ws.as(ADA, `/api/conversations/${crew.id}`, { method: "DELETE" })).status).toBe(200);
    expect(existsSync(folder)).toBe(false);
  }, 30_000);
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


test("a group continues across agent changes, including a return to a warm agent", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "colonie-group-agents-"));
  const instance = (driver: string) => ({ driver, displayName: driver, environment: { COLONIE_FAKE_STATE: join(stateDir, `${driver}.json`), COLONIE_FAKE_PROVIDER: driver === "claude-acp" ? "claude" : "codex" },
    config: { cli: process.execPath, args: ["--experimental-strip-types", join(import.meta.dirname, "../../acp/testing/fake-agent.ts")] } });
  const workspace = await startSharedWorkspace([{ email: ADA, admin: true }, { email: BOB }, { email: CICI }], {
    instances: { "codex-acp": instance("codex-acp"), "claude-acp": instance("claude-acp") },
  }).catch(async (error) => { await removeTempDir(stateDir); throw error; });
  try {
    const profile = (await workspace.as(ADA, "/api/bots")).body.bots[0];
    const made = await workspace.as(ADA, "/api/conversations", { method: "POST", body: { name: "Agent changes", emails: [BOB], bots: [profile.id] } });
    expect(made.status).toBe(201);
    const id = made.body.id;
    const ask = async (text: string) => {
      expect((await workspace.as(BOB, `/api/conversations/${id}/messages`, { method: "POST", body: { text } })).status).toBe(201);
      const end = Date.now() + 20_000;
      while (Date.now() < end) {
        const messages = (await workspace.as(BOB, `/api/conversations/${id}/messages`)).body.messages;
        const answer = messages.at(-1);
        if (answer?.from?.botId === profile.id && !answer.working) {
          expect(answer.text, workspace.log().slice(-1500)).not.toMatch(/could not/);
          return answer.text as string;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Group reply timed out: ${workspace.log().slice(-1500)}`);
    };
    const select = async (instanceId: string) => {
      const result = await workspace.as(ADA, `/api/bots/${profile.id}`, { method: "PATCH", body: { modelSelection: { instanceId, model: "agent-default" } } });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
    };
    await ask(`@${profile.name} the launch is Friday`);
    const worker = (await workspace.as(BOB, "/api/bots")).body.bots.find((entry: any) => entry.id === profile.id).tasks.find((task: any) => task.forConversation === id);
    const receipts = () => JSON.parse(readFileSync(join(workspace.dataDir, "acp-inputs", `${worker.threadId}.json`), "utf8")) as Array<{ instanceId: string; sessionId: string; prompt: Array<{ type: string; text?: string }> }>;
    const firstSession = receipts().at(-1)!.sessionId;
    await select("claude-acp");
    expect(await ask(`@${profile.name} what changed?`)).toContain("the launch is Friday");
    const switched = receipts().at(-1)!;
    expect(switched.instanceId).toBe("claude-acp");
    const after = (await workspace.as(ADA, "/api/bots")).body.bots.find((entry: any) => entry.id === profile.id);
    expect(after.threadId).toBe(profile.threadId);
    expect(after.messages).toEqual(profile.messages);
    expect((await workspace.as(CICI, `/api/conversations/${id}/messages`)).status).toBe(404);
    await ask(`@${profile.name} follow-up on the venue`);
    expect(receipts().at(-1)!.sessionId).toBe(switched.sessionId);
    expect(receipts().at(-1)!.prompt.map((block) => block.text ?? "").join("\n")).not.toContain("the launch is Friday");
    await select("codex-acp");
    expect(await ask(`@${profile.name} final plan?`)).toContain("follow-up on the venue");
    const returned = receipts().at(-1)!;
    expect(returned.instanceId).toBe("codex-acp");
    expect(returned.sessionId).not.toBe(firstSession);
    expect(returned.sessionId).not.toBe(switched.sessionId);
    await ask(`@${profile.name} thanks`);
    expect(receipts().at(-1)!.sessionId).toBe(returned.sessionId);
    const execution = (await workspace.as(BOB, `/api/threads/${worker.threadId}/messages`)).body.messages;
    expect(execution.filter((message: any) => message.role === "user").map((message: any) => message.text)).toEqual([
      `@${profile.name} the launch is Friday`, `@${profile.name} what changed?`, `@${profile.name} follow-up on the venue`, `@${profile.name} final plan?`, `@${profile.name} thanks`,
    ]);
  } finally { await workspace.stop(); await removeTempDir(stateDir); }
}, 90_000);
