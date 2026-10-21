// What a bot is handed from its other conversations, in a Shared workspace
// (step six of privacy by person). A turn must never quote a conversation into
// one with people who were not in it. Today the ACP path sends no transcript
// recall or "recent work" at all (both live only on the retired native path
// in turn-start.ts), so this is a guard: if either is ever wired into ACP
// turns, it must keep to the person's own conversations or this fails. The
// bot's memory stays shared (owner decision) and is not tested here. The check
// reads what the app actually sent the engine: the input receipts an admin
// can open per conversation.
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

// Both admins, so each may read their own engine inputs.
const ADA = "ada@x.com";
const BOB = "bob@x.com";
const SECRET = "zebrafish-ada-secret";

let ws: SharedWorkspace;
let botId: string;

async function turn(email: string, text: string, threadId?: string): Promise<string> {
  const sent = await ws.as(email, `/api/bots/${botId}/messages`, { method: "POST", body: { text, ...(threadId ? { threadId } : {}) } });
  if (sent.status !== 202) throw new Error(`send failed ${sent.status}: ${JSON.stringify(sent.body)}`);
  const id = sent.body.threadId as string;
  const until = Date.now() + 20_000;
  for (;;) {
    const bot = (await ws.as(email, "/api/bots")).body.bots.find((entry: any) => entry.id === botId);
    const task = bot?.tasks?.find((entry: any) => entry.threadId === id);
    if (task && !task.busy) return id;
    if (Date.now() > until) throw new Error(`turn did not finish:\n${ws.log().slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const inputsOf = async (email: string, threadId: string) =>
  JSON.stringify((await ws.as(email, `/api/bots/${botId}/acp-inputs?threadId=${threadId}`)).body);

let bobInputs: string;
let adaSecondInputs: string;

beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: ADA, admin: true }, { email: BOB, admin: true }]);
  botId = (await ws.as(BOB, "/api/bots")).body.bots[0].id;
  await turn(ADA, `Remember this: the launch codename is ${SECRET}.`);
  // A second conversation of Ada's: her own earlier chat may be recalled here.
  const created = await ws.as(ADA, `/api/bots/${botId}/tasks`, { method: "POST", body: { title: "Ada again" } });
  const adaSecond = await turn(ADA, "What is the launch codename?", created.body.bot.threadId);
  adaSecondInputs = await inputsOf(ADA, adaSecond);
  // Bob asks the same bot the same question in his own conversation.
  const bobThread = await turn(BOB, "What is the launch codename?");
  bobInputs = await inputsOf(BOB, bobThread);
}, 120_000);
afterAll(async () => { await ws?.stop(); });

test("another person's conversation is never quoted into a turn", () => {
  // the receipts are real: Bob's own question is in them
  expect(bobInputs).toContain("What is the launch codename?");
  expect(bobInputs).not.toContain(SECRET);
});

test("nor into the same person's other conversation, while no recall exists", () => {
  // If recall reaches ACP turns this may change, deliberately: recalling a
  // person's own earlier chat is allowed. Then replace this with a check that
  // it arrives here and still never in Bob's turn.
  expect(adaSecondInputs).toContain("What is the launch codename?");
  expect(adaSecondInputs).not.toContain(SECRET);
});
