// The desktop app's side of "create a Shared workspace": connect the owner's
// DigitalOcean account in their browser, show the price, create the server,
// wait until it answers, and hand over the owner's invite link. Against a
// stand-in DigitalOcean that plays both its sign-in and its API.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

import { createSharedServers } from "./shared-servers.ts";

const CALLBACK = "http://127.0.0.1:18799/api/deploy/digitalocean/callback";
const issued: Array<{ code: string; challenge: string; clientId: string; redirect: string }> = [];
const seen: Array<{ method: string; path: string; body: any; form?: URLSearchParams }> = [];
let refreshes = 0;
let base = "";
let dropletUp = false;

const read = async (req: IncomingMessage) => { let text = ""; for await (const chunk of req) text += chunk; return text; };

const fake = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  const text = await read(req);
  const json = (status: number, value?: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(value === undefined ? "" : JSON.stringify(value)); };
  const form = req.headers["content-type"]?.includes("x-www-form-urlencoded") ? new URLSearchParams(text) : undefined;
  seen.push({ method: req.method!, path: url.pathname + url.search, body: form ? null : text ? JSON.parse(text) : null, form });
  if (url.pathname === "/v1/oauth/register") {
    const body = JSON.parse(text);
    if (body.token_endpoint_auth_method !== "none") return json(400, { error: "invalid_client_metadata" });
    return json(201, { client_id: "public-client-1", redirect_uris: body.redirect_uris });
  }
  if (url.pathname === "/v1/oauth/token") {
    if (form!.get("grant_type") === "refresh_token") {
      if (form!.get("refresh_token") !== "refresh-1") return json(400, { error: "invalid_grant" });
      refreshes += 1;
      return json(200, { access_token: "good-token", refresh_token: "refresh-2", expires_in: 3600, token_type: "bearer" });
    }
    const grant = issued.find((entry) => entry.code === form!.get("code"));
    const verifier = form!.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!grant || grant.challenge !== challenge || form!.get("client_id") !== grant.clientId || form!.get("redirect_uri") !== grant.redirect || form!.has("client_secret")) {
      return json(400, { error: "invalid_grant" });
    }
    return json(200, { access_token: "first-token", refresh_token: "refresh-1", expires_in: 3600, token_type: "bearer" });
  }
  const auth = req.headers.authorization;
  if (auth !== "Bearer good-token" && auth !== "Bearer first-token") return json(401, { id: "unauthorized", message: "Unable to authenticate you" });
  if (url.pathname === "/v2/account") return json(200, { account: { droplet_limit: 3, status: "active", email: "owner@example.com" } });
  if (url.pathname === "/v2/sizes") return json(200, { sizes: [{ slug: "s-2vcpu-4gb", price_monthly: 24, price_hourly: 0.03571, regions: ["sgp1"], available: true }] });
  if (req.method === "POST" && url.pathname === "/v2/droplets") return json(202, { droplet: { id: 7, status: "new" } });
  if (req.method === "POST" && url.pathname === "/v2/firewalls") return json(202, { firewall: { id: "fw-7" } });
  if (url.pathname === "/v2/droplets/7") return json(200, { droplet: { id: 7, status: "active", networks: { v4: [{ type: "public", ip_address: "203.0.113.7" }] } } });
  if (req.method === "DELETE") return json(204);
  if (url.pathname === "/v2/firewalls") return json(200, { firewalls: [{ id: "fw-7", tags: [] }] });
  json(404, { message: "not found" });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const address = fake.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => fake.close(() => resolve())));

/** What the owner's browser does on DigitalOcean's consent page: approve. */
function approve(authorizationUrl: string) {
  const url = new URL(authorizationUrl);
  const code = `code-${issued.length + 1}`;
  issued.push({ code, challenge: url.searchParams.get("code_challenge")!, clientId: url.searchParams.get("client_id")!, redirect: url.searchParams.get("redirect_uri")! });
  return `?code=${code}&state=${url.searchParams.get("state")}`;
}

function servers(dataDir: string, probe: (address: string) => Promise<boolean> = async () => dropletUp) {
  return createSharedServers({
    dataDir, oauthBase: base, apiBase: base, image: "ghcr.io/example/colonie-workspace:1.0.0", issuer: "https://cloud.example",
    // a short real pause, so a test can change what the server answers between tries
    probe, sleep: () => new Promise((resolve) => setTimeout(resolve, 2)),
  });
}

const settle = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

test("the owner connects DigitalOcean in their browser: a public client, PKCE, only the permissions needed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colonie-shared-servers-"));
  const shared = servers(dir);
  expect(await shared.status()).toMatchObject({ connected: false });
  const { authorizationUrl } = await shared.connect(CALLBACK);
  const url = new URL(authorizationUrl);
  expect(url.origin + url.pathname).toBe(`${base}/v1/oauth/authorize`);
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
  expect(url.searchParams.get("scope")!.split(" ")).toEqual(expect.arrayContaining(["droplet:create", "droplet:delete", "firewall:create", "firewall:delete", "account:read", "sizes:read"]));
  expect(url.searchParams.get("scope")).not.toMatch(/api:write|ssh_key/);
  const registration = seen.find((request) => request.path === "/v1/oauth/register")!;
  expect(registration.body).toMatchObject({ token_endpoint_auth_method: "none", redirect_uris: [CALLBACK] });

  const back = await shared.callback(approve(authorizationUrl));
  expect(back.status).toBe(200);
  expect(back.text).toMatch(/return to Colonie/i);
  const status = await shared.status();
  expect(status).toMatchObject({ connected: true, account: { email: "owner@example.com", dropletLimit: 3 }, price: { monthlyUsd: 24 }, region: "sgp1", size: "s-2vcpu-4gb" });
  // The token stays on this computer, readable by its owner only.
  const file = join(dir, "digitalocean.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(status)).not.toContain("first-token");
});

test("a callback with a wrong or reused state is refused", async () => {
  const shared = servers(mkdtempSync(join(tmpdir(), "colonie-shared-servers-")));
  const { authorizationUrl } = await shared.connect(CALLBACK);
  expect((await shared.callback("?code=x&state=forged")).status).toBe(400);
  const answer = approve(authorizationUrl);
  expect((await shared.callback(answer)).status).toBe(200);
  expect((await shared.callback(answer)).status).toBe(400);
});

test("creating a workspace: the server is made, waited for, and the owner gets its invite link", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colonie-shared-servers-"));
  const shared = servers(dir);
  const { authorizationUrl } = await shared.connect(CALLBACK);
  await shared.callback(approve(authorizationUrl));
  dropletUp = false;
  const record = await shared.create("Launch Team");
  expect(record).toMatchObject({ name: "Launch Team", state: "creating" });
  await settle(() => shared.list()[0]?.state === "starting");
  expect(shared.list()[0]).toMatchObject({ address: "https://203-0-113-7.sslip.io" });
  expect(shared.list()[0].inviteUrl).toBeUndefined();
  dropletUp = true;
  await settle(() => shared.list()[0]?.state === "ready");
  const ready = shared.list()[0];
  expect(ready.inviteUrl).toMatch(/^https:\/\/203-0-113-7\.sslip\.io\/invite\/[\w-]{32}$/);
  const droplet = seen.filter((request) => request.method === "POST" && request.path === "/v2/droplets").at(-1)!;
  expect(droplet.body.user_data).toContain(`COLONIE_OWNER_INVITE_CODE="${ready.inviteUrl!.split("/").pop()}"`);
  expect(droplet.body.tags).toContain(ready.tag);
  shared.markOpened(ready.id);
  expect(shared.list()[0].opened).toBe(true);
  // The list survives a restart of the app.
  expect(servers(dir).list()[0]).toMatchObject({ id: ready.id, state: "ready" });
});

test("an expired DigitalOcean sign-in is renewed once with its refresh token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colonie-shared-servers-"));
  let clock = 1_000_000;
  const shared = createSharedServers({ dataDir: dir, oauthBase: base, apiBase: base, image: "img:1", issuer: "https://cloud.example", probe: async () => true, sleep: async () => {}, now: () => clock });
  const { authorizationUrl } = await shared.connect(CALLBACK);
  await shared.callback(approve(authorizationUrl));
  clock += 3_600_000;
  const before = refreshes;
  expect(await shared.status()).toMatchObject({ connected: true });
  expect(refreshes).toBe(before + 1);
  expect(readFileSync(join(dir, "digitalocean.json"), "utf8")).toContain("refresh-2");
});

test("deleting a workspace removes its server by tag and forgets it; disconnecting forgets the sign-in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colonie-shared-servers-"));
  const shared = servers(dir, async () => true);
  const { authorizationUrl } = await shared.connect(CALLBACK);
  await shared.callback(approve(authorizationUrl));
  const record = await shared.create("Short Lived");
  await settle(() => shared.list()[0]?.state === "ready");
  await shared.remove(record.id);
  expect(seen.some((request) => request.method === "DELETE" && request.path === `/v2/droplets?tag_name=${record.tag}`)).toBe(true);
  expect(shared.list()).toEqual([]);
  await shared.disconnect();
  expect(existsSync(join(dir, "digitalocean.json"))).toBe(false);
  expect(await shared.status()).toMatchObject({ connected: false });
});

test("on the owner's own server: no DigitalOcean needed, a command to paste, then the same wait and invite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colonie-shared-servers-"));
  let up = false;
  const shared = servers(dir, async (address) => up && address === "https://team.example.com");
  const before = seen.length;
  const record = await shared.createSelfHosted("Launch Team", "team.example.com");
  expect(seen.length).toBe(before); // DigitalOcean is never asked
  expect(record).toMatchObject({ name: "Launch Team", kind: "self", state: "starting", address: "https://team.example.com" });
  expect(record.command).toMatch(/^echo [A-Za-z0-9+/=]+ \| base64 -d \| gunzip \| sudo bash$/);
  expect(record.inviteUrl).toBeUndefined();
  up = true;
  await settle(() => shared.list()[0]?.state === "ready");
  const ready = shared.list()[0];
  expect(ready.inviteUrl).toMatch(/^https:\/\/team\.example\.com\/invite\/[\w-]{32}$/);
  // Forgetting it leaves the owner's server alone.
  await shared.remove(ready.id);
  expect(seen.length).toBe(before);
  expect(shared.list()).toEqual([]);
});

test("an address that cannot be reached from the internet is refused", async () => {
  const shared = servers(mkdtempSync(join(tmpdir(), "colonie-shared-servers-")));
  await expect(shared.createSelfHosted("Team", "192.168.1.20")).rejects.toMatchObject({ status: 400 });
});
