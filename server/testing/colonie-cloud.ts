// A real Colonie Cloud for end-to-end tests (the cloud/ app on an in-process
// Postgres, served over HTTP on this machine), and a scripted browser that
// follows redirects across sites and keeps each site's cookies.
import { createServer } from "node:http";

import { createApp } from "../../cloud/src/app.ts";
import { createSigner, generateSigningJwk } from "../../cloud/src/oauth.ts";
import { testDb } from "../../cloud/test/helpers.ts";
import { freePortBlock } from "./ports.ts";

export async function startColonieCloud(): Promise<{ url: string; stop(): Promise<void> }> {
  const db = await testDb();
  const port = await freePortBlock([0]);
  const url = `http://127.0.0.1:${port}`;
  const app = createApp({ db, issuer: url, signer: await createSigner(await generateSigningJwk("e2e"), url) });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
    const response = await app.fetch(new Request(`${url}${req.url}`, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}

export type Browser = ReturnType<typeof browser>;

/** A browser: follows redirects across sites, keeps each site's cookies. */
export function browser() {
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
  /** A JSON API call to a site as this browser. */
  async function api(origin: string, path: string, init: { method?: string; body?: unknown } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers: { cookie: cookieHeader(origin), origin, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body };
  }
  return { go, formFields, cookieHeader, api };
}

/** Accept an invite as a new person: sign up at Colonie, continue, land back. */
export async function joinAs(cloudUrl: string, inviteUrl: string, person: { name: string; email: string; password: string }) {
  const b = browser();
  // The invite page offers the app or this browser; a browser person picks the browser.
  const landing = await b.go(inviteUrl);
  if (!landing.text.includes("Continue in this browser")) throw new Error(`no invite page: ${landing.status} ${landing.text.slice(0, 200)}`);
  const signIn = await b.go(`${inviteUrl}?via=browser`);
  if (!signIn.url.startsWith(`${cloudUrl}/signin`)) throw new Error(`invite did not lead to Colonie sign-in: ${signIn.status} ${signIn.url}`);
  const next = new URL(signIn.url).searchParams.get("next")!;
  const consent = await b.go(`${cloudUrl}/signup`, { form: { ...person, next } });
  if (!consent.text.includes("Continue to the workspace")) throw new Error(`no consent page (${consent.status}): ${consent.text.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 400)}`);
  const landed = await b.go(`${cloudUrl}/authorize`, { form: b.formFields(consent.text) });
  return { b, landed };
}
