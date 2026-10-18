// Two marks decide whether a finished turn is mail for the person: an
// unattended (webhook-driven) thread, and a turn another bot started.
import { expect, test, vi } from "vitest";
import { createTurnOrigins } from "./turn-origins.ts";

function build(busy = false) {
  return createTurnOrigins({ threadBusy: () => busy } as never);
}

test("an unattended mark is per conversation, not per bot", () => {
  const { markUnattended, clearUnattended, isUnattended } = build();
  markUnattended("b1", "t1");
  expect(isUnattended("b1", "t1")).toBe(true);
  // A sibling conversation typed into by the person stays attended.
  expect(isUnattended("b1", "t2")).toBe(false);
  expect(isUnattended("b2", "t1")).toBe(false);
  clearUnattended("t1");
  expect(isUnattended("b1", "t1")).toBe(false);
});

test("a call without a thread fails closed on any of the bot's marks", () => {
  const { markUnattended, isUnattended } = build();
  expect(isUnattended(undefined, "t1")).toBe(false);
  expect(isUnattended("b1")).toBe(false);
  markUnattended("b1", "t9");
  expect(isUnattended("b1")).toBe(true);
  expect(isUnattended("b2")).toBe(false);
});

test("an idle mark ages out, a busy one never does", () => {
  vi.useFakeTimers();
  try {
    const idle = build(false);
    idle.markUnattended("b1", "t1");
    vi.advanceTimersByTime(31 * 60_000);
    expect(idle.isUnattended("b1", "t1")).toBe(false);

    const busy = build(true);
    busy.markUnattended("b1", "t2");
    vi.advanceTimersByTime(31 * 60_000);
    // The turn is still running, so its next approval can still be unattended.
    expect(busy.isUnattended("b1", "t2")).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("every positive read refreshes the inactivity window", () => {
  vi.useFakeTimers();
  try {
    const origins = build(false);
    origins.markUnattended("b1", "t1");
    vi.advanceTimersByTime(29 * 60_000);
    expect(origins.isUnattended("b1", "t1")).toBe(true);
    vi.advanceTimersByTime(29 * 60_000);
    // A mark read less than the window ago has not aged out.
    expect(origins.isUnattended("b1", "t1")).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("a peer-started turn is marked and cleared by thread", () => {
  const { markInternalTurn, clearInternalTurn, isInternalTurn } = build();
  expect(isInternalTurn("t1")).toBe(false);
  markInternalTurn("t1");
  expect(isInternalTurn("t1")).toBe(true);
  // Every dispatch rewrites the flag; a later person turn clears it.
  clearInternalTurn("t1");
  expect(isInternalTurn("t1")).toBe(false);
});
