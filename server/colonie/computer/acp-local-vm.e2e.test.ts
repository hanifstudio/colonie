// A Claude or Codex bot that works on its Local VM uses that desktop, as in
// OpenMausBot: the engine is handed the computer (not the separate built-in
// browser), each action asks the computer-control route and is let through,
// and no approval card stops it. On a throwaway Shared workspace with the
// stand-in ACP engine; the container runtime and Cua Driver are stand-ins
// (acp-local-vm-hooks.mjs), the lease, claim and control route are real.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";
import { removeTempDir } from "../../testing/cleanup.ts";

const ADA = "ada@x.com";
let ws: SharedWorkspace;
let engineDir: string;

beforeAll(async () => {
  // a browser engine is installed too, so leaving it out is a choice
  engineDir = mkdtempSync(join(tmpdir(), "colonie-fake-browser-"));
  const engine = join(engineDir, "agent-browser");
  writeFileSync(engine, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "../../testing/fake-agent-browser.mjs")}" "$@"\n`);
  chmodSync(engine, 0o755);
  ws = await startSharedWorkspace([{ email: ADA, admin: true }], {}, () => ({
    COLONIE_AGENT_BROWSER_PATH: engine,
    NODE_OPTIONS: `--import ${join(import.meta.dirname, "../../testing/acp-local-vm-hooks.mjs")}`,
  }));
}, 90_000);
afterAll(async () => { await ws?.stop(); await removeTempDir(engineDir); });

test("a bot on its Local VM is handed the desktop instead of the browser, and acts without a card", async () => {
  const bot = (await ws.as(ADA, "/api/bots")).body.bots[0];
  expect((await ws.as(ADA, `/api/bots/${bot.id}`, { method: "PATCH", body: { computer: "vm" } })).status).toBe(200);
  const sent = await ws.as(ADA, `/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "mcp call computer screenshot {}" } });
  const threadId = sent.body.threadId;
  const messages = async () => (await ws.as(ADA, `/api/threads/${threadId}/messages`)).body.messages as any[];
  let answer: any;
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    answer = (await messages()).filter((message) => message.role === "bot" && message.kind === "text").at(-1);
    if (answer && answer.text !== "Hi! What would you like help with?") break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  expect(answer?.text, `${JSON.stringify((await messages()).map((m) => [m.role, m.kind, m.text ?? m.tool?.name ?? m.card?.title]))}\n${ws.log().slice(-3000)}`).toContain("Desktop with Chrome open; control free");
  expect((await messages()).some((message) => message.card?.requestId)).toBe(false);
  const receipts = (await ws.as(ADA, `/api/bots/${bot.id}/acp-inputs?threadId=${threadId}`)).body.receipts as any[];
  const servers = receipts.at(-1).connectedTools.servers.map((server: any) => server.name);
  expect(servers).toContain("computer");
  expect(servers).not.toContain("browser");
}, 90_000);
