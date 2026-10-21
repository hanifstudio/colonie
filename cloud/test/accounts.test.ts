// Colonie accounts: sign up, sign in, the signed-in session, and signing out.
import { afterEach, expect, test } from "vitest";

import { MIGRATIONS, migrate } from "../src/db.ts";
import { hashPassword, verifyPassword } from "../src/passwords.ts";
import { testCloud, testDb } from "./helpers.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
async function cloud() {
  const made = await testCloud();
  closers.push(() => made.db.close());
  return made;
}
const ADA = { name: "Ada Lovelace", email: "Ada@Example.com", password: "correct horse battery" };

test("the schema migrates once and again without harm", async () => {
  const db = await testDb();
  closers.push(() => db.close());
  await migrate(db);
  const versions = (await db.query<{ version: number }>("select version from colonie_cloud.schema_migrations order by version")).map((row) => row.version);
  expect(versions).toEqual(MIGRATIONS.map((_, index) => index + 1));
});

test("a password is stored as an scrypt hash with its parameters, and only verifies itself", async () => {
  const stored = await hashPassword("correct horse battery");
  expect(stored).toMatch(/^scrypt\$32768\$8\$3\$[\w-]{22}\$[\w-]{43}$/);
  expect(stored).not.toContain("correct horse");
  expect(await verifyPassword("correct horse battery", stored)).toBe(true);
  expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
  expect(await hashPassword("correct horse battery")).not.toBe(stored);
  expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
});

test("signing up creates the account, signs the person in, and stores no password", async () => {
  const { db, request, cookieFrom } = await cloud();
  const { response } = await request("/signup", { form: ADA });
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/");
  expect(response.headers.get("set-cookie")).toMatch(/^__Host-colonie_session=[\w-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const [row] = await db.query<{ email: string; password_hash: string }>("select email, password_hash from colonie_cloud.accounts");
  expect(row!.email).toBe("ada@example.com");
  expect(row!.password_hash).not.toContain(ADA.password);
  const home = await request("/", { cookie: cookieFrom(response) });
  expect(home.text).toContain("Ada Lovelace");
  expect(home.text).toContain("ada@example.com");
});

test("an email can hold one account, whatever its letter case", async () => {
  const { request } = await cloud();
  await request("/signup", { form: ADA });
  const again = await request("/signup", { form: { ...ADA, email: "ada@EXAMPLE.com" } });
  expect(again.response.status).toBe(409);
  expect(again.text).toContain("already exists");
});

test("sign-up says what to fix and keeps what was typed, never the password", async () => {
  const { request } = await cloud();
  const short = await request("/signup", { form: { ...ADA, password: "short" } });
  expect(short.response.status).toBe(400);
  expect(short.text).toContain("at least 10 characters");
  expect(short.text).toContain('value="Ada Lovelace"');
  expect(short.text).not.toContain('value="short"');
  expect((await request("/signup", { form: { ...ADA, email: "not-an-email" } })).response.status).toBe(400);
  expect((await request("/signup", { form: { ...ADA, name: "  " } })).response.status).toBe(400);
});

test("signing in needs the right password, and a wrong email reads the same as a wrong password", async () => {
  const { request, cookieFrom } = await cloud();
  await request("/signup", { form: ADA });
  const right = await request("/signin", { form: { email: "ada@example.com", password: ADA.password } });
  expect(right.response.status).toBe(303);
  expect(cookieFrom(right.response)).toMatch(/^__Host-colonie_session=/);
  const wrong = await request("/signin", { form: { email: ADA.email, password: "wrong password!" } });
  const nobody = await request("/signin", { form: { email: "nobody@example.com", password: "wrong password!" } });
  expect(wrong.response.status).toBe(401);
  expect(nobody.response.status).toBe(401);
  expect(wrong.text.replace(/value="[^"]*"/g, "")).toBe(nobody.text.replace(/value="[^"]*"/g, ""));
});

test("signing out ends the session for good", async () => {
  const { request, cookieFrom } = await cloud();
  const cookie = cookieFrom((await request("/signup", { form: ADA })).response);
  const out = await request("/signout", { form: {}, cookie });
  expect(out.response.headers.get("set-cookie")).toContain("Max-Age=0");
  const home = await request("/", { cookie });
  expect(home.response.status).toBe(303);
  expect(home.response.headers.get("location")).toBe("/signin");
});

test("a form sent from another site is refused", async () => {
  const { request } = await cloud();
  const forged = await request("/signup", { form: ADA, origin: "https://evil.example" });
  expect(forged.response.status).toBe(403);
});

test("after signing in, the person goes only to a page on this site", async () => {
  const { request } = await cloud();
  const inside = await request("/signup", { form: { ...ADA, next: "/authorize?x=1" } });
  expect(inside.response.headers.get("location")).toBe("/authorize?x=1");
  for (const next of ["//evil.example/x", "https://evil.example", "/\\evil.example"]) {
    const outside = await request("/signup", { form: { ...ADA, email: `${Math.random()}@example.com`, next } });
    expect(outside.response.headers.get("location"), next).toBe("/");
  }
});

test("a database another app already uses is left alone: our tables live in their own schema", async () => {
  // October 21: the first database offered held a WhatsApp bot's tables named
  // accounts, sessions and schema_migrations. Migrating must neither fail on
  // them nor touch them.
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  closers.push(() => pg.close());
  const db = { query: async <T>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows };
  await db.query("create table accounts (jid text primary key, phone text)");
  await db.query("create table sessions (id text primary key, jid text)");
  await db.query("create table schema_migrations (version bigint primary key, dirty boolean)");
  await db.query("insert into accounts values ('123@s.whatsapp.net', '+62')");
  await migrate(db);
  await migrate(db);
  expect(await db.query("select * from public.accounts")).toEqual([{ jid: "123@s.whatsapp.net", phone: "+62" }]);
  expect(await db.query("select count(*)::int as n from public.schema_migrations")).toEqual([{ n: 0 }]);
  const ours = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'colonie_cloud' order by 1");
  expect(ours.map((row) => row.table_name)).toEqual(["accounts", "auth_codes", "clients", "password_resets", "schema_migrations", "sessions", "sign_in_failures"]);
});

test("several isolates may migrate at the same time", async () => {
  const db = await testDb();
  closers.push(() => db.close());
  // fresh schema raced by three migrations, then a half-done one finished
  await db.query("drop schema colonie_cloud cascade");
  await Promise.all([migrate(db), migrate(db), migrate(db)]);
  await db.query("delete from colonie_cloud.schema_migrations");
  await migrate(db);
  expect((await db.query("select count(*)::int as n from colonie_cloud.schema_migrations"))[0]).toEqual({ n: MIGRATIONS.length });
});
