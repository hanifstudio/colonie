// Sign-in/session boundary. Two implementations behind one interface:
//
//   * memoryAuth()       — a self-contained fixture for tests. It implements
//     the same four Better Auth route shapes the UI calls, with httpOnly
//     cookie sessions and scrypt password hashes. No dependency, no network.
//   * betterAuthAdapter() — the production adapter. It loads `better-auth`
//     dynamically (the lead installs it) and delegates everything under
//     /api/colonie/auth to Better Auth's node handler.
//
// Both answer POST /sign-up/email, POST /sign-in/email, GET /get-session and
// POST /sign-out. Signup needs no email verification.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { json, readBody } from "../../harness/http.ts";
import { PLATFORM_AUTH_BASE } from "../../../shared/colonie-platform.ts";
import type { AuthenticatedHuman, PlatformAuth } from "./contracts.ts";

const COOKIE = "colonie.session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

interface FixtureUser extends AuthenticatedHuman {
  salt: string;
  hash: string;
}

function hashPassword(password: string, salt: string): Buffer {
  return scryptSync(password, salt, 64);
}

/**
 * Test fixture auth. Accounts are ephemeral and live only for the process.
 * `signup` throws on a duplicate email, matching Better Auth's 422.
 */
export class MemoryPlatformAuth implements PlatformAuth {
  private readonly usersByEmail = new Map<string, FixtureUser>();
  private readonly sessions = new Map<string, string>();

  /** Test helper: register a confirmed account without going through HTTP. */
  seed(email: string, password: string, name = email.split("@")[0]!): AuthenticatedHuman {
    const user = this.createUser(email, password, name);
    return { id: user.id, email: user.email, name: user.name };
  }

  private createUser(email: string, password: string, name: string): FixtureUser {
    const key = email.trim().toLowerCase();
    const salt = randomBytes(16).toString("hex");
    const user: FixtureUser = {
      id: randomUUID(),
      email: key,
      name: name.trim() || key.split("@")[0]!,
      salt,
      hash: hashPassword(password, salt).toString("hex"),
    };
    this.usersByEmail.set(key, user);
    return user;
  }

  private verify(user: FixtureUser, password: string): boolean {
    const expected = Buffer.from(user.hash, "hex");
    const actual = hashPassword(password, user.salt);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private publicUser(user: FixtureUser): AuthenticatedHuman {
    return { id: user.id, email: user.email, name: user.name };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(PLATFORM_AUTH_BASE)) return false;
    const route = url.pathname.slice(PLATFORM_AUTH_BASE.length);
    if (route === "/sign-up/email" && req.method === "POST") {
      const body = (await readBody(req)) as { email?: unknown; password?: unknown; name?: unknown };
      if (typeof body.email !== "string" || typeof body.password !== "string" || body.password.length < 8) {
        json(res, 422, { error: "A valid email and a password of at least 8 characters are required.", code: "invalid_credentials" });
        return true;
      }
      const key = body.email.trim().toLowerCase();
      if (this.usersByEmail.has(key)) {
        json(res, 422, { error: "An account with that email already exists.", code: "user_exists" });
        return true;
      }
      const user = this.createUser(key, body.password, typeof body.name === "string" ? body.name : "");
      this.issue(user, res);
      json(res, 200, { user: this.publicUser(user) });
      return true;
    }
    if (route === "/sign-in/email" && req.method === "POST") {
      const body = (await readBody(req)) as { email?: unknown; password?: unknown };
      const user = typeof body.email === "string" ? this.usersByEmail.get(body.email.trim().toLowerCase()) : undefined;
      if (!user || typeof body.password !== "string" || !this.verify(user, body.password)) {
        json(res, 401, { error: "That email and password do not match.", code: "invalid_credentials" });
        return true;
      }
      this.issue(user, res);
      json(res, 200, { user: this.publicUser(user) });
      return true;
    }
    if (route === "/get-session" && req.method === "GET") {
      const human = await this.session(req);
      json(res, 200, human ? { session: { id: "fixture", expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() }, user: human } : null);
      return true;
    }
    if (route === "/sign-out" && req.method === "POST") {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies[COOKIE];
      if (token) this.sessions.delete(token);
      res.setHeader("set-cookie", sessionCookie("", 0));
      json(res, 200, {});
      return true;
    }
    return false;
  }

  private issue(user: FixtureUser, res: ServerResponse): string {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, user.id);
    res.setHeader("set-cookie", sessionCookie(token, SESSION_TTL_MS / 1000));
    return token;
  }

  async session(req: IncomingMessage): Promise<AuthenticatedHuman | null> {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const accountId = this.sessions.get(token);
    if (!accountId) return null;
    const user = [...this.usersByEmail.values()].find((u) => u.id === accountId);
    return user ? this.publicUser(user) : null;
  }

  async recoverPassword(accountId: string, newPassword: string): Promise<void> {
    const user = [...this.usersByEmail.values()].find((u) => u.id === accountId);
    if (!user) throw new Error("No such account.");
    const salt = randomBytes(16).toString("hex");
    user.salt = salt;
    user.hash = hashPassword(newPassword, salt).toString("hex");
  }

  async revokeSessions(accountId: string): Promise<void> {
    for (const [token, id] of this.sessions) {
      if (id === accountId) this.sessions.delete(token);
    }
  }
}

export interface BetterAuthOptions {
  /** A `pg` Pool (or any Better Auth database adapter). */
  database: unknown;
  secret: string;
  baseURL?: string;
  trustedOrigins?: string[];
  /** Better Auth session lifetime in seconds. */
  sessionExpiresIn?: number;
}

/** Minimal structural view of the pieces of Better Auth we call. */
interface BetterAuthAccount {
  id: string;
  providerId?: string;
}
interface BetterAuthContext {
  internalAdapter: {
    findAccounts(userId: string): Promise<BetterAuthAccount[]>;
    updateAccount(id: string, data: Record<string, unknown>): Promise<unknown>;
    updatePassword?(userId: string, password: string): Promise<void>;
    deleteUserSessions(userId: string): Promise<void>;
  };
}
interface BetterAuthInstance {
  handler(request: Request): Promise<Response>;
  api: { getSession(input: { headers: Headers }): Promise<{ user?: { id?: string; email?: string; name?: string } } | null> };
  /** Resolved options; handed to getMigrations so the host can create auth tables. */
  options: unknown;
  $context: Promise<BetterAuthContext>;
}

function headersFromNode(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}

function requestFromNode(req: IncomingMessage, body: Buffer): Request {
  const url = new URL(req.url ?? "/", "http://localhost");
  const headers = headersFromNode(req);
  const method = req.method ?? "GET";
  return new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(body) });
}

export function readPlatformAuthBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.length;
      if (bytes > 128_000) {
        settled = true;
        chunks.length = 0;
        reject(Object.assign(new Error("This request is too large."), { status: 413 }));
        return; // Keep draining so the caller can receive the 413 response.
      }
      chunks.push(buffer);
    });
    req.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on("error", () => { if (!settled) { settled = true; reject(new Error("The account request could not be read.")); } });
    req.on("aborted", () => { if (!settled) { settled = true; reject(new Error("The account request was interrupted.")); } });
  });
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  // set-cookie may repeat; Node's Headers folds it, so read it specially.
  const setCookie = (response.headers as { getSetCookie?: () => string[] }).getSetCookie?.();
  if (setCookie && setCookie.length > 0) headers["set-cookie"] = setCookie;
  res.writeHead(response.status, headers);
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

async function loadModule(specifier: string): Promise<Record<string, unknown>> {
  return import(specifier) as Promise<Record<string, unknown>>;
}

/** Build the Better Auth instance shared by the adapter and the migrator. */
async function createBetterAuthInstance(options: BetterAuthOptions): Promise<BetterAuthInstance> {
  const module = await loadModule("better-auth");
  const betterAuth = module.betterAuth as (config: Record<string, unknown>) => BetterAuthInstance;
  if (typeof betterAuth !== "function") throw new Error("better-auth did not export betterAuth().");
  return betterAuth({
    database: options.database,
    secret: options.secret,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    basePath: PLATFORM_AUTH_BASE,
    trustedOrigins: options.trustedOrigins ?? [],
    emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 8 },
    session: { expiresIn: options.sessionExpiresIn ?? SESSION_TTL_MS / 1000 },
  });
}

/**
 * Production adapter. Loads `better-auth` at runtime so a test build never
 * pulls it in. Password recovery hashes with `better-auth/crypto` and updates
 * the credential account through Better Auth's own internal adapter, then
 * revokes every session for the account.
 */
export async function betterAuthAdapter(options: BetterAuthOptions): Promise<PlatformAuth> {
  return betterAuthAdapterFrom(await createBetterAuthInstance(options));
}

export interface PlatformAuthInit {
  auth: PlatformAuth;
  /**
   * Create Better Auth's own tables with the same pool the app uses. The host
   * calls this once at boot; it must not be replaced with hand-written tables.
   */
  runMigrations(): Promise<{ tables: string[] }>;
}

/** Production init: one Better Auth instance for both serving and migrating. */
export async function initPlatformAuth(options: BetterAuthOptions): Promise<PlatformAuthInit> {
  const instance = await createBetterAuthInstance(options);
  const adapter = await betterAuthAdapterFrom(instance);
  return {
    auth: adapter,
    async runMigrations() {
      const migration = await loadModule("better-auth/db/migration");
      const getMigrations = migration.getMigrations as (config: unknown) => Promise<{ toBeCreated: Array<{ table: string }>; runMigrations: () => Promise<void> }>;
      if (typeof getMigrations !== "function") throw new Error("better-auth/db/migration did not export getMigrations().");
      const plan = await getMigrations(instance.options);
      await plan.runMigrations();
      return { tables: plan.toBeCreated.map((table) => table.table) };
    },
  };
}

function betterAuthAdapterFrom(auth: BetterAuthInstance): PlatformAuth {
  const hashPassword = async (password: string): Promise<string> => {
    const crypto = await loadModule("better-auth/crypto");
    const hasher = crypto.hashPassword as (value: string) => Promise<string>;
    return hasher(password);
  };
  return {
    async handle(req, res) {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith(PLATFORM_AUTH_BASE)) return false;
      const body = req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : await readPlatformAuthBody(req);
      const response = await auth.handler(requestFromNode(req, body));
      await writeFetchResponse(res, response);
      return true;
    },
    async session(req) {
      const result = await auth.api.getSession({ headers: headersFromNode(req) });
      const user = result?.user;
      if (!user?.id || !user.email) return null;
      return { id: user.id, email: user.email, name: user.name ?? user.email.split("@")[0]! };
    },
    async recoverPassword(accountId, newPassword) {
      const hash = await hashPassword(newPassword);
      const ctx = await auth.$context;
      const accounts = await ctx.internalAdapter.findAccounts(accountId);
      const credential = accounts.find((account) => account.providerId === "credential") ?? accounts[0];
      if (!credential) throw new Error("This account has no password to reset.");
      await ctx.internalAdapter.updateAccount(credential.id, { password: hash });
    },
    async revokeSessions(accountId) {
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteUserSessions(accountId);
    },
    hashPassword,
  };
}
