// The browser feature's process-local construction: one BrowserRuntime and the
// viewer that mirrors it, the map of throwaway guest sessions, and the cleanup
// outbox. There is no engine binary in the test environment, so the cases here
// pin the session addressing every caller depends on: a guest session is minted
// once per bot and forgotten on demand, a configured profile addresses its own
// partition, and a plain bot addresses its own session.
import { expect, test } from "vitest";
import { browserSessionId } from "./browser-engine.ts";
import { createBrowserSessions } from "./browser-sessions.ts";

const profile = { id: "work", partitionId: "persist:work" };

const sessions = (over: Record<string, unknown> = {}) =>
  createBrowserSessions({
    cfg: { browserProfiles: [profile] },
    ...over,
  });

test("a guest session is minted once and reused for the same bot", () => {
  const { currentBrowserSession } = sessions();
  const first = currentBrowserSession("b1", "guest");
  const second = currentBrowserSession("b1", "guest");
  expect(first).toMatch(/^guest-/);
  expect(second).toBe(first);
  // A guest never lands on the bot's own (persisted) session address.
  expect(first).not.toBe(browserSessionId("b1", ""));
});

test("two bots get distinct guest sessions", () => {
  const { currentBrowserSession } = sessions();
  expect(currentBrowserSession("b1", "guest")).not.toBe(currentBrowserSession("b2", "guest"));
});

test("a configured profile addresses its own partition", () => {
  const { currentBrowserSession, temporaryBrowserSessions } = sessions();
  expect(currentBrowserSession("b1", "work")).toBe(browserSessionId("b1", "persist:work"));
  // A named profile is stable, not a throwaway: nothing to forget later.
  expect(temporaryBrowserSessions.has("b1")).toBe(false);
});

test("an unknown profile falls back to the bot's own session", () => {
  const { currentBrowserSession } = sessions();
  expect(currentBrowserSession("b1", "nope")).toBe(browserSessionId("b1", ""));
});

test("forgetting a guest session mints a new one next time", async () => {
  const { currentBrowserSession, forgetTemporaryBrowser } = sessions();
  const before = currentBrowserSession("b1", "guest");
  await forgetTemporaryBrowser("b1");
  const after = currentBrowserSession("b1", "guest");
  expect(after).not.toBe(before);
  expect(after).toMatch(/^guest-/);
});

test("forgetting a bot with no guest session is a no-op", async () => {
  const { forgetTemporaryBrowser } = sessions();
  await expect(forgetTemporaryBrowser("b1")).resolves.toBeUndefined();
});
