// Secrets: keys and passwords a person gives their bots without putting
// them in a chat. Each secret is its owner's (a person of a Shared
// workspace, or this computer's owner) and reaches only the bots they allow,
// and only on that person's own requests.
//
// Values are encrypted at rest (AES-256-GCM) with a key kept beside them,
// readable only by this user (0600). They never enter a prompt or a
// transcript: for a request, the allowed ones are written to a private file
// outside the bot's working folder that its scripts load, and every known
// value is masked out of anything persisted (shared/redact.ts).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../../persistence/atomic.ts";
import { setKnownSecretValues } from "../../../shared/redact.ts";

/** An environment-variable name, as scripts read it. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const VALUE_MAX = 16_384;

interface StoredSecret {
  owner: string;
  name: string;
  description: string;
  bots: string[];
  iv: string;
  tag: string;
  data: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

/** What a person sees: never the value. */
export interface SecretView {
  name: string;
  description: string;
  bots: string[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

const view = (secret: StoredSecret): SecretView => ({
  name: secret.name, description: secret.description, bots: secret.bots,
  createdAt: secret.createdAt, updatedAt: secret.updatedAt, ...(secret.lastUsedAt ? { lastUsedAt: secret.lastUsedAt } : {}),
});

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** One shell-safe KEY='value' line. */
export function envLine(name: string, value: string): string {
  return `${name}='${value.replace(/'/g, `'\\''`)}'`;
}

export function createSecrets(deps: { dir: string; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const file = join(deps.dir, "secrets.json");
  const keyFile = join(deps.dir, "key");
  const runtimeDir = join(deps.dir, "runtime");
  mkdirSync(deps.dir, { recursive: true, mode: 0o700 });

  const key = (() => {
    if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
    const fresh = randomBytes(32);
    writeFileAtomic(keyFile, fresh.toString("base64"), { mode: 0o600 });
    return fresh;
  })();
  let secrets: StoredSecret[] = [];
  try { secrets = JSON.parse(readFileSync(file, "utf8")) as StoredSecret[]; } catch { /* none yet */ }

  const decrypt = (secret: StoredSecret): string => {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.iv, "base64"));
    decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(secret.data, "base64")), decipher.final()]).toString("utf8");
  };
  const encrypt = (value: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  };
  /** Every value, so anything persisted can mask them. */
  const announce = () => setKnownSecretValues(secrets.map((secret) => { try { return decrypt(secret); } catch { return ""; } }));
  const save = () => { writeFileAtomic(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 }); announce(); };
  const find = (owner: string, name: string) => secrets.find((secret) => secret.owner === owner && secret.name === name);
  announce();

  return {
    list(owner: string): SecretView[] {
      return secrets.filter((secret) => secret.owner === owner).map(view).sort((a, b) => a.name.localeCompare(b.name));
    },

    /** Add one, or replace its value. A bot named here may use it. */
    put(owner: string, input: { name: unknown; value: unknown; description?: unknown; bots?: unknown; botId?: unknown }): SecretView {
      const name = typeof input.name === "string" ? input.name.trim().toUpperCase() : "";
      if (!SECRET_NAME.test(name)) throw fail(400, "A name of capital letters, digits and _ , starting with a letter, like GMAIL_APP_PASSWORD.");
      const value = typeof input.value === "string" ? input.value : "";
      if (!value.trim()) throw fail(400, "Enter the secret's value.");
      if (value.length > VALUE_MAX) throw fail(400, "That value is too long for a secret.");
      const description = typeof input.description === "string" ? input.description.trim().slice(0, 200) : "";
      const bots = Array.isArray(input.bots) ? input.bots.filter((id): id is string => typeof id === "string") : undefined;
      const botId = typeof input.botId === "string" ? input.botId : undefined;
      const at = now();
      const existing = find(owner, name);
      if (existing) {
        Object.assign(existing, encrypt(value), { updatedAt: at, ...(description ? { description } : {}) });
        existing.bots = [...new Set([...(bots ?? existing.bots), ...(botId ? [botId] : [])])];
        save();
        return view(existing);
      }
      const secret: StoredSecret = { owner, name, description, bots: [...new Set([...(bots ?? []), ...(botId ? [botId] : [])])], ...encrypt(value), createdAt: at, updatedAt: at };
      secrets.push(secret);
      save();
      return view(secret);
    },

    /** Which bots may use it. */
    setBots(owner: string, name: string, bots: unknown): SecretView {
      const secret = find(owner, name);
      if (!secret) throw fail(404, "No such secret.");
      secret.bots = Array.isArray(bots) ? [...new Set(bots.filter((id): id is string => typeof id === "string"))] : [];
      secret.updatedAt = now();
      save();
      return view(secret);
    },

    remove(owner: string, name: string): boolean {
      const before = secrets.length;
      secrets = secrets.filter((secret) => !(secret.owner === owner && secret.name === name));
      if (secrets.length === before) return false;
      save();
      return true;
    },

    /** The names one bot may use on this person's request. */
    namesFor(owner: string, botId: string): string[] {
      return secrets.filter((secret) => secret.owner === owner && secret.bots.includes(botId)).map((secret) => secret.name).sort();
    },

    /** For one request: the allowed secrets in a private KEY='value' file
     * its scripts load, outside the bot's working folder. Null when there
     * are none (an old file for the thread is removed). */
    prepare(owner: string, botId: string, threadId: string): { file: string; names: string[] } | null {
      if (!/^[\w-]{1,128}$/.test(threadId)) return null;
      const target = join(runtimeDir, `${threadId}.env`);
      const allowed = secrets.filter((secret) => secret.owner === owner && secret.bots.includes(botId));
      if (!allowed.length) { rmSync(target, { force: true }); return null; }
      const lines: string[] = [];
      const at = now();
      for (const secret of allowed) {
        try { lines.push(envLine(secret.name, decrypt(secret))); secret.lastUsedAt = at; } catch { /* unreadable: skipped */ }
      }
      mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
      writeFileAtomic(target, `${lines.join("\n")}\n`, { mode: 0o600 });
      writeFileAtomic(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
      return { file: target, names: allowed.map((secret) => secret.name).sort() };
    },
  };
}

export type Secrets = ReturnType<typeof createSecrets>;
