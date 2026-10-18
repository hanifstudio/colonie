// The decision half of answering a staged skill request. Only the two cheap
// ends are testable without a real card: a request that is not this bot's card
// must claim nothing, and the HTTP shape must say "handled" only when it was.
import { expect, test } from "vitest";
import { createSkillResolution } from "./skill-resolution.ts";

const skill = (messages: unknown[] = []) =>
  createSkillResolution({ store: { messagesFor: () => messages, patchMessage: () => undefined } as never });

const args = { botId: "b1", threadId: "t1", requestId: "r1", behavior: "allow" as const };

test("a request this thread has no card for claims nothing", () => {
  const { resolveSkillRequest } = skill([]);

  expect(resolveSkillRequest(args)).toEqual({ claimed: false });
});

test("a card that is not a skill request claims nothing either", () => {
  const { resolveSkillRequest } = skill([{ id: "m1", card: { requestId: "r1" } }]);

  expect(resolveSkillRequest(args)).toEqual({ claimed: false });
});

test("the HTTP shape answers only what was claimed", () => {
  const { sendSkillResolution } = skill();
  const sent: Array<{ status: number; body: unknown }> = [];
  const res = asRes(sent);

  expect(sendSkillResolution(res, { claimed: false })).toBe(false);
  expect(sent).toEqual([]);

  expect(sendSkillResolution(res, { claimed: true, status: 403, error: "Only the asker may answer." })).toBe(true);
  expect(sent).toEqual([{ status: 403, body: { error: "Only the asker may answer." } }]);

  expect(sendSkillResolution(res, { claimed: true, outcome: "allowed-once" })).toBe(true);
  expect(sent[1]).toEqual({ status: 200, body: { ok: true, outcome: "allowed-once", alreadySettled: undefined } });
});

// `json()` writes a status and then the body; for the mapping test a recorder
// standing where the response would be is enough.
function asRes(sent: Array<{ status: number; body: unknown }>) {
  let status = 0;
  return {
    headersSent: false,
    setHeader: () => {},
    writeHead: (value: number) => { status = value; },
    end: (data: string) => { sent.push({ status, body: JSON.parse(data) }); },
  } as never;
}