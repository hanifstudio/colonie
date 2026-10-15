// Internal contracts for the Cloud platform core. Three seams are defined
// here so the core is testable without a database, an auth server, or a model
// runtime:
//
//   * PlatformRepository — persistence. Production is PostgreSQL (`pg`);
//     tests use the isolated in-memory fixture in memory-repository.ts.
//   * PlatformAuth       — sign-in/session. Production is Better Auth;
//     tests use the fixture in auth.ts.
//   * BotRuntime         — bot turns. The lead implements the real ACP
//     runtime in runtime.ts; this file fixes the callback shape.
//
// Authorization is always enforced in the service layer. The repository only
// enforces workspace scoping and uniqueness/ordering invariants.
import type { PlatformBotProfile, PlatformBotUpdate } from "../../../shared/colonie-bot-profile.ts";
import type {
  ConnectionAudience,
  ConversationKind,
  PlatformAccount,
  PlatformMessage,
  PlatformParticipant,
  PlatformRole,
  PrincipalKind,
  TurnState,
  WorkspaceKind,
} from "../../../shared/colonie-platform.ts";

export type { ConnectionAudience, ConversationKind, PlatformAccount, PlatformMessage, PlatformParticipant, PlatformRole, PrincipalKind, TurnState, WorkspaceKind };

/** HTTP status + message for anything the service refuses. */
export class PlatformError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string, code = "platform_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function isPlatformError(error: unknown): error is PlatformError {
  return error instanceof PlatformError;
}

/**
 * Raised by the repository when an invitation became invalid between the
 * service's pre-check and the locked write. The service maps it to a
 * `PlatformError`, so a race cannot hand out a membership the invitation no
 * longer grants.
 */
export class InvitationConflictError extends Error {
  readonly code: "revoked" | "expired" | "already_used";
  constructor(code: "revoked" | "expired" | "already_used") {
    super(`Invitation ${code}`);
    this.name = "InvitationConflictError";
    this.code = code;
  }
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  kind: WorkspaceKind;
  ownerAccountId: string;
  createdAt: string;
  provisioningState: "ready" | "provisioning" | "failed";
}

export interface MembershipRecord {
  workspaceId: string;
  accountId: string;
  role: PlatformRole;
  createdAt: string;
}

export interface PrincipalRecord {
  id: string;
  workspaceId: string;
  kind: PrincipalKind;
  /** Present for human principals. */
  accountId?: string;
  /** Present for bot principals. */
  botId?: string;
  displayName: string;
  createdAt: string;
}

export interface BotRecord extends PlatformBotProfile {
  id: string;
  workspaceId: string;
  principalId: string;
  name: string;
  purpose?: string;
  createdAt: string;
}

export interface BotAvatarRecord {
  id: string;
  workspaceId: string;
  botId: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  kind: ConversationKind;
  title?: string;
  createdByPrincipalId: string;
  createdAt: string;
}

export interface ParticipantRecord {
  conversationId: string;
  principalId: string;
  joinedAt: string;
}

export interface MessageRecord {
  id: string;
  workspaceId: string;
  conversationId: string;
  senderPrincipalId: string;
  sequence: number;
  body: string;
  createdAt: string;
}

export interface ReadCursorRecord {
  conversationId: string;
  accountId: string;
  lastReadSequence: number;
  updatedAt: string;
}

export interface InvitationRecord {
  id: string;
  workspaceId: string;
  role: PlatformRole;
  tokenHash: string;
  createdByAccountId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  acceptedAt?: string;
  acceptedByAccountId?: string;
}

export interface ConnectionRecord {
  id: string;
  workspaceId: string;
  owningPrincipalId: string;
  toolkit: string;
  audience: ConnectionAudience;
  actions: string[];
  status: "active" | "invalid" | "revoked";
  version: number;
  grantRevision: number;
  secretRefId?: string;
  providerAccountId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretReferenceRecord {
  id: string;
  workspaceId: string;
  label: string;
  /** AES-256-GCM ciphertext, base64. Never leaves the secret service. */
  ciphertext: string;
  iv: string;
  authTag: string;
  /** Only the last characters of the secret, safe to display. */
  maskedHint: string;
  keyVersion: number;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
}

/** One-time account recovery key. Only the hash is stored. */
export interface RecoveryKeyRecord {
  id: string;
  accountId: string;
  tokenHash: string;
  createdAt: string;
  consumedAt?: string;
}

export interface StreamEventRecord {
  id: string;
  workspaceId: string;
  conversationId?: string;
  sequence: number;
  /** Serialized PlatformStreamEvent payload. */
  payload: unknown;
  /**
   * When set, only this account may receive the event (a targeted `revoked`).
   * Durable so a reconnect replay cannot hand it to anyone else.
   */
  audienceAccountId?: string;
}

/** One durable, ordered store. Every method is workspace-scoped by argument. */
export interface PlatformRepository {
  // accounts mirror (Better Auth owns credentials; we keep the public profile)
  upsertAccount(account: PlatformAccount): Promise<void>;
  getAccount(accountId: string): Promise<PlatformAccount | null>;

  // workspaces
  createWorkspace(record: WorkspaceRecord): Promise<void>;
  getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null>;
  updateWorkspaceName(workspaceId: string, name: string): Promise<void>;
  listWorkspacesForAccount(accountId: string): Promise<Array<{ workspace: WorkspaceRecord; role: PlatformRole }>>;

  // memberships
  addMembership(record: MembershipRecord): Promise<void>;
  getMembership(workspaceId: string, accountId: string): Promise<MembershipRecord | null>;
  listMemberships(workspaceId: string): Promise<MembershipRecord[]>;
  updateMembershipRole(workspaceId: string, accountId: string, role: PlatformRole): Promise<void>;
  removeMembership(workspaceId: string, accountId: string): Promise<void>;
  countOwners(workspaceId: string): Promise<number>;

  // principals
  createPrincipal(record: PrincipalRecord): Promise<void>;
  getPrincipal(principalId: string): Promise<PrincipalRecord | null>;
  principalForAccount(workspaceId: string, accountId: string): Promise<PrincipalRecord | null>;
  principalForBot(workspaceId: string, botId: string): Promise<PrincipalRecord | null>;
  listPrincipals(workspaceId: string): Promise<PrincipalRecord[]>;

  // bots
  createBot(record: BotRecord): Promise<void>;
  /** Rename a bot and its principal in one step so the two never disagree. */
  updateBot(record: BotRecord, principalDisplayName: string, patch: PlatformBotUpdate): Promise<void>;
  saveBotAvatar(record: BotAvatarRecord): Promise<void>;
  getBotAvatar(id: string): Promise<BotAvatarRecord | null>;
  getBot(botId: string): Promise<BotRecord | null>;
  listBots(workspaceId: string): Promise<BotRecord[]>;
  removeBot(botId: string): Promise<void>;

  // conversations and participants
  createConversation(record: ConversationRecord): Promise<void>;
  getConversation(conversationId: string): Promise<ConversationRecord | null>;
  listConversationsForPrincipal(principalId: string): Promise<ConversationRecord[]>;
  addParticipant(record: ParticipantRecord): Promise<void>;
  removeParticipant(conversationId: string, principalId: string): Promise<void>;
  listParticipants(conversationId: string): Promise<ParticipantRecord[]>;
  isParticipant(conversationId: string, principalId: string): Promise<boolean>;
  /** Exact-participant-set lookup for a DM between the given principals. */
  findDm(workspaceId: string, principalIds: readonly string[]): Promise<ConversationRecord | null>;

  // messages
  appendMessage(record: MessageRecord): Promise<void>;
  getMessage(messageId: string): Promise<MessageRecord | null>;
  listMessages(conversationId: string, afterSequence: number, limit: number): Promise<MessageRecord[]>;
  lastSequence(conversationId: string): Promise<number>;

  // read cursors
  setReadCursor(record: ReadCursorRecord): Promise<void>;
  getReadCursor(conversationId: string, accountId: string): Promise<ReadCursorRecord | null>;
  listReadCursors(accountId: string): Promise<ReadCursorRecord[]>;

  // invitations
  createInvitation(record: InvitationRecord): Promise<void>;
  getInvitation(invitationId: string): Promise<InvitationRecord | null>;
  getInvitationByHash(tokenHash: string): Promise<InvitationRecord | null>;
  listInvitations(workspaceId: string): Promise<InvitationRecord[]>;
  revokeInvitation(invitationId: string): Promise<void>;
  /**
   * Mark accepted and (if absent) insert the membership in one durable step.
   * Retry-safe: a second call for the same invitation is a no-op that still
   * reports the now-accepted record and existing membership.
   */
  acceptInvitation(invitationId: string, accountId: string, acceptedAt: string): Promise<{ invitation: InvitationRecord; membership: MembershipRecord; created: boolean }>;

  // connections and secret references (metadata only; secrets stay encrypted)
  createConnection(record: ConnectionRecord): Promise<void>;
  getConnection(connectionId: string): Promise<ConnectionRecord | null>;
  listConnections(workspaceId: string): Promise<ConnectionRecord[]>;
  updateConnection(record: ConnectionRecord): Promise<void>;
  /** Bump version + grantRevision so stale leases and caches are invalidated. */
  rotateConnection(connectionId: string, updatedAt: string): Promise<ConnectionRecord | null>;
  deleteConnection(connectionId: string): Promise<void>;

  createSecretReference(record: SecretReferenceRecord): Promise<void>;
  getSecretReference(secretId: string): Promise<SecretReferenceRecord | null>;
  deleteSecretReference(secretId: string): Promise<void>;

  /**
   * Production-only atomic recovery: consume the key and write the new
   * password hash (and revoke sessions) in one transaction. Either both
   * happen or neither does, so a failed password write does not burn the key.
   * Absent on the fixture, which has no cross-store transaction to coordinate.
   */
  resetAccountWithKey?(input: { recoveryKeyId: string; consumedAt: string; passwordHash: string }): Promise<{ accountId: string } | null>;

  // account recovery keys (one active per account; only the hash is stored)
  /** Replace any outstanding key for the account with this new one. */
  replaceRecoveryKey(record: RecoveryKeyRecord): Promise<void>;
  getRecoveryKeyByHash(tokenHash: string): Promise<RecoveryKeyRecord | null>;
  /**
   * Consume the key in one durable step. Returns null when it was already
   * consumed, so a replay cannot reset a password twice.
   */
  consumeRecoveryKey(recoveryKeyId: string, consumedAt: string): Promise<RecoveryKeyRecord | null>;

  // durable ordered event log for authorized SSE replay
  /** Appends and returns the stored record (with its assigned sequence). */
  appendEvent(record: StreamEventRecord): Promise<StreamEventRecord>;
  listEvents(workspaceId: string, conversationId: string | null, afterSequence: number, limit: number): Promise<StreamEventRecord[]>;
  /** Postgres needs an explicit close; the memory fixture is a no-op. */
  close(): Promise<void>;
}

export interface AuthenticatedHuman {
  id: string;
  email: string;
  name: string;
}

/** Sign-in/session boundary. `handle` answers anything under the auth base. */
export interface PlatformAuth {
  handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<boolean>;
  session(req: import("node:http").IncomingMessage): Promise<AuthenticatedHuman | null>;
  /**
   * Account recovery without SMTP. Replaces the password through the auth
   * system's own hasher and revokes every session for the account. Optional so
   * a fixture without recovery support still typechecks; the service refuses
   * recovery when it is absent.
   */
  recoverPassword?(accountId: string, newPassword: string): Promise<void>;
  revokeSessions?(accountId: string): Promise<void>;
  /** Hash a new password with the auth system's own hasher (better-auth/crypto). */
  hashPassword?(password: string): Promise<string>;
}

export interface BotTurnRequest {
  workspaceId: string;
  conversationId: string;
  botId: string;
  botPrincipalId: string;
  trigger: "dm" | "mention" | "proactive";
  /** The human whose message opened this turn; access is rechecked against it. */
  initiatorAccountId: string;
  message: PlatformMessage;
  history: PlatformMessage[];
}

/** Everything a bot runtime may do back into the platform. */
export interface PlatformTurnSink {
  /**
   * Re-check access immediately before publishing: the bot must still be a
   * conversation participant AND the triggering human must still be a member
   * and participant. Returns false when either was revoked after the turn began.
   */
  canPublish(input: { botPrincipalId: string; conversationId: string; initiatorAccountId?: string }): Promise<boolean>;
  /** Publish a bot message; refuses if access was revoked after the turn began. */
  postBotMessage(input: { botPrincipalId: string; conversationId: string; body: string; initiatorAccountId?: string }): Promise<PlatformMessage>;
  /** Publish a turn state change (typing/completed/cancelled/error) on the stream. */
  publishTurnState(input: { botPrincipalId: string; conversationId: string; state: TurnState; messageId?: string; error?: string }): Promise<void>;
}

/** The lead's ACP runtime implements this; the core never runs a model. */
export interface BotRuntime {
  onTurn(request: BotTurnRequest): void | Promise<void>;
  /** Best-effort cancellation when a member loses access or the user stops. */
  cancelConversation?(conversationId: string): void | Promise<void>;
}

export interface PlatformConfig {
  repository: PlatformRepository;
  auth: PlatformAuth;
  /** Injected so tests can run without a real runtime. */
  runtime?: BotRuntime;
  /** AES-256-GCM key material for the secret service; 32 bytes when present. */
  secretKey?: Uint8Array;
  now?(): Date;
  id?(): string;
}
