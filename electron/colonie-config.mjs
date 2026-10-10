import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Native sessions pin absolute cwds: reuse legacy paths in place, don't move them.
export function colonieDataDir(home, env = process.env) {
  if (env.COLONIE_DATA_DIR || env.OMB_DATA_DIR) return env.COLONIE_DATA_DIR || env.OMB_DATA_DIR;
  const legacy = join(home, ".devone");
  return existsSync(join(legacy, "config.json")) ? legacy : join(home, ".colonie");
}

export function colonieUserData(appData, env = process.env) {
  if (env.COLONIE_USER_DATA || env.DEVONE_USER_DATA) return env.COLONIE_USER_DATA || env.DEVONE_USER_DATA;
  const legacy = join(appData, "DevOne");
  return existsSync(legacy) ? legacy : join(appData, "Colonie");
}

export function initializeColonieData(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const config = join(dataDir, "config.json");
  if (!existsSync(config)) writeFileSync(config, JSON.stringify({
    language: "en", onboarding: { completedAt: new Date().toISOString(), version: 1, hintsSeen: [
      "tour.composer", "tour.model", "tour.computer", "tour.computer-browser", "tour.tools",
      "tour.apps", "tour.apps-panel", "tour.automations", "tour.automations-page", "tour.done",
    ] },
    defaultModelSelection: { instanceId: "codex-acp", model: "agent-default" },
    features: { showToolCalls: true, llmThreadTitles: false, autoRecall: false, skillAuthoring: false, skillsLibrary: false },
    instances: {
      "codex-acp": { driver: "codex-acp", displayName: "Codex · ACP", icon: { kind: "preset", preset: "openai" } },
      "claude-acp": { driver: "claude-acp", displayName: "Claude · ACP", icon: { kind: "preset", preset: "anthropic" } },
    },
  }, null, 2), { mode: 0o600 });
}
