// The refusals a direct send meets before it is sequenced are the whole point of
// this module: they are what a person sees instead of a turn that silently never
// starts. The cheap ones are the ones worth guarding — a thread the bot already
// left, and the class the routes turn into their answer.
import { expect, test } from "vitest";
import { createDirectSend, DirectSendRefused } from "./direct-send.ts";

// No budget cap is configured, so the spend check reads nothing from disk.
const deps = (task: unknown) => {
  const send = createDirectSend({
    store: { taskByThread: () => task } as never,
    cfg: {} as never,
    handoffs: {} as never,
    computerSelectionTurns: new Map(),
    sendSequencer: { run: async () => undefined },
    startOrQueueDirectMessage: async () => undefined,
    clearUnattended: () => {},
    runningTurnInstance: () => undefined,
  });
  return send;
};

test("a thread the bot already left is refused, with the reason", () => {
  const refusal = deps(undefined).directSendRefusal("b1", "t-gone");

  expect(refusal).toBeInstanceOf(DirectSendRefused);
  expect(refusal?.status).toBe(409);
  expect(refusal?.body).toEqual({ error: "the bot switched tasks before it could receive the message" });
});

test("a thread the bot still owns is not refused", () => {
  expect(deps({ id: "task1" }).directSendRefusal("b1", "t1")).toBeNull();
});

test("a refusal carries its status and body, and stands in for its message", () => {
  const withError = new DirectSendRefused(409, { error: "words the person reads", code: "spend_cap" });
  expect(withError.message).toBe("words the person reads");
  expect(withError.status).toBe(409);
  expect(withError.body.code).toBe("spend_cap");

  const withoutError = new DirectSendRefused(400, {});
  expect(withoutError.message).toBe("send refused");
});