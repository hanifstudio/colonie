import { join } from "node:path";
import { COLONIE_DRIVER, isColonieAcpDriver } from "../../shared/acp.ts";
import type { InstanceConfig, InstanceConfigMap } from "../contracts.ts";

export const colonieProfile = () => process.env.COLONIE_PROFILE === "1";

/** Every ACP engine runs with its own config directory under the app's data
 * dir, so Colonie's sessions and sign-in never touch the user's own CLI state
 * (`~/.codex`, `~/.claude`). This is simply how Colonie runs — not a mode. */
const ACP_CONFIG_DIR_ENV: Record<string, { env: string; dir: string }> = {
  "codex-acp": { env: "CODEX_HOME", dir: "codex" },
  "claude-acp": { env: "CLAUDE_CONFIG_DIR", dir: "claude" },
};

/** Directory names under `native/` that the isolation target needs to exist. */
export function acpIsolationDirNames(): string[] {
  return Object.values(ACP_CONFIG_DIR_ENV).map((entry) => entry.dir);
}

function isolationEnvironment(driver: string, nativeBase: string): Record<string, string> {
  const entry = ACP_CONFIG_DIR_ENV[driver];
  return entry ? { [entry.env]: join(nativeBase, entry.dir) } : {};
}

/** The Colonie fleet's default pair: the two maintained ACP engines. */
function defaultFleet(isolated: (entry: InstanceConfig) => InstanceConfig): InstanceConfigMap {
  return {
    "codex-acp": isolated({ driver: COLONIE_DRIVER, displayName: "Codex · ACP", icon: { kind: "preset", preset: "openai" } }),
    "claude-acp": isolated({ driver: "claude-acp", displayName: "Claude · ACP", icon: { kind: "preset", preset: "anthropic" } }),
  };
}

export function colonieInstances(configured: InstanceConfigMap | undefined, nativeBase: string): InstanceConfigMap {
  const isolated = (entry: InstanceConfig): InstanceConfig => ({
    ...entry,
    // An explicitly configured directory (a named account, say) wins over the default
    // per-engine directory: isolation is the default, not a ceiling.
    environment: { ...isolationEnvironment(entry.driver, nativeBase), ...entry.environment },
  });
  const entries = Object.entries(configured ?? {});
  const usable = entries.filter(([, entry]) => isColonieAcpDriver(entry.driver));
  // Silence is what turns this into apparent data loss: the person configured an engine,
  // the Colonie fleet runs only the maintained ACP adapters, and the engine is simply
  // absent from the list with nothing said anywhere.
  const leftOut = entries.filter(([, entry]) => !isColonieAcpDriver(entry.driver)).map(([id, entry]) => `${id} (${entry.driver})`);
  if (leftOut.length) {
    console.warn(`instances: not started in this profile because the fleet runs only the maintained ACP engines: ${leftOut.join(", ")}`);
  }
  const result = Object.fromEntries(usable.map(([id, entry]) => [id, isolated(entry)]));
  // A configured fleet whose engines cannot run here must not leave the person with no
  // engines at all; the default pair is the floor.
  if (!Object.keys(result).length) return defaultFleet(isolated);
  if (!Object.values(result).some((entry) => entry.driver === "claude-acp")) {
    result["claude-acp"] = isolated({ driver: "claude-acp", displayName: "Claude · ACP", icon: { kind: "preset", preset: "anthropic" } });
  }
  return result;
}