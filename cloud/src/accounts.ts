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
export const RESET_MINUTES = 30;
export const LOCK_ATTEMPTS = 10;
export const LOCK_MINUTES = 15;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Why a password cannot be used, in words a person can act on; null when it can. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use a password of at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use a password of at most ${PASSWORD_MAX} characters.`;
  return null;
}

/** Why a sign-up cannot proceed, in words a person can act on; null when it can. */
export function signUpProblem(input: { email: string; name: string; password: string }): string | null {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > EMAIL_MAX) return "Enter a valid email address.";
  const name = input.name.trim();
  if (!name || name.length > NAME_MAX) return `Enter your name (up to ${NAME_MAX} characters).`;
  return passwordProblem(input.password);
}

export async function createAccount(db: Db, input: { email: string; name: string; password: string }): Promise<Account | "exists"> {
  const email = normalizeEmail(input.email);
  const account: Account = { id: randomUUID(), email, name: input.name.trim() };
  const hash = await hashPassword(input.password);
  const rows = await db.query<{ id: string }>(
    "insert into colonie_cloud.accounts (id, email, name, password_hash) values ($1, $2, $3, $4) on conflict (email) do nothing returning id",
    [account.id, account.email, account.name, hash],
  );
  return rows.length ? account : "exists";
}

/** True while this address is locked out: ten wrong passwords in a row, for
 * fifteen minutes. A stale row is cleared, so the next try counts from one. */
async function locked(db: Db, email: string, now: Date): Promise<boolean> {
  const [row] = await db.query<{ window_started_at: Date | string; locked_until: Date | string | null }>(
    "select window_started_at, locked_until from colonie_cloud.sign_in_failures where email = $1", [email]);
  if (!row) return false;
  if (row.locked_until && new Date(row.locked_until) > now) return true;
  // A lock that has run out starts the count over; an unlocked row keeps it.
  if (row.locked_until) await db.query("delete from colonie_cloud.sign_in_failures where email = $1", [email]);
  return false;
}

/** Count one wrong password, and lock the address on the tenth. The count
 * starts over when its window has passed, so old tries do not add up. */
async function failedSignIn(db: Db, email: string, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - LOCK_MINUTES * 60_000).toISOString();
  const lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString();
  await db.query(
    `insert into colonie_cloud.sign_in_failures (email, count, window_started_at, locked_until) values ($1, 1, $2, null)
     on conflict (email) do update set
       count = case when sign_in_failures.window_started_at <= $3 then 1 else sign_in_failures.count + 1 end,
       window_started_at = case when sign_in_failures.window_started_at <= $3 then $2 else sign_in_failures.window_started_at end,
       locked_until = case
         when sign_in_failures.window_started_at <= $3 then null
         when sign_in_failures.count + 1 >= $4 then $5
         else sign_in_failures.locked_until end`,
    [email, now.toISOString(), cutoff, LOCK_ATTEMPTS, lockedUntil],
  );
}

/** The account for these credentials, "locked" while the address is in its
 * fifteen-minute lockout, or null. Takes as long for an unknown email as for
 * a wrong password, so the answer does not say whether the account exists. */
export async function signIn(db: Db, rawEmail: string, password: string, now = new Date()): Promise<Account | "locked" | null> {
  const email = normalizeEmail(rawEmail);
  if (await locked(db, email, now)) {
    await verifyPassword(password, await dummyHash());
    return "locked";
  }
  const [row] = await db.query<Account & { password_hash: string }>(
    "select id, email, name, password_hash from colonie_cloud.accounts where email = $1", [email]);
  if (!row) {
    await verifyPassword(password, await dummyHash());
    await failedSignIn(db, email, now);
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    await failedSignIn(db, email, now);
    return null;
  }
  await db.query("delete from colonie_cloud.sign_in_failures where email = $1", [email]);
  return { id: row.id, email: row.email, name: row.name };
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("base64url");

/** A new signed-in session. Only its hash is stored. */
export async function openSession(db: Db, accountId: string, now = new Date()): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60_000);
  await db.query("insert into colonie_cloud.sessions (token_hash, account_id, expires_at) values ($1, $2, $3)", [hashToken(token), accountId, expires.toISOString()]);
  return token;
}

export async function sessionAccount(db: Db, token: string, now = new Date()): Promise<Account | null> {
  const [row] = await db.query<Account>(
    `select a.id, a.email, a.name from colonie_cloud.sessions s join colonie_cloud.accounts a on a.id = s.account_id
     where s.token_hash = $1 and s.expires_at > $2`, [hashToken(token), now.toISOString()]);
  return row ?? null;
}

export async function closeSession(db: Db, token: string): Promise<void> {
  await db.query("delete from colonie_cloud.sessions where token_hash = $1", [hashToken(token)]);
}

/** A reset link for this address, or null when it has no account. Only the
 * token's hash is stored; the token itself goes only into the email. Asking
 * again replaces any link that was not used yet. */
export async function startPasswordReset(db: Db, rawEmail: string, now = new Date()): Promise<{ account: Account; token: string } | null> {
  const [account] = await db.query<Account>(
    "select id, email, name from colonie_cloud.accounts where email = $1", [normalizeEmail(rawEmail)]);
  if (!account) return null;
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(now.getTime() + RESET_MINUTES * 60_000);
  await db.query("delete from colonie_cloud.password_resets where account_id = $1 and used_at is null", [account.id]);
  await db.query(
    "insert into colonie_cloud.password_resets (token_hash, account_id, expires_at) values ($1, $2, $3)",
    [hashToken(token), account.id, expires.toISOString()],
  );
  return { account, token };
}

/** The account a reset token still stands for, or null once it is used or
 * past its thirty minutes. */
export async function resetAccount(db: Db, token: string, now = new Date()): Promise<Account | null> {
  const [row] = await db.query<Account>(
    `select a.id, a.email, a.name from colonie_cloud.password_resets r join colonie_cloud.accounts a on a.id = r.account_id
     where r.token_hash = $1 and r.used_at is null and r.expires_at > $2`, [hashToken(token), now.toISOString()]);
  return row ?? null;
}

/** Spend the token, set the new password, and end every session. Null when
 * the token is no longer good. A password that breaks the rules is refused
 * before the token is touched, so the person can try again with the same link. */
export async function finishPasswordReset(db: Db, input: { token: string; password: string; now?: Date }): Promise<Account | null> {
  if (passwordProblem(input.password)) return null;
  const now = input.now ?? new Date();
  const [claimed] = await db.query<{ account_id: string }>(
    `update colonie_cloud.password_resets set used_at = $2
     where token_hash = $1 and used_at is null and expires_at > $2
     returning account_id`, [hashToken(input.token), now.toISOString()]);
  if (!claimed) return null;
  const hash = await hashPassword(input.password);
  const [account] = await db.query<Account>(
    "update colonie_cloud.accounts set password_hash = $2 where id = $1 returning id, email, name", [claimed.account_id, hash]);
  if (!account) return null;
  await db.query("delete from colonie_cloud.sessions where account_id = $1", [account.id]);
  await db.query("delete from colonie_cloud.sign_in_failures where email = $1", [account.email]);
  return account;
}
