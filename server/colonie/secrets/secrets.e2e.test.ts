// A bot asks for a secret, the person saves it from the card, and the next
// request carries only the secret's name and a private file, never its value.
// Another person's request to the same bot gets nothing. Driven on a throwaway
// Shared workspace whose stand-in engine calls a tool when a message says
// "mcp call <server> <tool> <json>".
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ANA = "ana@x.com";
const BOB = "bob@x.com";
const VALUE = "abcd-efgh-ijkl-mnop";
let ws: SharedWorkspace;
let botId: string;
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: ANA, admin: true }, { email: BOB }]);
  botId = (await ws.as(ANA, "/api/bots")).body.bots[0].id;
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
const messages = async (email: string, threadId: string) => (await ws.as(email, `/api/threads/${threadId}/messages`)).body.messages ?? [];
const sentText = async (email: string, threadId: string) => ((await ws.as(email, `/api/bots/${botId}/acp-inputs?threadId=${threadId}`)).body.receipts ?? [])
  .flatMap((receipt: any) => receipt.prompt ?? []).map((block: any) => block.text ?? "").join("\n");

test("a bot asks, the person saves it privately, and the next request gets a file, not the value", async () => {
  const ask = { name: "GMAIL_APP_PASSWORD", description: "App password for reading your Gmail.", requestId: "s-1" };
  const sent = await ws.as(ANA, `/api/bots/${botId}/messages`, { method: "POST", body: { text: `mcp call colonie_workspace request_secret ${JSON.stringify(ask)}` } });
  const threadId = sent.body.threadId;
  const permission = await waitFor("no tool permission card", async () => (await messages(ANA, threadId)).find((m: any) => m.card?.requestId)?.card);
  await ws.as(ANA, `/api/threads/${threadId}/respond`, { method: "POST", body: { behavior: "allow", requestId: permission.requestId } });

  const card = await waitFor("no secret request in the chat", async () => (await messages(ANA, threadId)).find((m: any) => m.secretAsk));
  expect(card.secretAsk).toMatchObject({ name: "GMAIL_APP_PASSWORD", botId });

  const saved = await ws.as(ANA, "/api/secrets/GMAIL_APP_PASSWORD", { method: "PUT", body: { value: VALUE, description: "Gmail", botId, threadId, messageId: card.id } });
  expect(saved.status).toBe(200);
  expect(JSON.stringify(saved.body)).not.toContain(VALUE);
  expect((await messages(ANA, threadId)).find((m: any) => m.id === card.id).secretAsk.saved).toBe(true);
  expect((await ws.as(ANA, "/api/secrets")).body.secrets.map((s: any) => s.name)).toEqual(["GMAIL_APP_PASSWORD"]);
  // each person sees only their own
  expect((await ws.as(BOB, "/api/secrets")).body.secrets).toEqual([]);

  await ws.as(ANA, `/api/bots/${botId}/messages`, { method: "POST", body: { threadId, text: "I saved GMAIL_APP_PASSWORD. Please continue." } });
  const withSecrets = await waitFor("the next request named no secrets", async () => {
    const text = await sentText(ANA, threadId);
    return text.includes("Secrets you may use: GMAIL_APP_PASSWORD") ? text : undefined;
  });
  expect(withSecrets).not.toContain(VALUE);
  const file = /in (\S+\.env) as NAME/.exec(withSecrets)?.[1];
  expect(file).toBeTruthy();
  expect(readFileSync(file!, "utf8")).toContain(`GMAIL_APP_PASSWORD='${VALUE}'`);
  // nothing persisted in the chat holds it
  expect(JSON.stringify(await messages(ANA, threadId))).not.toContain(VALUE);
}, 90_000);

test("another person's request to the same bot gets none of Ana's secrets", async () => {
  const sent = await ws.as(BOB, `/api/bots/${botId}/messages`, { method: "POST", body: { text: "hello" } });
  const threadId = sent.body.threadId;
  // the turn ran (the bot answered) and wrote no secrets file for it
  await waitFor("Bob got no answer", async () => (await messages(BOB, threadId)).find((m: any) => m.role === "bot" && m.text));
  expect(existsSync(join(ws.dataDir, "secrets", "runtime", `${threadId}.env`))).toBe(false);
}, 60_000);
