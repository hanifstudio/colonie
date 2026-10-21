// The database Colonie Cloud talks to: Neon Postgres in production (through
// Hyperdrive), an in-process Postgres (PGlite) in tests. Everything goes
// through this one small interface so the SQL is the same in both.

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Schema changes, in order. Append only: a released step never changes. */
export const MIGRATIONS: readonly string[] = [
  `create table if not exists colonie_cloud.accounts (
     id text primary key,
     email text not null unique,
     name text not null,
     password_hash text not null,
     created_at timestamptz not null default now()
   );
   create table if not exists colonie_cloud.sessions (
     token_hash text primary key,
     account_id text not null references colonie_cloud.accounts(id) on delete cascade,
     created_at timestamptz not null default now(),
     expires_at timestamptz not null
   );
   create index if not exists sessions_account on colonie_cloud.sessions(account_id);`,
  // Sign in with Colonie: each Shared workspace is a client with one exact
  // address to come back to; a code is single-use, short-lived, bound to a
  // PKCE challenge, and stored only as a hash.
  `create table if not exists colonie_cloud.clients (
     id text primary key,
     name text not null,
     redirect_uri text not null,
     created_at timestamptz not null default now()
   );
   create table if not exists colonie_cloud.auth_codes (
     code_hash text primary key,
     client_id text not null references colonie_cloud.clients(id) on delete cascade,
     account_id text not null references colonie_cloud.accounts(id) on delete cascade,
     redirect_uri text not null,
     code_challenge text not null,
     nonce text,
     expires_at timestamptz not null,
     used_at timestamptz
   );`,
  // Password resets: a link by email, stored only as a hash, good for thirty
  // minutes and once. Sign-in failures: a count per email, so a lock answers
  // the same whether or not that address has an account.
  `create table if not exists colonie_cloud.password_resets (
     token_hash text primary key,
     account_id text not null references colonie_cloud.accounts(id) on delete cascade,
     created_at timestamptz not null default now(),
     expires_at timestamptz not null,
     used_at timestamptz
   );
   create index if not exists password_resets_account on colonie_cloud.password_resets(account_id);
   create table if not exists colonie_cloud.sign_in_failures (
     email text primary key,
     count integer not null,
     window_started_at timestamptz not null,
     locked_until timestamptz
   );`,
];

/** Bring the schema up to date. Safe to run on every start, and from several
 * Worker isolates at once: every step may be repeated without error. */
export async function migrate(db: Db): Promise<void> {
  // Every table lives in its own schema, so a database shared with another
  // app (or a later Colonie service) can never collide with ours.
  await db.query("create schema if not exists colonie_cloud");
  await db.query("create table if not exists colonie_cloud.schema_migrations (version integer primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query<{ version: number }>("select version from colonie_cloud.schema_migrations")).map((row) => row.version));
  for (const [index, sql] of MIGRATIONS.entries()) {
    const version = index + 1;
    if (done.has(version)) continue;
    for (const statement of sql.split(/;\s*$/m).map((part) => part.trim()).filter(Boolean)) await db.query(statement);
    await db.query("insert into colonie_cloud.schema_migrations (version) values ($1) on conflict do nothing", [version]);
  }
}
