// Named accounts must be the engine this app actually runs. While these flows
// created the inherited `claudeAgent`/`codex` drivers, the fleet that runs now
// dropped them: a person added an account, the request succeeded, and no engine
// appeared.
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config.ts";
import type { InstanceConfig } from "../../contracts.ts";
import { newClaudeAccount, newCodexAccount, setClaudeAccountDirectory } from "./claude-accounts.ts";

const cfgOf = (instances: Record<string, InstanceConfig> = {}) => ({ instances }) as unknown as AppConfig;
const directoryOf = (entry: InstanceConfig) => (entry.config as { configDir?: string } | undefined)?.configDir;

describe("named accounts", () => {
  it("creates a Claude account as the engine this app runs, with a directory of its own", () => {
    const { instanceId, instances } = newClaudeAccount(cfgOf(), { displayName: "Second account" });
    const entry = instances[instanceId]!;

    expect(entry.driver).toBe("claude-acp");
    expect(entry.displayName).toBe("Second account");
    expect(directoryOf(entry)).toContain(instanceId);
    expect(entry.environment?.CLAUDE_CONFIG_DIR).toBe(directoryOf(entry));
  });

  it("writes a changed directory to the engine and the account card together", () => {
    const { instanceId, instances } = newClaudeAccount(cfgOf(), { displayName: "Second account", configDir: "/tmp/account-a" });
    const entry = instances[instanceId]!;
    expect(entry.environment?.CLAUDE_CONFIG_DIR).toBe("/tmp/account-a");

    setClaudeAccountDirectory(entry, "/tmp/account-b");

    expect(directoryOf(entry)).toBe("/tmp/account-b");
    expect(entry.environment?.CLAUDE_CONFIG_DIR).toBe("/tmp/account-b");
  });

  it("refuses a second account on a directory already in use", () => {
    const first = newClaudeAccount(cfgOf(), { displayName: "First", configDir: "/tmp/account-shared" });
    const saved = { instances: first.instances } as unknown as AppConfig;

    expect(() => newClaudeAccount(saved, { displayName: "Second", configDir: "/tmp/account-shared" })).toThrow(/already configured/);
  });

  it("creates a ChatGPT account as the Codex engine with a home of its own", () => {
    const { instanceId, instances } = newCodexAccount(cfgOf(), "Work account");
    const entry = instances[instanceId]!;

    expect(entry.driver).toBe("codex-acp");
    expect(entry.displayName).toBe("Work account");
    expect(entry.environment?.CODEX_HOME).toContain(instanceId);
  });
});
