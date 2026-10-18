// The saved-command guard is the cheap entry check in front of the allowlist,
// so each refusal reason is worth pinning; providerLabel names engines in chat.
import { expect, test } from "vitest";
import { createChatRequests } from "./requests.ts";

const build = (over: Record<string, unknown> = {}) =>
  createChatRequests({
    canManageCommandAllowlist: () => true,
    pendingCommandRules: new Map<string, unknown>(),
    TURN_STALL_MS: () => 60_000,
    ...over,
  } as never);

test("a non-manager may not save a command permission", () => {
  const { commandRememberRefusal } = build({ canManageCommandAllowlist: () => false });
  expect(commandRememberRefusal({} as never, "t1", "r1", "allow"))
    .toBe("Only the owner or an admin can save bot-wide command permissions.");
});

test("only an allow with a pending rule can be saved", () => {
  const { commandRememberRefusal } = build();
  expect(commandRememberRefusal({} as never, "t1", "r1", "deny")).toContain("Allow it once instead");
  expect(commandRememberRefusal({} as never, "t1", "r1", "allow")).toContain("Allow it once instead");
});

test("an allow with a pending rule is accepted", () => {
  const { commandRememberRefusal } = build({ pendingCommandRules: new Map([["t1:r1", {}]]) });
  expect(commandRememberRefusal({} as never, "t1", "r1", "allow")).toBeNull();
});

test("providerLabel names the driver for chat", () => {
  const { providerLabel } = build();
  expect(providerLabel("claudeAgent")).toBe("Claude");
  expect(providerLabel("codexAgent")).toBe("Codex");
  expect(providerLabel("openhands")).toBe("Openhands");
});