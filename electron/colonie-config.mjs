import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Native sessions pin absolute cwds: the data dir lives at ~/.colonie.
export function colonieDataDir(home, env = process.env) {
  return env.COLONIE_DATA_DIR || join(home, ".colonie");
}

/**
 * The folder workspaces are placed under: the person's home, unless the source
 * launcher moved development onto its own data (see developmentData).
 */
export function colonieHome(home, env = process.env) {
  return env.COLONIE_HOME || home;
}

/**
 * Where `pnpm colonie` keeps its data. By default a development run gets its
 * own home and app folder, so a source checkout never opens the person's real
 * workspaces. `--real-data`, or a COLONIE_DATA_DIR already chosen in the shell,
 * keeps the normal locations. Returns the variables to add to the environment.
 */
export function developmentData(home, argv, env = process.env) {
  if (argv.includes("--real-data") || env.COLONIE_DATA_DIR) return {};
  const root = env.COLONIE_HOME || join(home, ".colonie-dev-data");
  return { COLONIE_HOME: root, COLONIE_USER_DATA: env.COLONIE_USER_DATA || join(root, "app") };
}

export function colonieUserData(appData, env = process.env) {
  return env.COLONIE_USER_DATA || join(appData, "Colonie");
}

/**
 * Electron's application-data folder, for a launcher that must read a file
 * Electron owns (the workspace list) before Electron starts. Inside the app
 * `app.getPath("appData")` is the authority; this mirrors it for the three
 * platforms. A divergence only misplaces a developer's workspace switch — it
 * is never the running data directory.
 */
export function colonieAppData(home, env = process.env, platform = process.platform) {
  if (platform === "win32") return env.APPDATA || join(home, "AppData", "Roaming");
  if (platform === "darwin") return join(home, "Library", "Application Support");
  return env.XDG_CONFIG_HOME || join(home, ".config");
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
