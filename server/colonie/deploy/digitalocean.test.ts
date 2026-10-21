// Creating a Shared workspace on the owner's DigitalOcean account, against a
// stand-in DigitalOcean API that answers the way the real one documents.
import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

import { gunzipSync } from "node:zlib";

import { COMPOSE_FILE, CADDY_FILE, createDigitalOcean, firstBootScript, selfHostCommand, siteAddress, sslipAddress } from "./digitalocean.ts";

interface Seen { method: string; path: string; body: any; auth: string | undefined }
const seen: Seen[] = [];
let droplets: Array<{ id: number; status: string; tags: string[]; networks: { v4: Array<{ type: string; ip_address: string }> } }> = [];
let firewalls: Array<{ id: string; name: string; tags: string[] }> = [];
let polls = 0;
let base = "";

const body = async (req: IncomingMessage) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : null;
};

const fake = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  const sent = await body(req);
  seen.push({ method: req.method!, path: url.pathname + url.search, body: sent, auth: req.headers.authorization });
  const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(value === undefined ? "" : JSON.stringify(value)); };
  if (req.headers.authorization !== "Bearer good-token") return json(401, { id: "unauthorized", message: "Unable to authenticate you" });
  if (req.method === "GET" && url.pathname === "/v2/account") return json(200, { account: { droplet_limit: 3, status: "active", email: "owner@example.com" } });
  if (req.method === "GET" && url.pathname === "/v2/sizes") {
    return json(200, { sizes: [{ slug: "s-2vcpu-4gb", price_monthly: 24, price_hourly: 0.03571, regions: ["sgp1", "nyc1"], available: true }], links: {}, meta: { total: 1 } });
  }
  if (req.method === "GET" && url.pathname === "/v2/droplets" && url.searchParams.get("tag_name")) {
    return json(200, { droplets: droplets.filter((d) => d.tags.includes(url.searchParams.get("tag_name")!)), links: {}, meta: { total: 0 } });
  }
  if (req.method === "POST" && url.pathname === "/v2/droplets") {
    const droplet = { id: 101, status: "new", tags: sent.tags, networks: { v4: [] as Array<{ type: string; ip_address: string }> } };
    droplets.push(droplet);
    return json(202, { droplet });
  }
  if (req.method === "GET" && url.pathname === "/v2/droplets/101") {
    polls += 1;
    const droplet = droplets.find((d) => d.id === 101)!;
    if (polls >= 2) Object.assign(droplet, { status: "active", networks: { v4: [{ type: "private", ip_address: "10.0.0.5" }, { type: "public", ip_address: "203.0.113.5" }] } });
    return json(200, { droplet });
  }
  if (req.method === "POST" && url.pathname === "/v2/firewalls") {
    const firewall = { id: "fw-1", name: sent.name, tags: sent.tags };
    firewalls.push(firewall);
    return json(202, { firewall });
  }
  if (req.method === "GET" && url.pathname === "/v2/firewalls") return json(200, { firewalls, links: {}, meta: { total: firewalls.length } });
  if (req.method === "DELETE" && url.pathname === "/v2/droplets" && url.searchParams.get("tag_name")) {
    droplets = droplets.filter((d) => !d.tags.includes(url.searchParams.get("tag_name")!));
    return json(204, undefined);
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/v2/firewalls/")) {
    firewalls = firewalls.filter((f) => f.id !== url.pathname.split("/").pop());
    return json(204, undefined);
  }
  json(404, { id: "not_found", message: "The resource you were accessing could not be found." });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const address = fake.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => fake.close(() => resolve())));

const client = (token = "good-token") => createDigitalOcean({ api: base, token: async () => token, sleep: async () => {} });

test("the owner sees what the account allows and the live monthly price before anything is made", async () => {
  const account = await client().account();
  expect(account).toEqual({ email: "owner@example.com", dropletLimit: 3, active: true });
  expect(await client().price("s-2vcpu-4gb", "sgp1")).toEqual({ monthlyUsd: 24, hourlyUsd: 0.03571 });
  await expect(client().price("s-2vcpu-4gb", "ams3")).rejects.toThrow(/not offered in ams3/);
  expect(seen.every((request) => request.method === "GET")).toBe(true);
});

test("a token DigitalOcean refuses is reported in plain words", async () => {
  await expect(client("expired").account()).rejects.toThrow(/DigitalOcean did not accept the sign-in/);
});

test("creating makes one tagged droplet behind a firewall for 80 and 443, then waits for its address", async () => {
  seen.length = 0;
  const made = await client().create({ name: "launch-team", tag: "colonie-ws-abc", region: "sgp1", size: "s-2vcpu-4gb", userData: "#!/bin/bash\necho hi\n" });
  expect(made).toEqual({ dropletId: 101, firewallId: "fw-1" });
  const create = seen.find((request) => request.method === "POST" && request.path === "/v2/droplets")!;
  expect(create.body).toMatchObject({ name: "launch-team", region: "sgp1", size: "s-2vcpu-4gb", image: "ubuntu-24-04-x64", tags: ["colonie", "colonie-ws-abc"], user_data: "#!/bin/bash\necho hi\n" });
  expect(create.body.ssh_keys).toBeUndefined();
  const firewall = seen.find((request) => request.method === "POST" && request.path === "/v2/firewalls")!;
  expect(firewall.body.tags).toEqual(["colonie-ws-abc"]);
  expect(firewall.body.inbound_rules.map((rule: { ports: string }) => rule.ports).sort()).toEqual(["443", "80"]);
  expect(await client().waitForAddress(101)).toBe("203.0.113.5");
});

test("deleting removes the droplet and the firewall by the workspace's tag, and nothing else", async () => {
  firewalls.push({ id: "fw-other", name: "someone-elses", tags: ["web"] });
  await client().remove("colonie-ws-abc");
  expect(droplets).toEqual([]);
  expect(firewalls.map((f) => f.id)).toEqual(["fw-other"]);
  expect(seen.some((request) => request.method === "DELETE" && request.path === "/v2/droplets?tag_name=colonie-ws-abc")).toBe(true);
});

test("the server's address is its public IP on sslip.io", () => {
  expect(sslipAddress("203.0.113.5")).toBe("https://203-0-113-5.sslip.io");
});

test("the first-boot script runs the same compose and Caddy files as deploy/, with this workspace's settings", () => {
  const compose = readFileSync(join(import.meta.dirname, "../../../deploy/compose.yaml"), "utf8");
  expect(COMPOSE_FILE).toBe(compose.replace(/ {4}build:\n(?: {6}.*\n)+/, ""));
  expect(CADDY_FILE).toBe(readFileSync(join(import.meta.dirname, "../../../deploy/Caddyfile"), "utf8"));
  const script = firstBootScript({ image: "ghcr.io/example/colonie-workspace:1.0.0", issuer: "https://cloud.example", workspaceName: "Launch Team", ownerCode: "q3J0Xn2l7uGm1oS9YbV4cR8eTwKp5Hzd" });
  expect(script.startsWith("#!/bin/bash\n")).toBe(true);
  expect(script).toContain(COMPOSE_FILE);
  expect(script).toContain('COLONIE_IMAGE="ghcr.io/example/colonie-workspace:1.0.0"');
  expect(script).toContain('COLONIE_CLOUD_ISSUER="https://cloud.example"');
  expect(script).toContain('COLONIE_WORKSPACE_NAME="Launch Team"');
  expect(script).toContain('COLONIE_OWNER_INVITE_CODE="q3J0Xn2l7uGm1oS9YbV4cR8eTwKp5Hzd"');
  expect(script).toContain("sslip.io");
  expect(script).toContain("docker compose up -d --no-build");
});

test("a workspace name cannot smuggle shell or settings into the script", () => {
  const script = firstBootScript({ image: "img:1", issuer: "https://cloud.example", workspaceName: 'Team"$(reboot)\nEVIL=1', ownerCode: "q3J0Xn2l7uGm1oS9YbV4cR8eTwKp5Hzd" });
  expect(script).not.toContain("$(reboot)");
  expect(script).not.toContain("\nEVIL=1");
  expect(() => firstBootScript({ image: "img:1", issuer: "https://cloud.example", workspaceName: "Team", ownerCode: "short" })).toThrow();
  expect(() => firstBootScript({ image: "img;reboot", issuer: "https://cloud.example", workspaceName: "Team", ownerCode: "q3J0Xn2l7uGm1oS9YbV4cR8eTwKp5Hzd" })).toThrow();
  expect(() => firstBootScript({ image: "img:1", issuer: "http://cloud.example", workspaceName: "Team", ownerCode: "q3J0Xn2l7uGm1oS9YbV4cR8eTwKp5Hzd" })).toThrow();
  // a Colonie Cloud on this machine, during development
  expect(firstBootScript({ image: "img:1", issuer: "http://127.0.0.1:8787", workspaceName: "Team", ownerCode: "q3J0Xn2l7uGm1oS9YbV4cR8eTwKp5Hzd" })).toContain('COLONIE_CLOUD_ISSUER="http://127.0.0.1:8787"');
});

test("on the owner's own server the address is given, not read from DigitalOcean", () => {
  const script = firstBootScript({ image: "img:1", issuer: "https://cloud.example", workspaceName: "Team", ownerCode: "q3J0Xn2l7uGm1oS9YbV4cR8eTwKp5Hzd", site: "https://team.example.com" });
  expect(script).toContain("SITE=https://team.example.com\n");
  expect(script).toContain("SITE_ADDRESS=$SITE");
  expect(script).not.toContain("169.254.169.254");
  expect(script).toMatch(/must run as root/);
  expect(script).toMatch(/ufw allow/);
  expect(() => firstBootScript({ image: "img:1", issuer: "https://cloud.example", workspaceName: "Team", ownerCode: "q3J0Xn2l7uGm1oS9YbV4cR8eTwKp5Hzd", site: "https://x.example/$(reboot)" })).toThrow();
});

test("an IP address or a domain becomes the workspace's HTTPS address", () => {
  expect(siteAddress("203.0.113.9")).toBe("https://203-0-113-9.sslip.io");
  expect(siteAddress(" Team.Example.com ")).toBe("https://team.example.com");
  expect(siteAddress("https://team.example.com/")).toBe("https://team.example.com");
  for (const bad of ["", "localhost", "10.0.0.5", "192.168.1.2", "team", "https://user@team.example.com", "team.example.com:8443/x", "$(reboot).example.com"]) {
    expect(siteAddress(bad), bad).toBeNull();
  }
});

test("the command to paste is one line that carries the whole script", () => {
  const script = firstBootScript({ image: "img:1", issuer: "https://cloud.example", workspaceName: "Team", ownerCode: "q3J0Xn2l7uGm1oS9YbV4cR8eTwKp5Hzd", site: "https://team.example.com" });
  const command = selfHostCommand(script);
  expect(command).not.toContain("\n");
  expect(command).not.toMatch(/https?:\/\//); // nothing is downloaded to run it
  const encoded = /echo ([A-Za-z0-9+/=]+) \| base64 -d \| gunzip \| sudo bash$/.exec(command)?.[1];
  expect(encoded).toBeTruthy();
  expect(gunzipSync(Buffer.from(encoded!, "base64")).toString()).toBe(script);
  expect(command.length).toBeLessThan(4000);
});
