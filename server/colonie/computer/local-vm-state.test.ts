// The cheap activity gate decides whether a computer is treated as in use, so
// the busy and direct-dispatch branches are the paths worth pinning.
import { expect, test } from "vitest";
import { createLocalVmState } from "./local-vm-state.ts";

const build = (over: Record<string, unknown> = {}) =>
  createLocalVmState({
    store: { bot: () => undefined },
    hasDirectDispatch: () => false,
    ...over,
  } as never);

test("a busy bot has an active turn", () => {
  const { botHasActiveTurn } = build({ store: { bot: () => ({ busy: true }) } });
  expect(botHasActiveTurn("b1")).toBe(true);
});

test("a direct dispatch counts as an active turn", () => {
  const { botHasActiveTurn } = build({ hasDirectDispatch: () => true });
  expect(botHasActiveTurn("b1")).toBe(true);
});

test("an idle bot with no dispatch has no active turn", () => {
  const { botHasActiveTurn } = build();
  expect(botHasActiveTurn("b1")).toBe(false);
});

test("the computer-control key is the bot id", () => {
  const { botComputerControlKey } = build();
  expect(botComputerControlKey({ id: "b1" } as never)).toBe("b1");
});