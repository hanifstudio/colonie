import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { createBotReadRoutes, type BotReadRouteDeps } from "./bot-read.ts";

const READ = "/api/bots/b1/read";

const call = async (handler: RouteHandler, path = READ, method = "POST", auth: unknown = { scopes: [] }) => {
  const { ctx, sent } = callRoute(path, method, { threadId: "t1" });
  (ctx as { auth: unknown }).auth = auth;
  return { out: await handler(ctx), sent };
};

const deps = (threads = 1) => {
  const patched: Array<[string, string, unknown]> = [];
  const events: unknown[] = [];
  const fake = {
    store: {
      tasks: () => Array.from({ length: threads }, (_, index) => ({ id: `t${index}` })),
      patchTask: (botId: string, threadId: string, patch: unknown) => {
        patched.push([botId, threadId, patch]);
        return { id: botId, threadId };
      },
      bot: (id: string) => ({ id, name: id.toUpperCase(), threadId: "t1" }),
    },
    requestedTaskBot: (botId: string, rawThreadId: unknown) => ({
      id: botId,
      threadId: typeof rawThreadId === "string" ? rawThreadId : "t1",
    }),
    wireBot: (bot: { id: string; name: string }) => ({ id: bot.id, name: bot.name }),
    broadcast: (payload: Record<string, unknown>) => events.push(payload),
  } as unknown as BotReadRouteDeps;
  return { deps: fake, patched, events };
};

test("a request that is not a read is left to the next handler", async () => {
  const { deps: fake } = deps();
  const handler = createBotReadRoutes(fake);
  const elsewhere = await call(handler, "/api/health", "POST");
  const wrongVerb = await call(handler, READ, "GET");

  expect(elsewhere.out).toBe(PASS);
  expect(wrongVerb.out).toBe(PASS);
  expect(elsewhere.sent).toEqual([]);
});

test("reading marks the named thread read, answers the bot and tells the room", async () => {
  const { deps: fake, patched, events } = deps();
  const { sent } = await call(createBotReadRoutes(fake));

  expect(patched).toEqual([["b1", "t1", { unread: false }]]);
  expect(events).toEqual([{ kind: "bot", bot: { id: "b1", name: "B1" } }]);
  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toEqual({ bot: { id: "b1", name: "B1" } });
});

test("a client session with several threads must name one before anything is marked read", async () => {
  const { deps: fake, patched } = deps(2);
  const handler = createBotReadRoutes(fake);
  const { ctx } = callRoute(READ, "POST", {});
  (ctx as { auth: unknown }).auth = { kind: "session", session: { id: "s1" } };

  await expect(handler(ctx)).rejects.toMatchObject({ status: 409 });
  expect(patched).toEqual([]);
});