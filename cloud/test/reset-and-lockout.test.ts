// Forgotten passwords and guessing: a reset link by email that works once and
// for thirty minutes, and a lock on an account after repeated wrong passwords.
import { afterEach, expect, test } from "vitest";

import { ORIGIN, testCloud } from "./helpers.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
const ADA = { name: "Ada Lovelace", email: "ada@example.com", password: "correct horse battery" };

async function setup(clock = { now: new Date("2026-10-21T10:00:00Z") }) {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const cloud = await testCloud({ now: () => clock.now, mailer: { send: async (mail) => { sent.push(mail); } } });
  closers.push(() => cloud.db.close());
  const cookie = cloud.cookieFrom((await cloud.request("/signup", { form: ADA })).response)!;
  return { ...cloud, sent, clock, cookie };
}
const linkIn = (text: string) => new URL(/https:\/\/\S+\/reset\?token=[\w-]+/.exec(text)![0]);
const signIn = (s: Awaited<ReturnType<typeof setup>>, password: string) =>
  s.request("/signin", { form: { email: ADA.email, password } });

test("asking for a reset says the same whether or not the account exists, and emails only a real one", async () => {
  const s = await setup();
  const known = await s.request("/forgot", { form: { email: "ADA@example.com" } });
  const unknown = await s.request("/forgot", { form: { email: "nobody@example.com" } });
  expect(known.response.status).toBe(200);
  expect(unknown.response.status).toBe(200);
  expect(known.text.replace(/value="[^"]*"/g, "")).toBe(unknown.text.replace(/value="[^"]*"/g, ""));
  expect(s.sent).toHaveLength(1);
  expect(s.sent[0]!.to).toBe("ada@example.com");
  expect(linkIn(s.sent[0]!.text).origin).toBe(ORIGIN);
});

test("the link sets a new password once, signs out every session, and the old password stops working", async () => {
  const s = await setup();
  await s.request("/forgot", { form: { email: ADA.email } });
  const link = linkIn(s.sent[0]!.text);
  const token = link.searchParams.get("token")!;
  expect((await s.request(`/reset?token=${token}`)).response.status).toBe(200);
  const done = await s.request("/reset", { form: { token, password: "a brand new password" } });
  expect(done.response.status).toBe(303);
  expect((await signIn(s, ADA.password)).response.status).toBe(401);
  expect((await signIn(s, "a brand new password")).response.status).toBe(303);
  // the session from before the reset is gone
  expect((await s.request("/", { cookie: s.cookie })).response.headers.get("location")).toBe("/signin");
  // and the link does not work twice
  expect((await s.request("/reset", { form: { token, password: "yet another password" } })).response.status).toBe(400);
});

test("a reset link expires after thirty minutes and is stored only as a hash", async () => {
  const s = await setup();
  await s.request("/forgot", { form: { email: ADA.email } });
  const token = linkIn(s.sent[0]!.text).searchParams.get("token")!;
  const stored = JSON.stringify(await s.db.query("select * from colonie_cloud.password_resets"));
  expect(stored).not.toContain(token);
  s.clock.now = new Date(s.clock.now.getTime() + 31 * 60_000);
  expect((await s.request(`/reset?token=${token}`)).response.status).toBe(400);
  expect((await s.request("/reset", { form: { token, password: "a brand new password" } })).response.status).toBe(400);
});

test("a new password must still meet the rules", async () => {
  const s = await setup();
  await s.request("/forgot", { form: { email: ADA.email } });
  const token = linkIn(s.sent[0]!.text).searchParams.get("token")!;
  const short = await s.request("/reset", { form: { token, password: "short" } });
  expect(short.response.status).toBe(400);
  expect(short.text).toContain("at least 10 characters");
  // a refused attempt does not spend the link
  expect((await s.request("/reset", { form: { token, password: "a brand new password" } })).response.status).toBe(303);
});

test("ten wrong passwords lock the account for fifteen minutes, even for the right password", async () => {
  const s = await setup();
  for (let i = 0; i < 10; i += 1) expect((await signIn(s, `wrong password ${i}`)).response.status).toBe(401);
  const locked = await signIn(s, ADA.password);
  expect(locked.response.status).toBe(429);
  expect(locked.text).toContain("Too many");
  s.clock.now = new Date(s.clock.now.getTime() + 16 * 60_000);
  expect((await signIn(s, ADA.password)).response.status).toBe(303);
});

test("a successful sign-in clears the count of wrong ones", async () => {
  const s = await setup();
  for (let i = 0; i < 9; i += 1) await signIn(s, `wrong password ${i}`);
  expect((await signIn(s, ADA.password)).response.status).toBe(303);
  for (let i = 0; i < 9; i += 1) await signIn(s, `wrong password ${i}`);
  expect((await signIn(s, ADA.password)).response.status).toBe(303);
});

test("a lock does not reveal whether an address has an account", async () => {
  const s = await setup();
  for (let i = 0; i < 11; i += 1) await s.request("/signin", { form: { email: "nobody@example.com", password: `guess ${i}` } });
  const nobody = await s.request("/signin", { form: { email: "nobody@example.com", password: "guess again" } });
  expect(nobody.response.status).toBe(429);
});
