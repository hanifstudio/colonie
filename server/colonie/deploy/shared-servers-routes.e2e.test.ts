// The routes behind "create a Shared workspace", on a throwaway server whose
// owner is its loopback caller (as on the desktop), against a stand-in
// DigitalOcean. A Shared workspace server does not offer them at all.
import { createServer } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

let fakeUrl = "";
const fake = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  let text = "";
  for await (const chunk of req) text += chunk;
  const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (url.pathname === "/v1/oauth/register") return json(201, { client_id: "public-client-1" });
  if (url.pathname === "/v1/oauth/token") return new URLSearchParams(text).get("code") === "approved" ? json(200, { access_token: "t", refresh_token: "r", expires_in: 3600 }) : json(400, { error: "invalid_grant" });
  if (url.pathname === "/v2/account") return json(200, { account: { droplet_limit: 3, status: "active", email: "owner@example.com" } });
  if (url.pathname === "/v2/sizes") return json(200, { sizes: [{ slug: "s-2vcpu-4gb", price_monthly: 24, price_hourly: 0.0357, regions: ["sgp1"], available: true }] });
  json(404, { message: "not found" });
});

let desktop: SharedWorkspace;
let shared: SharedWorkspace;
beforeAll(async () => {
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const address = fake.address();
  fakeUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const env = () => ({ COLONIE_DIGITALOCEAN_OAUTH: fakeUrl, COLONIE_DIGITALOCEAN_API: fakeUrl });
  desktop = await startSharedWorkspace([], {}, env);
  shared = await startSharedWorkspace([], {}, () => ({ ...env(), COLONIE_WORKSPACE_KIND: "shared" }));
}, 90_000);
afterAll(async () => {
  await desktop?.stop();
  await shared?.stop();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
});

test("the owner connects DigitalOcean, comes back through this computer, and sees the price", async () => {
  const before = await (await fetch(`${desktop.url}/api/shared-servers`)).json();
  expect(before).toEqual({ digitalOcean: { connected: false, region: "sgp1", size: "s-2vcpu-4gb" }, servers: [] });
  const started = await (await fetch(`${desktop.url}/api/shared-servers/digitalocean/connect`, { method: "POST" })).json() as { authorizationUrl: string };
  const authorize = new URL(started.authorizationUrl);
  expect(authorize.origin).toBe(fakeUrl);
  const back = new URL(authorize.searchParams.get("redirect_uri")!);
  expect(back.origin).toBe(`http://127.0.0.1:${new URL(desktop.url).port}`);
  // A forged state is refused; the real one, approved, connects.
  expect((await fetch(`${back.href}?code=approved&state=forged`)).status).toBe(400);
  const done = await fetch(`${back.href}?code=approved&state=${authorize.searchParams.get("state")}`);
  expect(done.status).toBe(200);
  expect(await done.text()).toMatch(/return to Colonie/);
  const after = await (await fetch(`${desktop.url}/api/shared-servers`)).json() as { digitalOcean: unknown };
  expect(after.digitalOcean).toMatchObject({ connected: true, account: { email: "owner@example.com" }, price: { monthlyUsd: 24 } });
});

test("a name is required to create one", async () => {
  const res = await fetch(`${desktop.url}/api/shared-servers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: " " }) });
  expect(res.status).toBe(400);
});

test("a Shared workspace server does not create servers, for anyone", async () => {
  expect((await fetch(`${shared.url}/api/shared-servers`)).status).toBe(403);
  expect((await fetch(`${shared.url}/api/shared-servers/digitalocean/callback?code=approved&state=x`)).status).not.toBe(200);
});
