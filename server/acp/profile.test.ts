import { describe, expect, it, vi } from "vitest";
import { colonieInstances } from "./profile.ts";

const NATIVE = "/tmp/native";

describe("the Colonie fleet", () => {
  it("offers the default pair when nothing is configured", () => {
    expect(Object.keys(colonieInstances(undefined, NATIVE)).sort()).toEqual(["claude-acp", "codex-acp"]);
    expect(Object.keys(colonieInstances({}, NATIVE)).sort()).toEqual(["claude-acp", "codex-acp"]);
  });

  it("keeps ACP engines and isolates each one's config directory", () => {
    const fleet = colonieInstances({
      "claude-acp": { driver: "claude-acp", displayName: "Mine", environment: { KEEP: "1" } },
      "codex-acp": { driver: "codex-acp" },
    }, NATIVE);
    expect(Object.keys(fleet).sort()).toEqual(["claude-acp", "codex-acp"]);
    expect(fleet["claude-acp"]!.environment).toEqual({ KEEP: "1", CLAUDE_CONFIG_DIR: `${NATIVE}/claude` });
    expect(fleet["codex-acp"]!.environment).toEqual({ CODEX_HOME: `${NATIVE}/codex` });
  });

  // The defect this pins down: a configuration whose engines cannot run in this profile
  // used to resolve to an empty fleet, so the person lost every engine, not just the one
  // they had just configured.
  it("falls back to the default pair instead of an empty list, and names what it left out", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fleet = colonieInstances({ "claude-named": { driver: "claudeAgent", displayName: "Second account" } }, NATIVE);
    expect(Object.keys(fleet).sort()).toEqual(["claude-acp", "codex-acp"]);
    expect(warn.mock.calls.flat().join(" ")).toContain("claude-named (claudeAgent)");
    warn.mockRestore();
  });

  it("adds a Claude ACP engine when the configured engines are all Codex", () => {
    expect(Object.keys(colonieInstances({ "codex-acp": { driver: "codex-acp" } }, NATIVE)).sort()).toEqual(["claude-acp", "codex-acp"]);
  });
});
