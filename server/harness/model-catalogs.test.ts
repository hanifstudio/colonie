// The model picker hears about a model list when it lands.
//
// An engine learns its models in the background after it is created
// (startupModelRefresh). That happens at start, after a whole-fleet reload
// (settings that change the engines), and after one engine is replaced (its
// own settings, or a new account). Each time, the open picker has to be told
// once the list is in, or it keeps showing only the default model.
// announceWhenModelsLand is the one place that does the telling.
import { expect, test, vi } from "vitest";

import { announceWhenModelsLand } from "./model-catalogs.ts";
import type { ProviderInstance } from "../contracts.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const engine = (startupModelRefresh?: Promise<void>) => ({ startupModelRefresh }) as unknown as ProviderInstance;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("announces after the list lands, not before", async () => {
  const discovery = deferred();
  const announce = vi.fn();
  void announceWhenModelsLand([engine(discovery.promise)], announce);
  await tick();
  expect(announce).not.toHaveBeenCalled();
  discovery.resolve();
  await tick();
  expect(announce).toHaveBeenCalledTimes(1);
});

test("announces once for each engine whose list lands", async () => {
  const first = deferred();
  const second = deferred();
  const announce = vi.fn();
  const all = announceWhenModelsLand([engine(first.promise), engine(), engine(second.promise)], announce);
  first.resolve();
  await tick();
  expect(announce).toHaveBeenCalledTimes(1);
  second.resolve();
  await all;
  expect(announce).toHaveBeenCalledTimes(2);
});

test("resolves at once when no engine is discovering", async () => {
  const announce = vi.fn();
  await announceWhenModelsLand([engine(), engine()], announce);
  expect(announce).not.toHaveBeenCalled();
});

test("a failed discovery is not announced and does not fail the others", async () => {
  const failing = deferred();
  const working = deferred();
  const announce = vi.fn();
  const all = announceWhenModelsLand([engine(failing.promise), engine(working.promise)], announce);
  failing.reject(new Error("engine would not start"));
  working.resolve();
  await expect(all).resolves.toBeUndefined();
  expect(announce).toHaveBeenCalledTimes(1);
});

test("an announcement that throws does not break the others", async () => {
  // The announcement reads live server state; one bad read must not stop the
  // next engine's announcement or surface as an unhandled rejection.
  const first = deferred();
  const second = deferred();
  const announce = vi.fn().mockImplementationOnce(() => { throw new Error("status unavailable"); });
  const all = announceWhenModelsLand([engine(first.promise), engine(second.promise)], announce);
  first.resolve();
  second.resolve();
  await expect(all).resolves.toBeUndefined();
  expect(announce).toHaveBeenCalledTimes(2);
});
