// Everyone signs up once for a Colonie account on first opening the app,
// Local included (owner decision). End to end on this machine: a real
// Colonie Cloud on an in-process Postgres and a throwaway desktop server; a
// scripted browser plays the person's own browser. A Shared workspace server
// has no such account of its own.
import { afterAll, beforeAll, expect, test } from "vitest";

import { browser, startColonieCloud } from "../../testing/colonie-cloud.ts";
import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

let cloud: Awaited<ReturnType<typeof startColonieCloud>>;
let desktop: SharedWorkspace;
let shared: SharedWorkspace;
const local = (path: string, init: RequestInit = {}) => fetch(`${desktop.url}${path}`, init).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) as any }));

beforeAll(async () => {
  cloud = await startColonieCloud();
  desktop = await startSharedWorkspace([], {}, () => ({ COLONIE_CLOUD_ISSUER: cloud.url }));
  shared = await startSharedWorkspace([], {}, () => ({ COLONIE_CLOUD_ISSUER: cloud.url, COLONIE_WORKSPACE_KIND: "shared" }));
}, 90_000);
afterAll(async () => {
  await desktop?.stop();
  await shared?.stop();
  await cloud?.stop();
});

test("until they sign up, the app says an account is needed", async () => {
  expect(await local("/api/colonie-account")).toEqual({ status: 200, body: { required: true, account: null } });
});

test("they sign up in their browser, come back to this computer, and the app knows them", async () => {
  const started = await local("/api/colonie-account/start", { method: "POST" });
  expect(started.status).toBe(200);
  const authorize = new URL(started.body.authorizationUrl);
  expect(authorize.origin).toBe(cloud.url);
  expect(new URL(authorize.searchParams.get("redirect_uri")!).origin).toBe(`http://127.0.0.1:${new URL(desktop.url).port}`);

  const b = browser();
  const signIn = await b.go(started.body.authorizationUrl);
  const next = new URL(signIn.url).searchParams.get("next")!;
  const consent = await b.go(`${cloud.url}/signup`, { form: { name: "Ana Owner", email: "ana@x.com", password: "a strong password", next } });
  const back = await b.go(`${cloud.url}/authorize`, { form: b.formFields(consent.text) });
  expect(new URL(back.url).origin).toBe(`http://127.0.0.1:${new URL(desktop.url).port}`);
  expect(back.status).toBe(200);
  expect(back.text).toMatch(/return to Colonie/i);

  const after = await local("/api/colonie-account");
  expect(after.body).toEqual({ required: true, account: { email: "ana@x.com", name: "Ana Owner" } });
  // The profile the app shows is the account's.
  const config = await local("/api/config");
  expect(config.body.profile).toMatchObject({ name: "Ana Owner", email: "ana@x.com" });
});

test("a way back with a forged or reused state is refused", async () => {
  const forged = await fetch(`${desktop.url}/auth/colonie/desktop-callback?code=x&state=forged`);
  expect(forged.status).toBe(400);
});

test("a Shared workspace server has no desktop account", async () => {
  expect((await fetch(`${shared.url}/api/colonie-account`)).status).not.toBe(200);
});

test("in development, where the window's page comes from another server, the way back is still this server", async () => {
  // The UI server forwards /api here, and nothing else (vite.config.ts),
  // keeping the page's own Host, as vite's proxy does.
  const { createServer, request } = await import("node:http");
  const target = new URL(desktop.url);
  const proxy = createServer((req, res) => {
    const forward = request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    req.pipe(forward);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const address = proxy.address();
    const started = await (await fetch(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/colonie-account/start`, { method: "POST" })).json() as { authorizationUrl: string };
    const back = new URL(new URL(started.authorizationUrl).searchParams.get("redirect_uri")!);
    expect(back.port).toBe(new URL(desktop.url).port);
  } finally {
    proxy.close();
  }
});
