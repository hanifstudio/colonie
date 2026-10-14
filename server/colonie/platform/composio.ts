// Workspace-scoped Composio setup. One Composio project key per workspace,
// stored encrypted through the platform secret service and managed only by an
// owner/admin. Each human in the workspace gets a stable Composio `user_id`
// derived from workspace + principal IDs — never from an email — so personal
// OAuth connections stay isolated per person. The workspace also owns a shared
// service identity whose connections are created only by an explicit
// owner/admin action.
//
// Two rules hold throughout:
//   * The raw project key never leaves the secret service. Views carry a masked
//     hint at most, and never the key, a token, or a session URI.
//   * A connection is reported `active` only after the provider verifies the
//     callback identity. A pending link is never shown as connected.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PlatformRole } from "../../../shared/colonie-platform.ts";
import type { PlatformRepository } from "./contracts.ts";
import { PlatformError, isPlatformError } from "./contracts.ts";
import { maskSecret, type SecretBox } from "./secrets.ts";
import type { PlatformService } from "./service.ts";

// ── stable identities (pure) ─────────────────────────────────────────────

const short = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);

/** Stable Composio user id for one human in one workspace. Never from email. */
export function personalComposioUserId(workspaceId: string, principalId: string): string {
  return `colonie_h_${short(`human:${workspaceId}:${principalId}`)}`;
}

/** Stable Composio user id for the workspace's shared service identity. */
export function serviceComposioUserId(workspaceId: string): string {
  return `colonie_s_${short(`service:${workspaceId}`)}`;
}

// ── store ────────────────────────────────────────────────────────────────

export interface WorkspaceComposioKeyRecord {
  workspaceId: string;
  /** Reference into the platform secret table; the ciphertext lives there. */
  secretRefId: string;
  maskedHint: string;
  keyVersion: number;
  /** Session id returned by the key-validation call, when the provider sends one. */
  sessionId?: string;
  serviceUserId: string;
  status: "active" | "invalid";
  statusDetail?: string;
  updatedAt: string;
}

export type ComposioLinkAudience = "personal" | "shared";
export type ComposioLinkStatus = "pending" | "active" | "failed" | "expired";

export interface ComposioLinkRecord {
  id: string;
  workspaceId: string;
  audience: ComposioLinkAudience;
  /** Human principal that owns a personal link. Absent for a shared link. */
  principalId?: string;
  /** Account that started the link: the human, or the sharing admin. */
  accountId: string;
  toolkit: string;
  /** The Composio user_id the link was created under. */
  userId: string;
  status: ComposioLinkStatus;
  /** SHA-256 of the one-time state; the plaintext is never stored. */
  stateHash: string;
  providerAccountId?: string;
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ComposioStore {
  getKey(workspaceId: string): Promise<WorkspaceComposioKeyRecord | null>;
  putKey(record: WorkspaceComposioKeyRecord): Promise<void>;
  deleteKey(workspaceId: string): Promise<void>;

  createLink(record: ComposioLinkRecord): Promise<void>;
  getLink(linkId: string): Promise<ComposioLinkRecord | null>;
  getLinkByStateHash(stateHash: string): Promise<ComposioLinkRecord | null>;
  listLinks(workspaceId: string): Promise<ComposioLinkRecord[]>;
  updateLink(record: ComposioLinkRecord): Promise<void>;
  close(): Promise<void>;
}

// ── views (what the API returns) ─────────────────────────────────────────

export type ComposioKeyStatus = "active" | "invalid" | "unset";

export interface ComposioStatusView {
  configured: boolean;
  keyStatus: ComposioKeyStatus;
  /** Masked key hint; owner/admin only. Never the key. */
  maskedHint?: string;
  serviceUserId: string;
  canProvision: boolean;
  /** Why setup is unavailable, when it is. */
  setupUnavailableReason?: string;
}

export interface ComposioLinkView {
  id: string;
  workspaceId: string;
  audience: ComposioLinkAudience;
  toolkit: string;
  status: ComposioLinkStatus;
  userId: string;
  providerAccountId?: string;
  statusReason?: string;
  ownedByMe: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── server-only tool access (never serialized to an HTTP response) ────────

/** One active linked connected account, as the broker needs it. */
export interface ComposioToolConnection {
  id: string;
  toolkit: string;
  userId: string;
  providerAccountId: string;
}

/**
 * A resolved tool-access snapshot. It carries the RAW project key, so it is
 * server-only: never put one in a route response, a prompt, or a log.
 */
export interface ComposioToolAccess {
  accountId: string;
  workspaceId: string;
  scope: ComposioLinkAudience;
  /** Raw Composio project key. Server-only. */
  key: string;
  keyRef: string;
  keyVersion: number;
  /** The Composio identity this snapshot is bound to. */
  userId: string;
  /** Present for a personal snapshot only. */
  principalId?: string;
  connections: ComposioToolConnection[];
  resolvedAt: string;
}

// ── provider seam ────────────────────────────────────────────────────────

export interface ComposioKeyValidation {
  ok: boolean;
  code?: "session_write_required" | "invalid_key" | "unavailable";
  message?: string;
  sessionId?: string;
}

export interface ComposioLinkStart {
  linkId?: string;
  redirectUrl: string;
}

export type ComposioCallbackResult =
  | { active: true; connectedAccountId: string; toolkit?: string }
  | { active: false; code: "pending" | "identity_mismatch" | "failed" | "unavailable"; message: string };

/** Injected so tests never touch the network and production uses the real API. */
export interface ComposioProvider {
  /** POST tool_router/session with the project key; classify failure. */
  validateProjectKey(input: { apiKey: string; userId: string }): Promise<ComposioKeyValidation>;
  /** Optional org-key project provisioning. Absent means "not supported here". */
  provisionProject?(input: { orgKey: string; workspaceId: string; name: string }): Promise<{ apiKey: string; projectId?: string }>;
  createLink(input: { apiKey: string; userId: string; toolkit: string; callbackUrl: string }): Promise<ComposioLinkStart>;
  /**
   * Redeem the single-use `session_uri` Composio hands the verifier URL. This
   * is the only accepted proof of identity; a client-supplied account id is
   * never enough. A missing/empty URI must resolve to `pending`.
   */
  verifyCallback(input: { apiKey: string; userId: string; sessionUri: string }): Promise<ComposioCallbackResult>;
}

// ── access seam ──────────────────────────────────────────────────────────

export interface ComposioAccess {
  /** Role + human principal for the account, or null when not a member. */
  describe(accountId: string, workspaceId: string): Promise<{ role: PlatformRole; principalId: string } | null>;
}

/** Derive the access seam from the platform service's own authorization. */
export function platformAccess(service: PlatformService): ComposioAccess {
  return {
    async describe(accountId, workspaceId) {
      try {
        const view = await service.getWorkspace(accountId, workspaceId);
        const self = view.members.find((member) => member.accountId === accountId);
        if (!self) return null;
        return { role: view.workspace.myRole, principalId: self.principalId };
      } catch (error) {
        if (isPlatformError(error) && (error.status === 403 || error.status === 404)) return null;
        throw error;
      }
    },
  };
}

// ── service ──────────────────────────────────────────────────────────────

/** A pending link older than this can no longer be verified. */
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

export interface WorkspaceComposioConfig {
  store: ComposioStore;
  /** Secret references live in the platform repository. */
  repository: PlatformRepository;
  secrets: SecretBox;
  provider: ComposioProvider;
  access: ComposioAccess;
  /** Where Composio returns the browser after authentication. */
  callbackUrl: string;
  /** Org-level key used only server-side to auto-provision a project. */
  orgKey?: string;
  now?(): Date;
  id?(): string;
}

export class WorkspaceComposioService {
  private readonly store: ComposioStore;
  private readonly repository: PlatformRepository;
  private readonly secrets: SecretBox;
  private readonly provider: ComposioProvider;
  private readonly access: ComposioAccess;
  private readonly callbackUrl: string;
  private readonly orgKey: string | undefined;
  private readonly now: (() => Date) | undefined;
  private readonly id: (() => string) | undefined;
  private readonly keyLocks = new Map<string, Promise<void>>();

  constructor(config: WorkspaceComposioConfig) {
    this.store = config.store;
    this.repository = config.repository;
    this.secrets = config.secrets;
    this.provider = config.provider;
    this.access = config.access;
    this.callbackUrl = config.callbackUrl;
    this.orgKey = config.orgKey?.trim() || undefined;
    this.now = config.now;
    this.id = config.id;
  }

  private timestamp(): string {
    return (this.now?.() ?? new Date()).toISOString();
  }

  private currentTime(): number {
    return (this.now?.() ?? new Date()).getTime();
  }

  private makeId(): string {
    return this.id?.() ?? randomUUID();
  }

  /**
   * Serialize key mutations per workspace. Without this, a concurrent set,
   * remove, or provision could delete a reference another call just committed,
   * crossing or leaking a key.
   */
  private withKeyLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.keyLocks.get(workspaceId) ?? Promise.resolve();
    const run = tail.then(fn);
    const settled = run.then(() => undefined, () => undefined);
    this.keyLocks.set(workspaceId, settled);
    void settled.then(() => {
      if (this.keyLocks.get(workspaceId) === settled) this.keyLocks.delete(workspaceId);
    });
    return run;
  }

  private async requireMember(accountId: string, workspaceId: string): Promise<{ role: PlatformRole; principalId: string }> {
    const access = await this.access.describe(accountId, workspaceId);
    if (!access) throw new PlatformError(403, "You are not a member of that workspace.", "not_a_member");
    return access;
  }

  private async requireAdmin(accountId: string, workspaceId: string): Promise<{ role: PlatformRole; principalId: string }> {
    const access = await this.requireMember(accountId, workspaceId);
    if (access.role !== "owner" && access.role !== "admin") {
      throw new PlatformError(403, "Only an owner or admin can manage the Composio setup.", "forbidden");
    }
    return access;
  }

  private isAdmin(role: PlatformRole): boolean {
    return role === "owner" || role === "admin";
  }

  /** Decrypt the workspace project key for a provider call. Never returned. */
  private async readKey(workspaceId: string): Promise<{ apiKey: string; keyRef: string; keyVersion: number }> {
    const record = await this.store.getKey(workspaceId);
    if (!record) throw new PlatformError(409, "This workspace has no Composio project key yet.", "composio_unconfigured");
    const reference = await this.repository.getSecretReference(record.secretRefId);
    if (!reference || reference.status !== "active") {
      throw new PlatformError(409, "The stored Composio key is unavailable. Save it again.", "composio_key_unavailable");
    }
    return { apiKey: this.secrets.open(reference), keyRef: record.secretRefId, keyVersion: record.keyVersion };
  }

  private async openKey(workspaceId: string): Promise<string> {
    return (await this.readKey(workspaceId)).apiKey;
  }

  private async sealKey(workspaceId: string, plaintext: string): Promise<string> {
    const sealed = this.secrets.seal(plaintext);
    const id = this.makeId();
    const at = this.timestamp();
    await this.repository.createSecretReference({
      id,
      workspaceId,
      label: "Composio project key",
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
      maskedHint: sealed.maskedHint,
      keyVersion: sealed.keyVersion,
      status: "active",
      createdAt: at,
      updatedAt: at,
    });
    return id;
  }

  /** Seal + commit a validated key, then drop the superseded reference. */
  private async commitKey(workspaceId: string, apiKey: string, serviceUserId: string, sessionId?: string): Promise<void> {
    const previous = await this.store.getKey(workspaceId);
    const secretRefId = await this.sealKey(workspaceId, apiKey);
    const at = this.timestamp();
    await this.store.putKey({
      workspaceId,
      secretRefId,
      maskedHint: maskSecret(apiKey),
      keyVersion: this.secrets.keyVersion,
      ...(sessionId ? { sessionId } : {}),
      serviceUserId,
      status: "active",
      updatedAt: at,
    });
    if (previous && previous.secretRefId !== secretRefId) {
      await this.repository.deleteSecretReference(previous.secretRefId);
    }
  }

  // ── setup status ───────────────────────────────────────────────────────

  async status(accountId: string, workspaceId: string): Promise<ComposioStatusView> {
    const access = await this.requireMember(accountId, workspaceId);
    const record = await this.store.getKey(workspaceId);
    const base = {
      configured: Boolean(record),
      keyStatus: (record ? record.status : "unset") as ComposioKeyStatus,
      serviceUserId: serviceComposioUserId(workspaceId),
      canProvision: Boolean(this.orgKey),
    };
    if (!record) {
      return {
        ...base,
        ...(this.orgKey ? {} : { setupUnavailableReason: this.isAdmin(access.role)
          ? "Automatic app setup is not available yet. Add this workspace's project key below."
          : "Ask your workspace owner to set up apps." }),
      };
    }
    return {
      ...base,
      ...(this.isAdmin(access.role) ? { maskedHint: record.maskedHint } : {}),
      ...(record.status === "invalid" && record.statusDetail ? { setupUnavailableReason: record.statusDetail } : {}),
    };
  }

  // ── project key management (owner/admin) ───────────────────────────────

  async setProjectKey(accountId: string, workspaceId: string, apiKey: string): Promise<ComposioStatusView> {
    await this.requireAdmin(accountId, workspaceId);
    const trimmed = apiKey.trim();
    if (!trimmed) throw new PlatformError(400, "A Composio project key is required.", "invalid_key");
    if (!/^ak_[A-Za-z0-9_-]+$/.test(trimmed)) {
      throw new PlatformError(422, "That does not look like a Composio project key (expected ak_…).", "composio_key_rejected");
    }
    return this.withKeyLock(workspaceId, async () => {
      const serviceUserId = serviceComposioUserId(workspaceId);
      const validation = await this.provider.validateProjectKey({ apiKey: trimmed, userId: serviceUserId });
      if (!validation.ok) {
        // Nothing is written when validation fails, so the previous key survives.
        throw new PlatformError(422, validation.message ?? "Composio rejected this project key.", rejectionCode(validation.code));
      }
      await this.commitKey(workspaceId, trimmed, serviceUserId, validation.sessionId);
      return this.status(accountId, workspaceId);
    });
  }

  async removeProjectKey(accountId: string, workspaceId: string): Promise<void> {
    await this.requireAdmin(accountId, workspaceId);
    return this.withKeyLock(workspaceId, async () => {
      const record = await this.store.getKey(workspaceId);
      if (!record) return;
      await this.store.deleteKey(workspaceId);
      await this.repository.deleteSecretReference(record.secretRefId);
    });
  }

  async provisionProjectKey(accountId: string, workspaceId: string, name?: string): Promise<ComposioStatusView> {
    await this.requireAdmin(accountId, workspaceId);
    const orgKey = this.orgKey;
    if (!orgKey) {
      throw new PlatformError(501, "Automatic project setup is not configured on this server. Paste a Composio project key instead.", "composio_org_key_unconfigured");
    }
    const provision = this.provider.provisionProject?.bind(this.provider);
    if (!provision) {
      throw new PlatformError(501, "This Composio provider cannot provision projects.", "composio_provision_unsupported");
    }
    return this.withKeyLock(workspaceId, async () => {
      let provisioned: { apiKey: string; projectId?: string };
      try {
        // The name is stable and workspace-unique; Composio may still reject a
        // duplicate with 409, which surfaces as a provisioning failure.
        provisioned = await provision({ orgKey, workspaceId, name: name?.trim() || `colonie-${workspaceId}` });
      } catch {
        throw new PlatformError(502, "Composio could not create a project for this workspace.", "composio_provision_failed");
      }
      const serviceUserId = serviceComposioUserId(workspaceId);
      const validation = await this.provider.validateProjectKey({ apiKey: provisioned.apiKey, userId: serviceUserId });
      if (!validation.ok) {
        throw new PlatformError(422, validation.message ?? "The new project key was rejected.", rejectionCode(validation.code));
      }
      await this.commitKey(workspaceId, provisioned.apiKey, serviceUserId, validation.sessionId);
      return this.status(accountId, workspaceId);
    });
  }

  // ── connection links ───────────────────────────────────────────────────

  private linkView(record: ComposioLinkRecord, accountId: string): ComposioLinkView {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      audience: record.audience,
      toolkit: record.toolkit,
      status: record.status,
      userId: record.userId,
      ...(record.providerAccountId ? { providerAccountId: record.providerAccountId } : {}),
      ...(record.statusReason ? { statusReason: record.statusReason } : {}),
      ownedByMe: record.accountId === accountId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Personal links are visible only to their owner; shared links to every
   * member. An admin does not gain sight of another person's personal links.
   */
  async listLinks(accountId: string, workspaceId: string): Promise<ComposioLinkView[]> {
    const access = await this.requireMember(accountId, workspaceId);
    const records = await this.store.listLinks(workspaceId);
    return records
      .filter((record) => record.audience === "shared" || record.principalId === access.principalId)
      .map((record) => this.linkView(record, accountId));
  }

  async startPersonalLink(accountId: string, workspaceId: string, toolkit: string): Promise<{ link: ComposioLinkView; redirectUrl: string; state: string }> {
    const access = await this.requireMember(accountId, workspaceId);
    const apiKey = await this.openKey(workspaceId);
    const userId = personalComposioUserId(workspaceId, access.principalId);
    return this.beginLink({ workspaceId, accountId, audience: "personal", principalId: access.principalId, toolkit, userId, apiKey });
  }

  /** Admin-only: connect the workspace's shared service identity. */
  async startSharedLink(accountId: string, workspaceId: string, toolkit: string): Promise<{ link: ComposioLinkView; redirectUrl: string; state: string }> {
    await this.requireAdmin(accountId, workspaceId);
    const apiKey = await this.openKey(workspaceId);
    const userId = serviceComposioUserId(workspaceId);
    return this.beginLink({ workspaceId, accountId, audience: "shared", toolkit, userId, apiKey });
  }

  private async beginLink(input: { workspaceId: string; accountId: string; audience: ComposioLinkAudience; principalId?: string; toolkit: string; userId: string; apiKey: string }): Promise<{ link: ComposioLinkView; redirectUrl: string; state: string }> {
    const state = randomBytes(32).toString("base64url");
    const stateHash = createHash("sha256").update(state).digest("hex");
    const separator = this.callbackUrl.includes("?") ? "&" : "?";
    let started: ComposioLinkStart;
    try {
      started = await this.provider.createLink({ apiKey: input.apiKey, userId: input.userId, toolkit: input.toolkit, callbackUrl: `${this.callbackUrl}${separator}colonieState=${encodeURIComponent(state)}` });
    } catch {
      throw new PlatformError(502, "Composio could not start the connection. Try again.", "composio_unavailable");
    }
    const at = this.timestamp();
    const record: ComposioLinkRecord = {
      id: this.makeId(),
      workspaceId: input.workspaceId,
      audience: input.audience,
      ...(input.principalId ? { principalId: input.principalId } : {}),
      accountId: input.accountId,
      toolkit: input.toolkit,
      userId: input.userId,
      status: "pending",
      stateHash,
      createdAt: at,
      updatedAt: at,
    };
    await this.store.createLink(record);
    return { link: this.linkView(record, input.accountId), redirectUrl: started.redirectUrl, state };
  }

  /**
   * Redeem a verifier callback. Activation requires the provider to verify the
   * single-use `session_uri`; a client-supplied account id is never proof.
   * Everything that could have moved during the awaited provider call — the
   * actor's membership, the workspace key, and the link itself — is re-checked
   * before the link is marked active. A disconnected or failed link is never
   * reactivated by replaying the callback.
   */
  async completeLink(accountId: string, workspaceId: string, input: { state: string; sessionUri: string }): Promise<ComposioLinkView> {
    const access = await this.requireMember(accountId, workspaceId);
    if (!input.state) throw new PlatformError(400, "A connection state is required.", "invalid_body");
    if (!input.sessionUri.trim()) throw new PlatformError(400, "A verified Composio session is required.", "missing_session_uri");

    const stateHash = createHash("sha256").update(input.state).digest("hex");
    const record = await this.store.getLinkByStateHash(stateHash);
    if (!record || record.workspaceId !== workspaceId) throw new PlatformError(404, "No such connection attempt.", "not_found");
    if (!this.ownsLink(record, access, accountId)) throw new PlatformError(403, "This connection attempt belongs to someone else.", "forbidden");
    if (record.status === "active") return this.linkView(record, accountId);
    if (record.status === "expired") throw new PlatformError(410, "This connection was disconnected. Start it again.", "link_expired");
    if (record.status === "failed") throw new PlatformError(410, "This connection attempt failed. Start it again.", "link_failed");
    if (this.currentTime() - Date.parse(record.createdAt) >= PENDING_MAX_AGE_MS) {
      const dead: ComposioLinkRecord = { ...record, status: "expired", statusReason: "The connection link expired before it was verified.", updatedAt: this.timestamp() };
      await this.store.updateLink(dead);
      throw new PlatformError(410, "That connection link expired. Start it again.", "link_expired");
    }

    const snapshot = await this.readKey(workspaceId);
    let result: ComposioCallbackResult;
    try {
      result = await this.provider.verifyCallback({ apiKey: snapshot.apiKey, userId: record.userId, sessionUri: input.sessionUri });
    } catch {
      throw new PlatformError(503, "Composio is unreachable right now. The connection is still pending.", "composio_unavailable");
    }

    // Re-check after the awaited call: membership, ownership, key, and link.
    const stillMember = await this.access.describe(accountId, workspaceId);
    if (!stillMember || !this.ownsLink(record, stillMember, accountId)) {
      throw new PlatformError(403, "Your access to this workspace changed while the connection was being verified.", "forbidden");
    }
    const current = await this.store.getKey(workspaceId);
    const reference = current ? await this.repository.getSecretReference(current.secretRefId) : null;
    const keyUnchanged = Boolean(
      current && current.secretRefId === snapshot.keyRef && current.keyVersion === snapshot.keyVersion && reference && reference.status === "active",
    );
    const latest = (await this.store.getLink(record.id)) ?? record;
    const at = this.timestamp();

    if (!keyUnchanged) {
      // The key was swapped or removed mid-flight; never activate against it.
      const invalidated: ComposioLinkRecord = { ...latest, status: "failed", statusReason: "The workspace key changed while this connection was being verified. Start it again.", updatedAt: at };
      await this.store.updateLink(invalidated);
      return this.linkView(invalidated, accountId);
    }
    if (latest.status === "expired" || latest.status === "failed") {
      // Disconnected or failed during the provider call: replay must not revive it.
      throw new PlatformError(410, "This connection was closed while it was being verified.", latest.status === "expired" ? "link_expired" : "link_failed");
    }
    if (result.active) {
      if (result.toolkit && result.toolkit !== record.toolkit) {
        const mismatched: ComposioLinkRecord = { ...latest, status: "failed", statusReason: "Composio verified a different toolkit than this link requested.", updatedAt: at };
        await this.store.updateLink(mismatched);
        return this.linkView(mismatched, accountId);
      }
      const { statusReason: _previousReason, ...rest } = latest;
      const next: ComposioLinkRecord = { ...rest, status: "active", providerAccountId: result.connectedAccountId, updatedAt: at };
      await this.store.updateLink(next);
      return this.linkView(next, accountId);
    }
    const next: ComposioLinkRecord = {
      ...latest,
      status: result.code === "pending" ? "pending" : "failed",
      statusReason: result.message,
      updatedAt: at,
    };
    await this.store.updateLink(next);
    return this.linkView(next, accountId);
  }

  async disconnectLink(accountId: string, workspaceId: string, linkId: string): Promise<ComposioLinkView> {
    const access = await this.requireMember(accountId, workspaceId);
    const record = await this.store.getLink(linkId);
    if (!record || record.workspaceId !== workspaceId) throw new PlatformError(404, "No such connection.", "not_found");
    if (!this.ownsLink(record, access, accountId)) throw new PlatformError(403, "This connection belongs to someone else.", "forbidden");
    const next: ComposioLinkRecord = { ...record, status: "expired", updatedAt: this.timestamp() };
    await this.store.updateLink(next);
    return this.linkView(next, accountId);
  }

  // ── server-only tool access ────────────────────────────────────────────
  //
  // Root wires these into the tool broker. Neither result is ever placed in an
  // HTTP response: the snapshot carries the raw project key.

  /**
   * Resolve the identity and active connections the broker may use. Personal
   * scope resolves only the calling human's own Composio identity and never
   * falls back to a Group or shared identity. Shared scope resolves only the
   * workspace service identity; any member may use a connection an owner/admin
   * deliberately shared, while configuring one stays admin-only.
   */
  async resolveToolAccess(accountId: string, workspaceId: string, scope: ComposioLinkAudience): Promise<ComposioToolAccess> {
    const access = await this.requireMember(accountId, workspaceId);
    const principalId = scope === "personal" ? access.principalId : undefined;
    const userId = principalId ? personalComposioUserId(workspaceId, principalId) : serviceComposioUserId(workspaceId);
    const key = await this.readKey(workspaceId);
    const links = await this.store.listLinks(workspaceId);
    const connections = links
      .filter((link) => link.status === "active" && Boolean(link.providerAccountId) && link.audience === scope && link.userId === userId)
      .filter((link) => scope === "shared" || link.principalId === principalId)
      .map((link) => ({ id: link.id, toolkit: link.toolkit, userId: link.userId, providerAccountId: link.providerAccountId! }));
    return {
      accountId,
      workspaceId,
      scope,
      key: key.apiKey,
      keyRef: key.keyRef,
      keyVersion: key.keyVersion,
      userId,
      ...(principalId ? { principalId } : {}),
      connections,
      resolvedAt: this.timestamp(),
    };
  }

  /**
   * Re-check a snapshot immediately before a brokered call: the key reference
   * and version must be unchanged, the link must still be active, and the
   * resolving account's membership must still hold. No personal fallback.
   */
  async checkToolAccess(snapshot: ComposioToolAccess, connection: ComposioToolConnection): Promise<boolean> {
    const current = await this.store.getKey(snapshot.workspaceId);
    if (!current || current.secretRefId !== snapshot.keyRef || current.keyVersion !== snapshot.keyVersion) return false;
    const reference = await this.repository.getSecretReference(snapshot.keyRef);
    if (!reference || reference.status !== "active") return false;
    const link = await this.store.getLink(connection.id);
    if (!link || link.workspaceId !== snapshot.workspaceId || link.status !== "active") return false;
    if (link.audience !== snapshot.scope || link.userId !== snapshot.userId) return false;
    if (link.toolkit !== connection.toolkit || link.providerAccountId !== connection.providerAccountId) return false;
    if (snapshot.scope === "personal" && link.principalId !== snapshot.principalId) return false;
    const access = await this.access.describe(snapshot.accountId, snapshot.workspaceId);
    if (!access) return false;
    if (snapshot.scope === "personal" && access.principalId !== snapshot.principalId) return false;
    return true;
  }

  private ownsLink(record: ComposioLinkRecord, access: { role: PlatformRole; principalId: string }, accountId: string): boolean {
    if (record.audience === "personal") return record.principalId === access.principalId && record.accountId === accountId;
    return this.isAdmin(access.role);
  }
}

function rejectionCode(code: ComposioKeyValidation["code"]): string {
  if (code === "session_write_required") return "composio_session_write_required";
  if (code === "unavailable") return "composio_unavailable";
  return "composio_key_rejected";
}
