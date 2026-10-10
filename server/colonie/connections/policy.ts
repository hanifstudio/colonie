import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DATA_DIR } from "../../config.ts";
import { writeFileAtomic } from "../../atomic.ts";
import type { ConnectedAppsPolicy } from "../../../shared/connected-apps.ts";

export const policySchema = z.object({ toolkits: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(40),
  customServers: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).max(20).default([]) }).strict();
export const policyHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function path(botId: string) {
  if (!/^[\w-]{1,128}$/.test(botId)) throw new Error("Invalid bot id");
  return join(DATA_DIR, "connected-apps", "bots", `${botId}.json`);
}
export function botAppPolicy(botId: string): ConnectedAppsPolicy {
  try { return policySchema.parse(JSON.parse(readFileSync(path(botId), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { toolkits: [], customServers: [] }; throw error; }
}
export function saveBotAppPolicy(botId: string, policy: ConnectedAppsPolicy, expectedRevision: string) {
  if (policyHash(botAppPolicy(botId)) !== expectedRevision) throw Object.assign(new Error("Connected app access changed. Refresh before saving."), { status: 409 });
  const parsed = policySchema.parse(policy);
  const normalized = { toolkits: [...new Set(parsed.toolkits)].sort(), customServers: [...new Set(parsed.customServers)].sort() };
  mkdirSync(join(DATA_DIR, "connected-apps", "bots"), { recursive: true, mode: 0o700 });
  writeFileAtomic(path(botId), JSON.stringify(normalized, null, 2), { mode: 0o600 });
  return normalized;
}
