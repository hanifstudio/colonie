// The first owner of a new Shared workspace server. Whoever creates the server
// (the one-click deployment) starts it with Colonie Cloud's address and an
// owner invite code it made itself; the server connects before it listens,
// and that code lets the owner in as the first admin — once, and only while
// nobody has joined. Nothing about the owner is known to the server before.
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

import { browser, joinAs, startColonieCloud } from "../../testing/colonie-cloud.ts";
import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const OWNER_CODE = randomBytes(24).toString("base64url");
let cloud: Awaited<ReturnType<typeof startColonieCloud>>;
let ws: SharedWorkspace;
let owner: ReturnType<typeof browser>;

beforeAll(async () => {
  cloud = await startColonieCloud();
  // Serve a web app, as a real server does: its page fallback must not answer
  // invite links (it did once, in the container).
  const webApp = mkdtempSync(join(tmpdir(), "colonie-web-"));
  writeFileSync(join(webApp, "index.html"), "<!doctype html><title>Colonie web app</title>");
  ws = await startSharedWorkspace([], {}, (url) => ({
    COLONIE_STATIC_DIR: webApp,
    COLONIE_WORKSPACE_KIND: "shared",
    COLONIE_PUBLIC_URL: url,
    COLONIE_CLOUD_ISSUER: cloud.url,
    COLONIE_WORKSPACE_NAME: "Launch Team",
    COLONIE_OWNER_INVITE_CODE: OWNER_CODE,
  }));
}, 90_000);
afterAll(async () => {
  await ws?.stop();
  await cloud?.stop();
});

test("a new server is connected to Colonie and offers its sign-in from the start", async () => {
  const environment = await (await fetch(`${ws.url}/.well-known/colonie/environment`)).json() as { label: string; capabilities: { colonieSignIn?: boolean } };
  expect(environment.capabilities.colonieSignIn).toBe(true);
  // Its sign-in page names the workspace, not the machine.
  expect(environment.label).toBe("Launch Team");
});

test("the owner's code makes them the first admin, who can then invite others", async () => {
  const { b, landed } = await joinAs(cloud.url, `${ws.url}/invite/${OWNER_CODE}`, { name: "Owner", email: "owner@x.com", password: "a strong password" });
  owner = b;
  expect(new URL(landed.url).origin).toBe(ws.url);
  expect(b.cookieHeader(ws.url)).toMatch(/^colonie_session_/);
  const session = await b.api(ws.url, "/api/auth/session");
  expect(session.body.scopes).toContain("admin");
  // The first run there is the workspace one, not this computer's.
  expect(session.body.hosted).toBe(true);
  const invite = await b.api(ws.url, "/api/invites", { method: "POST", body: {} });
  expect(invite.status).toBe(201);
  expect(invite.body.url).toContain(`${ws.url}/invite/`);
});

test("an invite link opens a page offering the app, this browser, or a download", async () => {
  const fresh = await owner.api(ws.url, "/api/invites", { method: "POST", body: {} });
  const url = fresh.body.url as string;
  const page = await browser().go(url);
  expect(page.status).toBe(200);
  expect(page.text).toContain("You're invited to Launch Team");
  expect(page.text).toContain(`href="colonie://join?link=${encodeURIComponent(url)}"`);
  expect(page.text).toContain(`href="${new URL(url).pathname}?via=browser"`);
  expect(page.text).toContain("https://github.com/hanifstudio/colonie/releases/latest");
  // The desktop app goes straight to signing in.
  const app = await fetch(`${url}?via=app`, { redirect: "manual" });
  expect(app.status).toBe(303);
});

test("the owner's code works once", async () => {
  const again = await browser().go(`${ws.url}/invite/${OWNER_CODE}`);
  expect(again.status).toBe(410);
});

test("a caller on the server itself, such as a bot's shell, is not the owner", async () => {
  // Every bot runs its commands on this machine, so a request from loopback
  // with no session must not be able to invite people or read the settings.
  const noSession = async (path: string, method = "GET") =>
    (await fetch(`${ws.url}${path}`, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) })).status;
  expect(await noSession("/api/invites", "POST")).toBe(403);
  expect(await noSession("/api/config")).toBe(403);
  expect(await noSession("/api/colonie-cloud")).toBe(403);
  const session = await (await fetch(`${ws.url}/api/auth/session`)).json() as { trust?: string };
  expect(session.trust).toBe("service");
});
