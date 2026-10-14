// Colonie Cloud platform contract: the wire shapes and route paths shared by
// the server (`server/colonie/platform/`) and the renderer. This file is the
// coordination point for the UI worker — change it before changing either side.
//
// Product words here (workspace, bot, Group, DM, invitation) are English (US)
// and are shown to the person as-is. Nothing in this file carries a secret:
// connection responses expose masked metadata only.

/** Better Auth owns sign-in; it is mounted here. */
export const PLATFORM_AUTH_BASE = "/api/colonie/auth";

/** Every application endpoint lives under this prefix. */
export const PLATFORM_API_BASE = "/api/colonie/platform";

/**
 * Route contract. `:id` placeholders are opaque UUIDs. All routes require a
 * signed-in session except the auth routes, and all workspace/conversation
 * routes additionally require membership in that exact workspace.
 */
export const PLATFORM_ROUTES = {
  // ── account (Better Auth, standard email/password, no email verification) ──
  signup: `${PLATFORM_AUTH_BASE}/sign-up/email`,
  login: `${PLATFORM_AUTH_BASE}/sign-in/email`,
  logout: `${PLATFORM_AUTH_BASE}/sign-out`,
  session: `${PLATFORM_AUTH_BASE}/get-session`,

  // ── workspaces ──
  workspaces: `${PLATFORM_API_BASE}/workspaces`,
  workspace: `${PLATFORM_API_BASE}/workspaces/:id`,
  workspaceMembers: `${PLATFORM_API_BASE}/workspaces/:id/members`,
  workspaceMember: `${PLATFORM_API_BASE}/workspaces/:id/members/:accountId`,
  workspaceBots: `${PLATFORM_API_BASE}/workspaces/:id/bots`,
  workspaceGroups: `${PLATFORM_API_BASE}/workspaces/:id/groups`,
  workspaceConversations: `${PLATFORM_API_BASE}/workspaces/:id/conversations`,
  workspaceInvitations: `${PLATFORM_API_BASE}/workspaces/:id/invitations`,
  workspaceConnections: `${PLATFORM_API_BASE}/workspaces/:id/connections`,
  workspaceStream: `${PLATFORM_API_BASE}/workspaces/:id/stream`,

  // ── account recovery (no SMTP) ──
  accountRecoveryKey: `${PLATFORM_API_BASE}/account/recovery-key`,
  accountRecover: `${PLATFORM_API_BASE}/account/recover`,

  // ── invitations ──
  acceptInvitation: `${PLATFORM_API_BASE}/invitations/accept`,
  invitation: `${PLATFORM_API_BASE}/workspaces/:id/invitations/:invitationId`,

  // ── conversations ──
  conversation: `${PLATFORM_API_BASE}/conversations/:id`,
  conversationMessages: `${PLATFORM_API_BASE}/conversations/:id/messages`,
  conversationRead: `${PLATFORM_API_BASE}/conversations/:id/read`,
  conversationStopTurns: `${PLATFORM_API_BASE}/conversations/:id/turns/stop`,
  opens: `${PLATFORM_API_BASE}/workspaces/:id/conversations/open`,
} as const;

export type PlatformRole = "owner" | "admin" | "member";
export type WorkspaceKind = "local" | "cloud";
export type ConversationKind = "group" | "dm";
export type PrincipalKind = "human" | "bot";
export type ConnectionAudience = "workspace" | "personal";

/** Stable global human identity. Mirrors the Better Auth user. */
export interface PlatformAccount {
  id: string;
  email: string;
  name: string;
}

export interface PlatformWorkspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  ownerAccountId: string;
  myRole: PlatformRole;
  createdAt: string;
}

/** A workspace human member and their role. */
export interface PlatformMember {
  accountId: string;
  role: PlatformRole;
  displayName: string;
  email?: string;
  principalId: string;
  joinedAt: string;
}

/** A workspace-owned bot identity and its workspace principal. */
export interface PlatformBot {
  id: string;
  workspaceId: string;
  principalId: string;
  name: string;
  purpose?: string;
  createdAt: string;
}

/** A conversation participant: a human or a bot principal. */
export interface PlatformParticipant {
  principalId: string;
  kind: PrincipalKind;
  displayName: string;
  accountId?: string;
  botId?: string;
}

export interface PlatformConversation {
  id: string;
  workspaceId: string;
  kind: ConversationKind;
  title?: string;
  createdByPrincipalId: string;
  createdAt: string;
  participants: PlatformParticipant[];
  lastReadSequence: number;
  lastSequence: number;
  unreadCount: number;
}

/** Message sender attribution is explicit; ordering is the server `sequence`. */
export interface PlatformMessage {
  id: string;
  workspaceId: string;
  conversationId: string;
  senderPrincipalId: string;
  senderKind: PrincipalKind;
  senderName: string;
  sequence: number;
  body: string;
  createdAt: string;
}

/** One-time account recovery secret. The server stores only its hash. */
export interface PlatformRecoverySecret {
  /** Shown once at creation; the server keeps only a hash. */
  recoveryKey: string;
  createdAt: string;
}

/** Revocable, expiring invitation. The raw token is returned once, on creation. */
export interface PlatformInvitation {
  id: string;
  workspaceId: string;
  role: PlatformRole;
  createdByAccountId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  acceptedAt?: string;
  acceptedByAccountId?: string;
}

/** Connection metadata only. The raw provider/secret key never appears here. */
export interface PlatformConnection {
  id: string;
  workspaceId: string;
  owningPrincipalId: string;
  toolkit: string;
  audience: ConnectionAudience;
  actions: string[];
  status: "active" | "invalid" | "revoked";
  version: number;
  grantRevision: number;
  hasSecret: boolean;
  /** Masked hint such as a trailing key fragment; never the full secret. */
  maskedHint?: string;
  providerAccountId?: string;
  createdAt: string;
  updatedAt: string;
}

/** A bot turn's lifecycle as published on the stream. */
export type TurnState = "typing" | "completed" | "cancelled" | "error";

/** Authorized server-sent event. `resync` tells the client to refetch. */
export type PlatformStreamEvent =
  | { type: "ready"; workspaceId: string; subscriberAccountId: string; at: string }
  | { type: "message"; conversationId: string; message: PlatformMessage; at: string }
  | { type: "conversation"; conversationId: string; at: string }
  | { type: "read"; conversationId: string; accountId: string; lastReadSequence: number; at: string }
  | { type: "turn"; conversationId: string; botPrincipalId: string; state: TurnState; messageId?: string; error?: string; at: string }
  | { type: "membership"; workspaceId: string; at: string }
  | { type: "revoked"; workspaceId: string; conversationId?: string; at: string }
  | { type: "resync"; workspaceId: string; at: string };

/**
 * SSE frame. `sequence` is the workspace event cursor: send it back as
 * `?after=` on reconnect to replay missed frames before live delivery.
 */
export interface PlatformStreamFrame {
  sequence: number;
  event: PlatformStreamEvent;
}

export interface PlatformErrorBody {
  error: string;
  code?: string;
}
