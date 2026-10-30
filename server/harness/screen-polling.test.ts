// The poller table is created and dropped per turn, so the two ways it is
// reached without a turn — a poke for a thread nobody polls, and a teardown
// sweep — must stay inert rather than throw.
import { expect, test, vi } from "vitest";
import { createScreenPolling } from "./screen-polling.ts";

const build = () =>
  createScreenPolling({
    botForThread: () => undefined,
    broadcast: () => {},
    currentBrowserSession: () => undefined,
    store: { taskByThread: () => undefined, messagesFor: () => [] },
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

test("browser previews work without desktop services and discard a frame after turn ownership changes", async () => {
  const owner = { generation: "turn-one" };
  const owners = new Map([["thread-1", owner]]);
  const broadcast = vi.fn();
  let finish: ((frame: { png: string; format: string }) => void) | undefined;
  const poller = createScreenPolling({
    botForThread: () => ({ browserProfile: undefined }),
    currentBrowserSession: () => "bot-browser",
    broadcast,
    store: { taskByThread: () => ({}), messagesFor: () => [] },
    turnResourceOwners: owners,
    turnResources: { owns: (resource: string) => resource === "browser:bot-browser" },
  });
  poller.startScreenPoller("bot-1", "thread-1", {
    browser: () => new Promise((resolve) => { finish = resolve; }),
  }, { screenIsTheWork: true });
  try {
    const first = poller.screenPollers.get("thread-1")!.capture(true);
    finish!({ png: "first-browser-frame", format: "png" });
    await first;
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ kind: "screen", png: "first-browser-frame" }));
    broadcast.mockClear();
    const next = poller.screenPollers.get("thread-1")!.capture(true);
    owners.set("thread-1", { generation: "turn-two" });
    finish!({ png: "stale-browser-frame", format: "png" });
    await next;
    expect(broadcast).not.toHaveBeenCalled();
  } finally { poller.stopScreenPoller("bot-1", "thread-1"); }
});
