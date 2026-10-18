import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { createBotTaskRoutes, type BotTaskRouteDeps } from "./bot-task.ts";

const TASK = "/api/bots/b1/tasks/t1";

const deps = (over: Partial<Record<string, unknown>> = {}) => {
  const forgotten: string[] = [];
  const digested: string[] = [];
  const revoked: string[] = [];
  const fake = {
    store: {
      bot: (id: string) => (id === "b1" ? { id, name: "Bot", threadId: "t1", modelSelection: { instanceId: "codex-acp", model: "gpt" } } : undefined),
      switchTask: (botId: string, taskId: string) =>
        botId === "b1" && taskId === "t1" ? { id: botId, threadId: taskId, modelSelection: { instanceId: "codex-acp", model: "gpt" } } : null,
      tasks: () => [],
      projectBotForTask: (botId: string, taskId: string) => (botId === "b1" && taskId === "t1" ? { id: botId, threadId: taskId } : null),
      deleteTask: (botId: string, taskId: string) => (botId === "b1" && taskId === "t1" ? { id: botId, threadId: taskId } : null),
      taskByThread: (botId: string, taskId: string) => (taskId === "t1" ? { id: botId, threadId: taskId } : undefined),
    },
    desktopManaged: false,
    handoffs: { forget: (threadId: string) => forgotten.push(threadId) },
    directTurnGenerationByThread: new Map<string, string>([["t1", "g1"]]),
    routines: () => ({ isActiveThread: () => false }),
    wireBot: (bot: { id: string }) => ({ id: bot.id }),
    wireTask: (task: { threadId: string }) => ({ threadId: task.threadId }),
    publicBot: (bot: { id: string }) => ({ id: bot.id }),
    messagePage: () => ({ messages: [] }),
    pageSize: (raw: string | null) => (raw === null ? undefined : Number(raw) >= 0 ? Number(raw) : null),
    threadBusy: () => false,
    checkedModelSelection: () => ({ ok: true, selection: { instanceId: "codex-acp", model: "gpt" } }),
    checkedTaskModelSwitch: () => ({ ok: true, selection: { instanceId: "codex-acp", model: "gpt" } }),
    supportsApprovalMode: () => true,
    clearTurnDigestState: (threadId: string) => digested.push(threadId),
    settleDirectFollowup: () => {},
    cancelTeamSetupResumesForThread: () => {},
    revokeInternalCapabilitiesForThread: (threadId: string) => revoked.push(threadId),
    stagedSkillCleanupsForThread: () => [],
    rejectDeletedThreadSkillStages: () => {},
    ...over,
  } as unknown as BotTaskRouteDeps;
  return { deps: fake, forgotten, digested, revoked };
};

const call = async (handler: RouteHandler, path = TASK, method = "POST", body: unknown = {}, auth: unknown = { kind: "loopback" }) => {
  const { ctx, sent } = callRoute(path, method, body);
  (ctx as { auth: unknown }).auth = auth;
  return { out: await handler(ctx), sent };
};

test("another route, or another verb, is left to the next handler", async () => {
  const { deps: fake } = deps();
  const handler = createBotTaskRoutes(fake);
  const elsewhere = await call(handler, "/api/health", "POST");
  const wrongVerb = await call(handler, TASK, "GET");

  expect(elsewhere.out).toBe(PASS);
  expect(wrongVerb.out).toBe(PASS);
  expect(elsewhere.sent).toEqual([]);
});

test("switching a thread answers the bot with its settings", async () => {
  const { deps: fake } = deps();
  const handler = createBotTaskRoutes(fake);
  const switched = await call(handler, `${TASK}?messages=0`);
  const unknownBot = await call(handler, "/api/bots/nope/tasks/t1", "POST");
  const badPage = await call(handler, `${TASK}?messages=-1`);

  expect(switched.sent[0]?.status).toBe(200);
  expect(switched.sent[0]?.body).toEqual({ bot: { id: "b1", tasks: [] } });
  expect(unknownBot.sent).toEqual([{ status: 404, body: { error: "no such bot" } }]);
  expect(badPage.sent).toEqual([{ status: 400, body: { error: "messages must be a non-negative whole number" } }]);
});

test("a thread setting the app never sends is refused", async () => {
  const { deps: fake } = deps();
  const handler = createBotTaskRoutes(fake);
  const unsupported = await call(handler, TASK, "PATCH", { nickname: "x" });
  const orphan = await call(handler, TASK, "PATCH", { requireAvailableModel: true });
  const unknownTask = await call(handler, "/api/bots/b1/tasks/nope", "PATCH", { title: "New" });

  expect(unsupported.sent).toEqual([{ status: 400, body: { error: "unsupported thread setting" } }]);
  expect(orphan.sent).toEqual([{ status: 400, body: { error: "requireAvailableModel requires modelSelection" } }]);
  expect(unknownTask.sent).toEqual([{ status: 404, body: { error: "no such task" } }]);
});

test("deleting a thread forgets what only that thread knew", async () => {
  const { deps: fake, forgotten, digested, revoked } = deps();
  const deleted = await call(createBotTaskRoutes(fake), TASK, "DELETE");
  const unknownTask = await call(createBotTaskRoutes(fake), "/api/bots/b1/tasks/nope", "DELETE");

  expect(deleted.sent[0]?.status).toBe(200);
  expect(deleted.sent[0]?.body).toEqual({ bot: { id: "b1" } });
  expect(forgotten).toEqual(["t1"]);
  expect(digested).toEqual(["t1"]);
  expect(revoked).toEqual(["t1"]);
  expect(unknownTask.sent).toEqual([{ status: 404, body: { error: "no such task" } }]);
});