// Sending starts a turn, so this guards the front door: which requests are this
// route's, what a body must say, and that a refusal the send layer reports is
// answered as it is instead of starting anything. The turn itself is proven
// live on a throwaway HOME.
import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS } from "./table.ts";
import { createBotMessagesRoutes, type BotMessagesRouteDeps } from "./bot-messages.ts";

const SEND = "/api/bots/b1/messages";

class Refused extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super("refused");
    this.status = status;
    this.body = body;
  }
}

const deps = (over: Partial<Record<string, unknown>> = {}) => {
  const started: unknown[] = [];
  const fake = {
    store: {
      bot: (id: string) => (id === "b1" ? { id, threadId: "t1", busy: false, autoApprove: false } : undefined),
      activeLeaf: () => "leaf-1",
      bots: [{ id: "b1", threadId: "t1" }],
      tasks: () => [],
      taskByThread: () => undefined,
    },
    desktopManaged: false,
    guardedSendSchema: {
      safeParse: (body: Record<string, unknown>) =>
        body.threadId && body.sendId && body.text && "expectedActiveLeafId" in body
          ? { success: true, data: body }
          : { success: false, error: { issues: [{ path: ["threadId"] }] } },
    },
    directSendRefusal: () => null,
    resolveReplyTarget: () => undefined,
    messageSender: () => undefined,
    usageTriggerFor: () => ({ kind: "user" }),
    acceptDirectSend: async () => {
      started.push("accept");
      return { ok: true, threadId: "t1", message: { id: "m1" } };
    },
    startTurn: async () => {
      started.push("startTurn");
      return { id: "m1" };
    },
    botAtThreadCapacity: () => false,
    threadBusy: () => false,
    DirectSendRefused: Refused,
    ...over,
  } as unknown as BotMessagesRouteDeps;
  return { deps: fake, started };
};

const call = async (handler: ReturnType<typeof createBotMessagesRoutes>, path = SEND, method = "POST", body: unknown = { text: "hi" }) => {
  const { ctx, sent } = callRoute(path, method, body);
  return { out: await handler(ctx), sent };
};

test("another route, or another verb, is left to the next handler", async () => {
  const handler = createBotMessagesRoutes(deps().deps);
  const elsewhere = await call(handler, "/api/health", "POST");
  const wrongVerb = await call(handler, SEND, "GET");

  expect(elsewhere.out).toBe(PASS);
  expect(wrongVerb.out).toBe(PASS);
  expect(elsewhere.sent).toEqual([]);
});

test("a body that is not an object, or says nothing, is refused", async () => {
  const { deps: fake, started } = deps();
  const handler = createBotMessagesRoutes(fake);
  const notAnObject = await call(handler, SEND, "POST", [1]);
  const silent = await call(handler, SEND, "POST", { text: "   " });

  expect(notAnObject.sent).toEqual([{ status: 400, body: { error: "body must be a JSON object" } }]);
  expect(silent.sent).toEqual([{ status: 400, body: { error: "text required" } }]);
  expect(started).toEqual([]);
});

test("a guarded send without its safety preconditions is refused", async () => {
  const { deps: fake, started } = deps();
  const { sent } = await call(createBotMessagesRoutes(fake), `${SEND}/guarded`, "POST", { text: "hi" });

  expect(sent).toEqual([{
    status: 400,
    body: { error: "guarded sends require threadId, sendId, text and expectedActiveLeafId" },
  }]);
  expect(started).toEqual([]);
});

test("an unknown bot is a 404", async () => {
  const { deps: fake, started } = deps();
  const { sent } = await call(createBotMessagesRoutes(fake), "/api/bots/nope/messages", "POST", { text: "hi" });

  expect(sent).toEqual([{ status: 404, body: { error: "no such bot" } }]);
  expect(started).toEqual([]);
});

test("a refusal from the send layer is answered as it is", async () => {
  const { deps: fake, started } = deps({ directSendRefusal: () => ({ status: 409, body: { error: "that task is gone" } }) });
  const { sent } = await call(createBotMessagesRoutes(fake), SEND, "POST", { text: "hi" });

  expect(sent).toEqual([{ status: 409, body: { error: "that task is gone" } }]);
  expect(started).toEqual([]);
});

test("a send that the send layer itself refuses is answered with its status", async () => {
  const { deps: fake } = deps({
    acceptDirectSend: async () => {
      throw new Refused(409, { error: "wait for the approval change to finish" });
    },
  });
  const { sent } = await call(createBotMessagesRoutes(fake), SEND, "POST", { text: "hi" });

  expect(sent).toEqual([{ status: 409, body: { error: "wait for the approval change to finish" } }]);
});

test("a send that lands answers 202 with the receipt", async () => {
  const { deps: fake, started } = deps();
  const { sent } = await call(createBotMessagesRoutes(fake), SEND, "POST", { text: "hi" });

  expect(sent[0]?.status).toBe(202);
  expect(started).toEqual(["accept"]);
});