// The database Colonie Cloud talks to: Neon Postgres in production (through
// Hyperdrive), an in-process Postgres (PGlite) in tests. Everything goes
// through this one small interface so the SQL is the same in both.

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Schema changes, in order. Append only: a released step never changes. */
export const MIGRATIONS: readonly string[] = [
  `create table accounts (
     id text primary key,
     email text not null unique,
     name text not null,
     password_hash text not null,
     created_at timestamptz not null default now()
   );
   create table sessions (
     token_hash text primary key,
     account_id text not null references accounts(id) on delete cascade,
     created_at timestamptz not null default now(),
     expires_at timestamptz not null
   );
   create index sessions_account on sessions(account_id);`,
];

/** Bring the schema up to date. Safe to run on every start. */
export async function migrate(db: Db): Promise<void> {
  await db.query("create table if not exists schema_migrations (version integer primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query<{ version: number }>("select version from schema_migrations")).map((row) => row.version));
  for (const [index, sql] of MIGRATIONS.entries()) {
    const version = index + 1;
    if (done.has(version)) continue;
    for (const statement of sql.split(/;\s*$/m).map((part) => part.trim()).filter(Boolean)) await db.query(statement);
    await db.query("insert into schema_migrations (version) values ($1)", [version]);
  }
}
