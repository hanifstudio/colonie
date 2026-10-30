// Retained after desktop removal: old setup/control URLs and tool names must
// stay unavailable, while the same bots retain their browsers and sign-in help.
import { afterAll, beforeAll, expect, test } from "vitest";
import { BROWSER_OWNER, browserAnswer, startBrowserWorkspace } from "../../testing/browser-workspace.ts";
import type { SharedWorkspace } from "../../testing/shared-workspace.ts";

let local: SharedWorkspace;
let shared: SharedWorkspace;
beforeAll(async () => {
  local = await startBrowserWorkspace(false);
  shared = await startBrowserWorkspace(true);
}, 90_000);
afterAll(async () => { await local?.stop(); await shared?.stop(); });

test("Local bots have browser and sign-in tools, with no desktop setup or selection tools", async () => {
  const bot = (await local.as(BROWSER_OWNER, "/api/bots")).body.bots[0];
  const answer = await browserAnswer(local, bot.id, "mcp list");
  expect(answer.text).toContain("browser:agent_browser_open");
  expect(answer.text).toContain("colonie_workspace:request_sign_in");
  for (const name of ["use_computer", "select_computer", "shared_computer", "computer:screenshot"]) expect(answer.text).not.toContain(name);
  const retired = await browserAnswer(local, bot.id, 'mcp call colonie_workspace use_computer {"requestId":"retired"}', true);
  expect(retired.text).toContain("Unknown tool: use_computer");
  const messages = (await local.as(BROWSER_OWNER, `/api/threads/${retired.threadId}/messages`)).body.messages;
  expect(messages.some((message: any) => message.computerAsk)).toBe(false);
}, 60_000);

test("retired setup, control, screenshot, and viewer routes never provision a desktop", async () => {
  const bot = (await local.as(BROWSER_OWNER, "/api/bots")).body.bots[0];
  for (const path of ["/api/local-computer/run", "/api/local-computer/pull", `/api/bots/${bot.id}/local-computer/setup`, `/api/bots/${bot.id}/local-computer/join`, `/api/bots/${bot.id}/computer/control`, `/api/bots/${bot.id}/computer/screenshot`]) {
    expect((await local.as(BROWSER_OWNER, path, { method: "POST", body: { action: "take" } })).status, path).toBe(404);
  }
  for (const path of ["/api/local-computer", "/api/local-computer/instances", `/api/bots/${bot.id}/local-computer`]) {
    expect((await local.as(BROWSER_OWNER, path)).status, path).toBe(404);
  }
  expect((await local.as(BROWSER_OWNER, `/api/bots/${bot.id}`, { method: "PATCH", body: { computer: "vm" } })).status).toBe(400);
  expect((await local.as(BROWSER_OWNER, "/api/config", { method: "PATCH", body: { localVm: { mode: "shared" } } })).status).toBe(400);
});

test("Shared bots also keep their browser without a Computer feature", async () => {
  const bot = (await shared.as(BROWSER_OWNER, "/api/bots")).body.bots[0];
  const answer = await browserAnswer(shared, bot.id, 'mcp call browser agent_browser_open {"url":"https://example.com"}');
  expect(answer.text).toMatch(/^Opened https:\/\/example.com in \S+/);
  const receipts = (await shared.as(BROWSER_OWNER, `/api/bots/${bot.id}/acp-inputs?threadId=${answer.threadId}`)).body.receipts;
  expect(receipts.at(-1).connectedTools.servers.map((server: any) => server.name)).toContain("browser");
  expect(receipts.at(-1).connectedTools.servers.map((server: any) => server.name)).not.toContain("computer");
  const config = (await shared.as(BROWSER_OWNER, "/api/config")).body;
  expect(config).not.toHaveProperty("localVm");
  expect(config.features).not.toHaveProperty("sharedComputers");
}, 60_000);
