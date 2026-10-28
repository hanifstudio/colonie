// A bot meets a step only a person can do in its browser (a sign-in, a
// CAPTCHA) and asks for it with a card, as OpenMausBot does. In a group the
// card shows there and, like the group's other cards, the person who asked
// settles it; a person outside the group cannot, and the card stays settled.
// Driven on a throwaway Shared workspace whose stand-in engine calls a tool
// when a message says "mcp call <server> <tool> <json>".
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ANA = "ana@x.com";
const BOB = "bob@x.com";
const EVE = "eve@x.com";
let ws: SharedWorkspace;
let bot: { id: string; name: string };
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: ANA, admin: true }, { email: BOB }, { email: EVE }]);
  bot = (await ws.as(ANA, "/api/bots")).body.bots[0];
}, 90_000);
afterAll(async () => { await ws?.stop(); });

async function waitFor<T>(what: string, find: () => Promise<T | undefined>): Promise<T> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const found = await find();
    if (found) return found;
    await settle(150);
  }
  throw new Error(`${what}:\n${ws.log().slice(-2000)}`);
}

test("a bot's sign-in card shows in the group and the person who asked settles it", async () => {
  const group = (await ws.as(ANA, "/api/conversations", { method: "POST", body: { kind: "group", name: "Trips", emails: [BOB], bots: [bot.id] } })).body;
  const ask = { site: "https://www.redbus.id/bus-tickets", reason: "The schedule is behind a human check.", requestId: "r-1" };
  await ws.as(BOB, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: `@${bot.name} mcp call colonie_workspace request_sign_in ${JSON.stringify(ask)}` } });
  const groupMessages = async (email: string) => (await ws.as(email, `/api/conversations/${group.id}/messages`)).body.messages ?? [];
  const card = await waitFor("no sign-in card in the group", async () => (await groupMessages(ANA)).find((m: any) => m.signInAsk && m.relay));
  expect(card.signInAsk).toMatchObject({ site: "redbus.id", url: "https://www.redbus.id/bus-tickets", reason: ask.reason, botId: bot.id });
  // Colonie's own tool asks nothing first: the card is its confirmation
  expect((await groupMessages(ANA)).some((m: any) => m.card?.requestId)).toBe(false);

  const settleAs = (email: string, outcome: string) => ws.as(email, `/api/threads/${card.relay.threadId}/sign-in`, { method: "POST", body: { messageId: card.relay.messageId, outcome } });
  expect(card.relay.askedBy).toBeTruthy();
  expect((await settleAs(EVE, "done")).status).toBe(404);
  expect((await settleAs(BOB, "done")).status).toBe(200);
  await waitFor("the group's copy did not show it done", async () => (await groupMessages(BOB)).find((m: any) => m.id === card.id && m.signInAsk.outcome === "done"));
  expect((await settleAs(BOB, "cancelled")).status).toBe(409);
}, 90_000);

test("a page that is not a web address is refused, and no card appears", async () => {
  const sent = await ws.as(ANA, `/api/bots/${bot.id}/messages`, { method: "POST", body: { text: `mcp call colonie_workspace request_sign_in ${JSON.stringify({ site: "javascript:alert(1)", requestId: "r-2" })}` } });
  const threadId = sent.body.threadId;
  const messages = async () => (await ws.as(ANA, `/api/threads/${threadId}/messages`)).body.messages ?? [];
  await waitFor("the bot did not answer", async () => (await messages()).find((m: any) => m.role === "bot" && m.text));
  expect((await messages()).some((m: any) => m.signInAsk)).toBe(false);
}, 60_000);
