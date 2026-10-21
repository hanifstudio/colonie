// The Cloudflare Worker entry for Colonie Cloud. Everything it needs comes
// from the Worker's environment: the database (Hyperdrive in production, a
// plain DATABASE_URL in local development), the issuer address, the signing
// key, and the email sender. Secrets are set by the owner (`wrangler secret
// put`); this code only reads them.
import postgres from "postgres";
import type { JWK } from "jose";

import { createApp, type Mailer } from "./app.ts";
import { migrate, type Db } from "./db.ts";
import { createSigner, type Signer } from "./oauth.ts";

export interface Env {
  /** Neon through Hyperdrive, in production. */
  HYPERDRIVE?: { connectionString: string };
  /** A direct connection string, for local development (.dev.vars). */
  DATABASE_URL?: string;
  /** This service's public address: every ID token's issuer. */
  ISSUER: string;
  /** The ES256 private key as JSON (a secret; see scripts/new-signing-key.ts). */
  SIGNING_JWK: string;
  /** Resend, for password-reset email. Without it no email is sent. */
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
}

// Kept per isolate: the schema is checked once, and the key imported once.
let migrated: Promise<void> | null = null;
let signer: { jwk: string; issuer: string; value: Promise<Signer> } | null = null;

function resendMailer(env: Env): Mailer | undefined {
  if (!env.RESEND_API_KEY) return undefined;
  return {
    async send(mail) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM ?? "Colonie <onboarding@resend.dev>", to: [mail.to], subject: mail.subject, text: mail.text }),
      });
      if (!response.ok) throw new Error(`Resend answered ${response.status}`);
    },
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const connection = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
    if (!connection || !env.ISSUER || !env.SIGNING_JWK) return new Response("Colonie Cloud is not configured.", { status: 503 });
    // One connection per request: Workers cannot share sockets between requests.
    const sql = postgres(connection, { max: 1, fetch_types: false, prepare: false });
    const db: Db = { query: async <T>(text: string, params: unknown[] = []) => (await sql.unsafe(text, params as never[])) as unknown as T[] };
    try {
      migrated ??= migrate(db).catch((error) => { migrated = null; throw error; });
      await migrated;
      if (!signer || signer.jwk !== env.SIGNING_JWK || signer.issuer !== env.ISSUER) {
        signer = { jwk: env.SIGNING_JWK, issuer: env.ISSUER, value: createSigner(JSON.parse(env.SIGNING_JWK) as JWK, env.ISSUER) };
      }
      const app = createApp({ db, issuer: env.ISSUER, signer: await signer.value, mailer: resendMailer(env) });
      return await app.fetch(request);
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }));
    }
  },
};
