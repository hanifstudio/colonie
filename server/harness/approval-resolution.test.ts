// The approval level a turn runs at is a security boundary: an unimplemented
// elevated level must fall back to Ask, and a level must belong to the
// conversation that asked, never a sibling or the bot's future default.
import { expect, test } from "vitest";
import { createApprovalResolution } from "./approval-resolution.ts";

function build(options: {
  supports?: boolean;
  connector?: { bot: { approvalMode?: string } } | null;
  task?: { approvalMode?: string } | undefined;
} = {}) {
  return createApprovalResolution({
    connectorThread: () => () => options.connector ?? null,
    store: { projectBotForTask: () => options.task },
    supportsApprovalMode: () => options.supports ?? true,
  } as never);
}

test("an implemented elevated level is passed through", () => {
  const { approvalModeForTurn } = build();
  expect(approvalModeForTurn({ approvalMode: "full", modelSelection: {} } as never)).toBe("full");
});

test("a provider with no mapping for the level falls back to Ask", () => {
  const { approvalModeForTurn } = build({ supports: false });
  expect(approvalModeForTurn({ approvalMode: "full", modelSelection: {} } as never)).toBe("ask");
});

test("a peer-initiated custom level becomes the provider's Auto", () => {
  const { approvalModeForTurn } = build();
  expect(approvalModeForTurn({ approvalMode: "custom", modelSelection: {} } as never, true)).toBe("auto");
  // The person's own turn keeps Custom.
  expect(approvalModeForTurn({ approvalMode: "custom", modelSelection: {} } as never, false)).toBe("custom");
});

test("a conversation with no connector thread asks", () => {
  const { sourceApprovalMode, fullAccessForSource } = build({ connector: null });
  expect(sourceApprovalMode("b1", "t1")).toBe("ask");
  expect(fullAccessForSource("b1", "t1")).toBe(false);
});

test("the level belongs to the conversation's own bot, not a sibling", () => {
  // The task-level bot differs from the owner's own default.
  const { sourceApprovalMode, fullAccessForSource } = build({
    connector: { bot: { approvalMode: "ask" } },
    task: { approvalMode: "full" },
  });
  expect(sourceApprovalMode("b1", "t1")).toBe("full");
  expect(fullAccessForSource("b1", "t1")).toBe(true);
  // With no task override the owner bot's own level is used.
  const plain = build({ connector: { bot: { approvalMode: "edits" } } });
  expect(plain.fullAccessForSource("b1", "t1")).toBe(false);
});
