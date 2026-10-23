// A bot saves a way of working as one of its guides from chat: it stages
// the guide, a card shows the person the exact text, and only their answer
// saves it. Driven on a throwaway Shared workspace whose stand-in engine
// calls a tool when a message says "mcp call <server> <tool> <json>".
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ANA = "ana@x.com";
let ws: SharedWorkspace;
let botId: string;
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: ANA, admin: true }]);
  botId = (await ws.as(ANA, "/api/bots")).body.bots[0].id;
}, 90_000);
afterAll(async () => { await ws?.stop(); });

async function card(threadId: string, match: (card: any) => boolean) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const found = ((await ws.as(ANA, `/api/threads/${threadId}/messages`)).body.messages ?? []).find((message: any) => message.card && match(message.card));
    if (found) return found.card;
    await settle(100);
  }
  throw new Error(`no card:\n${ws.log().slice(-2000)}`);
}

test("a bot that is not the Chief saves a guide only once the person confirms the exact text", async () => {
  const guide = { name: "weekly-launch-report", description: "Use when asked for the weekly launch report.", instructions: "1. Read the launch notes.\n2. List what moved.\n3. Hand back five lines.", requestId: "guide-1" };
  const sent = await ws.as(ANA, `/api/bots/${botId}/messages`, { method: "POST", body: { text: `mcp call colonie_workspace save_my_skill ${JSON.stringify(guide)}` } });
  const threadId = sent.body.threadId;
  // Colonie's own tool asks nothing first: the guide card is the question
  const proposal = await card(threadId, (c) => Boolean(c.skillRequest));
  expect(((await ws.as(ANA, `/api/threads/${threadId}/messages`)).body.messages ?? []).some((m: any) => m.card?.requestId && !m.card.skillRequest)).toBe(false);
  expect(proposal.skillRequest).toMatchObject({ botId, name: "weekly-launch-report", action: "create" });
  expect(proposal.skillRequest.preview).toContain("List what moved.");
  // nothing is saved before the answer
  const before = (await ws.as(ANA, `/api/bots/${botId}/colonie-skills`)).body;
  expect(JSON.stringify(before)).not.toContain("weekly-launch-report");

  const answered = await ws.as(ANA, `/api/threads/${threadId}/respond`, { method: "POST", body: { behavior: "allow", requestId: proposal.requestId, reviewedSha256: proposal.skillRequest.sha256 } });
  expect(answered.status).toBe(200);
  const after = (await ws.as(ANA, `/api/bots/${botId}/colonie-skills`)).body;
  const saved = after.skills.find((skill: any) => skill.name === "weekly-launch-report");
  expect(saved).toMatchObject({ enabled: true });
}, 90_000);
