// A group bot that goes silent is stopped by the same stall watchdog the 1:1 chats use. The server
// must survive it (the watchdog's handler once crashed the whole process), the group must be told
// the cause, and the line must offer Continue. The watchdog's shortest stall is 60 s, so this takes
// about two minutes: the hang is real, on a throwaway server with the simulated engine.
import { afterAll, beforeAll, expect, test } from "vitest";
import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ADA = "ada@x.com";
let ws: SharedWorkspace;
beforeAll(async () => {
  ws = await startSharedWorkspace([{ email: ADA, admin: true }], {}, () => ({ COLONIE_TURN_STALL_MS: "60000" }));
}, 90_000);
afterAll(async () => { await ws?.stop(); });

test("a hanging group bot is stopped by the watchdog, the server survives, and the group says why", async () => {
  const bot = (await ws.as(ADA, "/api/bots")).body.bots[0];
  const group = (await ws.as(ADA, "/api/conversations", { method: "POST", body: { kind: "group", name: "Hang", bots: [bot.id] } })).body;
  await ws.as(ADA, `/api/conversations/${group.id}/messages`, { method: "POST", body: { text: `@${bot.name} hang` } });
  const end = Date.now() + 230_000;
  let line: any;
  while (Date.now() < end) {
    const messages = (await ws.as(ADA, `/api/conversations/${group.id}/messages`)).body.messages as any[];
    line = messages.filter((message) => message.from?.botId === bot.id).at(-1);
    if (line && !line.working) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  expect(line?.working).toBeFalsy();
  expect(line?.text).toContain("stopped: no activity for");
  expect(line?.stoppedBy).toEqual({ botId: bot.id, reason: "failed" });
  // the process that stopped the turn is still answering
  expect((await fetch(`${ws.url}/api/health`)).ok).toBe(true);
}, 260_000);
