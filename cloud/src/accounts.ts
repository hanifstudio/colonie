// Colonie accounts: one identity per person across every Shared workspace.
// Email and password; the email is not verified (owner decision) — a
// workspace's one-time invite link is what ties a person to a workspace.
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Db } from "./db.ts";
import { dummyHash, hashPassword, verifyPassword } from "./passwords.ts";

export interface Account { id: string; email: string; name: string }

export const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;
const NAME_MAX = 100;
const EMAIL_MAX = 320;
export const SESSION_DAYS = 30;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Why a sign-up cannot proceed, in words a person can act on; null when it can. */
export function signUpProblem(input: { email: string; name: string; password: string }): string | null {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > EMAIL_MAX) return "Enter a valid email address.";
  const name = input.name.trim();
  if (!name || name.length > NAME_MAX) return `Enter your name (up to ${NAME_MAX} characters).`;
  if (input.password.length < PASSWORD_MIN) return `Use a password of at least ${PASSWORD_MIN} characters.`;
  if (input.password.length > PASSWORD_MAX) return `Use a password of at most ${PASSWORD_MAX} characters.`;
  return null;
}

export async function createAccount(db: Db, input: { email: string; name: string; password: string }): Promise<Account | "exists"> {
  const email = normalizeEmail(input.email);
  const account: Account = { id: randomUUID(), email, name: input.name.trim() };
  const hash = await hashPassword(input.password);
  const rows = await db.query<{ id: string }>(
    "insert into accounts (id, email, name, password_hash) values ($1, $2, $3, $4) on conflict (email) do nothing returning id",
    [account.id, account.email, account.name, hash],
  );
  return rows.length ? account : "exists";
}

/** The account for these credentials, or null. Takes as long for an unknown
 * email as for a wrong password. */
export async function signIn(db: Db, rawEmail: string, password: string): Promise<Account | null> {
  const [row] = await db.query<Account & { password_hash: string }>(
    "select id, email, name, password_hash from accounts where email = $1", [normalizeEmail(rawEmail)]);
  if (!row) {
    await verifyPassword(password, await dummyHash());
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;
  return { id: row.id, email: row.email, name: row.name };
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("base64url");

/** A new signed-in session. Only its hash is stored. */
export async function openSession(db: Db, accountId: string, now = new Date()): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60_000);
  await db.query("insert into sessions (token_hash, account_id, expires_at) values ($1, $2, $3)", [tokenHash(token), accountId, expires.toISOString()]);
  return token;
}

export async function sessionAccount(db: Db, token: string, now = new Date()): Promise<Account | null> {
  const [row] = await db.query<Account>(
    `select a.id, a.email, a.name from sessions s join accounts a on a.id = s.account_id
     where s.token_hash = $1 and s.expires_at > $2`, [tokenHash(token), now.toISOString()]);
  return row ?? null;
}

export async function closeSession(db: Db, token: string): Promise<void> {
  await db.query("delete from sessions where token_hash = $1", [tokenHash(token)]);
}
