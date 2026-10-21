// Search, activity, and backups in a Shared workspace (step five of privacy by
// person). Search covers only the person's own conversations and still finds
// their own message when other people's conversations hold many more matches;
// a backup of the whole workspace, which holds every transcript, is refused to
// signed-in people, admins included.
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

// Both are admins: admins see every bot, never other people's conversations.
const ADA = "ada@x.com";
const BOB = "bob@x.com";

let ws: SharedWorkspace;
let botId: string;
let adaThread: string;
let bobThread: string;

async function sendAndWait(email: string, text: string): Promise<string> {
  const sent = await ws.as(email, `/api/bots/${botId}/messages`, { method: "POST", body: { text } });
  if (sent.status !== 202) throw new Error(`send failed ${sent.status}: ${JSON.stringify(sent.body)}`);
  const threadId = sent.body.threadId as string;
  const until = Date.now() + 20_000;
  // the turn has finished when the bot is no longer busy in that conversation
  for (;;) {
    const bot = (await ws.as(email, "/api/bots")).body.bots.find((entry: any) => entry.id === botId);
    const task = bot?.tasks?.find((entry: any) => entry.threadId === threadId);
    if (task && !task.busy) return threadId;
    if (Date.now() > until) throw new Error(`turn did not finish:\n${ws.log().slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: ADA, admin: true }, { email: BOB, admin: true }]);
  botId = (await ws.as(BOB, "/api/bots")).body.bots[0].id;
  // Bob's one match is the oldest; Ada's many matches come after it.
  bobThread = await sendAndWait(BOB, "needle bob-only-marker");
  for (let i = 0; i < 12; i += 1) adaThread = await sendAndWait(ADA, `needle ada-private-${i}`);
}, 120_000);
afterAll(async () => { await ws?.stop(); });

test("search never returns another person's conversation", async () => {
  const mine = await ws.as(BOB, `/api/search?q=${encodeURIComponent("ada-private")}`);
  expect(mine.status).toBe(200);
  expect(mine.body.hits).toEqual([]);
  expect(JSON.stringify(mine.body)).not.toContain(adaThread);
});

test("search still finds the person's own message when others hold many more matches", async () => {
  const found = await ws.as(BOB, `/api/search?q=needle&limit=1`);
  expect(found.status).toBe(200);
  expect(found.body.hits.map((hit: any) => hit.threadId)).toEqual([bobThread]);
  const adas = await ws.as(ADA, `/api/search?q=needle&limit=40`);
  expect(adas.body.hits.length).toBeGreaterThan(0);
  for (const hit of adas.body.hits) expect(hit.threadId).toBe(adaThread);
});

test("a backup of the whole workspace is refused to a signed-in admin", async () => {
  const backup = await ws.as(BOB, "/api/workspace-backup/export", { method: "POST", body: { password: "a long enough password 123" } });
  expect(backup.status).toBe(403);
  const teams = await ws.as(BOB, "/api/teams/export", { method: "POST", body: { format: "backup" } });
  expect(teams.status).toBe(403);
});
