// Named accounts reuse provider instances: a Claude account is the maintained
// `claude-acp` engine with a directory of its own, a ChatGPT account the
// `codex-acp` engine with a home of its own. Claude and OpenAI own login and
// credentials; removing a Colonie entry never removes its directory or signs it out.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR, persistableInstanceConfigs, type AppConfig } from "../../config.ts";
import type { InstanceConfig, InstanceConfigMap } from "../../contracts.ts";
import { CLAUDE_ACCOUNT_ENV_KEYS, resolveClaudeConfigDir } from "./claude-config.ts";
import { resolveCli } from "../../runtime/procs.ts";

const displayName = z.string().trim().min(1).max(80).refine((value) => !/\p{Cc}/u.test(value), "Name cannot contain control characters");
const configDir = z.string().trim().max(4096).refine((value) => !/\p{Cc}/u.test(value), "Directory cannot contain control characters");
export const createClaudeAccountSchema = z.object({ displayName, configDir: configDir.optional() }).strict();
export const instanceSettingsSchema = z.object({
  cli: z.string().max(4096).refine((value) => !/\p{Cc}/u.test(value), "CLI cannot contain control characters").optional(),
  displayName: displayName.optional(),
  configDir: configDir.optional(),
  tools: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "No settings supplied");

function rawConfig(entry: InstanceConfig): Record<string, unknown> {
  return entry.config && typeof entry.config === "object" && !Array.isArray(entry.config)
    ? entry.config as Record<string, unknown> : {};
}

/** Drivers that name a person's sign-in account: the inherited `claudeAgent`
 * instance and the maintained `claude-acp` engine that replaced it. */
const CLAUDE_ACCOUNT_DRIVERS = ["claudeAgent", "claude-acp"];
export function isClaudeAccountDriver(driver?: string): boolean {
  return CLAUDE_ACCOUNT_DRIVERS.some((kind) => kind === driver);
}

/** The account's directory is read from two places — the engine through its
 * environment, the sign-in card through its config — so one write sets both and
 * a changed directory can never leave the engine on the old one. */
export function setClaudeAccountDirectory(entry: InstanceConfig, directory: string | undefined): void {
  const config = { ...rawConfig(entry) };
  const environment = { ...entry.environment };
  if (directory?.trim()) {
    try {
      const resolved = resolveClaudeConfigDir(directory, { ...process.env, ...entry.environment });
      config.configDir = resolved;
      environment.CLAUDE_CONFIG_DIR = resolved;
    } catch {
      throw Object.assign(new Error("Use an absolute Claude configuration directory or a path beginning with ~/."), { status: 400 });
    }
  } else {
    delete config.configDir;
    delete environment.CLAUDE_CONFIG_DIR;
  }
  entry.config = config;
  if (Object.keys(environment).length) entry.environment = environment;
  else delete entry.environment;
}

export function accountDirectory(entry: InstanceConfig): string {
  const raw = rawConfig(entry).configDir;
  try {
    if (raw !== undefined && typeof raw !== "string") throw new Error("Invalid saved directory");
    return resolveClaudeConfigDir(raw, { ...process.env, ...entry.environment });
  } catch {
    throw Object.assign(new Error("Use an absolute Claude configuration directory or a path beginning with ~/."), { status: 400 });
  }
}

export function configuredAccountDirectory(entry: InstanceConfig): string {
  const explicit = rawConfig(entry).configDir;
  if (explicit !== undefined && typeof explicit !== "string") return accountDirectory(entry);
  return (typeof explicit === "string" && explicit.trim()) || entry.environment?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR
    ? accountDirectory(entry) : "";
}

function directoryIdentity(path: string): string {
  let canonical = path;
  try { canonical = realpathSync.native(path); } catch { /* Login may create it later. */ }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function assertSeparateClaudeAccount(map: InstanceConfigMap, id: string, entry: InstanceConfig): void {
  const directory = directoryIdentity(accountDirectory(entry));
  if (Object.entries(map).some(([otherId, other]) => {
    if (otherId === id || !isClaudeAccountDriver(other.driver)) return false;
    // A malformed saved account must not block adding or repairing another one.
    try { return directoryIdentity(accountDirectory(other)) === directory; } catch { return false; }
  })) {
    throw Object.assign(new Error("That Claude directory is already configured. Select the existing account or use a separate directory."), { status: 409 });
  }
}

export function newClaudeAccount(cfg: AppConfig, body: z.infer<typeof createClaudeAccountSchema>) {
  const instances = persistableInstanceConfigs(cfg);
  const instanceId = `claude-${randomUUID()}`;
  // Reuse the installed binary, not another account's environment/auth.
  const existing = Object.values(instances).find((entry) => isClaudeAccountDriver(entry.driver));
  const cli = existing ? rawConfig(existing).cli : undefined;
  const entry: InstanceConfig = {
    driver: "claude-acp",
    displayName: body.displayName,
    config: typeof cli === "string" && cli ? { cli } : {},
  };
  setClaudeAccountDirectory(entry, body.configDir || join(DATA_DIR, "providers", instanceId));
  assertSeparateClaudeAccount(instances, instanceId, entry);
  instances[instanceId] = entry;
  return { instanceId, instances };
}

/** A named ChatGPT account is the maintained Codex ACP engine with its own
 * `CODEX_HOME`, so one account's login never reaches another's sessions. */
export function newCodexAccount(cfg: AppConfig, displayName: string) {
  const instances = persistableInstanceConfigs(cfg);
  const instanceId = `chatgpt-${randomUUID()}`;
  // Reuse the selected executable, never another account's environment.
  const existing = Object.values(instances).find((entry) => entry.driver === "codex-acp" || entry.driver === "codex");
  const cli = existing ? rawConfig(existing).cli : undefined;
  instances[instanceId] = {
    driver: "codex-acp",
    displayName,
    config: { authMode: "chatgpt-plan", ...(typeof cli === "string" && cli ? { cli } : {}) },
    environment: { CODEX_HOME: join(DATA_DIR, "providers", instanceId) },
  };
  return { instanceId, instances };
}

/** Copyable commands are quoted as data, including wrapper arguments. The
 * subshell/block restores the caller's environment after Claude finishes. */
export function claudeSignInCommand(cli: string, directory: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = resolveCli(cli, ["auth", "login"]);
  if (platform === "win32") {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const keys = [...CLAUDE_ACCOUNT_ENV_KEYS, "CLAUDE_CONFIG_DIR"];
    return `& { $colonieKeys = ${keys.map(quote).join(",")}; $colonieSaved = @{}; foreach ($k in $colonieKeys) { $colonieSaved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $null, 'Process') }; try { ${directory ? `$env:CLAUDE_CONFIG_DIR = ${quote(directory)}; ` : ""}& ${[resolved.command, ...resolved.args].map(quote).join(" ")} } finally { foreach ($k in $colonieKeys) { [Environment]::SetEnvironmentVariable($k, $colonieSaved[$k], 'Process') } } }`;
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  return `(unset ${[...CLAUDE_ACCOUNT_ENV_KEYS, "CLAUDE_CONFIG_DIR"].join(" ")}; ${directory ? `export CLAUDE_CONFIG_DIR=${quote(directory)}; ` : ""}${[resolved.command, ...resolved.args].map(quote).join(" ")})`;
}

export function claudeAccountInfo(instanceId: string, entry: InstanceConfig, cli: string) {
  const directory = configuredAccountDirectory(entry);
  return {
    configDir: directory,
    signInCommand: claudeSignInCommand(cli, directory),
    signInShell: process.platform === "win32" ? "powershell" as const : "sh" as const,
    isDefault: instanceId === "claude" || instanceId === "claude-acp",
  };
}
