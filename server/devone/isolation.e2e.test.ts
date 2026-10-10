import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-omb.ts";

it.each([
  ["codex-acp", "acp-fixture-state.json", "CODEX_HOME", "codex"],
  ["claude-acp", "claude-fixture-state.json", "CLAUDE_CONFIG_DIR", "claude"],
] as const)("spawns %s with its own config dir under the app data dir, not the user's CLI", async (provider, stateFile, envKey, dirName) => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["devone"]);
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const value = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value as any;
  };
  try {
    const { bot } = await api("POST", "/api/bots", { name: "Isolation fixture", modelSelection: { instanceId: provider, model: "agent-default" }, computer: "off" });
    await api("POST", `/api/bots/${bot.id}/acp-settings`, { threadId: bot.threadId });
    await expect.poll(() => {
      try { return JSON.parse(readFileSync(join(dataDir, stateFile), "utf8")).environment?.[envKey] ?? null; }
      catch { return null; }
    }, { timeout: 20_000 }).toBe(join(dataDir, "native", dirName));
  } finally {
    await fixture.close();
  }
});