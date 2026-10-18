import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { createThreadEventsRoutes, type ThreadEventsRouteDeps } from "./thread-events.ts";

const EVENTS = "/api/threads/t1/events";

const deps = (over: Partial<Record<string, unknown>> = {}) => {
  const reads: Array<Record<string, unknown>> = [];
  const fake = {
    store: {
      bots: [{ id: "b1" }],
      tasks: (botId: string) => (botId === "b1" ? [{ threadId: "t1" }] : []),
      groupByThread: (threadId: string) => (threadId === "room1" ? { id: "room1" } : undefined),
    },
    eventsDir: "/events",
    nativeDir: "/native",
    readThreadEvents: (input: Record<string, unknown>) => {
      reads.push(input);
      return { threadId: input.threadId, entries: [] };
    },
    ...over,
  } as unknown as ThreadEventsRouteDeps;
  return { deps: fake, reads };
};

const call = async (handler: RouteHandler, path = EVENTS, method = "GET") => {
  const { ctx, sent } = callRoute(path, method);
  return { out: await handler(ctx), sent };
};

test("a request that is not a thread's events is left to the next handler", async () => {
  const { deps: fake } = deps();
  const handler = createThreadEventsRoutes(fake);
  const elsewhere = await call(handler, "/api/health");
  const wrongVerb = await call(handler, EVENTS, "POST");

  expect(elsewhere.out).toBe(PASS);
  expect(wrongVerb.out).toBe(PASS);
});

test("a thread of a bot, and a thread of a room, both read their logs", async () => {
  const { deps: fake, reads } = deps();
  const handler = createThreadEventsRoutes(fake);
  const botThread = await call(handler, "/api/threads/t1/events?limit=50");
  const roomThread = await call(handler, "/api/threads/room1/events");

  expect(botThread.sent[0]?.status).toBe(200);
  expect(roomThread.sent[0]?.status).toBe(200);
  expect(reads).toEqual([
    { eventsDir: "/events", nativeDir: "/native", threadId: "t1", limit: 50 },
    { eventsDir: "/events", nativeDir: "/native", threadId: "room1", limit: undefined },
  ]);
});

test("a thread this server does not know is a 404, and nothing is read", async () => {
  const { deps: fake, reads } = deps();
  const { sent } = await call(createThreadEventsRoutes(fake), "/api/threads/nope/events");

  expect(sent).toEqual([{ status: 404, body: { error: "no such thread" } }]);
  expect(reads).toEqual([]);
});

test("a limit that is not a positive whole number is refused, and nothing is read", async () => {
  const { deps: fake, reads } = deps();
  const handler = createThreadEventsRoutes(fake);
  const zero = await call(handler, `${EVENTS}?limit=0`);
  const fraction = await call(handler, `${EVENTS}?limit=1.5`);
  const words = await call(handler, `${EVENTS}?limit=all`);

  for (const refused of [zero, fraction, words]) {
    expect(refused.sent).toEqual([{ status: 400, body: { error: "limit must be a positive whole number" } }]);
  }
  expect(reads).toEqual([]);
});