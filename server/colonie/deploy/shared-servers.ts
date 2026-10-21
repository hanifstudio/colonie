// Creating Shared workspaces from the desktop app, on the owner's own
// DigitalOcean account.
//
// Connecting: the app registers itself with DigitalOcean as a public client
// (no secret), and the owner approves in their browser (PKCE, S256). The
// way back is this computer's own server on 127.0.0.1, which DigitalOcean
// accepts on any port. The token stays in <data>/digitalocean.json, mode 600,
// and never reaches the page: the routes answer with what the owner needs to
// see (account, price, servers), nothing more.
//
// Creating: one droplet per workspace (see digitalocean.ts), then waiting
// for its public address and for the Colonie server on it to answer. The
// owner invite code is made here and set on the server at first boot; the
// invite link is shown once the server answers.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../../persistence/atomic.ts";
import { DEFAULT_REGION, DEFAULT_SIZE, createDigitalOcean, firstBootScript, selfHostCommand, siteAddress, sslipAddress } from "./digitalocean.ts";

/** Colonie Cloud, where people sign in to a Shared workspace. The desktop
 * app's window allows the same address (electron/main.mjs). */
export const COLONIE_CLOUD = "https://colonie-cloud.hanifyaskur.workers.dev";
/** The published server image a new workspace runs, for this version. */
export const serverImage = (version: string) => `ghcr.io/hanifstudio/colonie-workspace:${version}`;
export const CALLBACK_PATH = "/api/shared-servers/digitalocean/callback";

const SCOPES = [
  "account:read", "sizes:read", "regions:read", "actions:read",
  "droplet:create", "droplet:read", "droplet:delete",
  "firewall:create", "firewall:read", "firewall:delete",
  "tag:create", "tag:read",
];
const PENDING_MS = 15 * 60_000;
const READY_ATTEMPTS = 180; // ten seconds apart: half an hour for first boot and the image download
const READY_INTERVAL_MS = 10_000;
const SELF_READY_ATTEMPTS = 720; // two hours: the owner pastes the command when they get to it

export type SharedServerState = "creating" | "starting" | "ready" | "failed";
export interface SharedServer {
  id: string;
  /** Where it runs: a droplet made here, or the owner's own server. */
  kind?: "digitalocean" | "self";
  /** Own server: the one line the owner pastes into it. */
  command?: string;
  name: string;
  tag: string;
  region: string;
  size: string;
  state: SharedServerState;
  createdAt: string;
  dropletId?: number;
  address?: string;
  inviteUrl?: string;
  /** The owner has opened it once: their invite is spent; open the address. */
  opened?: boolean;
  error?: string;
}
interface Stored extends SharedServer { ownerCode: string }
interface Credentials { clientId?: string; redirectUri?: string; accessToken?: string; refreshToken?: string; expiresAt?: number }

export function createSharedServers(deps: {
  dataDir: string;
  image: string;
  issuer: string;
  oauthBase?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** True once the Colonie server at this address answers. */
  probe?: (address: string) => Promise<boolean>;
}) {
  const oauth = `${deps.oauthBase ?? "https://cloud.digitalocean.com"}/v1/oauth`;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const probe = deps.probe ?? (async (address: string) => {
    try { return (await doFetch(`${address}/.well-known/colonie/environment`, { signal: AbortSignal.timeout(8_000) })).ok; } catch { return false; }
  });
  const credentialsFile = join(deps.dataDir, "digitalocean.json");
  const serversFile = join(deps.dataDir, "shared-servers.json");
  const pending = new Map<string, { verifier: string; redirectUri: string; expiresAt: number }>();
  let refreshing: Promise<string> | null = null;

  const readJson = <T>(file: string, fallback: T): T => {
    try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as T : fallback; } catch { return fallback; }
  };
  const credentials = () => readJson<Credentials>(credentialsFile, {});
  const saveCredentials = (next: Credentials) => writeFileAtomic(credentialsFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  let records = readJson<Stored[]>(serversFile, []);
  const saveRecords = () => writeFileAtomic(serversFile, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  const update = (id: string, change: Partial<Stored>) => {
    records = records.map((record) => (record.id === id ? { ...record, ...change } : record));
    saveRecords();
  };
  const shown = ({ ownerCode, ...record }: Stored): SharedServer => (
    record.state === "ready" && record.address ? { ...record, inviteUrl: `${record.address}/invite/${ownerCode}` } : record
  );

  async function tokenRequest(form: Record<string, string>) {
    const res = await doFetch(`${oauth}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
    const value = await res.json().catch(() => null) as { access_token?: string; refresh_token?: string; expires_in?: number } | null;
    if (!res.ok || !value?.access_token) throw Object.assign(new Error("DigitalOcean did not accept the sign-in. Connect DigitalOcean again."), { status: 401 });
    const current = credentials();
    saveCredentials({ ...current, accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: now() + (value.expires_in ?? 3600) * 1000 });
  }

  /** The access token, renewed first when it is about to expire. A refresh
   * token works once, so two callers share one renewal. */
  async function token(): Promise<string> {
    const current = credentials();
    if (!current.accessToken) throw Object.assign(new Error("Connect DigitalOcean first."), { status: 409 });
    if ((current.expiresAt ?? 0) - 60_000 > now()) return current.accessToken;
    if (!current.refreshToken || !current.clientId) throw Object.assign(new Error("DigitalOcean did not accept the sign-in. Connect DigitalOcean again."), { status: 401 });
    refreshing ??= tokenRequest({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: current.clientId })
      .then(() => credentials().accessToken!)
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  const digitalOcean = createDigitalOcean({ token, api: deps.apiBase, fetch: doFetch, sleep });

  async function finish(id: string) {
    const record = records.find((entry) => entry.id === id);
    if (!record?.dropletId && record?.kind !== "self") return;
    const self = record.kind === "self";
    try {
      let address = record.address;
      if (!address) {
        address = sslipAddress(await digitalOcean.waitForAddress(record.dropletId!));
        update(id, { state: "starting", address });
      }
      for (let attempt = 0; attempt < (self ? SELF_READY_ATTEMPTS : READY_ATTEMPTS); attempt += 1) {
        if (!records.some((entry) => entry.id === id)) return; // deleted meanwhile
        if (await probe(address)) { update(id, { state: "ready" }); return; }
        await sleep(READY_INTERVAL_MS);
      }
      update(id, { state: "failed", error: self
        ? "The server did not answer within two hours. Check the command finished on it, then add it again."
        : "The server did not answer within half an hour. Delete it and try again, or look at it in DigitalOcean." });
    } catch (error) {
      update(id, { state: "failed", error: (error as Error).message });
    }
  }

  // Servers still starting when the app last closed are waited for again.
  for (const record of records) if (record.state === "creating" || record.state === "starting") void finish(record.id);

  return {
    async status() {
      const base = { region: DEFAULT_REGION, size: DEFAULT_SIZE };
      if (!credentials().accessToken) return { connected: false, ...base };
      try {
        const [account, price] = await Promise.all([digitalOcean.account(), digitalOcean.price(DEFAULT_SIZE, DEFAULT_REGION)]);
        return { connected: true, account, price, ...base };
      } catch (error) {
        const status = (error as { status?: number }).status;
        return { connected: status !== 401, ...base, error: (error as Error).message };
      }
    },

    async connect(redirectUri: string): Promise<{ authorizationUrl: string }> {
      let current = credentials();
      if (!current.clientId || current.redirectUri !== redirectUri) {
        const res = await doFetch(`${oauth}/register`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "Colonie", redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
          }),
        });
        const value = await res.json().catch(() => null) as { client_id?: string } | null;
        if (!res.ok || !value?.client_id) throw Object.assign(new Error("DigitalOcean did not register Colonie. Try again in a moment."), { status: 502 });
        current = { ...current, clientId: value.client_id, redirectUri };
        saveCredentials(current);
      }
      const verifier = randomBytes(32).toString("base64url");
      const state = randomBytes(24).toString("base64url");
      for (const [key, entry] of pending) if (entry.expiresAt < now()) pending.delete(key);
      pending.set(state, { verifier, redirectUri, expiresAt: now() + PENDING_MS });
      const url = new URL(`${oauth}/authorize`);
      url.search = new URLSearchParams({
        response_type: "code", client_id: current.clientId!, redirect_uri: redirectUri, scope: SCOPES.join(" "), state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      }).toString();
      return { authorizationUrl: url.href };
    },

    /** The browser's way back from DigitalOcean. The state is the credential, used once. */
    async callback(search: string): Promise<{ status: number; text: string }> {
      const query = new URLSearchParams(search);
      const state = query.get("state") ?? "";
      const entry = pending.get(state);
      pending.delete(state);
      const code = query.get("code");
      if (!entry || entry.expiresAt < now() || !code) {
        return { status: 400, text: "This DigitalOcean sign-in is no longer valid. Return to Colonie and connect again." };
      }
      try {
        await tokenRequest({ grant_type: "authorization_code", code, client_id: credentials().clientId!, redirect_uri: entry.redirectUri, code_verifier: entry.verifier });
        return { status: 200, text: "DigitalOcean is connected. You can close this tab and return to Colonie." };
      } catch {
        return { status: 400, text: "DigitalOcean did not finish the sign-in. Return to Colonie and connect again." };
      }
    },

    async disconnect() {
      const current = credentials();
      if (current.accessToken) {
        await doFetch(`${oauth}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: current.accessToken }) }).catch(() => {});
      }
      rmSync(credentialsFile, { force: true });
    },

    list(): SharedServer[] {
      return records.map(shown);
    },

    async create(name: string): Promise<SharedServer> {
      const cleanName = name.trim().replace(/\s+/g, " ").slice(0, 60) || "Colonie workspace";
      const id = randomUUID();
      const tag = `colonie-ws-${id.slice(0, 8)}`;
      const ownerCode = randomBytes(24).toString("base64url");
      const userData = firstBootScript({ image: deps.image, issuer: deps.issuer, workspaceName: cleanName, ownerCode });
      const dropletName = `colonie-${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workspace"}`;
      const made = await digitalOcean.create({ name: dropletName, tag, region: DEFAULT_REGION, size: DEFAULT_SIZE, userData });
      const record: Stored = { id, name: cleanName, tag, region: DEFAULT_REGION, size: DEFAULT_SIZE, state: "creating", createdAt: new Date(now()).toISOString(), dropletId: made.dropletId, ownerCode };
      records = [...records, record];
      saveRecords();
      void finish(id);
      return shown(record);
    },

    markOpened(id: string) {
      if (!records.some((entry) => entry.id === id)) throw Object.assign(new Error("No such Shared workspace."), { status: 404 });
      update(id, { opened: true });
    },

    /** A Shared workspace on the owner's own server: the command to paste
     * there, then the same wait and owner invite as a droplet. */
    async createSelfHosted(name: string, rawAddress: string): Promise<SharedServer> {
      const address = siteAddress(rawAddress);
      if (!address) throw Object.assign(new Error("Enter the server's public IP address, or a domain that points to it."), { status: 400 });
      const cleanName = name.trim().replace(/\s+/g, " ").slice(0, 60) || "Colonie workspace";
      const id = randomUUID();
      const ownerCode = randomBytes(24).toString("base64url");
      const command = selfHostCommand(firstBootScript({ image: deps.image, issuer: deps.issuer, workspaceName: cleanName, ownerCode, site: address }));
      const record: Stored = {
        id, kind: "self", name: cleanName, tag: `colonie-ws-${id.slice(0, 8)}`, region: "", size: "",
        state: "starting", createdAt: new Date(now()).toISOString(), address, command, ownerCode,
      };
      records = [...records, record];
      saveRecords();
      void finish(id);
      return shown(record);
    },

    async remove(id: string) {
      const record = records.find((entry) => entry.id === id);
      if (!record) throw Object.assign(new Error("No such Shared workspace."), { status: 404 });
      // The owner's own server is theirs to stop; only a droplet made here is deleted.
      if (record.kind !== "self") await digitalOcean.remove(record.tag);
      records = records.filter((entry) => entry.id !== id);
      saveRecords();
    },
  };
}

export type SharedServers = ReturnType<typeof createSharedServers>;
