import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS } from "./table.ts";
import { createTeamMapRoutes } from "./team-map.ts";

const visibleOnly = (...ids: string[]) => ({ everything: false, bot: (id: string) => ids.includes(id) }) as never;

const routes = (over: Partial<Parameters<typeof createTeamMapRoutes>[0]> = {}) =>
  createTeamMapRoutes({
    store: { bots: [{ id: "alpha" }, { id: "beta" }, { id: "hidden", hidden: true }] } as never,
    visibleFor: () => visibleOnly("alpha", "beta"),
    pendingDelegationSnapshot: () => [],
    delegationWatch: new Map(),
    ...over,
  });

const get = async (handler: ReturnType<typeof createTeamMapRoutes>) => {
  const { ctx, sent } = callRoute("/api/team-map");
  const out = await handler(ctx);
  return { out, sent };
};

test("a request that is not its own is left to the next handler", async () => {
  const { ctx, sent } = callRoute("/api/team-map", "POST");
  const out = await routes()(ctx);

  expect(out).toBe(PASS);
  expect(sent).toEqual([]);
});

test("a hidden bot's edge is dropped even when a queued handoff names it", async () => {
  const handler = routes({
    pendingDelegationSnapshot: () => [
      { sourceBotId: "alpha", toBotId: "beta", reason: "review the draft" },
      { sourceBotId: "alpha", toBotId: "hidden" },
      { sourceBotId: "hidden", toBotId: "beta" },
    ],
  });

  const { sent } = await get(handler);
  const body = sent[0]?.body as { queued: unknown[]; collaborations: unknown[] };

  expect(body.queued).toEqual([{ sourceBotId: "alpha", targetBotId: "beta", reason: "review the draft" }]);
  expect(body.collaborations).toEqual([]);
});

test("a running delegation needs both ends visible and names its thread", async () => {
  const handler = routes({
    delegationWatch: new Map([
      ["thread-1", { toBotId: "beta", sourceBotId: "alpha" }],
      ["thread-2", { toBotId: "beta" }],
      ["thread-3", { toBotId: "hidden", sourceBotId: "alpha" }],
    ]),
  });

  const { sent } = await get(handler);
  const body = sent[0]?.body as { running: unknown[] };

  expect(body.running).toEqual([{ sourceBotId: "alpha", targetBotId: "beta", threadId: "thread-1" }]);
});

test("only ids, labels and thread ids leave the server", async () => {
  const handler = routes({ pendingDelegationSnapshot: () => [{ sourceBotId: "alpha", toBotId: "beta" }] });

  const { sent } = await get(handler);

  expect(sent[0]?.status).toBe(200);
  expect(Object.keys(sent[0]?.body as object).sort()).toEqual(["collaborations", "queued", "running"]);
});