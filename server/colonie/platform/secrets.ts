// Workspace secret service. Provider and Composio keys are sealed here with
// AES-256-GCM before a reference is stored; the plaintext lives only for the
// duration of a request that legitimately needs it (an authorized relay call).
// The API never returns plaintext — only a masked hint drawn from the last
// four characters.
//
// Key material comes from the environment/provisioning service, never from the
// database. `keyVersion` is stored beside the ciphertext so a rotation can keep
// old rows readable.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
  maskedHint: string;
}

const MASK_VISIBLE = 4;

/** A short, non-reversible hint safe to show owner/admins. */
export function maskSecret(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length <= MASK_VISIBLE) return "•".repeat(Math.max(trimmed.length, 1));
  return `…${trimmed.slice(-MASK_VISIBLE)}`;
}

export class SecretBox {
  readonly keyVersion: number;
  private readonly key: Uint8Array;

  constructor(key: Uint8Array, keyVersion = 1) {
    if (key.length !== 32) throw new Error("The secret service needs a 32-byte AES-256 key.");
    this.key = key;
    this.keyVersion = keyVersion;
  }

  seal(plaintext: string): SealedSecret {
    if (!plaintext) throw new Error("Refusing to seal an empty secret.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      keyVersion: this.keyVersion,
      maskedHint: maskSecret(plaintext),
    };
  }

  open(sealed: Pick<SealedSecret, "ciphertext" | "iv" | "authTag">): string {
    if (sealed.ciphertext === "" || sealed.iv === "" || sealed.authTag === "") {
      throw new Error("The stored secret is incomplete.");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
}

/** 32 random bytes for an installation with no secret key configured. */
export function generateSecretKey(): Uint8Array {
  return randomBytes(32);
}
