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

export function colonieInstances(configured: InstanceConfigMap | undefined, nativeBase: string): InstanceConfigMap {
  const isolated = (entry: InstanceConfig): InstanceConfig => ({
    ...entry,
    environment: { ...entry.environment, ...isolationEnvironment(entry.driver, nativeBase) },
  });
  if (configured && Object.keys(configured).length) {
    const result = Object.fromEntries(
      Object.entries(configured)
        .filter(([, entry]) => isColonieAcpDriver(entry.driver))
        .map(([id, entry]) => [id, isolated(entry)]),
    );
    if (Object.keys(result).length && !Object.values(result).some((entry) => entry.driver === "claude-acp")) {
      result["claude-acp"] = isolated({ driver: "claude-acp", displayName: "Claude · ACP", icon: { kind: "preset", preset: "anthropic" } });
    }
    return result;
  }
  return {
    "codex-acp": isolated({ driver: COLONIE_DRIVER, displayName: "Codex · ACP", icon: { kind: "preset", preset: "openai" } }),
    "claude-acp": isolated({ driver: "claude-acp", displayName: "Claude · ACP", icon: { kind: "preset", preset: "anthropic" } }),
  };
}