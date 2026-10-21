// Sign in with Colonie, for Shared workspaces: the authorization code flow with
// PKCE (S256), and an ES256-signed ID token the workspace verifies against
// the published public key. A workspace is a public client: it has no secret,
// only one exact address to come back to.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { exportJWK, importJWK, SignJWT, type JWK } from "jose";

import type { Account } from "./accounts.ts";
import type { Db } from "./db.ts";

export const CODE_SECONDS = 60;
export const ID_TOKEN_SECONDS = 5 * 60;

export interface Client { id: string; name: string; redirect_uri: string }

const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

/** A workspace's sign-in address: HTTPS (or http on this machine, for
 * development), no fragment, no credentials. Exact-match only afterwards. */
export function redirectProblem(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return "redirect_uri must be an absolute URL"; }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "redirect_uri must use https";
  if (url.hash || url.username || url.password) return "redirect_uri must not carry a fragment or credentials";
  return null;
}

export async function registerClient(db: Db, input: { name: string; redirect_uri: string }): Promise<Client> {
  const client: Client = { id: `ws_${randomUUID()}`, name: input.name.trim().slice(0, 100), redirect_uri: input.redirect_uri };
  await db.query("insert into colonie_cloud.clients (id, name, redirect_uri) values ($1, $2, $3)", [client.id, client.name, client.redirect_uri]);
  return client;
}

export async function findClient(db: Db, id: string): Promise<Client | null> {
  const [row] = await db.query<Client>("select id, name, redirect_uri from colonie_cloud.clients where id = $1", [id]);
  return row ?? null;
}

export async function issueCode(db: Db, input: { client: Client; account: Account; challenge: string; nonce: string | null; now: Date }): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  const expires = new Date(input.now.getTime() + CODE_SECONDS * 1000);
  await db.query(
    "insert into colonie_cloud.auth_codes (code_hash, client_id, account_id, redirect_uri, code_challenge, nonce, expires_at) values ($1, $2, $3, $4, $5, $6, $7)",
    [sha256(code), input.client.id, input.account.id, input.client.redirect_uri, input.challenge, input.nonce, expires.toISOString()],
  );
  return code;
}

/** Spend a code: the account and nonce it was issued for, or why not. A code
 * works once; a second try fails, as does a wrong client, address, or
 * verifier, or one past its minute. */
export async function redeemCode(db: Db, input: { code: string; clientId: string; redirectUri: string; verifier: string; now: Date }):
  Promise<{ account: Account; nonce: string | null } | { error: string }> {
  // Mark it used in the same statement that reads it, so two racing
  // exchanges cannot both succeed.
  const [row] = await db.query<{ client_id: string; redirect_uri: string; code_challenge: string; nonce: string | null; expired: boolean; id: string; email: string; name: string }>(
    `update colonie_cloud.auth_codes c set used_at = $2 from colonie_cloud.accounts a
     where c.code_hash = $1 and c.used_at is null and a.id = c.account_id
     returning c.client_id, c.redirect_uri, c.code_challenge, c.nonce, c.expires_at <= $2 as expired, a.id, a.email, a.name`,
    [sha256(input.code), input.now.toISOString()],
  );
  if (!row) return { error: "invalid_grant" };
  if (row.expired || row.client_id !== input.clientId || row.redirect_uri !== input.redirectUri) return { error: "invalid_grant" };
  if (!/^[\w.~-]{43,128}$/.test(input.verifier) || sha256(input.verifier) !== row.code_challenge) return { error: "invalid_grant" };
  return { account: { id: row.id, email: row.email, name: row.name }, nonce: row.nonce };
}

export interface Signer {
  kid: string;
  sign(claims: Record<string, unknown>, audience: string, now: Date): Promise<string>;
  publicJwks(): Promise<{ keys: JWK[] }>;
}

/** The ID token signer, from the private key as a JWK (a Worker secret). */
export async function createSigner(privateJwk: JWK, issuer: string): Promise<Signer> {
  const kid = privateJwk.kid ?? "colonie-1";
  const key = await importJWK(privateJwk, "ES256");
  const { d: _private, ...publicJwk } = privateJwk;
  return {
    kid,
    async sign(claims, audience, now) {
      const iat = Math.floor(now.getTime() / 1000);
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
        .setIssuer(issuer).setAudience(audience).setIssuedAt(iat).setExpirationTime(iat + ID_TOKEN_SECONDS)
        .sign(key);
    },
    async publicJwks() {
      return { keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }] };
    },
  };
}

/** A fresh ES256 key pair as a private JWK, for tests and for the owner's
 * one-time setup (scripts print it; the owner stores it as a secret). */
export async function generateSigningJwk(kid = `colonie-${Date.now()}`): Promise<JWK> {
  const { generateKeyPair } = await import("jose");
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return { ...(await exportJWK(privateKey)), kid };
}
