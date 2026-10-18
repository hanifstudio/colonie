import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { createReactionRoutes, type ReactionRouteDeps } from "./reactions.ts";

const REACTIONS = "/api/threads/t1/messages/m1/reactions";

const call = async (handler: RouteHandler, path = REACTIONS, method = "POST", body: unknown = { emoji: "\u{1f44d}" }) => {
  const { ctx, sent } = callRoute(path, method, body);
  return { out: await handler(ctx), sent };
};

/** A store fake that records what the route asked it to toggle. */
const store = (result: unknown = { id: "m1", reactions: [] }) => {
  const calls: Array<[string, string, string, string]> = [];
  const deps = {
    store: {
      toggleReaction: (threadId: string, messageId: string, emoji: string, by: string) => {
        calls.push([threadId, messageId, emoji, by]);
        return result;
      },
    },
  } as unknown as ReactionRouteDeps;
  return { deps, calls };
};

test("a request that is not a reaction is left to the next handler", async () => {
  const { deps } = store();
  const handler = createReactionRoutes(deps);
  const elsewhere = await call(handler, "/api/health", "GET");
  const read = await call(handler, REACTIONS, "GET");

  expect(elsewhere.out).toBe(PASS);
  expect(read.out).toBe(PASS);
  expect(elsewhere.sent).toEqual([]);
  expect(read.sent).toEqual([]);
});

test("a missing reaction is refused before the store is asked", async () => {
  const { deps, calls } = store();
  const { sent } = await call(createReactionRoutes(deps), REACTIONS, "POST", {});

  expect(sent).toEqual([{ status: 400, body: { error: "emoji required" } }]);
  expect(calls).toEqual([]);
});

test("a reaction is passed on with its thread, message and emoji", async () => {
  const { deps, calls } = store({ id: "m1", reactions: [{ emoji: "\u{1f44d}", by: "user" }] });
  const { sent } = await call(createReactionRoutes(deps), REACTIONS, "POST", { emoji: "\u{1f44d}" });

  expect(calls).toEqual([["t1", "m1", "\u{1f44d}", "user"]]);
  expect(sent[0]?.status).toBe(200);
  expect((sent[0]?.body as { message?: { id?: string } } | undefined)?.message?.id).toBe("m1");
});

test("an over-long emoji is cut to the length the store accepts", async () => {
  const { deps, calls } = store();
  await call(createReactionRoutes(deps), REACTIONS, "POST", { emoji: "abcdefghijkl", by: "bot-1" });

  expect(calls).toEqual([["t1", "m1", "abcdefgh", "bot-1"]]);
});

test("a nameless sender is recorded as the user, and an unknown message is a 404", async () => {
  const named = store();
  await call(createReactionRoutes(named.deps), REACTIONS, "POST", { emoji: "\u{1f44d}", by: 7 });
  const missing = store(null);
  const { sent } = await call(createReactionRoutes(missing.deps), REACTIONS, "POST");

  expect(named.calls).toEqual([["t1", "m1", "\u{1f44d}", "user"]]);
  expect(sent).toEqual([{ status: 404, body: { error: "no such message" } }]);
});