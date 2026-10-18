// Electron's private channel is the only place privileged approval transitions
// may come from, so the cheap ends matter: a message that is not one of these
// must claim nothing (the caller keeps going), and a message that is one of
// these but is malformed must be answered without acting.
import { expect, test } from "vitest";
import { createTrustedApprovalMessageHandler } from "./trusted-approval-message.ts";

const deps = () => {
  const posted: unknown[] = [];
  const patched: unknown[] = [];
  const handler = createTrustedApprovalMessageHandler({
    store: {
      bot: () => undefined,
      tasks: () => [],
      projectBotForTask: () => undefined,
      patchBot: (id: string, patch: unknown) => { patched.push([id, patch]); return undefined; },
    } as never,
    registry: { get: () => undefined, cliTarget: () => undefined },
    broadcast: () => {},
    threadBusy: () => false,
    supportsApprovalMode: () => true,
    checkedTaskModelSwitch: () => ({ ok: false, error: "no" }),
    postDesktopPrivateMessage: (message: unknown) => { posted.push(message); },
    stopBotForEmergencyApprovalDowngrade: async () => {},
    wireBot: (bot: unknown) => bot,
    wireTrustedApprovalBot: (bot: unknown) => bot,
  });
  return { handler, posted, patched };
};

test("a message that is not one of ours claims nothing", () => {
  const { handler, posted } = deps();

  for (const raw of [null, undefined, "text", 7, [], [1, 2]]) {
    expect(handler(raw)).toBe(false);
  }
  expect(posted).toEqual([]);
});

test("an object with no type claims nothing", () => {
  const { handler, posted } = deps();

  expect(handler({})).toBe(false);
  expect(handler({ type: "something-else" })).toBe(false);
  expect(posted).toEqual([]);
});

test("a commit with an unusable request id is answered without acting", () => {
  const { handler, posted, patched } = deps();

  expect(handler({ type: "approval-trusted-mode-commit", requestId: "not an id!" })).toBe(true);
  expect(posted).toEqual([]);
  expect(patched).toEqual([]);
});

test("a commit that names no bot or no elevated mode is answered without acting", () => {
  const { handler, posted, patched } = deps();

  expect(handler({ type: "approval-trusted-mode-commit", requestId: "r1" })).toBe(true);
  expect(handler({ type: "approval-trusted-mode-commit", requestId: "r1", botId: "b1", mode: "ask" })).toBe(true);
  expect(posted).toEqual([]);
  expect(patched).toEqual([]);
});