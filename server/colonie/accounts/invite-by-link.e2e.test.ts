// Inviting a person by link, end to end on this machine: a real Colonie Cloud
// (the cloud/ app on an in-process Postgres, served over HTTP) and a real
// Shared workspace server. A scripted browser follows the redirects the way a
// person's browser would: invite link, Colonie sign-up, consent, back to the
// workspace signed in under their own identity — and the privacy rules hold
// for them like for anyone else.
import { afterAll, beforeAll, expect, test } from "vitest";

import { browser, joinAs as join, startColonieCloud, type Browser } from "../../testing/colonie-cloud.ts";
import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ADA = "ada@x.com"; // the workspace admin who invites

let cloud: Awaited<ReturnType<typeof startColonieCloud>>;
let cloudUrl: string;
let ws: SharedWorkspace;
let botId: string;

const joinAs = (inviteUrl: string, person: { name: string; email: string; password: string }) => join(cloudUrl, inviteUrl, person);
/** The workspace API as this browser's session. */
const api = (b: Browser, path: string, init: { method?: string; body?: unknown } = {}) => b.api(ws.url, path, init);

beforeAll(async () => {
  cloud = await startColonieCloud();
  cloudUrl = cloud.url;
  ws = await startSharedWorkspace([{ email: ADA, admin: true }]);
  botId = (await ws.as(ADA, "/api/bots")).body.bots[0].id;
  const connected = await ws.as(ADA, "/api/colonie-cloud/connect", { method: "POST", body: { issuer: cloudUrl, name: "Launch Team" } });
  expect(connected.status, JSON.stringify(connected.body)).toBe(200);
}, 90_000);
afterAll(async () => {
  await ws?.stop();
  await cloud?.stop();
});

test("an invited person signs up at Colonie and lands in the workspace under their own identity", async () => {
  const invite = await ws.as(ADA, "/api/invites", { method: "POST", body: { role: "member" } });
  expect(invite.status).toBe(201);
  const { b, landed } = await joinAs(invite.body.url, { name: "Bob Builder", email: "bob@x.com", password: "a strong password" });
  expect(new URL(landed.url).origin).toBe(ws.url);
  expect(b.cookieHeader(ws.url)).toMatch(/^colonie_session_/);
  const bots = await api(b, "/api/bots");
  expect(bots.status).toBe(200);
  const members = await ws.as(ADA, "/api/colonie-cloud");
  expect(members.body.members).toEqual([expect.objectContaining({ email: "bob@x.com", name: "Bob Builder", role: "member" })]);
  // The sidebar shows who is signed in: their own account, not the workspace's profile.
  expect((await api(b, "/api/me")).body).toEqual({ account: {
    name: "Bob Builder", email: "bob@x.com",
    avatar: expect.stringMatching(new RegExp(`^${cloud.url}/photos/[\\w-]+$`)), photoUrl: `${cloud.url}/photo`,
  } });
});

test("the new member's conversations are private from the admin who invited them", async () => {
  const invite = await ws.as(ADA, "/api/invites", { method: "POST", body: {} });
  const { b } = await joinAs(invite.body.url, { name: "Cy", email: "cy@x.com", password: "a strong password" });
  const sent = await api(b, `/api/bots/${botId}/messages`, { method: "POST", body: { text: "cy-private-note" } });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  expect((await ws.as(ADA, `/api/threads/${sent.body.threadId}/messages`)).status).toBe(404);
  expect(JSON.stringify((await ws.as(ADA, "/api/bots")).body)).not.toContain("cy-private-note");
  // a member is not an admin
  expect((await api(b, "/api/invites", { method: "POST", body: {} })).status).toBe(403);
});

test("an invite link works once", async () => {
  const invite = await ws.as(ADA, "/api/invites", { method: "POST", body: {} });
  await joinAs(invite.body.url, { name: "Dee", email: "dee@x.com", password: "a strong password" });
  const again = await browser().go(invite.body.url);
  expect(again.status).toBe(410);
});

test("a Colonie account that was never invited cannot sign in to the workspace", async () => {
  const b = browser();
  const signIn = await b.go(`${ws.url}/auth/colonie/signin`);
  const next = new URL(signIn.url).searchParams.get("next")!;
  const consent = await b.go(`${cloudUrl}/signup`, { form: { name: "Eve", email: "eve@x.com", password: "a strong password", next } });
  const landed = await b.go(`${cloudUrl}/authorize`, { form: b.formFields(consent.text) });
  expect(landed.status).toBe(403);
  // No workspace session was handed out. (A request with no session from this
  // same machine is trusted as the machine itself, so an API call here would
  // prove nothing; behind the real HTTPS proxy no outside request is.)
  expect(b.cookieHeader(ws.url)).toBe("");
});

test("a member signs in again later without an invite", async () => {
  const invite = await ws.as(ADA, "/api/invites", { method: "POST", body: {} });
  await joinAs(invite.body.url, { name: "Fay", email: "fay@x.com", password: "a strong password" });
  const later = browser();
  const signIn = await later.go(`${ws.url}/auth/colonie/signin`);
  const next = new URL(signIn.url).searchParams.get("next")!;
  const consent = await later.go(`${cloudUrl}/signin`, { form: { email: "fay@x.com", password: "a strong password", next } });
  const landed = await later.go(`${cloudUrl}/authorize`, { form: later.formFields(consent.text) });
  expect(new URL(landed.url).origin).toBe(ws.url);
  expect(later.cookieHeader(ws.url)).toMatch(/^colonie_session_/);
  // the session is Fay's own: her message opens her own conversation
  const sent = await api(later, `/api/bots/${botId}/messages`, { method: "POST", body: { text: "fay-again" } });
  expect(sent.status).toBe(202);
});

test("an admin removes a member: their session stops at once and they cannot come back without a new invite", async () => {
  const invite = await ws.as(ADA, "/api/invites", { method: "POST", body: {} });
  const person = { name: "Gus", email: "gus@x.com", password: "a strong password" };
  const { b } = await joinAs(invite.body.url, person);
  expect((await api(b, "/api/bots")).status).toBe(200);

  const removed = await ws.as(ADA, `/api/colonie-cloud/members/${encodeURIComponent("gus@x.com")}`, { method: "DELETE" });
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  expect((await ws.as(ADA, "/api/colonie-cloud")).body.members.map((member: any) => member.email)).not.toContain("gus@x.com");
  expect([401, 403]).toContain((await api(b, "/api/bots")).status);
  // Signing in again with the same Colonie account is refused.
  const consent = await b.go(`${ws.url}/auth/colonie/signin`);
  expect(consent.text).toContain("Continue to the workspace");
  const again = await b.go(`${cloudUrl}/authorize`, { form: b.formFields(consent.text) });
  expect(again.status).toBe(403);
});

test("a member cannot remove anyone, and the last admin cannot be removed", async () => {
  const invite = await ws.as(ADA, "/api/invites", { method: "POST", body: {} });
  const { b } = await joinAs(invite.body.url, { name: "Hal", email: "hal@x.com", password: "a strong password" });
  expect((await api(b, `/api/colonie-cloud/members/${encodeURIComponent("bob@x.com")}`, { method: "DELETE" })).status).toBe(403);
  const last = await ws.as(ADA, `/api/colonie-cloud/members/${encodeURIComponent(ADA)}`, { method: "DELETE" });
  expect(last.status).toBe(409);
  expect(last.body.error).toMatch(/last admin/);
});
