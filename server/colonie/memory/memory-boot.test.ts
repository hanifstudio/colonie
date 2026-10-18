// Memory booting must never be a boot dependency, but once it is up its
// lifecycle wiring has to hold: a deleted bot leaves no queued capture behind,
// and a settled turn stops counting as a memory source the moment it is read.
import { expect, test } from "vitest";
import type { RuntimeEvent } from "../../contracts.ts";
import { createColonieMemoryBoot } from "./memory-boot.ts";

function build(options: { ignored?: boolean } = {}) {
  const changeHandlers: Array<(change: { type: string; botId: string }) => void> = [];
  const busHandlers: Array<(event: RuntimeEvent) => void> = [];
  const cancelled: string[] = [];
  const sources = new Map<string, { botId: string; threadId: string; text: string }>();
  const boot = createColonieMemoryBoot({
    bus: { subscribe: (handler: (event: RuntimeEvent) => void) => { busHandlers.push(handler); return () => {}; } },
    cfg: {},
    colonieChief: { cancelBot: (botId: string) => cancelled.push(botId) },
    colonieMemorySources: sources,
    registry: { get: () => undefined },
    shouldIgnoreProviderEvent: () => options.ignored === true,
    store: {
      bot: () => undefined,
      taskByThread: () => undefined,
      onChange: (handler: (change: { type: string; botId: string }) => void) => { changeHandlers.push(handler); return () => {}; },
    },
  } as never);
  return { ...boot, changeHandlers, busHandlers, cancelled, sources };
}

test("booting registers one lifecycle handler and one event subscriber", () => {
  const boot = build();
  expect(boot.memoryStore).not.toBeNull();
  expect(boot.changeHandlers).toHaveLength(1);
  expect(boot.busHandlers).toHaveLength(1);
  expect(typeof boot.memory.view("b1").status.pending).toBe("number");
});

test("a deleted bot is cancelled everywhere and its captured job is dropped", () => {
  const boot = build();
  const before = boot.memoryStore!.view("b1").status.pending;
  boot.memoryStore!.enqueue({ botId: "b1", threadId: "t1", messageId: "m1", text: "hello", at: "2026-10-18" });
  boot.memoryStore!.enqueue({ botId: "b2", threadId: "t2", messageId: "m2", text: "kept", at: "2026-10-18" });
  boot.sources.set("t1", { botId: "b1", threadId: "t1", text: "hello" });
  boot.sources.set("t2", { botId: "b2", threadId: "t2", text: "kept" });
  expect(boot.memoryStore!.view("b1").status.pending).toBe(before + 2);

  boot.changeHandlers[0]!({ type: "bot.deleted", botId: "b1" });

  expect(boot.cancelled).toEqual(["b1"]);
  // Only b1's job is dropped; the other bot's capture is still waiting.
  expect(boot.memoryStore!.view("b1").status.pending).toBe(before + 1);
  // Only the deleted bot's sources go; the other bot's turn is still waiting.
  expect([...boot.sources.keys()]).toEqual(["t2"]);
});

test("a settled turn stops being a memory source once it is read", () => {
  const boot = build();
  boot.sources.set("t1", { botId: "b1", threadId: "t1", text: "hello" });
  boot.busHandlers[0]!({ type: "turn.completed", threadId: "t1", turnId: "x", ok: true } as RuntimeEvent);
  expect(boot.sources.size).toBe(0);
});

test("an event for a thread with no source is ignored", () => {
  const boot = build();
  boot.sources.set("t1", { botId: "b1", threadId: "t1", text: "hello" });
  boot.busHandlers[0]!({ type: "turn.started", threadId: "other" } as RuntimeEvent);
  boot.busHandlers[0]!({ type: "session.exited", threadId: "t1" } as RuntimeEvent);
  // The unrelated event left it alone; the exit consumed it.
  expect(boot.sources.size).toBe(0);
});

test("an ignored provider turn is dropped before any capture", () => {
  const boot = build({ ignored: true });
  const before = boot.memoryStore!.view("b1").status.pending;
  boot.sources.set("t1", { botId: "b1", threadId: "t1", text: "hello" });
  boot.busHandlers[0]!({ type: "turn.completed", threadId: "t1", turnId: "x", ok: true } as RuntimeEvent);
  expect(boot.sources.size).toBe(0);
  expect(boot.memoryStore!.view("b1").status.pending).toBe(before);
});
