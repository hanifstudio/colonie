// Answering a running thread: the deep branches resolve requests the app has
// already put in the conversation, so this guards the front door — who may
// answer at all, what a body may say, and that a refusal never reaches a card.
import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { createThreadRespondRoutes, type ThreadRespondRouteDeps } from "./thread-respond.ts";

const RESPOND = "/api/threads/t1/respond";

const deps = (over: Partial<Record<string, unknown>> = {}) => {
  const reached: unknown[] = [];
  const fake = {
    store: { messagesFor: () => [], botByThread: () => undefined, bot: () => undefined, bots: [] },
    desktopManaged: false,
    approvalBus: {},
    botForThread: () => null,
    answerRequest: (...args: any[]) => { reached.push(args); return { ok: true, outcome: "answered" }; },
    answeringCardAs: async (_auth: unknown, _threadId: string, _requestId: string, work: () => Promise<unknown>) => work(),
    cardAnswerRefusal: () => null,
    commandRememberRefusal: () => null,
    requestBehavior: (value: unknown) =>
      value === "allow" || value === "deny" || value === "answer" ? value : null,
    deliverLateQuestionAnswer: async () => ({ ok: true }),
    resolveAndSendModel: () => false,
    resolveAndSendProfile: () => false,
    resolveAndSendRoutine: () => false,
    resolveAndSendTeamSetup: async () => false,
    resolveAndSendTrust: () => false,
    resolveSkillRequest: () => ({}),
    sendSkillResolution: () => false,
    ...over,
  } as unknown as ThreadRespondRouteDeps;
  return { deps: fake, reached };
};

const call = async (handler: RouteHandler, path = RESPOND, method = "POST", body: unknown = { behavior: "allow", requestId: "r1" }, auth: unknown = { kind: "loopback" }) => {
  const { ctx, sent } = callRoute(path, method, body);
  (ctx as { auth: unknown }).auth = auth;
  return { out: await handler(ctx), sent };
};

test("another route, or another verb, is left to the next handler", async () => {
  const handler = createThreadRespondRoutes(deps().deps);
  const elsewhere = await call(handler, "/api/health", "POST");
  const wrongVerb = await call(handler, RESPOND, "GET");

  expect(elsewhere.out).toBe(PASS);
  expect(wrongVerb.out).toBe(PASS);
  expect(elsewhere.sent).toEqual([]);
});

test("a behavior that is not allow, deny or answer is refused", async () => {
  const { sent } = await call(createThreadRespondRoutes(deps().deps), RESPOND, "POST", { behavior: "maybe" });

  expect(sent).toEqual([{ status: 400, body: { error: "behavior must be allow, deny, or answer" } }]);
});

test("a card that may not be answered this way is refused before the card is touched", async () => {
  const { deps: fake, reached } = deps({ cardAnswerRefusal: () => "Only the person who asked may answer here." });
  const { sent } = await call(createThreadRespondRoutes(fake), RESPOND);

  expect(sent).toEqual([{ status: 403, body: { error: "Only the person who asked may answer here." } }]);
  expect(reached).toEqual([]);
});

test("remembering a command is checked on its own, too", async () => {
  const { deps: fake, reached } = deps({ commandRememberRefusal: () => "Saving a command permission needs the desktop." });
  const { sent } = await call(createThreadRespondRoutes(fake), RESPOND, "POST", { behavior: "allow", requestId: "r1", rememberCommand: true });

  expect(sent).toEqual([{ status: 403, body: { error: "Saving a command permission needs the desktop." } }]);
  expect(reached).toEqual([]);
});