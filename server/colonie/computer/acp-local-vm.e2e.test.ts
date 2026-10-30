// An old VM default must neither start a desktop nor keep a new bot from
// browsing. Exercise upgrade compatibility through the real app with fake tools.
import { afterAll, beforeAll, expect, test } from "vitest";
import { BROWSER_OWNER, browserAnswer, startBrowserWorkspace } from "../../testing/browser-workspace.ts";
import type { SharedWorkspace } from "../../testing/shared-workspace.ts";

let ws: SharedWorkspace;
beforeAll(async () => {
  ws = await startBrowserWorkspace(false, { newBotDefaults: { profile: { computer: "vm" }, memory: {}, skills: [], routines: [] } });
}, 90_000);
afterAll(async () => { await ws?.stop(); });

test("a legacy desktop default becomes a browser-only bot without losing its normal tools", async () => {
  const made = await ws.as(BROWSER_OWNER, "/api/bots", { method: "POST", body: { name: "Legacy browser" } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const bot = made.body.bot ?? made.body;
  expect(bot.id).toBeTruthy();
  expect(bot.computer).toBeUndefined();
  const answer = await browserAnswer(ws, bot.id, 'mcp call browser agent_browser_open {"url":"https://example.com"}');
  expect(answer.text).toMatch(/^Opened https:\/\/example.com in \S+/);
  const receipts = (await ws.as(BROWSER_OWNER, `/api/bots/${bot.id}/acp-inputs?threadId=${answer.threadId}`)).body.receipts;
  const servers = receipts.at(-1).connectedTools.servers.map((server: any) => server.name);
  expect(servers).toContain("browser");
  expect(servers).toContain("colonie_workspace");
  expect(servers).not.toContain("computer");
  expect((await ws.as(BROWSER_OWNER, `/api/bots/${bot.id}/local-computer/setup`, { method: "POST", body: {} })).status).toBe(404);
}, 60_000);
