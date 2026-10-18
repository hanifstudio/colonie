// The picker asks which sign-in family an engine belongs to. In the system the
// app now runs, the accounts a person signs in to are `claude-acp`/`codex-acp`;
// recognising only the inherited drivers hid every account from that grouping.
import { describe, expect, it } from "vitest";
import { isClaudeAccount, signInFamily } from "./engine-rail.ts";

describe("sign-in families", () => {
  it("recognises the maintained engines as the accounts a person signs in to", () => {
    expect(signInFamily({ driverKind: "claude-acp" })).toBe("claude");
    expect(signInFamily({ driverKind: "codex-acp" })).toBe("openai");
    expect(isClaudeAccount({ driverKind: "claude-acp" })).toBe(true);
  });

  it("still recognises the inherited drivers, and never claims a pasted-key engine", () => {
    expect(signInFamily({ driverKind: "claudeAgent" })).toBe("claude");
    expect(signInFamily({ driverKind: "codex" })).toBe("openai");
    expect(signInFamily({ driverKind: "claude-acp", access: "api" })).toBeUndefined();
    expect(signInFamily({ driverKind: "openai-compat" })).toBeUndefined();
    expect(signInFamily(undefined)).toBeUndefined();
  });
});
