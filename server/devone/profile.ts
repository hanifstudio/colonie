import { DEVONE_DRIVER, isColonieAcpDriver } from "../../shared/devone.ts";
import type { InstanceConfigMap } from "../contracts.ts";

export const devoneProfile = () => process.env.COLONIE_PROFILE === "1" || process.env.DEVONE_PROFILE === "1";

export function devoneInstances(configured?: InstanceConfigMap): InstanceConfigMap {
  if (configured && Object.keys(configured).length) {
    const result = Object.fromEntries(Object.entries(configured).filter(([, entry]) => isColonieAcpDriver(entry.driver)));
    if (Object.keys(result).length && !Object.values(result).some((entry) => entry.driver === "claude-acp")) result["claude-acp"] = { driver: "claude-acp", displayName: "Claude · ACP", icon: { kind: "preset", preset: "anthropic" } };
    return result;
  }
  return { "codex-acp": { driver: DEVONE_DRIVER, displayName: "Codex · ACP", icon: { kind: "preset", preset: "openai" } }, "claude-acp": { driver: "claude-acp", displayName: "Claude · ACP", icon: { kind: "preset", preset: "anthropic" } } };
}
