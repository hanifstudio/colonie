// A Claude or Codex bot asks for its computer (use_computer) only when a task
// needs one. In a Local workspace with the container app installed, its turn
// ends and the request resumes on the started computer; without it, the person
// gets one offer card, and after "Not now" bots stop offering. A Shared
// workspace's server runs no bot computer yet, and says so instead. Throwaway
// servers with the stand-in ACP engine; the container runtime is a stand-in
// (acp-local-vm-hooks.mjs), the selection, continuation and offer are real.
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ADA = "ada@x.com";
const hooks = `--import ${join(import.meta.dirname, "../../testing/acp-local-vm-hooks.mjs")}`;
let installed: SharedWorkspace;
let missing: SharedWorkspace;
let shared: SharedWorkspace;

/** A Local workspace names nobody: the app on this Mac asks as its owner. */
function local(ws: SharedWorkspace) {
  return {
    ...ws,
    async as(_email: string, path: string, init: { method?: string; body?: unknown } = {}) {
      const response = await fetch(`${ws.url}${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
  } as SharedWorkspace;
}

beforeAll(async () => {
  const [a, b, c] = await Promise.all([
    startSharedWorkspace([], {}, () => ({ NODE_OPTIONS: hooks })),
    startSharedWorkspace([], {}, () => ({ NODE_OPTIONS: hooks, COLONIE_TEST_VM_RUNTIME: "none" })),
    startSharedWorkspace([{ email: ADA, admin: true }], {}, () => ({ NODE_OPTIONS: hooks })),
  ]);
  installed = local(a); missing = local(b); shared = c;
}, 120_000);
afterAll(async () => { await installed?.stop(); await missing?.stop(); await shared?.stop(); });

async function waitFor<T>(ws: SharedWorkspace, what: string, find: () => Promise<T | undefined>): Promise<T> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const found = await find();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${what}:\n${ws.log().slice(-3000)}`);
}
const ask = (reason: string) => `mcp call colonie_workspace use_computer ${JSON.stringify({ reason, requestId: `r-${Math.random()}` })}`;

test("with the app installed, the request resumes on the bot's started computer", async () => {
  const bot = (await installed.as(ADA, "/api/bots")).body.bots[0];
  // the workspace's first bot starts with its computer off; a person's bots work on Auto
  expect((await installed.as(ADA, `/api/bots/${bot.id}`, { method: "PATCH", body: { computer: null } })).status).toBe(200);
  const sent = await installed.as(ADA, `/api/bots/${bot.id}/messages`, { method: "POST", body: { text: ask("OLX refuses the simple browser.") } });
  const threadId = sent.body.threadId;
  const receipts = async () => ((await installed.as(ADA, `/api/bots/${bot.id}/acp-inputs?threadId=${threadId}`)).body.receipts ?? []) as any[];
  const resumed = await waitFor(installed, "the request never resumed on the computer", async () => {
    const all = await receipts();
    return all.length >= 2 && all.at(-1).connectedTools.servers.some((server: any) => server.name === "computer") ? all.at(-1) : undefined;
  });
  expect(resumed.connectedTools.servers.map((server: any) => server.name)).not.toContain("browser");
  const task = (await installed.as(ADA, "/api/bots")).body.bots[0].tasks.find((entry: any) => entry.threadId === threadId);
  expect(task.surface).toBe("vm");
}, 90_000);

test("without the app, the person gets one offer, and Not now stops the offers", async () => {
  const bot = (await missing.as(ADA, "/api/bots")).body.bots[0];
  const sent = await missing.as(ADA, `/api/bots/${bot.id}/messages`, { method: "POST", body: { text: ask("OLX refuses the simple browser.") } });
  const threadId = sent.body.threadId;
  const messages = async () => (await missing.as(ADA, `/api/threads/${threadId}/messages`)).body.messages as any[];
  const card = await waitFor(missing, "no offer card", async () => (await messages()).find((m) => m.computerAsk));
  expect(card.computerAsk).toMatchObject({ botId: bot.id, reason: "OLX refuses the simple browser." });
  expect((await missing.as(ADA, `/api/threads/${threadId}/computer-offer`, { method: "POST", body: { messageId: card.id } })).status).toBe(200);
  await waitFor(missing, "the card did not settle", async () => (await messages()).find((m) => m.id === card.id && m.computerAsk.outcome === "later"));
  await waitFor(missing, "the first turn did not finish", async () => !(await missing.as(ADA, "/api/bots")).body.bots[0].tasks.find((t: any) => t.threadId === threadId)?.busy ? true : undefined);
  await missing.as(ADA, `/api/bots/${bot.id}/messages`, { method: "POST", body: { threadId, text: ask("Still refused.") } });
  await waitFor(missing, "the second request got no answer", async () => (await messages()).filter((m) => m.role === "bot" && m.kind === "text" && m.text).length >= 2 ? true : undefined);
  expect((await messages()).filter((m) => m.computerAsk)).toHaveLength(1);
}, 90_000);

test("a Shared workspace's server says it has no bot computer yet, and offers nothing", async () => {
  const bot = (await shared.as(ADA, "/api/bots")).body.bots[0];
  expect((await shared.as(ADA, `/api/bots/${bot.id}`, { method: "PATCH", body: { computer: null } })).status).toBe(200);
  const sent = await shared.as(ADA, `/api/bots/${bot.id}/messages`, { method: "POST", body: { text: ask("OLX refuses the simple browser.") } });
  const threadId = sent.body.threadId;
  const messages = async () => (await shared.as(ADA, `/api/threads/${threadId}/messages`)).body.messages as any[];
  await waitFor(shared, "the bot did not answer", async () => (await messages()).find((m) => m.role === "bot" && m.kind === "text" && /no computer for bots yet/.test(m.text ?? "")));
  expect((await messages()).some((m) => m.computerAsk)).toBe(false);
  const status = (await shared.as(ADA, `/api/bots/${bot.id}/local-computer?threadId=${threadId}`)).body;
  expect(status.computer_supported).toBe(false);
}, 90_000);
