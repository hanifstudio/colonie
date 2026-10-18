// The bus side of the stall watchdog: the marks a room reads while it decides
// whether a busy teammate is stuck, the settle that frees a thread, and the
// direct-follow-up receipt that closes a turn's provider slot.
import { expect, test, vi } from "vitest";
import type { RuntimeEvent } from "../../contracts.ts";
import { registerTurnWatchdog } from "./turn-watchdog.ts";

interface Outcome { ok: boolean; text: string }

function build(options: { reply?: string; ignore?: boolean; owner?: { generation: string } } = {}) {
  const handlers: Array<(event: RuntimeEvent) => void> = [];
  const calls: string[] = [];
  const watchdog = {
    start: vi.fn(() => calls.push("start")),
    setWaitingOnHuman: vi.fn((threadId: string, waiting: boolean) => calls.push(`human:${threadId}:${waiting}`)),
    setWaitingOnComputer: vi.fn((threadId: string, waiting: boolean) => calls.push(`computer:${threadId}:${waiting}`)),
    settle: vi.fn((threadId: string) => calls.push(`settle:${threadId}`)),
    touch: vi.fn((threadId: string) => calls.push(`touch:${threadId}`)),
  };
  const completed: Array<{ threadId: string; turnId: string; outcome: Outcome }> = [];
  const settled: string[] = [];
  const revoked: RuntimeEvent[] = [];
  registerTurnWatchdog({
    bus: { subscribe: (handler: (event: RuntimeEvent) => void) => { handlers.push(handler); return () => {}; } },
    directFollowupTurns: {
      complete: vi.fn((threadId: string, turnId: string, outcome: Outcome) => {
        completed.push({ threadId, turnId, outcome });
        return options.owner;
      }),
    },
    revokeInternalCapabilityForProviderEvent: (event: RuntimeEvent) => revoked.push(event),
    settleDirectFollowup: (generation: string) => settled.push(generation),
    shouldIgnoreProviderEvent: () => options.ignore === true,
    store: {
      botByThread: () => ({ id: "b1" }),
      messagesFor: () => (options.reply === undefined ? [] : [{ role: "bot", kind: "text", text: options.reply, turnId: "x" }]),
    },
    watchdog,
  } as never);
  const fire = (event: Partial<RuntimeEvent>) => handlers[0]!({ threadId: "t1", ...event } as RuntimeEvent);
  return { fire, calls, completed, settled, revoked, watchdog };
}

test("the watchdog is started and fed the waiting marks", () => {
  const h = build();
  expect(h.watchdog.start).toHaveBeenCalledTimes(1);
  h.fire({ type: "request.opened" });
  h.fire({ type: "request.resolved" });
  h.fire({ type: "turn.wait_started" });
  h.fire({ type: "turn.wait_ended" });
  expect(h.calls).toEqual(["start", "human:t1:true", "human:t1:false", "computer:t1:true", "computer:t1:false"]);
});

test("a completed turn settles, revokes and closes its follow-up receipt", () => {
  const h = build({ reply: "done", owner: { generation: "g1" } });
  h.fire({ type: "turn.completed", turnId: "x", ok: true });
  expect(h.calls).toEqual(["start", "settle:t1"]);
  expect(h.completed).toEqual([{ threadId: "t1", turnId: "x", outcome: { ok: true, text: "done" } }]);
  expect(h.revoked).toHaveLength(1);
  expect(h.settled).toEqual(["g1"]);
});

test("a completed turn with no reply still carries a stand-in text", () => {
  const h = build();
  h.fire({ type: "turn.completed", turnId: "x", ok: false, stopReason: "budget" });
  // No provider reply, so the stop reason stands in for the outcome text.
  expect(h.completed[0]!.outcome).toEqual({ ok: false, text: "budget" });
  // No owner claimed the turn, so nothing was settled.
  expect(h.settled).toEqual([]);
});

test("an ignored provider event changes nothing", () => {
  const h = build({ ignore: true });
  h.fire({ type: "request.opened" });
  h.fire({ type: "turn.completed", turnId: "x", ok: true });
  expect(h.calls).toEqual(["start"]);
  expect(h.completed).toEqual([]);
  expect(h.revoked).toEqual([]);
});

test("session.exited is never a touch; any other event is", () => {
  const h = build();
  h.fire({ type: "session.exited" });
  h.fire({ type: "turn.started" });
  expect(h.calls).toEqual(["start", "touch:t1"]);
});
