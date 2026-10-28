// A bot on Claude or Codex browses with its own built-in browser. On a
// throwaway Shared workspace with the stand-in ACP engine and a stand-in
// agent-browser: the engine is handed the browser tools, and a call reaches
// the bot's own browser session through the harness, after the person who
// asked allows it.
import { afterAll, beforeAll, expect, test } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";
import { removeTempDir } from "../../testing/cleanup.ts";

const ADA = "ada@x.com";
let ws: SharedWorkspace;
let engineDir: string;

beforeAll(async () => {
  engineDir = mkdtempSync(join(tmpdir(), "colonie-fake-browser-"));
  const engine = join(engineDir, "agent-browser");
  writeFileSync(engine, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "../../testing/fake-agent-browser.mjs")}" "$@"\n`);
  chmodSync(engine, 0o755);
  ws = await startSharedWorkspace([{ email: ADA, admin: true }], {}, () => ({ COLONIE_AGENT_BROWSER_PATH: engine }));
}, 90_000);
afterAll(async () => { await ws?.stop(); await removeTempDir(engineDir); });

test("a bot opens a page in its own browser once the person who asked allows it", async () => {
  const bot = (await ws.as(ADA, "/api/bots")).body.bots[0];
  const made = await ws.as(ADA, "/api/conversations", { method: "POST", body: { kind: "group", name: "Research", bots: [bot.id] } });
  const id = made.body.id;
  const messages = async () => (await ws.as(ADA, `/api/conversations/${id}/messages`)).body.messages as any[];
  await ws.as(ADA, `/api/conversations/${id}/messages`, { method: "POST", body: { text: `@${bot.name} mcp call browser agent_browser_open {"url":"https://example.com"}` } });
  let card: any;
  const deadline = Date.now() + 30_000;
  while (!card && Date.now() < deadline) {
    card = (await messages()).find((message) => message.relay && message.card?.requestId && !message.card.answered);
    if (!card) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  expect(card, ws.log().slice(-2000)).toBeTruthy();
  expect((await ws.as(ADA, `/api/threads/${card.relay.threadId}/respond`, { method: "POST", body: { behavior: "allow", requestId: card.card.requestId } })).status).toBe(200);
  let answer: any;
  const answered = Date.now() + 30_000;
  while (Date.now() < answered) {
    answer = (await messages()).filter((message) => message.from?.botId === bot.id && !message.relay).at(-1);
    if (answer && !answer.working && !/is waiting for/.test(answer.text)) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  // the bot's own session: one per bot, named by Colonie
  expect(answer.text, ws.log().slice(-2000)).toMatch(/^Opened https:\/\/example\.com in \S+/);
}, 90_000);
