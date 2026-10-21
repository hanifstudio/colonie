// Bot memory learns from everyone who uses the bot in a Shared workspace
// (owner decision: memory belongs to the bot). A member's message is queued
// for this bot's memory under their name; it never targets the owner's
// profile (memory/ledger/capture.ts keeps it to bot scope).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const BOB = "bob@x.com";
let ws: SharedWorkspace;
let botId: string;

beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: "ada@x.com", admin: true }, { email: BOB }]);
  botId = (await ws.as(BOB, "/api/bots")).body.bots[0].id;
}, 60_000);
afterAll(async () => { await ws?.stop(); });

test("a member's message reaches the bot's memory, under their name", async () => {
  const sent = await ws.as(BOB, `/api/bots/${botId}/messages`, { method: "POST", body: { text: "I prefer weekly summaries on Monday." } });
  expect(sent.status).toBe(202);
  const file = join(ws.dataDir, "colonie-memory", "state.json");
  const seen = () => { try { return readFileSync(file, "utf8"); } catch { return ""; } };
  const learned = () => {
    const state = JSON.parse(seen() || "{}");
    const queued = (state.jobs ?? []).some((entry: any) => entry.botId === botId && entry.speaker === BOB);
    const processed = Object.values(state.bots ?? {}).some((ledger: any) => (ledger.processed ?? []).some((id: string) => id.startsWith(`${botId}|${sent.body.threadId}|`)));
    return queued || processed;
  };
  const until = Date.now() + 20_000;
  while (!learned() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
  expect(learned(), `${seen()}\n${ws.log().slice(-1500)}`).toBe(true);
});
