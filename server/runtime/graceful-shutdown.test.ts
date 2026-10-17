import { expect, test, vi } from "vitest";
import { createGracefulShutdown } from "./graceful-shutdown.ts";

test("runs every cleanup job once and exits 0, even if stop is called twice", async () => {
  const done: string[] = [];
  const exit = vi.fn();
  const stop = createGracefulShutdown({
    cleanup: [() => void done.push("sync"), async () => void done.push("async")],
    exit,
  });

  stop();
  stop();

  await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
  expect(exit).toHaveBeenCalledWith(0);
  expect(done.sort()).toEqual(["async", "sync"]);
});

test("a wedged cleanup job cannot hold the process past the timeout", async () => {
  const exit = vi.fn();
  const stop = createGracefulShutdown({
    cleanup: [() => new Promise<void>(() => {})],
    exit,
    timeoutMs: 10,
  });

  stop();

  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
});