// Isolated in-memory platform repository. This is a test fixture, not a
// production store: it keeps every record in Maps and returns clones so a
// caller cannot mutate stored state. It implements the same invariants the
// PostgreSQL repository enforces, so service and isolation tests exercise the
// real authorization logic without a database.
//
// ponytail: single-process, non-durable — fine for fixtures. Upgrade to
// pg-repository.ts for anything that must survive a restart.
import { InvitationConflictError, PlatformError } from "./contracts.ts";
import type {
  BotRecord,
  BotAvatarRecord,
  ConnectionRecord,
  ConversationRecord,
  InvitationRecord,
  MembershipRecord,
  MessageRecord,
  ParticipantRecord,
  PlatformAccount,
  PlatformRepository,
  PlatformRole,
  PrincipalRecord,
  ReadCursorRecord,
  RecoveryKeyRecord,
  SecretReferenceRecord,
  StreamEventRecord,
  WorkspaceRecord,
} from "./contracts.ts";
import type { PlatformBotUpdate } from "../../../shared/colonie-bot-profile.ts";

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryPlatformRepository implements PlatformRepository {
  private readonly accounts = new Map<string, PlatformAccount>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly memberships = new Map<string, MembershipRecord>();
  private readonly principals = new Map<string, PrincipalRecord>();
  private readonly bots = new Map<string, BotRecord>();
  private readonly botAvatars = new Map<string, BotAvatarRecord>();
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly participants: ParticipantRecord[] = [];
  private readonly messages: MessageRecord[] = [];
  private readonly cursors = new Map<string, ReadCursorRecord>();
  private readonly invitations = new Map<string, InvitationRecord>();
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly secrets = new Map<string, SecretReferenceRecord>();
  private readonly recoveryKeys = new Map<string, RecoveryKeyRecord>();
  private readonly events: StreamEventRecord[] = [];
  private eventSequence = 0;

  private readonly key = (workspaceId: string, accountId: string) => `${workspaceId}\u0000${accountId}`;
  private readonly cursorKey = (conversationId: string, accountId: string) => `${conversationId}\u0000${accountId}`;

  private require<T>(value: T | undefined, what: string): T {
    if (value === undefined) throw new PlatformError(500, `${what} disappeared from the fixture store.`, "fixture_missing");
    return value;
  }

  async upsertAccount(account: PlatformAccount): Promise<void> {
    this.accounts.set(account.id, clone(account));
  }
  async getAccount(accountId: string): Promise<PlatformAccount | null> {
    return clone(this.accounts.get(accountId) ?? null);
  }

  async createWorkspace(record: WorkspaceRecord): Promise<void> {
    if (this.workspaces.has(record.id)) throw new PlatformError(409, "That workspace already exists.", "duplicate");
    this.workspaces.set(record.id, clone(record));
  }
  async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
    return clone(this.workspaces.get(workspaceId) ?? null);
  }
  async updateWorkspaceName(workspaceId: string, name: string): Promise<void> {
    this.require(this.workspaces.get(workspaceId), "workspace").name = name;
  }
  async listWorkspacesForAccount(accountId: string): Promise<Array<{ workspace: WorkspaceRecord; role: PlatformRole }>> {
    const out: Array<{ workspace: WorkspaceRecord; role: PlatformRole }> = [];
    for (const membership of this.memberships.values()) {
      if (membership.accountId !== accountId) continue;
      const workspace = this.workspaces.get(membership.workspaceId);
      if (workspace) out.push({ workspace: clone(workspace), role: membership.role });
    }
    return out.sort((a, b) => (a.workspace.createdAt < b.workspace.createdAt ? -1 : 1));
  }

  async addMembership(record: MembershipRecord): Promise<void> {
    const key = this.key(record.workspaceId, record.accountId);
    if (this.memberships.has(key)) throw new PlatformError(409, "That person is already a member.", "already_member");
    this.memberships.set(key, clone(record));
  }
  async getMembership(workspaceId: string, accountId: string): Promise<MembershipRecord | null> {
    return clone(this.memberships.get(this.key(workspaceId, accountId)) ?? null);
  }
  async listMemberships(workspaceId: string): Promise<MembershipRecord[]> {
    return [...this.memberships.values()].filter((m) => m.workspaceId === workspaceId).map(clone);
  }
  async updateMembershipRole(workspaceId: string, accountId: string, role: PlatformRole): Promise<void> {
    this.require(this.memberships.get(this.key(workspaceId, accountId)), "membership").role = role;
  }
  async removeMembership(workspaceId: string, accountId: string): Promise<void> {
    this.memberships.delete(this.key(workspaceId, accountId));
    const principal = [...this.principals.values()].find((p) => p.workspaceId === workspaceId && p.accountId === accountId);
    if (!principal) return;
    for (let i = this.participants.length - 1; i >= 0; i -= 1) {
      if (this.participants[i]!.principalId === principal.id) this.participants.splice(i, 1);
    }
  }
  async countOwners(workspaceId: string): Promise<number> {
    return [...this.memberships.values()].filter((m) => m.workspaceId === workspaceId && m.role === "owner").length;
  }

  async createPrincipal(record: PrincipalRecord): Promise<void> {
    this.principals.set(record.id, clone(record));
  }
  async getPrincipal(principalId: string): Promise<PrincipalRecord | null> {
    return clone(this.principals.get(principalId) ?? null);
  }
  async principalForAccount(workspaceId: string, accountId: string): Promise<PrincipalRecord | null> {
    return clone([...this.principals.values()].find((p) => p.workspaceId === workspaceId && p.accountId === accountId) ?? null);
  }
  async principalForBot(workspaceId: string, botId: string): Promise<PrincipalRecord | null> {
    return clone([...this.principals.values()].find((p) => p.workspaceId === workspaceId && p.botId === botId) ?? null);
  }
  async listPrincipals(workspaceId: string): Promise<PrincipalRecord[]> {
    return [...this.principals.values()].filter((p) => p.workspaceId === workspaceId).map(clone);
  }

  async createBot(record: BotRecord): Promise<void> {
    this.bots.set(record.id, clone(record));
  }
  async updateBot(record: BotRecord, principalDisplayName: string, patch: PlatformBotUpdate): Promise<void> {
    const previous = this.require(this.bots.get(record.id), "Bot");
    this.bots.set(record.id, clone({ ...previous, ...patch, ...(patch.purpose !== undefined ? { purpose: record.purpose } : {}) }));
    const principal = this.principals.get(record.principalId);
    if (principal && patch.name !== undefined) this.principals.set(principal.id, clone({ ...principal, displayName: principalDisplayName }));
  }
  async saveBotAvatar(record: BotAvatarRecord): Promise<void> {
    this.botAvatars.set(record.id, clone(record));
  }
  async getBotAvatar(id: string): Promise<BotAvatarRecord | null> {
    return clone(this.botAvatars.get(id) ?? null);
  }
  async getBot(botId: string): Promise<BotRecord | null> {
    return clone(this.bots.get(botId) ?? null);
  }
  async listBots(workspaceId: string): Promise<BotRecord[]> {
    return [...this.bots.values()].filter((b) => b.workspaceId === workspaceId).map(clone);
  }
  async removeBot(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    this.bots.delete(botId);
    for (const [id, image] of this.botAvatars) if (image.botId === botId) this.botAvatars.delete(id);
    if (bot) {
      this.principals.delete(bot.principalId);
      for (let i = this.participants.length - 1; i >= 0; i -= 1) {
        if (this.participants[i]!.principalId === bot.principalId) this.participants.splice(i, 1);
      }
    }
  }

  async createConversation(record: ConversationRecord): Promise<void> {
    if (this.conversations.has(record.id)) throw new PlatformError(409, "That conversation already exists.", "duplicate");
    this.conversations.set(record.id, clone(record));
  }
  async getConversation(conversationId: string): Promise<ConversationRecord | null> {
    return clone(this.conversations.get(conversationId) ?? null);
  }
  async listConversationsForPrincipal(principalId: string): Promise<ConversationRecord[]> {
    const ids = new Set(this.participants.filter((p) => p.principalId === principalId).map((p) => p.conversationId));
    return [...this.conversations.values()].filter((c) => ids.has(c.id)).map(clone);
  }
  async addParticipant(record: ParticipantRecord): Promise<void> {
    const exists = this.participants.some((p) => p.conversationId === record.conversationId && p.principalId === record.principalId);
    if (!exists) this.participants.push(clone(record));
  }
  async removeParticipant(conversationId: string, principalId: string): Promise<void> {
    for (let i = this.participants.length - 1; i >= 0; i -= 1) {
      const p = this.participants[i]!;
      if (p.conversationId === conversationId && p.principalId === principalId) this.participants.splice(i, 1);
    }
  }
  async listParticipants(conversationId: string): Promise<ParticipantRecord[]> {
    return this.participants.filter((p) => p.conversationId === conversationId).map(clone);
  }
  async isParticipant(conversationId: string, principalId: string): Promise<boolean> {
    return this.participants.some((p) => p.conversationId === conversationId && p.principalId === principalId);
  }
  async findDm(workspaceId: string, principalIds: readonly string[]): Promise<ConversationRecord | null> {
    const wanted = [...principalIds].sort();
    for (const conversation of this.conversations.values()) {
      if (conversation.workspaceId !== workspaceId || conversation.kind !== "dm") continue;
      const members = this.participants
        .filter((p) => p.conversationId === conversation.id)
        .map((p) => p.principalId)
        .sort();
      if (members.length === wanted.length && members.every((id, i) => id === wanted[i])) return clone(conversation);
    }
    return null;
  }

  async appendMessage(record: MessageRecord): Promise<void> {
    const last = this.messages.filter((m) => m.conversationId === record.conversationId).reduce((max, m) => Math.max(max, m.sequence), 0);
    this.messages.push(clone({ ...record, sequence: last + 1 }));
  }
  async getMessage(messageId: string): Promise<MessageRecord | null> {
    return clone(this.messages.find((m) => m.id === messageId) ?? null);
  }
  async listMessages(conversationId: string, afterSequence: number, limit: number): Promise<MessageRecord[]> {
    return this.messages
      .filter((m) => m.conversationId === conversationId && m.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit)
      .map(clone);
  }
  async lastSequence(conversationId: string): Promise<number> {
    return this.messages.filter((m) => m.conversationId === conversationId).reduce((max, m) => Math.max(max, m.sequence), 0);
  }
  /** Only messages in conversations the principal participates in; literal,
   * case-insensitive substring match with no wildcard interpretation. */
  async searchMessages(workspaceId: string, principalId: string, query: string, limit: number, conversationId?: string): Promise<MessageRecord[]> {
    const conversationIds = new Set(
      this.participants.filter((p) => p.principalId === principalId).map((p) => p.conversationId),
    );
    const needle = query.toLowerCase();
    return this.messages
      .filter((m) => m.workspaceId === workspaceId && (!conversationId || m.conversationId === conversationId) && conversationIds.has(m.conversationId) && m.body.toLowerCase().includes(needle))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.sequence - a.sequence || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(clone);
  }

  async setReadCursor(record: ReadCursorRecord): Promise<void> {
    this.cursors.set(this.cursorKey(record.conversationId, record.accountId), clone(record));
  }
  async getReadCursor(conversationId: string, accountId: string): Promise<ReadCursorRecord | null> {
    return clone(this.cursors.get(this.cursorKey(conversationId, accountId)) ?? null);
  }
  async listReadCursors(accountId: string): Promise<ReadCursorRecord[]> {
    return [...this.cursors.values()].filter((c) => c.accountId === accountId).map(clone);
  }

  async createInvitation(record: InvitationRecord): Promise<void> {
    this.invitations.set(record.id, clone(record));
  }
  async getInvitation(invitationId: string): Promise<InvitationRecord | null> {
    return clone(this.invitations.get(invitationId) ?? null);
  }
  async getInvitationByHash(tokenHash: string): Promise<InvitationRecord | null> {
    return clone([...this.invitations.values()].find((i) => i.tokenHash === tokenHash) ?? null);
  }
  async listInvitations(workspaceId: string): Promise<InvitationRecord[]> {
    return [...this.invitations.values()].filter((i) => i.workspaceId === workspaceId).map(clone);
  }
  async revokeInvitation(invitationId: string): Promise<void> {
    const invitation = this.invitations.get(invitationId);
    if (invitation && !invitation.revokedAt) invitation.revokedAt = new Date(0).toISOString();
  }
  async acceptInvitation(invitationId: string, accountId: string, acceptedAt: string) {
    const invitation = this.require(this.invitations.get(invitationId), "invitation");
    // Mirror the PostgreSQL lock re-check so fixtures catch the same races.
    if (invitation.revokedAt) throw new InvitationConflictError("revoked");
    if (invitation.acceptedAt && invitation.acceptedByAccountId && invitation.acceptedByAccountId !== accountId) {
      throw new InvitationConflictError("already_used");
    }
    if (!invitation.acceptedAt && Date.parse(invitation.expiresAt) <= Date.parse(acceptedAt)) {
      throw new InvitationConflictError("expired");
    }
    let membership = this.memberships.get(this.key(invitation.workspaceId, accountId));
    let created = false;
    if (!membership) {
      membership = { workspaceId: invitation.workspaceId, accountId, role: invitation.role, createdAt: acceptedAt };
      this.memberships.set(this.key(invitation.workspaceId, accountId), clone(membership));
      created = true;
    }
    if (!invitation.acceptedAt) {
      invitation.acceptedAt = acceptedAt;
      invitation.acceptedByAccountId = accountId;
      created = true;
    }
    return { invitation: clone(invitation), membership: clone(membership), created };
  }

  async createConnection(record: ConnectionRecord): Promise<void> {
    this.connections.set(record.id, clone(record));
  }
  async getConnection(connectionId: string): Promise<ConnectionRecord | null> {
    return clone(this.connections.get(connectionId) ?? null);
  }
  async listConnections(workspaceId: string): Promise<ConnectionRecord[]> {
    return [...this.connections.values()].filter((c) => c.workspaceId === workspaceId).map(clone);
  }
  async updateConnection(record: ConnectionRecord): Promise<void> {
    this.connections.set(record.id, clone(record));
  }
  async rotateConnection(connectionId: string, updatedAt: string): Promise<ConnectionRecord | null> {
    const connection = this.connections.get(connectionId);
    if (!connection) return null;
    connection.version += 1;
    connection.grantRevision += 1;
    connection.updatedAt = updatedAt;
    return clone(connection);
  }
  async deleteConnection(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    this.connections.delete(connectionId);
    if (connection?.secretRefId) this.secrets.delete(connection.secretRefId);
  }

  async createSecretReference(record: SecretReferenceRecord): Promise<void> {
    this.secrets.set(record.id, clone(record));
  }
  async getSecretReference(secretId: string): Promise<SecretReferenceRecord | null> {
    return clone(this.secrets.get(secretId) ?? null);
  }
  async deleteSecretReference(secretId: string): Promise<void> {
    this.secrets.delete(secretId);
  }

  async replaceRecoveryKey(record: RecoveryKeyRecord): Promise<void> {
    for (const [id, key] of this.recoveryKeys) {
      if (key.accountId === record.accountId && !key.consumedAt) this.recoveryKeys.delete(id);
    }
    this.recoveryKeys.set(record.id, clone(record));
  }
  async getRecoveryKeyByHash(tokenHash: string): Promise<RecoveryKeyRecord | null> {
    return clone([...this.recoveryKeys.values()].find((key) => key.tokenHash === tokenHash) ?? null);
  }
  async consumeRecoveryKey(recoveryKeyId: string, consumedAt: string): Promise<RecoveryKeyRecord | null> {
    const key = this.recoveryKeys.get(recoveryKeyId);
    if (!key || key.consumedAt) return null;
    key.consumedAt = consumedAt;
    return clone(key);
  }

  async appendEvent(record: StreamEventRecord): Promise<StreamEventRecord> {
    this.eventSequence += 1;
    const stored = clone({ ...record, sequence: this.eventSequence });
    this.events.push(stored);
    return clone(stored);
  }
  async listEvents(workspaceId: string, conversationId: string | null, afterSequence: number, limit: number): Promise<StreamEventRecord[]> {
    return this.events
      .filter((e) => e.workspaceId === workspaceId && e.sequence > afterSequence)
      .filter((e) => (conversationId === null ? true : e.conversationId === undefined || e.conversationId === conversationId))
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit)
      .map(clone);
  }

  async close(): Promise<void> {}
}
