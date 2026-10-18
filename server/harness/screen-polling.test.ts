// The poller table is created and dropped per turn, so the two ways it is
// reached without a turn — a poke for a thread nobody polls, and a teardown
// sweep — must stay inert rather than throw.
import { expect, test } from "vitest";
import { createScreenPolling } from "./screen-polling.ts";

const build = () =>
  createScreenPolling({
    botComputerControlSnapshot: () => ({ held: false }),
    botForThread: () => undefined,
    broadcast: () => {},
    computerControlRevision: new Map(),
    currentBrowserSession: () => undefined,
    store: { taskByThread: () => undefined, messagesFor: () => [] },
    turnComputerResources: new Map(),
    turnResourceOwners: new Map(),
    turnResources: { owns: () => true, free: () => true },
  } as never);

test("a poller with no capture is never registered", () => {
  const { startScreenPoller, screenPollers } = build();
  startScreenPoller("bot-1", "thread-1", {});
  expect(screenPollers.size).toBe(0);
});

test("a poke and a teardown with no poller are no-ops", async () => {
  const { pokeScreenPoller, stopScreenPoller, finalScreenFrame, screenPollers } = build();
  pokeScreenPoller("thread-1", true, "computer");
  stopScreenPoller("bot-1", "thread-1");
  expect(await finalScreenFrame("bot-1", "thread-1")).toBeNull();
  expect(screenPollers.size).toBe(0);
});