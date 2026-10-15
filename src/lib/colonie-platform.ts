// Browser client and pure helpers for the Colonie Cloud platform
// (`shared/colonie-platform.ts`). One configurable origin, one injected fetch,
// so a renderer test drives the whole flow without a network.
//
// The wire shapes come from the shared contract; nothing here invents data.
// Authorization is the backend's job: this file only hides what the server has
// already refused, and it never treats a role check as a substitute for RLS.

import {
  PLATFORM_API_BASE,
  PLATFORM_AUTH_BASE,
  PLATFORM_ROUTES,
  type ConnectionAudience,
  type PlatformAccount,
  type PlatformBot,
  type PlatformConnection,
  type PlatformConversation,
  type PlatformInvitation,
  type PlatformMember,
  type PlatformMessage,
  type PlatformRole,
  type PlatformRecoverySecret,
  type PlatformSearchHit,
  type PlatformStreamEvent,
  type PlatformWorkspace,
  type WorkspaceKind,
} from "../../shared/colonie-platform";
import { MAUS_COLOR_NAMES, type MausColor } from "@/lib/mascot";
import { PLATFORM_AVATAR_MAX_BYTES, type PlatformBotUpdate } from "../../shared/colonie-bot-profile";
import type { SearchHit } from "@/lib/search-hit";

export {
  PLATFORM_API_BASE,
  PLATFORM_AUTH_BASE,
  PLATFORM_ROUTES,
};
export type {
  ConnectionAudience,
  PlatformAccount,
  PlatformBot,
  PlatformConnection,
  PlatformConversation,
  PlatformInvitation,
  PlatformMember,
  PlatformMessage,
  PlatformParticipant,
  PlatformRole,
  PlatformRecoverySecret,
  PlatformSearchHit,
  PlatformStreamEvent,
  PlatformWorkspace,
  PrincipalKind,
  WorkspaceKind,
  ConversationKind,
} from "../../shared/colonie-platform";

/** An error the platform returned. 401 means re-authenticate; 403 means the
 * signed-in person is not allowed here and must not be signed out. */
export class PlatformApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body: unknown;
  constructor(message: string, status: number, code?: string, body?: unknown) {
    super(message);
    this.name = "PlatformApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
  /** No or expired session: the shell returns to sign-in. */
  get unauthorized(): boolean {
    return this.status === 401;
  }
  /** Signed in, but not a member or not allowed by role. */
  get forbidden(): boolean {
    return this.status === 403;
  }
  get notFound(): boolean {
    return this.status === 404;
  }
}

/** Join an absolute platform origin with a contract path. An empty or
 * same-origin value keeps the path relative so cookies flow normally. */
export function platformUrl(origin: string | undefined, path: string): string {
  if (!origin) return path;
  return `${origin.replace(/\/+$/, "")}${path}`;
}

// ── Composio apps (workspace-scoped) ─────────────────────────────────────────
// The server owns these; the renderer only ever sees masked metadata and the
// link's real status. A link stays "pending" until Composio verifies the
// single-use session URI, so a pending link is never shown as connected.

export type ConnectionLinkAudience = "personal" | "shared";
export type ConnectionLinkStatus = "pending" | "active" | "failed" | "expired";
export type ComposioKeyStatus = "active" | "invalid" | "unset";

export interface PlatformConnectionLink {
  id: string;
  workspaceId: string;
  audience: ConnectionLinkAudience;
  toolkit: string;
  status: ConnectionLinkStatus;
  userId: string;
  providerAccountId?: string;
  statusReason?: string;
  /** True for links this account started. */
  ownedByMe: boolean;
  createdAt: string;
  updatedAt: string;
}

/** This workspace's Composio state. `maskedHint` is only ever sent to owners
 * and admins, and is never the raw key. */
export interface PlatformComposioStatus {
  configured: boolean;
  keyStatus: ComposioKeyStatus;
  maskedHint?: string;
  serviceUserId: string;
  /** The server reports whether it can create projects; never assumed. */
  canProvision: boolean;
  /** Why app setup is unavailable here (for example, no server-side org key). */
  setupUnavailableReason?: string;
}

/** Plain words for a link's real state; "pending" is never "connected". */
export function connectionLinkLabel(link: PlatformConnectionLink): string {
  if (link.status === "active") return "Connected";
  if (link.status === "pending") return "Waiting for confirmation";
  if (link.status === "failed") return link.statusReason ? `Failed: ${link.statusReason}` : "Failed";
  return "Disconnected";
}

export function connectionLinkTone(link: PlatformConnectionLink): "success" | "warning" {
  return link.status === "active" ? "success" : "warning";
}

/** Plain words for a Composio setup failure. The server's codes are the only
 * reliable signal, so they get real, actionable sentences here. */
export function composioErrorMessage(error: unknown): string {
  if (error instanceof PlatformApiError) {
    if (error.code === "composio_session_write_required") {
      return "That key cannot manage sessions. Create a Composio key with session management write access, then try again.";
    }
    if (error.code === "composio_key_rejected") return "Composio rejected that key. Check it and try again.";
    if (error.code === "composio_org_key_unconfigured") return "This server has no Composio organization key, so automatic setup is unavailable. Paste a project key instead.";
    if (error.code === "composio_unconfigured") return "This workspace has no app project yet. An owner or admin sets it up first.";
    if (error.code === "composio_provision_failed") return "Composio could not create a project for this workspace. Try again.";
    if (error.code === "composio_unavailable") return "Composio is unreachable right now. The connection is still pending.";
    if (error.code === "forbidden") return "Only an owner or admin can do that.";
    return error.message;
  }
  return error instanceof Error ? error.message : "App setup failed.";
}

/**
 * The apps Colonie supports today, and how far each goes. Every one is
 * read-only, and the copy says exactly that: nothing here can send, edit or
 * delete. A toolkit outside this list is shown as connection-only, never as
 * something the bots can use.
 */
export const COMPOSIO_TOOLKITS = [
  { id: "gmail", label: "Gmail", summary: "Fetch mail" },
  { id: "googlecalendar", label: "Google Calendar", summary: "List and read events" },
  { id: "googledrive", label: "Google Drive", summary: "Find and read documents" },
] as const;

export type ComposioToolkitId = (typeof COMPOSIO_TOOLKITS)[number]["id"];

export function composioToolkit(id: string): (typeof COMPOSIO_TOOLKITS)[number] | undefined {
  return COMPOSIO_TOOLKITS.find((toolkit) => toolkit.id === id);
}

/** Plain words for a link's audience: personal apps stay with their owner, and
 * a shared app is read by the workspace's bots in Groups and DMs. */
export function connectionAudienceLabel(audience: ConnectionLinkAudience): string {
  return audience === "shared" ? "Shared: workspace bots can read it in Groups and DMs" : "Personal: only you, and only in your own chats with bots";
}

// ── the verifier callback ────────────────────────────────────────────────────
// Composio returns the browser to `/composio/callback?session_uri=…`. The
// redirect carries no state: the opaque state is our own, and it stays in this
// tab's remembered attempt until the signed-in member can confirm. The session
// URI is traded for the link immediately and is never stored or logged.
//
// `clearComposioCallbackUrl` runs as soon as the URI is read, so the URI does
// not survive in the address bar; the value lives in memory only.

export const COMPOSIO_CALLBACK_PATH = "/composio/callback";
const LINK_STATE_KEY = "colonie:composio:pending";

interface LinkAttempt {
  workspaceId: string;
  state: string;
}

function tabStore(): Storage | null {
  try {
    const holder = globalThis as { sessionStorage?: Storage; window?: { sessionStorage?: Storage } };
    return holder.sessionStorage ?? holder.window?.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Remember the opaque link state for this tab so the callback can be matched.
 * Only the state and its workspace are kept — never a key or a session URI. */
export function rememberLinkState(attempt: LinkAttempt): void {
  try {
    tabStore()?.setItem(LINK_STATE_KEY, JSON.stringify(attempt));
  } catch {
    /* Without storage the callback asks the person to start again. */
  }
}

/** Read and clear this tab's attempt. The state is single-use. */
export function takeLinkState(): LinkAttempt | null {
  try {
    const store = tabStore();
    const raw = store?.getItem(LINK_STATE_KEY) ?? null;
    store?.removeItem(LINK_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LinkAttempt>;
    return parsed.workspaceId && parsed.state ? { workspaceId: parsed.workspaceId, state: parsed.state } : null;
  } catch {
    return null;
  }
}

export function forgetLinkState(): void {
  try {
    tabStore()?.removeItem(LINK_STATE_KEY);
  } catch {
    /* nothing to clear */
  }
}

export function isComposioCallback(pathname: string | undefined): boolean {
  return (pathname ?? "").replace(/\/+$/, "") === COMPOSIO_CALLBACK_PATH;
}

/** The single-use session URI Composio sent back, or null when it is missing.
 * The verifier redirect carries no state; the state comes from this tab's
 * remembered attempt. */
export function composioCallbackParams(search: string | undefined): { sessionUri: string } | null {
  const query = new URLSearchParams(search ?? "");
  const sessionUri = query.get("session_uri") ?? query.get("sessionUri") ?? "";
  return sessionUri ? { sessionUri } : null;
}

/** Drop the callback URL (and its state and session URI) from the address bar.
 * ponytail: the app root is "/"; pass a base when the app is served below one. */
export function clearComposioCallbackUrl(): void {
  try {
    globalThis.history?.replaceState?.(null, "", "/");
  } catch {
    /* the address bar keeps the URL; nothing else changes */
  }
}

export interface PlatformClientOptions {
  /** Absolute origin of the platform (for example a Cloud host). Empty means
   * same-origin, which is how the packaged Mac app talks to its own server. */
  platformOrigin?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Defaults to "include" so the Better Auth session cookie is sent. */
  credentials?: RequestCredentials;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  accept?: string;
}

/** Thin, testable wrapper over fetch: JSON in, JSON out, one error type. */
export class PlatformClient {
  readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly credentials: RequestCredentials;

  constructor(options: PlatformClientOptions = {}) {
    this.origin = options.platformOrigin ?? "";
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.credentials = options.credentials ?? "include";
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: options.accept ?? "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(platformUrl(this.origin, path), {
      method: options.method ?? "GET",
      headers,
      credentials: this.credentials,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    const text = await res.text().catch(() => "");
    const body = parseJson(text);
    if (!res.ok) throw errorFrom(res.status, res.statusText, body);
    return body as T;
  }

  // ── account (Better Auth) ──────────────────────────────────────────────
  // The session is an httpOnly cookie only; there is no bearer token.
  async signUp(input: { email: string; password: string; name: string }): Promise<{ user: PlatformAccount }> {
    return this.request(PLATFORM_ROUTES.signup, { method: "POST", body: input });
  }
  async signIn(input: { email: string; password: string }): Promise<{ user: PlatformAccount }> {
    return this.request(PLATFORM_ROUTES.login, { method: "POST", body: input });
  }
  async signOut(): Promise<void> {
    await this.request(PLATFORM_ROUTES.logout, { method: "POST" });
  }
  /** The current session, or null. A 401 is "not signed in", not an error. */
  async session(): Promise<{ session: unknown; user: PlatformAccount } | null> {
    try {
      const body = await this.request<{ session: unknown; user: PlatformAccount } | null>(PLATFORM_ROUTES.session);
      return body && typeof body === "object" && "user" in body ? body : null;
    } catch (error) {
      if (error instanceof PlatformApiError && error.unauthorized) return null;
      throw error;
    }
  }
  /** Create (or rotate) this account's one-time recovery key. Signed in only. */
  async createRecoveryKey(): Promise<PlatformRecoverySecret> {
    return this.request(PLATFORM_ROUTES.accountRecoveryKey, { method: "POST" });
  }
  /** Reset a password with the recovery key. No session required. */
  async recoverAccount(input: { recoveryKey: string; newPassword: string }): Promise<void> {
    await this.request(PLATFORM_ROUTES.accountRecover, { method: "POST", body: input });
  }

  // ── workspaces ─────────────────────────────────────────────────────────
  async listWorkspaces(): Promise<PlatformWorkspace[]> {
    const body = await this.request<{ workspaces: PlatformWorkspace[] }>(PLATFORM_ROUTES.workspaces);
    return body.workspaces ?? [];
  }
  async createWorkspace(input: { name: string; kind: "cloud" }): Promise<PlatformWorkspace> {
    const body = await this.request<{ workspace: PlatformWorkspace }>(PLATFORM_ROUTES.workspaces, { method: "POST", body: input });
    return body.workspace;
  }
  async getWorkspace(id: string, signal?: AbortSignal): Promise<{ workspace: PlatformWorkspace; members: PlatformMember[]; bots: PlatformBot[] }> {
    return this.request(route(PLATFORM_ROUTES.workspace, id), { signal });
  }
  async renameWorkspace(id: string, name: string): Promise<PlatformWorkspace> {
    const body = await this.request<{ workspace: PlatformWorkspace }>(route(PLATFORM_ROUTES.workspace, id), { method: "PATCH", body: { name } });
    return body.workspace;
  }

  // ── members ────────────────────────────────────────────────────────────
  async listMembers(id: string): Promise<PlatformMember[]> {
    const body = await this.request<{ members: PlatformMember[] }>(route(PLATFORM_ROUTES.workspaceMembers, id));
    return body.members ?? [];
  }
  async setMemberRole(id: string, accountId: string, role: PlatformRole): Promise<PlatformMember> {
    const body = await this.request<{ member: PlatformMember }>(route(PLATFORM_ROUTES.workspaceMember, id, accountId), { method: "PATCH", body: { role } });
    return body.member;
  }
  async removeMember(id: string, accountId: string): Promise<void> {
    await this.request(route(PLATFORM_ROUTES.workspaceMember, id, accountId), { method: "DELETE" });
  }

  // ── bots ───────────────────────────────────────────────────────────────
  async listBots(id: string): Promise<PlatformBot[]> {
    const body = await this.request<{ bots: PlatformBot[] }>(route(PLATFORM_ROUTES.workspaceBots, id));
    return body.bots ?? [];
  }
  async createBot(id: string, input: PlatformBotUpdate & { name: string }): Promise<PlatformBot> {
    const body = await this.request<{ bot: PlatformBot }>(route(PLATFORM_ROUTES.workspaceBots, id), { method: "POST", body: input });
    return body.bot;
  }
  async updateBot(id: string, botId: string, input: PlatformBotUpdate): Promise<PlatformBot> {
    const body = await this.request<{ bot: PlatformBot }>(`${route(PLATFORM_ROUTES.workspaceBots, id)}/${encodeURIComponent(botId)}`, { method: "PATCH", body: input });
    return body.bot;
  }
  async uploadBotAvatar(id: string, botId: string, file: File): Promise<string> {
    if (!file.size || file.size > PLATFORM_AVATAR_MAX_BYTES || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) {
      throw new Error("Choose a PNG, JPEG, GIF, or WebP image up to 10 MB.");
    }
    const base64 = await new Promise<string>((done, fail) => {
      const reader = new FileReader();
      reader.onload = () => done(String(reader.result).split(",")[1]!);
      reader.onerror = () => fail(new Error("The image could not be read."));
      reader.readAsDataURL(file);
    });
    const result = await this.request<{ avatarUrl: string }>(`${route(PLATFORM_ROUTES.workspaceBots, id)}/${encodeURIComponent(botId)}/avatars`, { method: "POST", body: { contentType: file.type, base64 } });
    return result.avatarUrl;
  }
  async deleteBot(id: string, botId: string): Promise<void> {
    await this.request(`${route(PLATFORM_ROUTES.workspaceBots, id)}/${encodeURIComponent(botId)}`, { method: "DELETE" });
  }

  // ── conversations ──────────────────────────────────────────────────────
  async listConversations(id: string, signal?: AbortSignal): Promise<PlatformConversation[]> {
    const body = await this.request<{ conversations: PlatformConversation[] }>(route(PLATFORM_ROUTES.workspaceConversations, id), { signal });
    return body.conversations ?? [];
  }
  async listGroups(id: string): Promise<PlatformConversation[]> {
    const body = await this.request<{ conversations: PlatformConversation[] }>(route(PLATFORM_ROUTES.workspaceGroups, id));
    return body.conversations ?? [];
  }
  async createGroup(id: string, input: { title: string; memberPrincipalIds: string[] }): Promise<PlatformConversation> {
    const body = await this.request<{ conversation: PlatformConversation }>(route(PLATFORM_ROUTES.workspaceGroups, id), { method: "POST", body: input });
    return body.conversation;
  }
  async openDm(id: string, input: { withAccountId?: string; withBotId?: string }): Promise<PlatformConversation> {
    const body = await this.request<{ conversation: PlatformConversation }>(route(PLATFORM_ROUTES.opens, id), { method: "POST", body: { kind: "dm", ...input } });
    return body.conversation;
  }
  async getConversation(id: string, opts: { after?: number; limit?: number; signal?: AbortSignal } = {}): Promise<{ conversation: PlatformConversation; messages: PlatformMessage[] }> {
    const query = new URLSearchParams();
    if (opts.after !== undefined) query.set("after", String(opts.after));
    if (opts.limit !== undefined) query.set("limit", String(opts.limit));
    const suffix = query.size ? `?${query}` : "";
    return this.request(`${route(PLATFORM_ROUTES.conversation, id)}${suffix}`, { signal: opts.signal });
  }
  /**
   * Workspace-scoped transcript search. The server returns only conversations
   * this account's workspace principal participates in, so the scope is never
   * decided here.
   */
  async search(id: string, query: string, opts: { limit?: number; signal?: AbortSignal; conversationId?: string } = {}): Promise<PlatformSearchHit[]> {
    const params = new URLSearchParams({ q: query });
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.conversationId) params.set("conversationId", opts.conversationId);
    const body = await this.request<{ hits: PlatformSearchHit[] }>(`${route(PLATFORM_ROUTES.workspaceSearch, id)}?${params}`, { signal: opts.signal });
    return body.hits ?? [];
  }
  async listMessages(id: string, opts: { after?: number; limit?: number; signal?: AbortSignal } = {}): Promise<PlatformMessage[]> {
    const query = new URLSearchParams();
    if (opts.after !== undefined) query.set("after", String(opts.after));
    if (opts.limit !== undefined) query.set("limit", String(opts.limit));
    const suffix = query.size ? `?${query}` : "";
    const body = await this.request<{ messages: PlatformMessage[] }>(`${route(PLATFORM_ROUTES.conversationMessages, id)}${suffix}`, { signal: opts.signal });
    return body.messages ?? [];
  }
  async sendMessage(id: string, body: string): Promise<PlatformMessage> {
    const res = await this.request<{ message: PlatformMessage }>(route(PLATFORM_ROUTES.conversationMessages, id), { method: "POST", body: { body } });
    return res.message;
  }
  async markRead(id: string, sequence: number): Promise<PlatformConversation> {
    const res = await this.request<{ conversation: PlatformConversation }>(route(PLATFORM_ROUTES.conversationRead, id), { method: "POST", body: { sequence } });
    return res.conversation;
  }
  /** Add or remove a participant of a Group (DMs are not editable here). */
  async addConversationMember(id: string, principalId: string): Promise<void> {
    await this.request(`${route(PLATFORM_ROUTES.conversation, id)}/members`, { method: "POST", body: { principalId } });
  }
  async removeConversationMember(id: string, principalId: string): Promise<void> {
    await this.request(`${route(PLATFORM_ROUTES.conversation, id)}/members/${encodeURIComponent(principalId)}`, { method: "DELETE" });
  }
  /** Ask the server to stop the bot turns running in a conversation. */
  async stopTurns(id: string, botPrincipalId?: string): Promise<{ stopped?: number }> {
    return this.request(route(PLATFORM_ROUTES.conversationStopTurns, id), { method: "POST", body: botPrincipalId ? { botPrincipalId } : {} });
  }

  // ── invitations ────────────────────────────────────────────────────────
  async listInvitations(id: string): Promise<PlatformInvitation[]> {
    const body = await this.request<{ invitations: PlatformInvitation[] }>(route(PLATFORM_ROUTES.workspaceInvitations, id));
    return body.invitations ?? [];
  }
  async createInvitation(id: string, input: { role: PlatformRole; expiresInHours?: number }): Promise<{ invitation: PlatformInvitation; token: string; url?: string }> {
    return this.request(route(PLATFORM_ROUTES.workspaceInvitations, id), { method: "POST", body: input });
  }
  async revokeInvitation(id: string, invitationId: string): Promise<void> {
    await this.request(route(PLATFORM_ROUTES.invitation, id, invitationId), { method: "DELETE" });
  }
  /** Accept a pending invitation token into the signed-in account. */
  async acceptInvitation(token: string): Promise<{ workspace: PlatformWorkspace; role: PlatformRole }> {
    return this.request(PLATFORM_ROUTES.acceptInvitation, { method: "POST", body: { token } });
  }

  // ── connections (masked metadata only) ─────────────────────────────────
  async listConnections(id: string): Promise<PlatformConnection[]> {
    const body = await this.request<{ connections: PlatformConnection[] }>(route(PLATFORM_ROUTES.workspaceConnections, id));
    return body.connections ?? [];
  }
  async createConnection(id: string, input: { toolkit: string; audience: ConnectionAudience; actions: string[]; secret?: string; providerAccountId?: string }): Promise<PlatformConnection> {
    const body = await this.request<{ connection: PlatformConnection }>(route(PLATFORM_ROUTES.workspaceConnections, id), { method: "POST", body: input });
    return body.connection;
  }
  async removeConnection(id: string, connectionId: string): Promise<void> {
    await this.request(`${route(PLATFORM_ROUTES.workspaceConnections, id)}/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
  }
  /** Replace a connection's secret; the server bumps its version and revokes
   * leases that used the old one. */
  async rotateConnection(id: string, connectionId: string, secret: string): Promise<PlatformConnection> {
    const body = await this.request<{ connection: PlatformConnection }>(`${route(PLATFORM_ROUTES.workspaceConnections, id)}/${encodeURIComponent(connectionId)}`, { method: "PATCH", body: { secret } });
    return body.connection;
  }

  // ── Composio: this workspace's app connections ────────────────────────
  // The workspace key is set by an owner or admin and stays server-side; the
  // raw key is never read back. A link is only "active" once Composio has
  // verified the connection, so a pending link is never shown as connected.
  private composio(id: string, path = ""): string {
    return `${route(PLATFORM_ROUTES.workspace, id)}/composio${path}`;
  }
  async composioStatus(id: string): Promise<PlatformComposioStatus> {
    return this.request<PlatformComposioStatus>(this.composio(id));
  }
  async setComposioKey(id: string, apiKey: string): Promise<PlatformComposioStatus> {
    return this.request<PlatformComposioStatus>(`${this.composio(id)}/key`, { method: "PUT", body: { apiKey } });
  }
  async removeComposioKey(id: string): Promise<void> {
    await this.request(`${this.composio(id)}/key`, { method: "DELETE" });
  }
  async provisionComposio(id: string, name?: string): Promise<PlatformComposioStatus> {
    return this.request<PlatformComposioStatus>(`${this.composio(id)}/provision`, { method: "POST", body: name ? { name } : {} });
  }
  async listConnectionLinks(id: string): Promise<PlatformConnectionLink[]> {
    const body = await this.request<{ links: PlatformConnectionLink[] }>(`${this.composio(id)}/connections`);
    return body.links ?? [];
  }
  /** Start a hosted OAuth connection. The server returns the provider URL and
   * the opaque state that must come back on the callback. */
  async connectApp(id: string, input: { toolkit: string; audience?: ConnectionLinkAudience }): Promise<{ link: PlatformConnectionLink; redirectUrl: string; state: string }> {
    return this.request(`${this.composio(id)}/connections`, { method: "POST", body: input });
  }
  /** Finish connecting: the session URI is the only accepted proof of identity.
   * Until this succeeds the link stays pending, never connected. */
  async completeAppConnection(id: string, input: { state: string; sessionUri: string }): Promise<PlatformConnectionLink> {
    const body = await this.request<{ link: PlatformConnectionLink }>(`${this.composio(id)}/connections/complete`, { method: "POST", body: input });
    return body.link;
  }
  async removeConnectionLink(id: string, linkId: string): Promise<PlatformConnectionLink> {
    const body = await this.request<{ link: PlatformConnectionLink }>(`${this.composio(id)}/connections/${encodeURIComponent(linkId)}`, { method: "DELETE" });
    return body.link;
  }

  /**
   * Subscribe to the workspace event stream. `after` replays missed frames
   * before going live when the caller has a cursor. Frames arrive wrapped as
   * `{ sequence, event }`; `onEvent` receives the event plus its cursor so the
   * caller can pass `after` on reconnect. A bare (unwrapped) event is accepted
   * too, for compatibility with an older sender.
   */
  async stream(
    id: string,
    opts: { conversationId?: string; after?: number; signal?: AbortSignal; onEvent: (event: PlatformStreamEvent, sequence: number) => void; onError?: (error: unknown) => void },
  ): Promise<void> {
    const query = new URLSearchParams();
    if (opts.conversationId) query.set("conversationId", opts.conversationId);
    if (opts.after !== undefined) query.set("after", String(opts.after));
    const suffix = query.size ? `?${query}` : "";
    try {
      const res = await this.fetchImpl(platformUrl(this.origin, `${route(PLATFORM_ROUTES.workspaceStream, id)}${suffix}`), {
        method: "GET",
        headers: { accept: "text/event-stream" },
        credentials: this.credentials,
        signal: opts.signal,
      });
      if (!res.ok) throw errorFrom(res.status, res.statusText, await res.text().catch(() => ""));
      if (!res.body) throw new PlatformApiError("This browser cannot read the workspace stream", 0);
      for await (const data of sseData(res.body)) {
        const parsed = parseJson(data);
        if (!parsed || typeof parsed !== "object") continue;
        const record = parsed as { sequence?: unknown; event?: unknown; type?: unknown };
        if (record.event && typeof record.event === "object") {
          opts.onEvent(record.event as PlatformStreamEvent, typeof record.sequence === "number" ? record.sequence : 0);
        } else if (typeof record.type === "string") {
          opts.onEvent(parsed as PlatformStreamEvent, 0);
        }
      }
    } catch (error) {
      if (opts.signal?.aborted) return;
      if (opts.onError) opts.onError(error);
      else throw error;
    }
  }
}

/** A ready-made embellishment for callers who only have a plain fetch. */
export function createPlatformClient(options: PlatformClientOptions = {}): PlatformClient {
  return new PlatformClient(options);
}

/** Fill `:id`/`:accountId`/`:invitationId` placeholders in a contract route. */
export function route(template: string, ...values: string[]): string {
  let index = 0;
  return template.replace(/:(id|accountId|invitationId)/g, () => encodeURIComponent(values[index++] ?? ""));
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function errorFrom(status: number, statusText: string, body: unknown): PlatformApiError {
  const record = body && typeof body === "object" ? (body as { error?: unknown; code?: unknown }) : {};
  const message = typeof record.error === "string" && record.error ? record.error : `${status} ${statusText || "Request failed"}`;
  return new PlatformApiError(message, status, typeof record.code === "string" ? record.code : undefined, body);
}

/** Parse a `text/event-stream` body into the `data:` payloads. Pure and
 * testable; the contract puts the event kind inside the JSON, not a field. */
export async function* sseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
        boundary = buffer.indexOf("\n\n");
      }
    }
    const tail = buffer.trim();
    const data = tail
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) yield data;
  } finally {
    reader.releaseLock();
  }
}

// ── invitations in the URL ─────────────────────────────────────────────────

/** A pending invitation token from a normal shareable link. Both the product
 * link (`/invite/:token`) and the query form (`?colonieInvite=`) are read so a
 * link from either side of the app still continues through auth. */
export function invitationTokenFromLocation(location: { pathname?: string; search?: string } | undefined): string | null {
  if (!location) return null;
  const match = /\/invite\/([^/?#]+)/.exec(location.pathname ?? "");
  if (match) return decodeURIComponent(match[1]!);
  const query = new URLSearchParams(location.search ?? "");
  const token = query.get("colonieInvite");
  return token ? token : null;
}

/** The link an admin copies and shares. */
export function invitationLinkFor(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/invite/${encodeURIComponent(token)}`;
}

// ── native Local bridge ────────────────────────────────────────────────────

/** A Local workspace as the desktop bridge reports it (`ColonieWorkspaceSummary`).
 * The renderer never sees a root or a path, only an id and a name. */
export interface LocalWorkspaceSummary {
  id: string;
  name: string;
  mode?: "local";
  /** The account's selected Local workspace. */
  active?: boolean;
}

/** `window.ogb.colonieWorkspaces` — the native Local workspace surface. No
 * method takes an account id; main supplies the verified account. */
export interface LocalWorkspaceBridge {
  list(): Promise<LocalWorkspaceSummary[]>;
  create(input: { name: string }): Promise<LocalWorkspaceSummary>;
  /** Opens the workspace's own native server; resolves with its origin. */
  open(id: string): Promise<unknown>;
  /** Optional: navigate to an app's OAuth page inside the desktop window and
   * resolve once the renderer is back, so this tab's attempt survives. */
  authorizeApp?(redirectUrl: string): Promise<void>;
  /** Optional: clear the desktop's verified account on sign-out. */
  signOut?(): Promise<void>;
}

/** One row in the workspace switcher: a Cloud workspace from the API or a
 * Local workspace from the native bridge, unified for the sidebar. */
export interface WorkspaceView {
  id: string;
  name: string;
  kind: WorkspaceKind;
  myRole: PlatformRole;
  /** Local workspaces come from the desktop bridge. */
  local?: boolean;
}

/** Cloud first (as the server ordered them), then Local workspaces. A Local
 * workspace is owned by this account on this Mac. */
export function mergeWorkspaceViews(cloud: PlatformWorkspace[], local: LocalWorkspaceSummary[]): WorkspaceView[] {
  return [
    ...cloud.map((workspace) => ({ id: workspace.id, name: workspace.name, kind: workspace.kind, myRole: workspace.myRole })),
    ...local.map((workspace) => ({ id: workspace.id, name: workspace.name, kind: "local" as const, myRole: "owner" as const, local: true })),
  ];
}

/** The bridge when the packaged desktop exposes it, else null. Read through a
 * narrow cast so this module never rewrites the shared `ogb` typings. */
export function localWorkspaceBridge(): LocalWorkspaceBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { ogb?: { colonieWorkspaces?: Partial<LocalWorkspaceBridge> } }).ogb?.colonieWorkspaces;
  if (!bridge || typeof bridge.list !== "function" || typeof bridge.create !== "function" || typeof bridge.open !== "function") return null;
  return bridge as LocalWorkspaceBridge;
}

// ── role-scoped controls ───────────────────────────────────────────────────

const ROLE_RANK: Record<PlatformRole, number> = { member: 0, admin: 1, owner: 2 };

export function canManageBots(role: PlatformRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.admin;
}
export function canManageMembers(role: PlatformRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.admin;
}
export function canManageConnections(role: PlatformRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.admin;
}
export function canCreateGroups(): boolean {
  // Every member may create a Group and start a DM (contract §roles).
  return true;
}
export function canDeleteWorkspace(role: PlatformRole): boolean {
  return role === "owner";
}
/** Owner can change roles; admin cannot. Nobody changes the owner's role here. */
export function canChangeRoles(role: PlatformRole): boolean {
  return role === "owner";
}
export function outranks(actor: PlatformRole, target: PlatformRole): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

// ── conversation helpers ───────────────────────────────────────────────────

export type PrincipalKindUnion = "human" | "bot";

/** The person or bot on the other side of a DM; null for a Group. */
export function dmPeer(conversation: PlatformConversation, selfPrincipalId: string) {
  if (conversation.kind !== "dm") return null;
  return conversation.participants.find((p) => p.principalId !== selfPrincipalId) ?? null;
}

/** The human members of a DM, used to tell a human DM from a bot DM. */
export function isBotDm(conversation: PlatformConversation, selfPrincipalId: string): boolean {
  return dmPeer(conversation, selfPrincipalId)?.kind === "bot";
}

/** The row label: a Group title or the other DM participant. */
export function conversationTitle(conversation: PlatformConversation, selfPrincipalId: string): string {
  if (conversation.kind === "group") return conversation.title?.trim() || "Group";
  return dmPeer(conversation, selfPrincipalId)?.displayName ?? "Direct message";
}

export function conversationHasUnread(conversation: PlatformConversation): boolean {
  return conversation.unreadCount > 0;
}

export function totalUnread(conversations: PlatformConversation[]): number {
  return conversations.reduce((sum, c) => sum + Math.max(0, c.unreadCount), 0);
}

/** Groups first, then DMs, each most-recent first. */
export function partitionConversations(conversations: PlatformConversation[], selfPrincipalId: string) {
  const byRecency = (a: PlatformConversation, b: PlatformConversation) => b.lastSequence - a.lastSequence;
  const groups = conversations.filter((c) => c.kind === "group").sort(byRecency);
  const dms = conversations.filter((c) => c.kind === "dm").sort(byRecency);
  return {
    groups,
    dms,
    humanDms: dms.filter((c) => !isBotDm(c, selfPrincipalId)),
    botDms: dms.filter((c) => isBotDm(c, selfPrincipalId)),
  };
}

/** Append messages without duplicating one the stream and the POST both
 * delivered, keeping server order. */
export function mergeMessages(existing: PlatformMessage[], incoming: PlatformMessage[]): PlatformMessage[] {
  if (!incoming.length) return existing;
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

/**
 * Adapt one authorized Cloud search hit to the message-hit shape the original
 * SearchResults and CommandPalette render. `threadId` is the conversation id,
 * so a Cloud navigation port opens it directly; `groupId`/`botId` are set only
 * where a Group or a bot DM really has them, never to fake a human DM as a bot.
 */
export function searchHitFromPlatform(hit: PlatformSearchHit): SearchHit {
  return {
    ...(hit.conversationKind === "group" ? { groupId: hit.conversationId } : {}),
    ...(hit.botId ? { botId: hit.botId } : {}),
    name: hit.title,
    threadId: hit.conversationId,
    messageId: hit.messageId,
    sequence: hit.sequence,
    role: hit.senderKind === "human" ? "user" : "bot",
    kind: "text",
    from: hit.senderName,
    at: Date.parse(hit.createdAt),
    snippet: hit.snippet,
    matchStart: hit.matchStart,
    matchLength: hit.matchLength,
    onActivePath: true,
  };
}

/** A stable bot body colour from its id, so a bot looks the same everywhere. */
export function botColor(id: string): MausColor {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const index = Math.abs(hash) % MAUS_COLOR_NAMES.length;
  return MAUS_COLOR_NAMES[index] as MausColor;
}

/** Initials for a human avatar. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function roleLabel(role: PlatformRole): string {
  return role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member";
}
