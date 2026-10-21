// Joining and signing in to a Shared workspace with a Colonie account.
//
// The workspace registers itself once with Colonie Cloud (its issuer and the
// client id it got back live in <data>/colonie-cloud.json). An admin makes a
// one-time invite link; opening it sends the person to Colonie Cloud to sign
// in or sign up (code plus PKCE), and the ID token that comes back names
// their account. Membership is bound to that account id, never to the email:
// Colonie does not verify email addresses, so an email alone proves nothing.
// Members and invites live in <data>/colonie-members.json (0600), server-
// private. A member signs in again later through the same flow, no invite.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { writeFileAtomic } from "../../persistence/atomic.ts";

export type MemberRole = "admin" | "member";
export interface Member { sub: string; email: string; name: string; role: MemberRole; joinedAt: string }
interface Invite { codeHash: string; role: MemberRole; expiresAt: string; usedAt?: string }
interface Pending { verifier: string; nonce: string; inviteHash?: string; expires: number }
export interface CloudLink { issuer: string; clientId: string }

export const INVITE_DAYS = 7;
const PENDING_MS = 10 * 60_000;
const CALLBACK = "/auth/colonie/callback";

const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

export interface ColonieSignInDeps {
  dataDir: string;
  /** Put an email on the workspace's sign-in list with this role. */
  allowEmail: (email: string, role: MemberRole) => void;
  /** Take an email off the sign-in list; its sessions end with it. */
  forgetEmail: (email: string) => void;
  /** Open a session for a member; returns the token for the session cookie. */
  openSession: (member: Member, label: string) => { token: string; maxAgeSeconds: number };
  /** Serialize the workspace's session cookie for this request. */
  sessionCookie: (req: IncomingMessage, token: string, maxAgeSeconds: number) => string;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function createColonieSignIn(deps: ColonieSignInDeps) {
  const cloudFile = join(deps.dataDir, "colonie-cloud.json");
  const membersFile = join(deps.dataDir, "colonie-members.json");
  const http = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const pending = new Map<string, Pending>();
  let jwks: { issuer: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;

  const readJson = <T>(file: string, fallback: T): T => {
    try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as T : fallback; } catch { return fallback; }
  };
  const link = (): CloudLink | null => {
    const value = readJson<Partial<CloudLink>>(cloudFile, {});
    return typeof value.issuer === "string" && typeof value.clientId === "string" ? { issuer: value.issuer, clientId: value.clientId } : null;
  };
  const book = () => readJson<{ invites: Invite[]; members: Member[] }>(membersFile, { invites: [], members: [] });
  const saveBook = (value: { invites: Invite[]; members: Member[] }) => writeFileAtomic(membersFile, JSON.stringify(value, null, 2), { mode: 0o600 });

  function page(res: ServerResponse, status: number, title: string, text: string) {
    const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><body style="font:16px system-ui;max-width:28rem;margin:4rem auto"><h1>${escape(title)}</h1><p>${escape(text)}</p>`);
  }
  const redirectTo = (res: ServerResponse, location: string, headers: Record<string, string> = {}) => {
    res.writeHead(303, { location, "cache-control": "no-store", ...headers });
    res.end();
  };
  const origin = (req: IncomingMessage, publicUrl: string | null) =>
    publicUrl ?? `http://${req.headers.host ?? "127.0.0.1"}`;

  /** Send the person to Colonie Cloud to sign in (or up), remembering how to
   * finish when they come back. */
  function startSignIn(req: IncomingMessage, res: ServerResponse, cloud: CloudLink, publicUrl: string | null, inviteHash?: string) {
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(16).toString("base64url");
    for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
    pending.set(state, { verifier, nonce, ...(inviteHash ? { inviteHash } : {}), expires: Date.now() + PENDING_MS });
    const url = new URL(`${cloud.issuer}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code", client_id: cloud.clientId, redirect_uri: `${origin(req, publicUrl)}${CALLBACK}`, state, nonce,
      code_challenge: sha256(verifier), code_challenge_method: "S256",
    }).toString();
    redirectTo(res, url.toString());
  }

  async function verifiedAccount(cloud: CloudLink, redirectUri: string, code: string, flow: Pending) {
    const answer = await http(`${cloud.issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: cloud.clientId, redirect_uri: redirectUri, code_verifier: flow.verifier }).toString(),
    });
    if (!answer.ok) return null;
    const { id_token: idToken } = await answer.json() as { id_token?: string };
    if (!idToken) return null;
    if (jwks?.issuer !== cloud.issuer) jwks = { issuer: cloud.issuer, set: createRemoteJWKSet(new URL(`${cloud.issuer}/.well-known/jwks.json`)) };
    const { payload } = await jwtVerify(idToken, jwks.set, { issuer: cloud.issuer, audience: cloud.clientId, algorithms: ["ES256"] });
    if (payload.nonce !== flow.nonce || typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return { sub: payload.sub, email: payload.email.trim().toLowerCase(), name: typeof payload.name === "string" ? payload.name : payload.email };
  }

  return {
    /** The workspace's link to Colonie Cloud, if it has one. */
    link,

    /** Register this workspace with Colonie Cloud: its name and the one
     * address sign-ins come back to. */
    async connect(issuer: string, name: string, publicUrl: string): Promise<CloudLink> {
      const cleanIssuer = issuer.replace(/\/+$/, "");
      const answer = await http(`${cleanIssuer}/clients`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, redirect_uri: `${publicUrl.replace(/\/+$/, "")}${CALLBACK}` }),
      });
      if (!answer.ok) throw Object.assign(new Error(`Colonie Cloud refused the workspace (${answer.status})`), { status: 502 });
      const { client_id: clientId } = await answer.json() as { client_id: string };
      const value = { issuer: cleanIssuer, clientId };
      writeFileAtomic(cloudFile, JSON.stringify(value, null, 2), { mode: 0o600 });
      return value;
    },

    /** A one-time invite link. Only its hash is kept. */
    /** Remove a person from the workspace: off the member list and the
     * sign-in list, which ends their sessions. Their Colonie account stays;
     * coming back takes a new invite. */
    removeMember(email: string): boolean {
      const address = email.trim().toLowerCase();
      const current = book();
      const kept = current.members.filter((member) => member.email.toLowerCase() !== address);
      if (kept.length !== current.members.length) saveBook({ ...current, members: kept });
      deps.forgetEmail(address);
      return kept.length !== current.members.length;
    },

    createInvite(role: MemberRole, publicUrl: string): { url: string; expiresAt: string } {
      const code = randomBytes(24).toString("base64url");
      const expiresAt = new Date(now().getTime() + INVITE_DAYS * 24 * 60 * 60_000).toISOString();
      const current = book();
      current.invites = current.invites.filter((invite) => !invite.usedAt && invite.expiresAt > now().toISOString());
      current.invites.push({ codeHash: sha256(code), role, expiresAt });
      saveBook(current);
      return { url: `${publicUrl.replace(/\/+$/, "")}/invite/${code}`, expiresAt };
    },

    members: (): Member[] => book().members,

    /** The first owner's way in. Whoever creates the server (the one-click
     * deployment) makes this code and hands it over at start; only its hash is
     * kept. It is an admin invite, and only while the workspace has no member:
     * once anyone has joined, a code at start does nothing. */
    ensureOwnerInvite(code: string): "added" | "present" | "has-members" | "invalid" {
      if (!/^[\w-]{20,64}$/.test(code)) return "invalid";
      const current = book();
      if (current.members.length) return "has-members";
      const codeHash = sha256(code);
      if (current.invites.some((invite) => invite.codeHash === codeHash)) return "present";
      current.invites.push({ codeHash, role: "admin", expiresAt: new Date(now().getTime() + INVITE_DAYS * 24 * 60 * 60_000).toISOString() });
      saveBook(current);
      return "added";
    },

    /** The public routes of this flow. True when the request was one of them. */
    async handle(req: IncomingMessage, res: ServerResponse, path: string, method: string, publicUrl: string | null): Promise<boolean> {
      const invitePath = /^\/invite\/([\w-]{20,64})$/.exec(path);
      if (!(invitePath || path === "/auth/colonie/signin" || path === CALLBACK) || method !== "GET") return false;
      const cloud = link();
      if (!cloud) { page(res, 404, "Not available", "This workspace is not connected to Colonie accounts."); return true; }

      if (invitePath) {
        const inviteHash = sha256(invitePath[1]!);
        const invite = book().invites.find((entry) => entry.codeHash === inviteHash);
        if (!invite || invite.usedAt || invite.expiresAt <= now().toISOString()) {
          page(res, 410, "This invite link no longer works", "It was used already or has expired. Ask for a new one.");
          return true;
        }
        startSignIn(req, res, cloud, publicUrl, inviteHash);
        return true;
      }
      if (path === "/auth/colonie/signin") {
        startSignIn(req, res, cloud, publicUrl);
        return true;
      }

      // Back from Colonie Cloud.
      const url = new URL(req.url ?? "/", "http://local");
      const state = url.searchParams.get("state") ?? "";
      const flow = pending.get(state);
      pending.delete(state);
      if (!flow || flow.expires < Date.now() || url.searchParams.get("error") || !url.searchParams.get("code")) {
        page(res, 400, "Sign-in did not finish", "Start again from your invite link or the sign-in page.");
        return true;
      }
      let account: { sub: string; email: string; name: string } | null = null;
      try {
        account = await verifiedAccount(cloud, `${origin(req, publicUrl)}${CALLBACK}`, url.searchParams.get("code")!, flow);
      } catch {
        account = null;
      }
      if (!account) { page(res, 401, "Sign-in did not finish", "Colonie could not confirm who you are. Try again."); return true; }

      const current = book();
      let member = current.members.find((entry) => entry.sub === account!.sub);
      if (!member && flow.inviteHash) {
        const invite = current.invites.find((entry) => entry.codeHash === flow.inviteHash);
        if (!invite || invite.usedAt || invite.expiresAt <= now().toISOString()) {
          page(res, 410, "This invite link no longer works", "It was used already or has expired. Ask for a new one.");
          return true;
        }
        // One account per email in a workspace: two accounts claiming one
        // address would share one person's conversations.
        if (current.members.some((entry) => entry.email === account!.email)) {
          page(res, 409, "This email is already a member", "Another Colonie account with this email already belongs to this workspace.");
          return true;
        }
        invite.usedAt = now().toISOString();
        member = { ...account, role: invite.role, joinedAt: invite.usedAt };
        current.members.push(member);
        saveBook(current);
        deps.allowEmail(member.email, member.role);
      }
      if (!member) { page(res, 403, "You are not a member of this workspace", "Ask an admin for an invite link."); return true; }
      const session = deps.openSession(member, "Colonie account");
      redirectTo(res, "/", { "set-cookie": deps.sessionCookie(req, session.token, session.maxAgeSeconds) });
      return true;
    },
  };
}

export type ColonieSignIn = ReturnType<typeof createColonieSignIn>;
