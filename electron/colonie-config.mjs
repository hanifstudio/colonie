import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Native sessions pin absolute cwds: the data dir lives at ~/.colonie.
export function colonieDataDir(home, env = process.env) {
  return env.COLONIE_DATA_DIR || join(home, ".colonie");
}

export function colonieUserData(appData, env = process.env) {
  return env.COLONIE_USER_DATA || join(appData, "Colonie");
}

export function initializeColonieData(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const config = join(dataDir, "config.json");
  if (!existsSync(config)) writeFileSync(config, JSON.stringify({
    // A fresh install is not onboarding-complete: the welcome flow decides
    // for itself. Marking it done here (as phase 1 did to suppress the
    // inherited flow) hid onboarding from every new user.
    language: "en", onboarding: { completedAt: "", version: 0, reelSeen: false, hintsSeen: [] },
    defaultModelSelection: { instanceId: "codex-acp", model: "agent-default" },
    features: { showToolCalls: true, llmThreadTitles: false, autoRecall: false, skillAuthoring: false, skillsLibrary: false },
    instances: {
      "codex-acp": { driver: "codex-acp", displayName: "Codex · ACP", icon: { kind: "preset", preset: "openai" } },
      "claude-acp": { driver: "claude-acp", displayName: "Claude · ACP", icon: { kind: "preset", preset: "anthropic" } },
    },
  }, null, 2), { mode: 0o600 });
}
