// Composio persistence: a self-contained store so the Composio module never
// edits the frozen platform repository. Production uses `pg` on the same pool
// as the platform repository; tests use the in-memory fixture.
import { Pool } from "pg";
import { PLATFORM_SCHEMA_SQL } from "./pg-repository.ts";
import type { ComposioLinkRecord, ComposioStore, WorkspaceComposioKeyRecord } from "./composio.ts";

/** Runs after the platform schema so the workspace foreign keys resolve. */
export const COMPOSIO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS platform_composio_keys (
  workspace_id text PRIMARY KEY REFERENCES platform_workspaces(id) ON DELETE CASCADE,
  secret_ref_id text NOT NULL,
  masked_hint text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  session_id text,
  service_user_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','invalid')),
  status_detail text,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_composio_links (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES platform_workspaces(id) ON DELETE CASCADE,
  audience text NOT NULL CHECK (audience IN ('personal','shared')),
  principal_id text,
  account_id text NOT NULL,
  toolkit text NOT NULL,
  user_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','active','failed','expired')),
  state_hash text NOT NULL UNIQUE,
  provider_account_id text,
  status_reason text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_composio_links_ws ON platform_composio_links (workspace_id);
`;

/** Isolated in-memory fixture. Deep-copies on the way in and out. */
export class MemoryComposioStore implements ComposioStore {
  private readonly keys = new Map<string, WorkspaceComposioKeyRecord>();
  private readonly links = new Map<string, ComposioLinkRecord>();

  async getKey(workspaceId: string): Promise<WorkspaceComposioKeyRecord | null> {
    const record = this.keys.get(workspaceId);
    return record ? { ...record } : null;
  }
  async putKey(record: WorkspaceComposioKeyRecord): Promise<void> {
    this.keys.set(record.workspaceId, { ...record });
  }
  async deleteKey(workspaceId: string): Promise<void> {
    this.keys.delete(workspaceId);
  }

  async createLink(record: ComposioLinkRecord): Promise<void> {
    this.links.set(record.id, { ...record });
  }
  async getLink(linkId: string): Promise<ComposioLinkRecord | null> {
    const record = this.links.get(linkId);
    return record ? { ...record } : null;
  }
  async getLinkByStateHash(stateHash: string): Promise<ComposioLinkRecord | null> {
    for (const record of this.links.values()) {
      if (record.stateHash === stateHash) return { ...record };
    }
    return null;
  }
  async listLinks(workspaceId: string): Promise<ComposioLinkRecord[]> {
    return [...this.links.values()].filter((record) => record.workspaceId === workspaceId).map((record) => ({ ...record }));
  }
  async updateLink(record: ComposioLinkRecord): Promise<void> {
    this.links.set(record.id, { ...record });
  }
  async close(): Promise<void> {}
}

export interface PgComposioOptions {
  connectionString?: string;
  pool?: Pool;
}

/** Open a pool and ensure both the platform and Composio schemas exist. */
export async function createPgComposioStore(options: PgComposioOptions): Promise<{ store: PgComposioStore; pool: Pool }> {
  const pool = options.pool ?? new Pool(options.connectionString ? { connectionString: options.connectionString } : {});
  const store = new PgComposioStore(pool);
  await store.migrate();
  return { store, pool };
}

type Row = Record<string, unknown>;
const str = (value: unknown): string => String(value);
const num = (value: unknown): number => Number(value);
const optStr = (value: unknown): string | undefined => (value === null || value === undefined ? undefined : String(value));

export class PgComposioStore implements ComposioStore {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(PLATFORM_SCHEMA_SQL);
    await this.pool.query(COMPOSIO_SCHEMA_SQL);
  }

  async getKey(workspaceId: string): Promise<WorkspaceComposioKeyRecord | null> {
    const { rows } = await this.pool.query("SELECT * FROM platform_composio_keys WHERE workspace_id=$1", [workspaceId]);
    return rows[0] ? rowToKey(rows[0]) : null;
  }
  async putKey(record: WorkspaceComposioKeyRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_composio_keys (workspace_id, secret_ref_id, masked_hint, key_version, session_id, service_user_id, status, status_detail, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (workspace_id) DO UPDATE SET secret_ref_id=EXCLUDED.secret_ref_id, masked_hint=EXCLUDED.masked_hint,
         key_version=EXCLUDED.key_version, session_id=EXCLUDED.session_id, service_user_id=EXCLUDED.service_user_id,
         status=EXCLUDED.status, status_detail=EXCLUDED.status_detail, updated_at=EXCLUDED.updated_at`,
      [record.workspaceId, record.secretRefId, record.maskedHint, record.keyVersion, record.sessionId ?? null, record.serviceUserId, record.status, record.statusDetail ?? null, record.updatedAt],
    );
  }
  async deleteKey(workspaceId: string): Promise<void> {
    await this.pool.query("DELETE FROM platform_composio_keys WHERE workspace_id=$1", [workspaceId]);
  }

  async createLink(record: ComposioLinkRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_composio_links (id, workspace_id, audience, principal_id, account_id, toolkit, user_id, status, state_hash, provider_account_id, status_reason, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [record.id, record.workspaceId, record.audience, record.principalId ?? null, record.accountId, record.toolkit, record.userId, record.status, record.stateHash, record.providerAccountId ?? null, record.statusReason ?? null, record.createdAt, record.updatedAt],
    );
  }
  async getLink(linkId: string): Promise<ComposioLinkRecord | null> {
    const { rows } = await this.pool.query("SELECT * FROM platform_composio_links WHERE id=$1", [linkId]);
    return rows[0] ? rowToLink(rows[0]) : null;
  }
  async getLinkByStateHash(stateHash: string): Promise<ComposioLinkRecord | null> {
    const { rows } = await this.pool.query("SELECT * FROM platform_composio_links WHERE state_hash=$1", [stateHash]);
    return rows[0] ? rowToLink(rows[0]) : null;
  }
  async listLinks(workspaceId: string): Promise<ComposioLinkRecord[]> {
    const { rows } = await this.pool.query("SELECT * FROM platform_composio_links WHERE workspace_id=$1 ORDER BY created_at ASC", [workspaceId]);
    return rows.map(rowToLink);
  }
  async updateLink(record: ComposioLinkRecord): Promise<void> {
    await this.pool.query(
      `UPDATE platform_composio_links SET status=$2, provider_account_id=$3, status_reason=$4, updated_at=$5 WHERE id=$1`,
      [record.id, record.status, record.providerAccountId ?? null, record.statusReason ?? null, record.updatedAt],
    );
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

function rowToKey(row: Row): WorkspaceComposioKeyRecord {
  return {
    workspaceId: str(row.workspace_id),
    secretRefId: str(row.secret_ref_id),
    maskedHint: str(row.masked_hint),
    keyVersion: num(row.key_version),
    sessionId: optStr(row.session_id),
    serviceUserId: str(row.service_user_id),
    status: str(row.status) as WorkspaceComposioKeyRecord["status"],
    statusDetail: optStr(row.status_detail),
    updatedAt: str(row.updated_at),
  };
}

function rowToLink(row: Row): ComposioLinkRecord {
  return {
    id: str(row.id),
    workspaceId: str(row.workspace_id),
    audience: str(row.audience) as ComposioLinkRecord["audience"],
    principalId: optStr(row.principal_id),
    accountId: str(row.account_id),
    toolkit: str(row.toolkit),
    userId: str(row.user_id),
    status: str(row.status) as ComposioLinkRecord["status"],
    stateHash: str(row.state_hash),
    providerAccountId: optStr(row.provider_account_id),
    statusReason: optStr(row.status_reason),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}
