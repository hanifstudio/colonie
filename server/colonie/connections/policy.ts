import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { writeFileAtomic } from "../../persistence/atomic.ts";
import type { ConnectedAppsPolicy } from "../../../shared/connected-apps.ts";

export const policySchema = z.object({ toolkits: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(40),
  customServers: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).max(20).default([]) }).strict();
export const policyHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Each bot's connected-app selection, one JSON file per bot in `directory`.
 * The caller owns where that directory is; this module never reads global config. */
export class BotAppPolicies {
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  read(botId: string): ConnectedAppsPolicy {
    try { return policySchema.parse(JSON.parse(readFileSync(this.path(botId), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { toolkits: [], customServers: [] }; throw error; }
  }

  save(botId: string, policy: ConnectedAppsPolicy, expectedRevision: string) {
    if (policyHash(this.read(botId)) !== expectedRevision) throw Object.assign(new Error("Connected app access changed. Refresh before saving."), { status: 409 });
    const parsed = policySchema.parse(policy);
    const normalized = { toolkits: [...new Set(parsed.toolkits)].sort(), customServers: [...new Set(parsed.customServers)].sort() };
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.path(botId), JSON.stringify(normalized, null, 2), { mode: 0o600 });
    return normalized;
  }

  private path(botId: string) {
    if (!/^[\w-]{1,128}$/.test(botId)) throw new Error("Invalid bot id");
    return join(this.directory, `${botId}.json`);
  }
}
