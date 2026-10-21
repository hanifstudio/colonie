// A Shared workspace on the owner's own DigitalOcean account: one droplet in
// their account, behind a firewall, set up on first boot to run the Colonie
// server image with Caddy for HTTPS on `<ip>.sslip.io`. Everything made is
// tagged with the workspace's own tag, so deleting removes exactly that.
// DigitalOcean bills the owner; nothing here runs on a Colonie service.
//
// The first-boot files are the ones in deploy/ (a test keeps them equal), so
// what runs on a droplet is what was tried in Docker. The same script sets up
// the owner's own server when they paste selfHostCommand into it.
import { gzipSync } from "node:zlib";

export const DEFAULT_REGION = "sgp1";
export const DEFAULT_SIZE = "s-2vcpu-4gb";
const BASE_IMAGE = "ubuntu-24-04-x64";
const SHARED_TAG = "colonie";

/** deploy/compose.yaml without its build section: a droplet pulls the image. */
export const COMPOSE_FILE = [
  "# A Shared workspace on one machine: the Colonie server and Caddy for HTTPS.\n",
  "# Caddy shares the server's network, so the server keeps listening on\n",
  "# loopback only, and every outside request reaches it through the proxy,\n",
  "# which the server never trusts as its owner.\n",
  "services:\n",
  "  colonie:\n",
  "    # COLONIE_IMAGE: a published image (a droplet pulls it), or this local build\n",
  "    image: ${COLONIE_IMAGE:-colonie-workspace:latest}\n",
  "    restart: unless-stopped\n",
  "    environment:\n",
  "      # where people reach it; differs from SITE_ADDRESS only behind a port mapping\n",
  "      COLONIE_PUBLIC_URL: ${PUBLIC_URL:-${SITE_ADDRESS}}\n",
  "      COLONIE_CLOUD_ISSUER: ${COLONIE_CLOUD_ISSUER}\n",
  "      COLONIE_WORKSPACE_NAME: ${COLONIE_WORKSPACE_NAME:-Colonie workspace}\n",
  "      COLONIE_OWNER_INVITE_CODE: ${COLONIE_OWNER_INVITE_CODE:-}\n",
  "    volumes:\n",
  "      - colonie-data:/data\n",
  "    ports:\n",
  "      - \"${HTTP_PORT:-80}:80\"\n",
  "      - \"${HTTPS_PORT:-443}:443\"\n",
  "  caddy:\n",
  "    image: caddy:2.11.7\n",
  "    restart: unless-stopped\n",
  "    network_mode: \"service:colonie\"\n",
  "    environment:\n",
  "      SITE_ADDRESS: ${SITE_ADDRESS}\n",
  "    volumes:\n",
  "      - ./Caddyfile:/etc/caddy/Caddyfile:ro\n",
  "      - caddy-data:/data\n",
  "volumes:\n",
  "  colonie-data:\n",
  "  caddy-data:\n",
].join("");

/** deploy/Caddyfile. */
export const CADDY_FILE = [
  "# HTTPS in front of the workspace server. SITE_ADDRESS is the server's public\n",
  "# address, for example https://203-0-113-5.sslip.io (a certificate is fetched\n",
  "# automatically) or https://localhost:8443 on a test machine (a local one).\n",
  "{$SITE_ADDRESS} {\n",
  "\treverse_proxy 127.0.0.1:8799 {\n",
  "\t\t# live updates are a long-lived event stream: pass each frame at once\n",
  "\t\tflush_interval -1\n",
  "\t}\n",
  "}\n",
].join("");

export function sslipAddress(ip: string): string {
  return `https://${ip.replace(/[.:]/g, "-")}.sslip.io`;
}

/** The workspace's HTTPS address from what the owner typed: a public IPv4
 * address (served on `<ip>.sslip.io`) or a domain that points at the server.
 * Null for anything else, private addresses included. */
export function siteAddress(input: string): string | null {
  const text = input.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/$/, "");
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    if (ip.slice(1).some((part) => Number(part) > 255)) return null;
    if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return null;
    return sslipAddress(text);
  }
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(text)) return null;
  return `https://${text}`;
}

/** The server's set-up script: on a droplet's first boot, or pasted by the
 * owner into their own Ubuntu server (`site` given). Every value is checked
 * or reduced to plain characters, because it lands in a shell script and an
 * env file. Running it again keeps the data and restarts with these values. */
export function firstBootScript(input: { image: string; issuer: string; workspaceName: string; ownerCode: string; site?: string }): string {
  if (!/^[\w.\-/:@]+$/.test(input.image)) throw new Error("image reference has characters a script cannot carry");
  if (!/^https:\/\/[\w.\-:]+$/.test(input.issuer)) throw new Error("the Colonie Cloud address must be a bare https origin");
  if (!/^[\w-]{24,128}$/.test(input.ownerCode)) throw new Error("the owner invite code must be 24 to 128 letters, digits, - or _");
  if (input.site !== undefined && !/^https:\/\/[a-z0-9.-]+$/.test(input.site)) throw new Error("the site address must be an https origin");
  const name = input.workspaceName.replace(/[^\p{L}\p{N} .,'&()-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Colonie workspace";
  const site = input.site
    ? [`SITE=${input.site}`]
    : ["IP=$(curl -fsS http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address)", "SITE=https://${IP//./-}.sslip.io"];
  return [
    "#!/bin/bash",
    "# Colonie Shared workspace: set up this server. On a droplet, logs are in /var/log/cloud-init-output.log",
    "set -euo pipefail",
    'if [ "$(id -u)" -ne 0 ]; then echo "This must run as root (use sudo)." >&2; exit 1; fi',
    "export DEBIAN_FRONTEND=noninteractive",
    "if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then",
    "  apt-get update",
    "  apt-get install -y docker.io docker-compose-v2",
    "fi",
    ...site,
    "if [ ! -f /opt/colonie/compose.yaml ] && command -v ss >/dev/null && ss -ltnH '( sport = :80 or sport = :443 )' | grep -q .; then",
    '  echo "Something on this server already uses port 80 or 443. Stop it, then run this again." >&2; exit 1',
    "fi",
    "if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then ufw allow 80/tcp; ufw allow 443/tcp; fi",
    "mkdir -p /opt/colonie",
    "cd /opt/colonie",
    "cat > compose.yaml <<'COLONIE_COMPOSE'",
    COMPOSE_FILE + "COLONIE_COMPOSE",
    "cat > Caddyfile <<'COLONIE_CADDY'",
    CADDY_FILE + "COLONIE_CADDY",
    "umask 077",
    "cat > .env <<COLONIE_ENV",
    "SITE_ADDRESS=$SITE",
    `COLONIE_IMAGE="${input.image}"`,
    `COLONIE_CLOUD_ISSUER="${input.issuer}"`,
    `COLONIE_WORKSPACE_NAME="${name}"`,
    `COLONIE_OWNER_INVITE_CODE="${input.ownerCode}"`,
    "COLONIE_ENV",
    "docker compose pull",
    "docker compose up -d --no-build",
    'echo "Colonie is starting at $SITE. Go back to the Colonie app: it opens the workspace when it answers."',
    "",
  ].join("\n");
}

/** One line the owner pastes into their server: the whole script, gzipped
 * and base64-encoded, so nothing is downloaded from anywhere to run it. */
export function selfHostCommand(script: string): string {
  return `echo ${gzipSync(Buffer.from(script)).toString("base64")} | base64 -d | gunzip | sudo bash`;
}

interface Droplet { id: number; status: string; networks?: { v4?: Array<{ type: string; ip_address: string }> } }

export function createDigitalOcean(deps: {
  token: () => Promise<string>;
  api?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}) {
  const api = deps.api ?? "https://api.digitalocean.com";
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${await deps.token()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401) throw Object.assign(new Error("DigitalOcean did not accept the sign-in. Connect DigitalOcean again."), { status: 401 });
    const text = await res.text();
    const value = text ? JSON.parse(text) : null;
    if (!res.ok) throw Object.assign(new Error(`DigitalOcean answered: ${value?.message ?? res.statusText}`), { status: res.status });
    return value as T;
  }

  return {
    async account(): Promise<{ email: string; dropletLimit: number; active: boolean }> {
      const { account } = await call("GET", "/v2/account");
      return { email: account.email, dropletLimit: account.droplet_limit, active: account.status === "active" };
    },

    /** The live price DigitalOcean lists for this size, in this region. */
    async price(size: string, region: string): Promise<{ monthlyUsd: number; hourlyUsd: number }> {
      const { sizes } = await call<{ sizes: Array<{ slug: string; price_monthly: number; price_hourly: number; regions: string[]; available: boolean }> }>("GET", "/v2/sizes?per_page=200");
      const found = sizes.find((entry) => entry.slug === size);
      if (!found || !found.available || !found.regions.includes(region)) throw new Error(`Size ${size} is not offered in ${region} right now.`);
      return { monthlyUsd: found.price_monthly, hourlyUsd: found.price_hourly };
    },

    async create(input: { name: string; tag: string; region: string; size: string; userData: string }): Promise<{ dropletId: number; firewallId: string }> {
      const { droplet } = await call<{ droplet: Droplet }>("POST", "/v2/droplets", {
        name: input.name, region: input.region, size: input.size, image: BASE_IMAGE,
        tags: [SHARED_TAG, input.tag], user_data: input.userData, monitoring: true,
      });
      const anywhere = { addresses: ["0.0.0.0/0", "::/0"] };
      const { firewall } = await call<{ firewall: { id: string } }>("POST", "/v2/firewalls", {
        name: input.tag,
        inbound_rules: ["80", "443"].map((ports) => ({ protocol: "tcp", ports, sources: anywhere })),
        outbound_rules: [
          { protocol: "tcp", ports: "all", destinations: anywhere },
          { protocol: "udp", ports: "all", destinations: anywhere },
          { protocol: "icmp", destinations: anywhere },
        ],
        tags: [input.tag],
      });
      return { dropletId: droplet.id, firewallId: firewall.id };
    },

    /** Wait until the droplet is running and has a public IPv4 address. */
    async waitForAddress(dropletId: number, { attempts = 60, intervalMs = 5_000 } = {}): Promise<string> {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const { droplet } = await call<{ droplet: Droplet }>("GET", `/v2/droplets/${dropletId}`);
        const ip = droplet.networks?.v4?.find((network) => network.type === "public")?.ip_address;
        if (droplet.status === "active" && ip) return ip;
        await sleep(intervalMs);
      }
      throw new Error("The server did not start in time. It may still be starting; check DigitalOcean.");
    },

    /** Delete everything this workspace's tag marks: its droplet and firewall. */
    async remove(tag: string): Promise<void> {
      await call("DELETE", `/v2/droplets?tag_name=${encodeURIComponent(tag)}`);
      const { firewalls } = await call<{ firewalls: Array<{ id: string; tags: string[] }> }>("GET", "/v2/firewalls?per_page=200");
      for (const firewall of firewalls.filter((entry) => entry.tags.includes(tag))) await call("DELETE", `/v2/firewalls/${firewall.id}`);
    },
  };
}

export type DigitalOcean = ReturnType<typeof createDigitalOcean>;
