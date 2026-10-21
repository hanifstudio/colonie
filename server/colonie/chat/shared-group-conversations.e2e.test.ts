// Conversations with several people in a Shared workspace. Someone in a
// conversation adds another person of the workspace; from then on both see
// it, write in it, and the bot answers both. Nobody else sees it, an admin
// included, and only people of the workspace can be added.
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ADA = "ada@x.com"; // admin
const BOB = "bob@x.com"; // member
const CICI = "cici@x.com"; // member, never added

let ws: SharedWorkspace;
let botId: string;
let thread: string;

beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: ADA, admin: true }, { email: BOB }, { email: CICI }]);
  botId = (await ws.as(ADA, "/api/bots")).body.bots[0].id;
  const sent = await ws.as(ADA, `/api/bots/${botId}/messages`, { method: "POST", body: { text: "plan the launch together" } });
  thread = sent.body.threadId;
}, 60_000);
afterAll(async () => { await ws?.stop(); });

const people = (email: string) => ws.as(email, `/api/threads/${thread}/people`);

test("a conversation starts with the person who opened it", async () => {
  const list = await people(ADA);
  expect(list.status).toBe(200);
  expect(list.body.people).toEqual([{ email: ADA, name: ADA, you: true }]);
});

test("they add another person of the workspace, who then sees and writes in it", async () => {
  const added = await ws.as(ADA, `/api/threads/${thread}/people`, { method: "POST", body: { email: " Bob@X.com " } });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  expect(added.body.people.map((person: any) => person.email)).toEqual([ADA, BOB]);

  const bobsView = await ws.as(BOB, `/api/threads/${thread}/messages`);
  expect(bobsView.status).toBe(200);
  expect(JSON.stringify(bobsView.body)).toContain("plan the launch together");
  const bobsBots = await ws.as(BOB, "/api/bots");
  expect(JSON.stringify(bobsBots.body)).toContain(thread);

  const bobWrites = await ws.as(BOB, `/api/bots/${botId}/messages`, { method: "POST", body: { text: "bob adds the budget", threadId: thread } });
  expect(bobWrites.status).toBe(202);
  expect(bobWrites.body.threadId).toBe(thread);
  // Ada sees Bob's words, signed with his name, once the bot takes them up
  // (it may still be answering Ada).
  let adasView = await ws.as(ADA, `/api/threads/${thread}/messages`);
  for (let i = 0; i < 100 && !JSON.stringify(adasView.body.messages).includes("bob adds the budget"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    adasView = await ws.as(ADA, `/api/threads/${thread}/messages`);
  }
  const bobsMessage = adasView.body.messages.find((message: any) => JSON.stringify(message).includes("bob adds the budget"));
  expect(bobsMessage, JSON.stringify(adasView.body.messages.map((message: any) => Object.keys(message)))).toBeDefined();
  expect(bobsMessage.sender?.name).toBe(BOB);
});

test("someone not in it still cannot see it, list its people, or add themselves", async () => {
  expect((await ws.as(CICI, `/api/threads/${thread}/messages`)).status).toBe(404);
  expect((await people(CICI)).status).toBe(404);
  expect((await ws.as(CICI, `/api/threads/${thread}/people`, { method: "POST", body: { email: CICI } })).status).toBe(404);
  expect(JSON.stringify((await ws.as(CICI, "/api/bots")).body)).not.toContain(thread);
});

test("only people of the workspace can be added", async () => {
  const outsider = await ws.as(ADA, `/api/threads/${thread}/people`, { method: "POST", body: { email: "mallory@evil.example" } });
  expect(outsider.status).toBe(400);
  expect(outsider.body.error).toMatch(/not in this workspace/);
});

test("a person can leave; then it is gone for them and stays for the others", async () => {
  const left = await ws.as(BOB, `/api/threads/${thread}/people/me`, { method: "DELETE" });
  expect(left.status).toBe(200);
  expect((await ws.as(BOB, `/api/threads/${thread}/messages`)).status).toBe(404);
  expect((await people(ADA)).body.people.map((person: any) => person.email)).toEqual([ADA]);
});
