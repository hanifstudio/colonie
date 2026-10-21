// A Shared workspace on the owner's own DigitalOcean account: one droplet in
// their account, behind a firewall, set up on first boot to run the Colonie
// server image with Caddy for HTTPS on `<ip>.sslip.io`. Everything made is
// tagged with the workspace's own tag, so deleting removes exactly that.
// DigitalOcean bills the owner; nothing here runs on a Colonie service.
//
// The first-boot files are the ones in deploy/ (a test keeps them equal), so
// what runs on a droplet is what was tried in Docker.

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

/** The droplet's first-boot script. Every value is checked or reduced to
 * plain characters, because it lands in a shell script and an env file. */
export function firstBootScript(input: { image: string; issuer: string; workspaceName: string; ownerCode: string }): string {
  if (!/^[\w.\-/:@]+$/.test(input.image)) throw new Error("image reference has characters a script cannot carry");
  if (!/^https:\/\/[\w.\-:]+$/.test(input.issuer)) throw new Error("the Colonie Cloud address must be a bare https origin");
  if (!/^[\w-]{24,128}$/.test(input.ownerCode)) throw new Error("the owner invite code must be 24 to 128 letters, digits, - or _");
  const name = input.workspaceName.replace(/[^\p{L}\p{N} .,'&()-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Colonie workspace";
  return [
    "#!/bin/bash",
    "# Colonie Shared workspace: first boot. Logs: /var/log/cloud-init-output.log",
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update",
    "apt-get install -y docker.io docker-compose-v2",
    "IP=$(curl -fsS http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address)",
    "mkdir -p /opt/colonie",
    "cd /opt/colonie",
    "cat > compose.yaml <<'COLONIE_COMPOSE'",
    COMPOSE_FILE + "COLONIE_COMPOSE",
    "cat > Caddyfile <<'COLONIE_CADDY'",
    CADDY_FILE + "COLONIE_CADDY",
    "umask 077",
    "cat > .env <<COLONIE_ENV",
    "SITE_ADDRESS=https://${IP//./-}.sslip.io",
    `COLONIE_IMAGE="${input.image}"`,
    `COLONIE_CLOUD_ISSUER="${input.issuer}"`,
    `COLONIE_WORKSPACE_NAME="${name}"`,
    `COLONIE_OWNER_INVITE_CODE="${input.ownerCode}"`,
    "COLONIE_ENV",
    "docker compose pull",
    "docker compose up -d --no-build",
    "",
  ].join("\n");
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
