// Live updates in a Shared workspace carry only a person's own conversations,
// for admins too, both as they happen and when a client reconnects and the
// server replays what it missed. Step four of privacy by person.
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type LiveStream, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ADA = "ada@x.com"; // member
const BOB = "bob@x.com"; // admin: admins see every bot, never other people's conversations

let ws: SharedWorkspace;
let botId: string;
let bobLive: LiveStream;
let adaLive: LiveStream;
let bobCursorBefore: string;
let adaThread: string;
let bobThread: string;

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: ADA }, { email: BOB, admin: true }]);
  botId = (await ws.as(BOB, "/api/bots")).body.bots[0].id;
  bobLive = await ws.stream(BOB);
  adaLive = await ws.stream(ADA);
  bobCursorBefore = bobLive.cursor()!;
  const ada = await ws.as(ADA, `/api/bots/${botId}/messages`, { method: "POST", body: { text: "ada-secret-live" } });
  adaThread = ada.body.threadId;
  const bob = await ws.as(BOB, `/api/bots/${botId}/messages`, { method: "POST", body: { text: "bob-secret-live" } });
  bobThread = bob.body.threadId;
  // let both turns run and their frames arrive
  const until = Date.now() + 20_000;
  while (!(/"role":"bot"/.test(adaLive.text()) && /"role":"bot"/.test(bobLive.text())) && Date.now() < until) await settle(200);
  await settle(500);
}, 90_000);
afterAll(async () => {
  bobLive?.close();
  adaLive?.close();
  await ws?.stop();
});

test("each person's live stream carries their own conversation", () => {
  expect(adaLive.text()).toContain("ada-secret-live");
  expect(bobLive.text()).toContain("bob-secret-live");
});

test("an admin's live stream carries nothing of another person's conversation", () => {
  expect(bobLive.text()).not.toContain("ada-secret-live");
  expect(bobLive.text()).not.toContain(adaThread);
});

test("a member's live stream carries nothing of another person's conversation", () => {
  expect(adaLive.text()).not.toContain("bob-secret-live");
  expect(adaLive.text()).not.toContain(bobThread);
});

test("reconnecting replays only the person's own conversation, admins included", async () => {
  const replay = await ws.stream(BOB, bobCursorBefore);
  await settle(500);
  replay.close();
  expect(replay.text()).toContain('"resumed":true');
  expect(replay.text()).toContain("bob-secret-live");
  expect(replay.text()).not.toContain("ada-secret-live");
  expect(replay.text()).not.toContain(adaThread);
});
