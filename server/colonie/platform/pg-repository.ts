// PostgreSQL persistence for the Cloud platform. Production uses this; the
// in-memory fixture in memory-repository.ts mirrors its invariants for tests.
//
// Workspace scoping is enforced by a workspace_id column on every table, by
// foreign keys, and by the `UNIQUE (conversation_id, sequence)` ordering
// constraint. Authorization still happens in the service layer — the database
// prevents cross-workspace dangling references, not unauthorized reads.
import { Pool, type PoolClient } from "pg";
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
import { InvitationConflictError } from "./contracts.ts";
import { platformBotProfileSchema, type PlatformBotUpdate } from "../../../shared/colonie-bot-profile.ts";

export const PLATFORM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS platform_accounts (
  id text PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  created_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_accounts_email ON platform_accounts (lower(email));

CREATE TABLE IF NOT EXISTS platform_workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('local','cloud')),
  owner_account_id text NOT NULL,
  created_at text NOT NULL,
  provisioning_state text NOT NULL DEFAULT 'ready' CHECK (provisioning_state IN ('ready','provisioning','failed'))
);

CREATE TABLE IF NOT EXISTS platform_memberships (
  workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at text NOT NULL,
  PRIMARY KEY (workspace_id, account_id)
);

CREATE TABLE IF NOT EXISTS platform_principals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('human','bot')),
  account_id text,
  bot_id text,
  display_name text NOT NULL,
  created_at text NOT NULL,
  CHECK ((kind = 'human' AND account_id IS NOT NULL AND bot_id IS NULL) OR (kind = 'bot' AND bot_id IS NOT NULL AND account_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_principals_human ON platform_principals (workspace_id, account_id) WHERE kind = 'human';
CREATE UNIQUE INDEX IF NOT EXISTS platform_principals_bot ON platform_principals (workspace_id, bot_id) WHERE kind = 'bot';

CREATE TABLE IF NOT EXISTS platform_bots (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
  principal_id text NOT NULL UNIQUE REFERENCES platform_principals(id) ON DELETE CASCADE,
  name text NOT NULL,
  purpose text,
  created_at text NOT NULL
);

ALTER TABLE platform_bots ADD COLUMN IF NOT EXISTS profile jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS platform_bot_avatars (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
  bot_id text NOT NULL REFERENCES platform_bots(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  bytes bytea NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_conversations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('group','dm')),
  title text,
  created_by_principal_id text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_participants (
  conversation_id text NOT NULL REFERENCES platform_conversations(id) ON DELETE CASCADE,
  principal_id text NOT NULL REFERENCES platform_principals(id) ON DELETE CASCADE,
  joined_at text NOT NULL,
  PRIMARY KEY (conversation_id, principal_id)
);

CREATE TABLE IF NOT EXISTS platform_messages (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES platform_conversations(id) ON DELETE CASCADE,
  sender_principal_id text NOT NULL REFERENCES platform_principals(id),
  sequence integer NOT NULL,
  body text NOT NULL,
  created_at text NOT NULL,
  UNIQUE (conversation_id, sequence)
);

CREATE TABLE IF NOT EXISTS platform_read_cursors (
  conversation_id text NOT NULL REFERENCES platform_conversations(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  last_read_sequence integer NOT NULL DEFAULT 0,
  updated_at text NOT NULL,
  PRIMARY KEY (conversation_id, account_id)
);

CREATE TABLE IF NOT EXISTS platform_invitations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  token_hash text NOT NULL UNIQUE,
  created_by_account_id text NOT NULL,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  revoked_at text,
  accepted_at text,
  accepted_by_account_id text
);

CREATE TABLE IF NOT EXISTS platform_secret_references (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
  label text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  masked_hint text NOT NULL,
  key_version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('active','revoked')),
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_connections (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
  owning_principal_id text NOT NULL REFERENCES platform_principals(id),
  toolkit text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('workspace','personal')),
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('active','invalid','revoked')),
  version integer NOT NULL DEFAULT 1,
  grant_revision integer NOT NULL DEFAULT 1,
  secret_ref_id text REFERENCES platform_secret_references(id) ON DELETE SET NULL,
  provider_account_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
  conversation_id text,
  sequence bigint NOT NULL,
  payload jsonb NOT NULL,
  audience_account_id text
);
CREATE INDEX IF NOT EXISTS platform_events_ws_seq ON platform_events (workspace_id, sequence);

CREATE TABLE IF NOT EXISTS platform_event_counters (
  workspace_id text PRIMARY KEY REFERENCES platform_workspaces(id) ON DELETE CASCADE,
  sequence bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS platform_recovery_keys (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at text NOT NULL,
  consumed_at text
);
CREATE INDEX IF NOT EXISTS platform_recovery_keys_account ON platform_recovery_keys (account_id) WHERE consumed_at IS NULL;
`;

export interface PgPlatformOptions {
  connectionString?: string;
  pool?: Pool;
  /**
   * Better Auth's own credential/session statements, run inside the recovery
   * transaction. Defaults follow Better Auth's generated camelCase schema
   * (`"account"`, `"userId"`, `"providerId"`, `"password"`); override if the
   * host configures different table or column names.
   */
  authTables?: { passwordUpdate?: string; sessionDelete?: string };
}

/** Better Auth default schema, generated by `better-auth`'s own migrations. */
const DEFAULT_PASSWORD_UPDATE = `UPDATE "account" SET "password"=$2 WHERE "userId"=$1 AND "providerId"='credential'`;
const DEFAULT_SESSION_DELETE = `DELETE FROM "session" WHERE "userId"=$1`;

/** Open a pool and ensure the schema exists. */
export async function createPgPlatformRepository(options: PgPlatformOptions): Promise<{ repository: PgPlatformRepository; pool: Pool }> {
  const pool = options.pool ?? new Pool(options.connectionString ? { connectionString: options.connectionString } : {});
  const repository = new PgPlatformRepository(pool, options.authTables);
  await repository.migrate();
  return { repository, pool };
}

type Row = Record<string, unknown>;
const str = (value: unknown): string => String(value);
const num = (value: unknown): number => Number(value);
const optStr = (value: unknown): string | undefined => (value === null || value === undefined ? undefined : String(value));

export class PgPlatformRepository implements PlatformRepository {
  private readonly passwordUpdate: string;
  private readonly sessionDelete: string;

  constructor(private readonly pool: Pool, authTables?: { passwordUpdate?: string; sessionDelete?: string }) {
    this.passwordUpdate = authTables?.passwordUpdate ?? DEFAULT_PASSWORD_UPDATE;
    this.sessionDelete = authTables?.sessionDelete ?? DEFAULT_SESSION_DELETE;
  }

  async migrate(): Promise<void> {
    await this.pool.query(PLATFORM_SCHEMA_SQL);
  }

  private async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertAccount(account: PlatformAccount): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_accounts (id, email, name, created_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name`,
      [account.id, account.email, account.name, new Date().toISOString()],
    );
  }
  async getAccount(accountId: string): Promise<PlatformAccount | null> {
    const { rows } = await this.pool.query<Row>("SELECT id, email, name FROM platform_accounts WHERE id=$1", [accountId]);
    const row = rows[0];
    return row ? { id: str(row.id), email: str(row.email), name: str(row.name) } : null;
  }

  async createWorkspace(record: WorkspaceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_workspaces (id, name, kind, owner_account_id, created_at, provisioning_state)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [record.id, record.name, record.kind, record.ownerAccountId, record.createdAt, record.provisioningState],
    );
  }
  async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_workspaces WHERE id=$1", [workspaceId]);
    return rows[0] ? rowToWorkspace(rows[0]) : null;
  }
  async updateWorkspaceName(workspaceId: string, name: string): Promise<void> {
    await this.pool.query("UPDATE platform_workspaces SET name=$2 WHERE id=$1", [workspaceId, name]);
  }
  async listWorkspacesForAccount(accountId: string): Promise<Array<{ workspace: WorkspaceRecord; role: PlatformRole }>> {
    const { rows } = await this.pool.query<Row>(
      `SELECT w.*, m.role AS my_role FROM platform_memberships m
       JOIN platform_workspaces w ON w.id = m.workspace_id
       WHERE m.account_id=$1 ORDER BY w.created_at ASC`,
      [accountId],
    );
    return rows.map((row) => ({ workspace: rowToWorkspace(row), role: str(row.my_role) as PlatformRole }));
  }

  async addMembership(record: MembershipRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_memberships (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (workspace_id, account_id) DO NOTHING`,
      [record.workspaceId, record.accountId, record.role, record.createdAt],
    );
  }
  async getMembership(workspaceId: string, accountId: string): Promise<MembershipRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_memberships WHERE workspace_id=$1 AND account_id=$2", [workspaceId, accountId]);
    return rows[0] ? rowToMembership(rows[0]) : null;
  }
  async listMemberships(workspaceId: string): Promise<MembershipRecord[]> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_memberships WHERE workspace_id=$1 ORDER BY created_at ASC", [workspaceId]);
    return rows.map(rowToMembership);
  }
  async updateMembershipRole(workspaceId: string, accountId: string, role: PlatformRole): Promise<void> {
    await this.pool.query("UPDATE platform_memberships SET role=$3 WHERE workspace_id=$1 AND account_id=$2", [workspaceId, accountId, role]);
  }
  async removeMembership(workspaceId: string, accountId: string): Promise<void> {
    await this.tx(async (client) => {
      await client.query("DELETE FROM platform_memberships WHERE workspace_id=$1 AND account_id=$2", [workspaceId, accountId]);
      await client.query(
        `DELETE FROM platform_participants p USING platform_principals pr
         WHERE p.principal_id = pr.id AND pr.workspace_id=$1 AND pr.account_id=$2`,
        [workspaceId, accountId],
      );
    });
  }
  async countOwners(workspaceId: string): Promise<number> {
    const { rows } = await this.pool.query<Row>("SELECT count(*)::int AS n FROM platform_memberships WHERE workspace_id=$1 AND role='owner'", [workspaceId]);
    return num(rows[0]?.n ?? 0);
  }

  async createPrincipal(record: PrincipalRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_principals (id, workspace_id, kind, account_id, bot_id, display_name, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [record.id, record.workspaceId, record.kind, record.accountId ?? null, record.botId ?? null, record.displayName, record.createdAt],
    );
  }
  async getPrincipal(principalId: string): Promise<PrincipalRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_principals WHERE id=$1", [principalId]);
    return rows[0] ? rowToPrincipal(rows[0]) : null;
  }
  async principalForAccount(workspaceId: string, accountId: string): Promise<PrincipalRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_principals WHERE workspace_id=$1 AND account_id=$2 AND kind='human'", [workspaceId, accountId]);
    return rows[0] ? rowToPrincipal(rows[0]) : null;
  }
  async principalForBot(workspaceId: string, botId: string): Promise<PrincipalRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_principals WHERE workspace_id=$1 AND bot_id=$2 AND kind='bot'", [workspaceId, botId]);
    return rows[0] ? rowToPrincipal(rows[0]) : null;
  }
  async listPrincipals(workspaceId: string): Promise<PrincipalRecord[]> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_principals WHERE workspace_id=$1", [workspaceId]);
    return rows.map(rowToPrincipal);
  }

  async createBot(record: BotRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_bots (id, workspace_id, principal_id, name, purpose, created_at, profile) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [record.id, record.workspaceId, record.principalId, record.name, record.purpose ?? null, record.createdAt, JSON.stringify(platformBotProfileSchema.strip().parse(record))],
    );
  }
  async updateBot(record: BotRecord, principalDisplayName: string, patch: PlatformBotUpdate): Promise<void> {
    // One transaction so the bot row and its principal never disagree.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE platform_bots SET name=CASE WHEN $5 THEN $2 ELSE name END,
        purpose=CASE WHEN $6 THEN $3 ELSE purpose END, profile=profile || $4::jsonb WHERE id=$1 AND workspace_id=$7`,
      [record.id, record.name, record.purpose ?? null, JSON.stringify(platformBotProfileSchema.strip().parse(patch)), patch.name !== undefined, patch.purpose !== undefined, record.workspaceId]);
      if (patch.name !== undefined) await client.query("UPDATE platform_principals SET display_name=$2 WHERE id=$1", [record.principalId, principalDisplayName]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async saveBotAvatar(record: BotAvatarRecord): Promise<void> {
    await this.pool.query("INSERT INTO platform_bot_avatars (id,workspace_id,bot_id,content_type,bytes) VALUES ($1,$2,$3,$4,$5)",
      [record.id, record.workspaceId, record.botId, record.contentType, Buffer.from(record.bytes)]);
  }
  async getBotAvatar(id: string): Promise<BotAvatarRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_bot_avatars WHERE id=$1", [id]);
    const row = rows[0];
    return row ? { id: str(row.id), workspaceId: str(row.workspace_id), botId: str(row.bot_id), contentType: str(row.content_type), bytes: row.bytes as Uint8Array } : null;
  }
  async getBot(botId: string): Promise<BotRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_bots WHERE id=$1", [botId]);
    return rows[0] ? rowToBot(rows[0]) : null;
  }
  async listBots(workspaceId: string): Promise<BotRecord[]> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_bots WHERE workspace_id=$1 ORDER BY created_at ASC", [workspaceId]);
    return rows.map(rowToBot);
  }
  async removeBot(botId: string): Promise<void> {
    await this.pool.query("DELETE FROM platform_bots WHERE id=$1", [botId]);
  }

  async createConversation(record: ConversationRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_conversations (id, workspace_id, kind, title, created_by_principal_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [record.id, record.workspaceId, record.kind, record.title ?? null, record.createdByPrincipalId, record.createdAt],
    );
  }
  async getConversation(conversationId: string): Promise<ConversationRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_conversations WHERE id=$1", [conversationId]);
    return rows[0] ? rowToConversation(rows[0]) : null;
  }
  async listConversationsForPrincipal(principalId: string): Promise<ConversationRecord[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT c.* FROM platform_conversations c
       JOIN platform_participants p ON p.conversation_id = c.id
       WHERE p.principal_id=$1 ORDER BY c.created_at ASC`,
      [principalId],
    );
    return rows.map(rowToConversation);
  }
  async addParticipant(record: ParticipantRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_participants (conversation_id, principal_id, joined_at) VALUES ($1,$2,$3)
       ON CONFLICT (conversation_id, principal_id) DO NOTHING`,
      [record.conversationId, record.principalId, record.joinedAt],
    );
  }
  async removeParticipant(conversationId: string, principalId: string): Promise<void> {
    await this.pool.query("DELETE FROM platform_participants WHERE conversation_id=$1 AND principal_id=$2", [conversationId, principalId]);
  }
  async listParticipants(conversationId: string): Promise<ParticipantRecord[]> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_participants WHERE conversation_id=$1 ORDER BY joined_at ASC", [conversationId]);
    return rows.map((row) => ({ conversationId: str(row.conversation_id), principalId: str(row.principal_id), joinedAt: str(row.joined_at) }));
  }
  async isParticipant(conversationId: string, principalId: string): Promise<boolean> {
    const { rows } = await this.pool.query<Row>("SELECT 1 FROM platform_participants WHERE conversation_id=$1 AND principal_id=$2", [conversationId, principalId]);
    return rows.length > 0;
  }
  async findDm(workspaceId: string, principalIds: readonly string[]): Promise<ConversationRecord | null> {
    const wanted = [...principalIds].sort();
    const { rows } = await this.pool.query<Row>(
      `SELECT c.* FROM platform_conversations c
       JOIN platform_participants p ON p.conversation_id = c.id
       WHERE c.workspace_id=$1 AND c.kind='dm'
       GROUP BY c.id
       HAVING array_agg(p.principal_id ORDER BY p.principal_id) = $2::text[]
       LIMIT 1`,
      [workspaceId, wanted],
    );
    return rows[0] ? rowToConversation(rows[0]) : null;
  }

  async appendMessage(record: MessageRecord): Promise<void> {
    await this.tx(async (client) => {
      await client.query("SELECT id FROM platform_conversations WHERE id=$1 FOR UPDATE", [record.conversationId]);
      const { rows } = await client.query<Row>("SELECT COALESCE(MAX(sequence),0) AS max FROM platform_messages WHERE conversation_id=$1", [record.conversationId]);
      const sequence = num(rows[0]?.max ?? 0) + 1;
      await client.query(
        `INSERT INTO platform_messages (id, workspace_id, conversation_id, sender_principal_id, sequence, body, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [record.id, record.workspaceId, record.conversationId, record.senderPrincipalId, sequence, record.body, record.createdAt],
      );
    });
  }
  async getMessage(messageId: string): Promise<MessageRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_messages WHERE id=$1", [messageId]);
    return rows[0] ? rowToMessage(rows[0]) : null;
  }
  async listMessages(conversationId: string, afterSequence: number, limit: number): Promise<MessageRecord[]> {
    const { rows } = await this.pool.query<Row>(
      "SELECT * FROM platform_messages WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence ASC LIMIT $3",
      [conversationId, afterSequence, limit],
    );
    return rows.map(rowToMessage);
  }
  async lastSequence(conversationId: string): Promise<number> {
    const { rows } = await this.pool.query<Row>("SELECT COALESCE(MAX(sequence),0) AS max FROM platform_messages WHERE conversation_id=$1", [conversationId]);
    return num(rows[0]?.max ?? 0);
  }
  /**
   * Literal, case-insensitive substring search. `strpos` treats the query as
   * text, so `%`, `_` and every other character is matched literally — no LIKE
   * wildcard can widen the result. The participant join is the authorization:
   * only conversations this principal belongs to are scanned.
   * ponytail: a lower() scan cannot use a btree index; add a pg_trgm GIN index
   * when a workspace's message volume outgrows it.
   */
  async searchMessages(workspaceId: string, principalId: string, query: string, limit: number, conversationId?: string): Promise<MessageRecord[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT m.* FROM platform_messages m
       JOIN platform_participants p ON p.conversation_id = m.conversation_id AND p.principal_id = $2
       WHERE m.workspace_id = $1 AND strpos(lower(m.body), lower($3)) > 0
       AND ($5::text IS NULL OR m.conversation_id = $5)
       ORDER BY m.created_at DESC, m.sequence DESC, m.id ASC
       LIMIT $4`,
      [workspaceId, principalId, query, limit, conversationId ?? null],
    );
    return rows.map(rowToMessage);
  }

  async setReadCursor(record: ReadCursorRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_read_cursors (conversation_id, account_id, last_read_sequence, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (conversation_id, account_id) DO UPDATE SET last_read_sequence=EXCLUDED.last_read_sequence, updated_at=EXCLUDED.updated_at`,
      [record.conversationId, record.accountId, record.lastReadSequence, record.updatedAt],
    );
  }
  async getReadCursor(conversationId: string, accountId: string): Promise<ReadCursorRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_read_cursors WHERE conversation_id=$1 AND account_id=$2", [conversationId, accountId]);
    return rows[0] ? { conversationId: str(rows[0].conversation_id), accountId: str(rows[0].account_id), lastReadSequence: num(rows[0].last_read_sequence), updatedAt: str(rows[0].updated_at) } : null;
  }
  async listReadCursors(accountId: string): Promise<ReadCursorRecord[]> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_read_cursors WHERE account_id=$1", [accountId]);
    return rows.map((row) => ({ conversationId: str(row.conversation_id), accountId: str(row.account_id), lastReadSequence: num(row.last_read_sequence), updatedAt: str(row.updated_at) }));
  }

  async createInvitation(record: InvitationRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_invitations (id, workspace_id, role, token_hash, created_by_account_id, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [record.id, record.workspaceId, record.role, record.tokenHash, record.createdByAccountId, record.createdAt, record.expiresAt],
    );
  }
  async getInvitation(invitationId: string): Promise<InvitationRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_invitations WHERE id=$1", [invitationId]);
    return rows[0] ? rowToInvitation(rows[0]) : null;
  }
  async getInvitationByHash(tokenHash: string): Promise<InvitationRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_invitations WHERE token_hash=$1", [tokenHash]);
    return rows[0] ? rowToInvitation(rows[0]) : null;
  }
  async listInvitations(workspaceId: string): Promise<InvitationRecord[]> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_invitations WHERE workspace_id=$1 ORDER BY created_at DESC", [workspaceId]);
    return rows.map(rowToInvitation);
  }
  async revokeInvitation(invitationId: string): Promise<void> {
    await this.pool.query("UPDATE platform_invitations SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL", [invitationId, new Date().toISOString()]);
  }
  async acceptInvitation(invitationId: string, accountId: string, acceptedAt: string) {
    return this.tx(async (client) => {
      const { rows } = await client.query<Row>("SELECT * FROM platform_invitations WHERE id=$1 FOR UPDATE", [invitationId]);
      const row = rows[0];
      if (!row) throw new Error("invitation disappeared during acceptance");
      const invitation = rowToInvitation(row);
      // Re-check under the lock: the service's pre-check ran outside the
      // transaction, so revocation, expiry, or a competing acceptance may have
      // landed in between.
      if (invitation.revokedAt) throw new InvitationConflictError("revoked");
      if (invitation.acceptedAt && invitation.acceptedByAccountId && invitation.acceptedByAccountId !== accountId) {
        throw new InvitationConflictError("already_used");
      }
      if (!invitation.acceptedAt && Date.parse(invitation.expiresAt) <= Date.parse(acceptedAt)) {
        throw new InvitationConflictError("expired");
      }
      let created = false;
      const existing = await client.query<Row>("SELECT * FROM platform_memberships WHERE workspace_id=$1 AND account_id=$2", [invitation.workspaceId, accountId]);
      if (existing.rows.length === 0) {
        await client.query("INSERT INTO platform_memberships (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)", [invitation.workspaceId, accountId, invitation.role, acceptedAt]);
        created = true;
      }
      if (!invitation.acceptedAt) {
        await client.query("UPDATE platform_invitations SET accepted_at=$2, accepted_by_account_id=$3 WHERE id=$1", [invitationId, acceptedAt, accountId]);
        invitation.acceptedAt = acceptedAt;
        invitation.acceptedByAccountId = accountId;
        created = true;
      }
      const membershipRow = await client.query<Row>("SELECT * FROM platform_memberships WHERE workspace_id=$1 AND account_id=$2", [invitation.workspaceId, accountId]);
      return { invitation, membership: rowToMembership(membershipRow.rows[0]!), created };
    });
  }

  async createConnection(record: ConnectionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_connections (id, workspace_id, owning_principal_id, toolkit, audience, actions, status, version, grant_revision, secret_ref_id, provider_account_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)`,
      [record.id, record.workspaceId, record.owningPrincipalId, record.toolkit, record.audience, JSON.stringify(record.actions), record.status, record.version, record.grantRevision, record.secretRefId ?? null, record.providerAccountId ?? null, record.createdAt, record.updatedAt],
    );
  }
  async getConnection(connectionId: string): Promise<ConnectionRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_connections WHERE id=$1", [connectionId]);
    return rows[0] ? rowToConnection(rows[0]) : null;
  }
  async listConnections(workspaceId: string): Promise<ConnectionRecord[]> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_connections WHERE workspace_id=$1 ORDER BY created_at ASC", [workspaceId]);
    return rows.map(rowToConnection);
  }
  async updateConnection(record: ConnectionRecord): Promise<void> {
    await this.pool.query(
      `UPDATE platform_connections SET toolkit=$2, audience=$3, actions=$4::jsonb, status=$5, secret_ref_id=$6, provider_account_id=$7, updated_at=$8 WHERE id=$1`,
      [record.id, record.toolkit, record.audience, JSON.stringify(record.actions), record.status, record.secretRefId ?? null, record.providerAccountId ?? null, record.updatedAt],
    );
  }
  async rotateConnection(connectionId: string, updatedAt: string): Promise<ConnectionRecord | null> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE platform_connections SET version = version + 1, grant_revision = grant_revision + 1, updated_at=$2 WHERE id=$1 RETURNING *`,
      [connectionId, updatedAt],
    );
    return rows[0] ? rowToConnection(rows[0]) : null;
  }
  async deleteConnection(connectionId: string): Promise<void> {
    await this.tx(async (client) => {
      const { rows } = await client.query<Row>("DELETE FROM platform_connections WHERE id=$1 RETURNING secret_ref_id", [connectionId]);
      const secretRefId = rows[0]?.secret_ref_id;
      if (typeof secretRefId === "string") await client.query("DELETE FROM platform_secret_references WHERE id=$1", [secretRefId]);
    });
  }

  async createSecretReference(record: SecretReferenceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_secret_references (id, workspace_id, label, ciphertext, iv, auth_tag, masked_hint, key_version, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [record.id, record.workspaceId, record.label, record.ciphertext, record.iv, record.authTag, record.maskedHint, record.keyVersion, record.status, record.createdAt, record.updatedAt],
    );
  }
  async getSecretReference(secretId: string): Promise<SecretReferenceRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_secret_references WHERE id=$1", [secretId]);
    return rows[0] ? rowToSecret(rows[0]) : null;
  }
  async deleteSecretReference(secretId: string): Promise<void> {
    await this.pool.query("DELETE FROM platform_secret_references WHERE id=$1", [secretId]);
  }

  async replaceRecoveryKey(record: RecoveryKeyRecord): Promise<void> {
    await this.tx(async (client) => {
      await client.query("DELETE FROM platform_recovery_keys WHERE account_id=$1 AND consumed_at IS NULL", [record.accountId]);
      await client.query("INSERT INTO platform_recovery_keys (id, account_id, token_hash, created_at) VALUES ($1,$2,$3,$4)", [record.id, record.accountId, record.tokenHash, record.createdAt]);
    });
  }
  async getRecoveryKeyByHash(tokenHash: string): Promise<RecoveryKeyRecord | null> {
    const { rows } = await this.pool.query<Row>("SELECT * FROM platform_recovery_keys WHERE token_hash=$1", [tokenHash]);
    return rows[0] ? rowToRecoveryKey(rows[0]) : null;
  }
  async consumeRecoveryKey(recoveryKeyId: string, consumedAt: string): Promise<RecoveryKeyRecord | null> {
    const { rows } = await this.pool.query<Row>(
      "UPDATE platform_recovery_keys SET consumed_at=$2 WHERE id=$1 AND consumed_at IS NULL RETURNING *",
      [recoveryKeyId, consumedAt],
    );
    return rows[0] ? rowToRecoveryKey(rows[0]) : null;
  }

  /**
   * Atomic recovery: consume the key, write the password hash, and delete the
   * account's sessions in one transaction. A failure anywhere rolls back, so
   * the key is not burned by a failed password write.
   */
  async resetAccountWithKey(input: { recoveryKeyId: string; consumedAt: string; passwordHash: string }): Promise<{ accountId: string } | null> {
    return this.tx(async (client) => {
      const { rows } = await client.query<Row>(
        "UPDATE platform_recovery_keys SET consumed_at=$2 WHERE id=$1 AND consumed_at IS NULL RETURNING account_id",
        [input.recoveryKeyId, input.consumedAt],
      );
      const row = rows[0];
      if (!row) return null;
      const accountId = str(row.account_id);
      await client.query(this.passwordUpdate, [accountId, input.passwordHash]);
      await client.query(this.sessionDelete, [accountId]);
      return { accountId };
    });
  }

  async appendEvent(record: StreamEventRecord): Promise<StreamEventRecord> {
    return this.tx(async (client) => {
      const { rows } = await client.query<Row>(
        `INSERT INTO platform_event_counters (workspace_id, sequence) VALUES ($1, 1)
         ON CONFLICT (workspace_id) DO UPDATE SET sequence = platform_event_counters.sequence + 1
         RETURNING sequence`,
        [record.workspaceId],
      );
      const sequence = num(rows[0]!.sequence);
      await client.query("INSERT INTO platform_events (id, workspace_id, conversation_id, sequence, payload, audience_account_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6)", [
        record.id,
        record.workspaceId,
        record.conversationId ?? null,
        sequence,
        JSON.stringify(record.payload),
        record.audienceAccountId ?? null,
      ]);
      return { ...record, sequence };
    });
  }
  async listEvents(workspaceId: string, conversationId: string | null, afterSequence: number, limit: number): Promise<StreamEventRecord[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM platform_events
       WHERE workspace_id=$1 AND sequence>$2 AND ($3::text IS NULL OR conversation_id IS NULL OR conversation_id=$3)
       ORDER BY sequence ASC LIMIT $4`,
      [workspaceId, afterSequence, conversationId, limit],
    );
    return rows.map((row) => ({ id: str(row.id), workspaceId: str(row.workspace_id), conversationId: optStr(row.conversation_id), sequence: num(row.sequence), payload: row.payload, audienceAccountId: optStr(row.audience_account_id) }));
  }
}

function rowToWorkspace(row: Row): WorkspaceRecord {
  return { id: str(row.id), name: str(row.name), kind: str(row.kind) as WorkspaceRecord["kind"], ownerAccountId: str(row.owner_account_id), createdAt: str(row.created_at), provisioningState: str(row.provisioning_state) as WorkspaceRecord["provisioningState"] };
}
function rowToMembership(row: Row): MembershipRecord {
  return { workspaceId: str(row.workspace_id), accountId: str(row.account_id), role: str(row.role) as PlatformRole, createdAt: str(row.created_at) };
}
function rowToPrincipal(row: Row): PrincipalRecord {
  return { id: str(row.id), workspaceId: str(row.workspace_id), kind: str(row.kind) as PrincipalRecord["kind"], accountId: optStr(row.account_id), botId: optStr(row.bot_id), displayName: str(row.display_name), createdAt: str(row.created_at) };
}
function rowToBot(row: Row): BotRecord {
  return { ...platformBotProfileSchema.parse(row.profile ?? {}), id: str(row.id), workspaceId: str(row.workspace_id), principalId: str(row.principal_id), name: str(row.name), purpose: optStr(row.purpose), createdAt: str(row.created_at) };
}
function rowToConversation(row: Row): ConversationRecord {
  return { id: str(row.id), workspaceId: str(row.workspace_id), kind: str(row.kind) as ConversationRecord["kind"], title: optStr(row.title), createdByPrincipalId: str(row.created_by_principal_id), createdAt: str(row.created_at) };
}
function rowToMessage(row: Row): MessageRecord {
  return { id: str(row.id), workspaceId: str(row.workspace_id), conversationId: str(row.conversation_id), senderPrincipalId: str(row.sender_principal_id), sequence: num(row.sequence), body: str(row.body), createdAt: str(row.created_at) };
}
function rowToInvitation(row: Row): InvitationRecord {
  return { id: str(row.id), workspaceId: str(row.workspace_id), role: str(row.role) as PlatformRole, tokenHash: str(row.token_hash), createdByAccountId: str(row.created_by_account_id), createdAt: str(row.created_at), expiresAt: str(row.expires_at), revokedAt: optStr(row.revoked_at), acceptedAt: optStr(row.accepted_at), acceptedByAccountId: optStr(row.accepted_by_account_id) };
}
function rowToConnection(row: Row): ConnectionRecord {
  const actions = Array.isArray(row.actions) ? (row.actions as string[]) : [];
  return { id: str(row.id), workspaceId: str(row.workspace_id), owningPrincipalId: str(row.owning_principal_id), toolkit: str(row.toolkit), audience: str(row.audience) as ConnectionRecord["audience"], actions, status: str(row.status) as ConnectionRecord["status"], version: num(row.version), grantRevision: num(row.grant_revision), secretRefId: optStr(row.secret_ref_id), providerAccountId: optStr(row.provider_account_id), createdAt: str(row.created_at), updatedAt: str(row.updated_at) };
}
function rowToSecret(row: Row): SecretReferenceRecord {
  return { id: str(row.id), workspaceId: str(row.workspace_id), label: str(row.label), ciphertext: str(row.ciphertext), iv: str(row.iv), authTag: str(row.auth_tag), maskedHint: str(row.masked_hint), keyVersion: num(row.key_version), status: str(row.status) as SecretReferenceRecord["status"], createdAt: str(row.created_at), updatedAt: str(row.updated_at) };
}
function rowToRecoveryKey(row: Row): RecoveryKeyRecord {
  return { id: str(row.id), accountId: str(row.account_id), tokenHash: str(row.token_hash), createdAt: str(row.created_at), consumedAt: optStr(row.consumed_at) };
}
