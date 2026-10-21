// Inviting a person by link, end to end on this machine: a real Colonie Cloud
// (the cloud/ app on an in-process Postgres, served over HTTP) and a real
// Shared workspace server. A scripted browser follows the redirects the way a
// person's browser would: invite link, Colonie sign-up, consent, back to the
// workspace signed in under their own identity — and the privacy rules hold
// for them like for anyone else.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";

import { createApp } from "../../../cloud/src/app.ts";
import { createSigner, generateSigningJwk } from "../../../cloud/src/oauth.ts";
import { testDb } from "../../../cloud/test/helpers.ts";
import { freePortBlock } from "../../testing/ports.ts";
import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ADA = "ada@x.com"; // the workspace admin who invites

let cloudServer: Server;
let cloudUrl: string;
let closeDb: () => Promise<void>;
let ws: SharedWorkspace;
let botId: string;

/** A browser: follows redirects across both sites, keeps each site's cookies. */
function browser() {
  const jars = new Map<string, Map<string, string>>();
  const jarFor = (origin: string) => jars.get(origin) ?? jars.set(origin, new Map()).get(origin)!;
  async function go(url: string, init: { method?: string; form?: Record<string, string> } = {}): Promise<{ url: string; status: number; text: string }> {
    let current = new URL(url);
    let method = init.method ?? (init.form ? "POST" : "GET");
    let body: string | undefined = init.form ? new URLSearchParams(init.form).toString() : undefined;
    for (let hop = 0; hop < 10; hop += 1) {
      const jar = jarFor(current.origin);
      const headers: Record<string, string> = {};
      if (jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
      if (body !== undefined) { headers["content-type"] = "application/x-www-form-urlencoded"; headers.origin = current.origin; }
      const response = await fetch(current, { method, headers, body, redirect: "manual" });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(";");
        const [name, ...value] = pair!.split("=");
        if (/Max-Age=0/i.test(cookie)) jar.delete(name!); else jar.set(name!, value.join("="));
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, current);
        method = "GET";
        body = undefined;
        continue;
      }
      return { url: current.toString(), status: response.status, text: await response.text() };
    }
    throw new Error("too many redirects");
  }
  /** The form fields on the page (the consent page posts them back). */
  const formFields = (html: string) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)]
    .map((match) => [match[1]!, match[2]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")]));
  const cookieHeader = (origin: string) => [...jarFor(origin)].map(([name, value]) => `${name}=${value}`).join("; ");
  return { go, formFields, cookieHeader };
}

/** Accept an invite as a new person: sign up at Colonie, continue, land back. */
async function joinAs(inviteUrl: string, person: { name: string; email: string; password: string }) {
  const b = browser();
  const signIn = await b.go(inviteUrl);
  expect(signIn.url).toContain(`${cloudUrl}/signin`);
  const next = new URL(signIn.url).searchParams.get("next")!;
  const consent = await b.go(`${cloudUrl}/signup`, { form: { ...person, next } });
  expect(consent.text, consent.text.slice(0, 500)).toContain("Continue to the workspace");
  const landed = await b.go(`${cloudUrl}/authorize`, { form: b.formFields(consent.text) });
  return { b, landed };
}

/** The workspace API as this browser's session. */
async function api(b: ReturnType<typeof browser>, path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${ws.url}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie: b.cookieHeader(ws.url), origin: ws.url, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body };
}

beforeAll(async () => {
  const db = await testDb();
  closeDb = () => db.close();
  const port = await freePortBlock([0]);
  cloudUrl = `http://127.0.0.1:${port}`;
  const app = createApp({ db, issuer: cloudUrl, signer: await createSigner(await generateSigningJwk("e2e"), cloudUrl) });
  cloudServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
    const response = await app.fetch(new Request(`${cloudUrl}${req.url}`, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => cloudServer.listen(port, "127.0.0.1", resolve));

  ws = await startSharedWorkspace([{ email: ADA, admin: true }]);
  botId = (await ws.as(ADA, "/api/bots")).body.bots[0].id;
  const connected = await ws.as(ADA, "/api/colonie-cloud/connect", { method: "POST", body: { issuer: cloudUrl, name: "Launch Team" } });
  expect(connected.status, JSON.stringify(connected.body)).toBe(200);
}, 90_000);
afterAll(async () => {
  await ws?.stop();
  await new Promise((resolve) => cloudServer?.close(resolve));
  await closeDb?.();
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
