// The Cloud platform core: workspace, membership, principal, bot, Group, DM,
// message, invitation, read-cursor, connection and turn authorization. Every
// rule the product promises about privacy is enforced here, not in the UI and
// not only in the database:
//
//   * a workspace ID is not access — membership is required for every call;
//   * a Group is visible only to its participants; a human-human DM only to
//     its two humans; a bot DM only to one human and that bot;
//   * owner/admin powers over workspace settings never expose other people's
//     DMs, because reads, streams, and bot turns all run the same participant
//     check;
//   * bot output must re-pass canPublish immediately before it is written, so
//     a revoked member cannot publish a result from a turn that started earlier;
//   * secrets are sealed and only masked metadata is ever returned.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  PlatformBot,
  PlatformConnection,
  PlatformConversation,
  PlatformInvitation,
  PlatformMember,
  PlatformMessage,
  PlatformParticipant,
  PlatformRecoverySecret,
  PlatformRole,
  PlatformSearchHit,
  PlatformStreamEvent,
  PlatformStreamFrame,
  PlatformWorkspace,
  TurnState,
} from "../../../shared/colonie-platform.ts";
import type {
  AuthenticatedHuman,
  BotRecord,
  BotTurnRequest,
  ConversationRecord,
  MembershipRecord,
  PlatformConfig,
  PlatformRepository,
  PlatformTurnSink,
  PrincipalRecord,
} from "./contracts.ts";
import { InvitationConflictError, PlatformError } from "./contracts.ts";
import { StreamHub } from "./events.ts";
import { SecretBox } from "./secrets.ts";
import { chooseGroupBot } from "./participation.ts";
import { PLATFORM_AVATAR_MAX_BYTES, platformBotCreateSchema, platformBotProfileSchema, platformBotUpdateSchema, type PlatformBotUpdate } from "../../../shared/colonie-bot-profile.ts";

const ROLE_RANK: Record<PlatformRole, number> = { owner: 3, admin: 2, member: 1 };
const MAX_BODY = 16_384;
const MAX_REPLAY = 500;
const DEFAULT_HISTORY = 20;
const DEFAULT_INVITE_HOURS = 72;
const MAX_INVITE_HOURS = 24 * 30;
const MAX_SEARCH_QUERY = 200;
const MAX_SEARCH_LIMIT = 50;
/** Characters of message text kept on each side of a search match. */
const SNIPPET_RADIUS = 80;

export interface PlatformServiceConfig extends PlatformConfig {
  /** Used to build invitation links. Defaults to a relative link. */
  publicOrigin?: string;
  /**
   * Best-effort background hook for a Cloud workspace, e.g. automatic Composio
   * project provisioning. It runs after the membership and principal records
   * exist, fire-and-catch: the hook may make slow vendor calls, so workspace
   * creation never waits on it. A rejection is swallowed and no status is set,
   * so the host's Apps status stays unset until a real validation commits.
   * Never called for a Local workspace.
   */
  workspaceCreated?(workspace: PlatformWorkspace, actorId: string): Promise<void>;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Map a repository invitation race to the same errors the pre-check raises. */
function invitationConflict(code: InvitationConflictError["code"]): PlatformError {
  if (code === "revoked") return new PlatformError(410, "That invitation was revoked.", "revoked");
  if (code === "expired") return new PlatformError(410, "That invitation has expired.", "expired");
  return new PlatformError(409, "That invitation was already used.", "already_used");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the text names the bot, as in "@Scout" or "@Scout, please". */
export function mentionsBot(body: string, botName: string): boolean {
  if (!botName.trim()) return false;
  return new RegExp(`@${escapeRegex(botName.trim())}(?![\\p{L}\\p{N}_])`, "iu").test(body);
}

/**
 * A bounded excerpt around the first literal (case-insensitive) match, plus the
 * match offsets relative to the excerpt. Pure and deterministic: the same body
 * and query always give the same triple.
 */
export function snippetAround(body: string, query: string): { snippet: string; matchStart: number; matchLength: number } {
  const index = body.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return { snippet: body.slice(0, SNIPPET_RADIUS * 2), matchStart: 0, matchLength: 0 };
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(body.length, index + query.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  return { snippet: `${prefix}${body.slice(start, end)}${end < body.length ? "…" : ""}`, matchStart: prefix.length + (index - start), matchLength: query.length };
}

export class PlatformService implements PlatformTurnSink {
  readonly repository: PlatformRepository;
  readonly hub: StreamHub;
  private readonly authRuntime: PlatformServiceConfig["runtime"];
  private readonly auth: PlatformServiceConfig["auth"];
  private readonly box: SecretBox | null;
  private readonly now: () => Date;
  private readonly makeId: () => string;
  private readonly publicOrigin: string;
  private readonly workspaceCreated: ((workspace: PlatformWorkspace, actorId: string) => Promise<void>) | undefined;

  constructor(config: PlatformServiceConfig) {
    this.repository = config.repository;
    this.authRuntime = config.runtime;
    this.auth = config.auth;
    this.box = config.secretKey ? new SecretBox(config.secretKey) : null;
    this.now = config.now ?? (() => new Date());
    this.makeId = config.id ?? (() => randomUUID());
    this.publicOrigin = config.publicOrigin?.replace(/\/$/, "") ?? "";
    this.workspaceCreated = config.workspaceCreated;
    this.hub = new StreamHub((input) => this.authorizeFrame(input));
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private timestamp(): string {
    return this.now().toISOString();
  }

  /** Mirror the public profile so memberships can show a name without auth. */
  async ensureAccount(human: AuthenticatedHuman): Promise<void> {
    await this.repository.upsertAccount({ id: human.id, email: human.email, name: human.name });
  }

  private async membershipOrThrow(accountId: string, workspaceId: string): Promise<MembershipRecord> {
    const membership = await this.repository.getMembership(workspaceId, accountId);
    if (!membership) throw new PlatformError(403, "You are not a member of this workspace.", "not_a_member");
    return membership;
  }

  private async requireRole(accountId: string, workspaceId: string, minimum: PlatformRole): Promise<MembershipRecord> {
    const membership = await this.membershipOrThrow(accountId, workspaceId);
    if (ROLE_RANK[membership.role] < ROLE_RANK[minimum]) {
      throw new PlatformError(403, `This action needs the ${minimum} role.`, "needs_role");
    }
    return membership;
  }

  private async humanPrincipalOrThrow(accountId: string, workspaceId: string): Promise<PrincipalRecord> {
    const principal = await this.repository.principalForAccount(workspaceId, accountId);
    if (!principal) throw new PlatformError(403, "Your workspace identity is missing.", "no_principal");
    return principal;
  }

  /** The one access check shared by reads, writes, streams, and bot output. */
  private async authorizeFrame(input: { workspaceId: string; conversationId?: string; accountId: string }): Promise<boolean> {
    const membership = await this.repository.getMembership(input.workspaceId, input.accountId);
    if (!membership) return false;
    if (!input.conversationId) return true;
    const conversation = await this.repository.getConversation(input.conversationId);
    if (!conversation || conversation.workspaceId !== input.workspaceId) return false;
    const principal = await this.repository.principalForAccount(input.workspaceId, input.accountId);
    if (!principal) return false;
    return this.repository.isParticipant(input.conversationId, principal.id);
  }

  private async principalView(principal: PrincipalRecord): Promise<PlatformParticipant> {
    return {
      principalId: principal.id,
      kind: principal.kind,
      displayName: principal.displayName,
      ...(principal.accountId ? { accountId: principal.accountId } : {}),
      ...(principal.botId ? { botId: principal.botId } : {}),
    };
  }

  private async messageView(message: { id: string; workspaceId: string; conversationId: string; senderPrincipalId: string; sequence: number; body: string; createdAt: string }): Promise<PlatformMessage> {
    const sender = await this.repository.getPrincipal(message.senderPrincipalId);
    return {
      id: message.id,
      workspaceId: message.workspaceId,
      conversationId: message.conversationId,
      senderPrincipalId: message.senderPrincipalId,
      senderKind: sender?.kind ?? "bot",
      senderName: sender?.displayName ?? "Unknown",
      sequence: message.sequence,
      body: message.body,
      createdAt: message.createdAt,
    };
  }

  private async conversationView(conversation: ConversationRecord, accountId: string): Promise<PlatformConversation> {
    const participantRecords = await this.repository.listParticipants(conversation.id);
    const participants = await Promise.all(
      participantRecords.map(async (p) => {
        const principal = await this.repository.getPrincipal(p.principalId);
        return principal ? this.principalView(principal) : null;
      }),
    );
    const lastSequence = await this.repository.lastSequence(conversation.id);
    const cursor = await this.repository.getReadCursor(conversation.id, accountId);
    const lastReadSequence = cursor?.lastReadSequence ?? 0;
    return {
      id: conversation.id,
      workspaceId: conversation.workspaceId,
      kind: conversation.kind,
      ...(conversation.title ? { title: conversation.title } : {}),
      createdByPrincipalId: conversation.createdByPrincipalId,
      createdAt: conversation.createdAt,
      participants: participants.filter((p): p is PlatformParticipant => p !== null),
      lastReadSequence,
      lastSequence,
      unreadCount: Math.max(0, lastSequence - lastReadSequence),
    };
  }

  private invitationView(record: { id: string; workspaceId: string; role: PlatformRole; createdByAccountId: string; createdAt: string; expiresAt: string; revokedAt?: string; acceptedAt?: string; acceptedByAccountId?: string }): PlatformInvitation {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      role: record.role,
      createdByAccountId: record.createdByAccountId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
      ...(record.acceptedAt ? { acceptedAt: record.acceptedAt } : {}),
      ...(record.acceptedByAccountId ? { acceptedByAccountId: record.acceptedByAccountId } : {}),
    };
  }

  private connectionView(record: { id: string; workspaceId: string; owningPrincipalId: string; toolkit: string; audience: "workspace" | "personal"; actions: string[]; status: "active" | "invalid" | "revoked"; version: number; grantRevision: number; secretRefId?: string; providerAccountId?: string; createdAt: string; updatedAt: string }, maskedHint?: string): PlatformConnection {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      owningPrincipalId: record.owningPrincipalId,
      toolkit: record.toolkit,
      audience: record.audience,
      actions: [...record.actions],
      status: record.status,
      version: record.version,
      grantRevision: record.grantRevision,
      hasSecret: Boolean(record.secretRefId),
      ...(maskedHint ? { maskedHint } : {}),
      ...(record.providerAccountId ? { providerAccountId: record.providerAccountId } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  // ── durable + live events ────────────────────────────────────────────

  private async publish(workspaceId: string, conversationId: string | undefined, event: PlatformStreamEvent, options: { audienceAccountId?: string } = {}): Promise<PlatformStreamFrame> {
    const record = await this.repository.appendEvent({ id: this.makeId(), workspaceId, conversationId: conversationId ?? undefined, sequence: 0, payload: event, audienceAccountId: options.audienceAccountId });
    const frame: PlatformStreamFrame = { sequence: record.sequence, event };
    await this.hub.emit(frame, { workspaceId, ...(conversationId ? { conversationId } : {}), ...(options.audienceAccountId ? { audienceAccountId: options.audienceAccountId } : {}) });
    return frame;
  }

  /**
   * Replay helper for a reconnect. Every record is re-authorized individually
   * against the requesting account, and a targeted event is returned only to
   * its audience, so a workspace stream can never surface another person's DM.
   */
  async replay(accountId: string, workspaceId: string, conversationId: string | null, after: number, limit = 200): Promise<PlatformStreamFrame[]> {
    await this.membershipOrThrow(accountId, workspaceId);
    if (conversationId) {
      const allowed = await this.authorizeFrame({ workspaceId, conversationId, accountId });
      if (!allowed) throw new PlatformError(403, "You are not a participant in that conversation.", "not_a_participant");
    }
    const bounded = Math.min(Math.max(limit, 1), MAX_REPLAY);
    // Read one past the page so an exactly-full final page is not mistaken for
    // a truncated one.
    const records = await this.repository.listEvents(workspaceId, conversationId, after, bounded + 1);
    const page = records.slice(0, bounded);
    const frames: PlatformStreamFrame[] = [];
    for (const record of page) {
      if (record.audienceAccountId && record.audienceAccountId !== accountId) continue;
      const allowed = await this.authorizeFrame({ workspaceId, conversationId: record.conversationId, accountId });
      if (!allowed) continue;
      frames.push({ sequence: record.sequence, event: record.payload as PlatformStreamEvent });
    }
    // The raw page is capped before per-record authorization, so a truncated
    // page cannot prove the client has caught up. Signal a resync from the last
    // scanned sequence rather than silently skipping older events. Private
    // records were already dropped above, so nothing leaks here.
    if (records.length > bounded) {
      const cursor = page[page.length - 1]!.sequence;
      frames.push({ sequence: cursor, event: { type: "resync", workspaceId, at: this.timestamp() } });
    }
    return frames;
  }

  // ── workspaces ───────────────────────────────────────────────────────

  async createWorkspace(accountId: string, human: AuthenticatedHuman, input: { name: string; kind: "cloud" | "local" }): Promise<PlatformWorkspace> {
    const name = input.name.trim();
    if (!name || name.length > 120) throw new PlatformError(400, "A workspace name is required.", "invalid_name");
    await this.ensureAccount(human);
    const workspaceId = this.makeId();
    const at = this.timestamp();
    await this.repository.createWorkspace({ id: workspaceId, name, kind: input.kind, ownerAccountId: accountId, createdAt: at, provisioningState: "ready" });
    await this.repository.addMembership({ workspaceId, accountId, role: "owner", createdAt: at });
    await this.repository.createPrincipal({ id: this.makeId(), workspaceId, kind: "human", accountId, displayName: human.name || human.email, createdAt: at });
    const workspace: PlatformWorkspace = { id: workspaceId, name, kind: input.kind, ownerAccountId: accountId, myRole: "owner", createdAt: at };
    if (workspace.kind === "cloud" && this.workspaceCreated) {
      // Fire-and-catch: the hook may make slow vendor calls, so the workspace
      // must not wait on it. A rejection is swallowed and no status is set, so
      // the Apps status stays unset until a real validation commits.
      try {
        void this.workspaceCreated(workspace, accountId).catch(() => {});
      } catch {
        // Swallowed on purpose.
      }
    }
    return workspace;
  }

  async listWorkspaces(accountId: string): Promise<PlatformWorkspace[]> {
    const rows = await this.repository.listWorkspacesForAccount(accountId);
    return rows.map(({ workspace, role }) => ({ id: workspace.id, name: workspace.name, kind: workspace.kind, ownerAccountId: workspace.ownerAccountId, myRole: role, createdAt: workspace.createdAt }));
  }

  async getWorkspace(accountId: string, workspaceId: string): Promise<{ workspace: PlatformWorkspace; members: PlatformMember[]; bots: PlatformBot[] }> {
    const membership = await this.membershipOrThrow(accountId, workspaceId);
    const workspace = await this.repository.getWorkspace(workspaceId);
    if (!workspace) throw new PlatformError(404, "No such workspace.", "not_found");
    return {
      workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind, ownerAccountId: workspace.ownerAccountId, myRole: membership.role, createdAt: workspace.createdAt },
      members: await this.listMembers(accountId, workspaceId),
      bots: await this.listBots(accountId, workspaceId),
    };
  }

  async renameWorkspace(accountId: string, workspaceId: string, name: string): Promise<PlatformWorkspace> {
    const membership = await this.requireRole(accountId, workspaceId, "admin");
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) throw new PlatformError(400, "A workspace name is required.", "invalid_name");
    await this.repository.updateWorkspaceName(workspaceId, trimmed);
    const workspace = await this.repository.getWorkspace(workspaceId);
    if (!workspace) throw new PlatformError(404, "No such workspace.", "not_found");
    await this.publish(workspaceId, undefined, { type: "membership", workspaceId, at: this.timestamp() });
    return { id: workspace.id, name: workspace.name, kind: workspace.kind, ownerAccountId: workspace.ownerAccountId, myRole: membership.role, createdAt: workspace.createdAt };
  }

  // ── membership ───────────────────────────────────────────────────────

  async listMembers(accountId: string, workspaceId: string): Promise<PlatformMember[]> {
    await this.membershipOrThrow(accountId, workspaceId);
    const memberships = await this.repository.listMemberships(workspaceId);
    const out: PlatformMember[] = [];
    for (const membership of memberships) {
      const principal = await this.repository.principalForAccount(workspaceId, membership.accountId);
      const account = await this.repository.getAccount(membership.accountId);
      if (!principal) continue;
      out.push({
        accountId: membership.accountId,
        role: membership.role,
        displayName: principal.displayName,
        ...(account?.email ? { email: account.email } : {}),
        principalId: principal.id,
        joinedAt: membership.createdAt,
      });
    }
    return out;
  }

  async setMemberRole(actorAccountId: string, workspaceId: string, targetAccountId: string, role: PlatformRole): Promise<PlatformMember> {
    // Only an owner may move anyone between owner/admin/member; keeping the
    // workspace alive (at least one owner) is enforced below.
    await this.requireRole(actorAccountId, workspaceId, "owner");
    const target = await this.repository.getMembership(workspaceId, targetAccountId);
    if (!target) throw new PlatformError(404, "No such member.", "not_found");
    if (target.role === "owner" && role !== "owner" && (await this.repository.countOwners(workspaceId)) <= 1) {
      throw new PlatformError(409, "A workspace must keep at least one owner.", "last_owner");
    }
    await this.repository.updateMembershipRole(workspaceId, targetAccountId, role);
    await this.publish(workspaceId, undefined, { type: "membership", workspaceId, at: this.timestamp() });
    const members = await this.listMembers(actorAccountId, workspaceId);
    const updated = members.find((m) => m.accountId === targetAccountId);
    if (!updated) throw new PlatformError(404, "No such member.", "not_found");
    return updated;
  }

  async removeMember(actorAccountId: string, workspaceId: string, targetAccountId: string): Promise<void> {
    const actor = await this.requireRole(actorAccountId, workspaceId, "admin");
    const target = await this.repository.getMembership(workspaceId, targetAccountId);
    if (!target) return; // idempotent: already gone
    if (target.role === "owner") {
      if (actor.role !== "owner" || actorAccountId === targetAccountId) throw new PlatformError(403, "Only another owner can remove an owner.", "owner_protected");
      if ((await this.repository.countOwners(workspaceId)) <= 1) throw new PlatformError(409, "A workspace must keep at least one owner.", "last_owner");
    }
    if (actor.role === "admin" && ROLE_RANK[target.role] >= ROLE_RANK.admin) {
      throw new PlatformError(403, "Only an owner can remove an admin.", "owner_only");
    }
    // Cancel in-flight bot work before access is withdrawn.
    await this.revokeAccess(workspaceId, targetAccountId);
    await this.repository.removeMembership(workspaceId, targetAccountId);
    await this.publish(workspaceId, undefined, { type: "revoked", workspaceId, at: this.timestamp() }, { audienceAccountId: targetAccountId });
    await this.publish(workspaceId, undefined, { type: "membership", workspaceId, at: this.timestamp() });
    await this.publish(workspaceId, undefined, { type: "resync", workspaceId, at: this.timestamp() });
  }

  /** Cancel the runtime work and close streams an account can no longer see. */
  private async revokeAccess(workspaceId: string, accountId: string): Promise<void> {
    const principal = await this.repository.principalForAccount(workspaceId, accountId);
    if (!principal) return;
    const conversations = await this.repository.listConversationsForPrincipal(principal.id);
    await this.cancelRuntime(conversations.map((c) => c.id));
  }

  private async cancelRuntime(conversationIds: readonly string[]): Promise<void> {
    if (!this.authRuntime?.cancelConversation) return;
    for (const id of conversationIds) {
      try {
        await this.authRuntime.cancelConversation(id);
      } catch {
        // best effort; access is already withdrawn by the caller
      }
    }
  }

  // ── bots ─────────────────────────────────────────────────────────────

  private async botView(record: BotRecord): Promise<PlatformBot> {
    return { ...record };
  }

  async createBot(accountId: string, workspaceId: string, input: PlatformBotUpdate & { name: string }): Promise<PlatformBot> {
    await this.requireRole(accountId, workspaceId, "admin");
    const checked = platformBotCreateSchema.safeParse(input);
    if (!checked.success) throw new PlatformError(400, "The bot profile is not valid.", "invalid_profile");
    input = checked.data;
    const name = input.name;
    // An uploaded avatar must belong to an existing bot in this workspace.
    if (input.avatarUrl) throw new PlatformError(400, "Upload an avatar after creating the bot.", "invalid_avatar");
    const at = this.timestamp();
    const botId = this.makeId();
    const principalId = this.makeId();
    await this.repository.createPrincipal({ id: principalId, workspaceId, kind: "bot", botId, displayName: name, createdAt: at });
    const record = { ...platformBotProfileSchema.strip().parse(input), id: botId, workspaceId, principalId, name, ...(input.purpose ? { purpose: input.purpose } : {}), createdAt: at };
    await this.repository.createBot(record);
    await this.publish(workspaceId, undefined, { type: "membership", workspaceId, at });
    return this.botView(record);
  }

  async updateBot(actorAccountId: string, workspaceId: string, botId: string, input: PlatformBotUpdate): Promise<PlatformBot> {
    await this.requireRole(actorAccountId, workspaceId, "admin");
    const bot = await this.repository.getBot(botId);
    if (!bot || bot.workspaceId !== workspaceId) throw new PlatformError(404, "No such bot.", "not_found");
    const checked = platformBotUpdateSchema.safeParse(input);
    if (!checked.success) throw new PlatformError(400, "The bot profile is not valid.", "invalid_profile");
    input = checked.data;
    if (input.avatarUrl) {
      const image = await this.repository.getBotAvatar(input.avatarUrl.split("/").pop()!);
      const expected = `/api/colonie/platform/workspaces/${workspaceId}/bots/${botId}/avatars/${image?.id}`;
      if (!image || image.workspaceId !== workspaceId || image.botId !== botId || input.avatarUrl !== expected) {
        throw new PlatformError(400, "Choose an image uploaded for this bot.", "invalid_avatar");
      }
    }
    // Merge only submitted fields, including explicit empty instructions.
    const name = input.name === undefined ? bot.name : input.name.trim();
    const rawPurpose = input.purpose === undefined ? bot.purpose : input.purpose.trim();
    const purpose = rawPurpose ? rawPurpose.slice(0, 500) : undefined;
    const record: BotRecord = { ...bot, ...input, name, purpose };
    await this.repository.updateBot(record, name, input);
    await this.publish(workspaceId, undefined, { type: "membership", workspaceId, at: this.timestamp() });
    return this.botView((await this.repository.getBot(botId))!);
  }

  async saveBotAvatar(accountId: string, workspaceId: string, botId: string, bytes: Uint8Array, contentType: string): Promise<string> {
    await this.requireRole(accountId, workspaceId, "admin");
    const bot = await this.repository.getBot(botId);
    if (!bot || bot.workspaceId !== workspaceId) throw new PlatformError(404, "No such bot.", "not_found");
    const data = Buffer.from(bytes);
    const detected = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : data[0] === 255 && data[1] === 216 && data[2] === 255 ? "image/jpeg"
      : /^(GIF87a|GIF89a)$/.test(data.subarray(0, 6).toString("ascii")) ? "image/gif"
      : data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : null;
    if (!data.length || data.length > PLATFORM_AVATAR_MAX_BYTES || detected !== contentType || !detected) {
      throw new PlatformError(400, "Choose a PNG, JPEG, GIF, or WebP image up to 10 MB.", "invalid_avatar");
    }
    const id = this.makeId();
    await this.repository.saveBotAvatar({ id, workspaceId, botId, bytes: data, contentType: detected });
    return `/api/colonie/platform/workspaces/${workspaceId}/bots/${botId}/avatars/${id}`;
  }

  async getBotAvatar(accountId: string, workspaceId: string, botId: string, id: string) {
    await this.membershipOrThrow(accountId, workspaceId);
    const image = await this.repository.getBotAvatar(id);
    if (!image || image.workspaceId !== workspaceId || image.botId !== botId) throw new PlatformError(404, "No such image.", "not_found");
    return image;
  }

  async listBots(accountId: string, workspaceId: string): Promise<PlatformBot[]> {
    await this.membershipOrThrow(accountId, workspaceId);
    const bots = await this.repository.listBots(workspaceId);
    return Promise.all(bots.map((bot) => this.botView(bot)));
  }

  async removeBot(actorAccountId: string, workspaceId: string, botId: string): Promise<void> {
    await this.requireRole(actorAccountId, workspaceId, "admin");
    const bot = await this.repository.getBot(botId);
    if (!bot || bot.workspaceId !== workspaceId) throw new PlatformError(404, "No such bot.", "not_found");
    const conversations = await this.repository.listConversationsForPrincipal(bot.principalId);
    await this.cancelRuntime(conversations.map((c) => c.id));
    for (const conversation of conversations) {
      for (const participant of await this.repository.listParticipants(conversation.id)) {
        if (participant.principalId === bot.principalId) await this.repository.removeParticipant(conversation.id, bot.principalId);
      }
    }
    await this.repository.removeBot(botId);
    await this.publish(workspaceId, undefined, { type: "membership", workspaceId, at: this.timestamp() });
    await this.publish(workspaceId, undefined, { type: "resync", workspaceId, at: this.timestamp() });
  }

  // ── conversations ────────────────────────────────────────────────────

  async listConversations(accountId: string, workspaceId: string): Promise<PlatformConversation[]> {
    await this.membershipOrThrow(accountId, workspaceId);
    const principal = await this.humanPrincipalOrThrow(accountId, workspaceId);
    const conversations = await this.repository.listConversationsForPrincipal(principal.id);
    return Promise.all(conversations.map((conversation) => this.conversationView(conversation, accountId)));
  }

  async createGroup(actorAccountId: string, workspaceId: string, input: { title: string; memberPrincipalIds?: string[] }): Promise<PlatformConversation> {
    await this.membershipOrThrow(actorAccountId, workspaceId);
    const title = input.title.trim();
    if (!title || title.length > 120) throw new PlatformError(400, "A Group name is required.", "invalid_name");
    const actor = await this.humanPrincipalOrThrow(actorAccountId, workspaceId);
    const requested = new Set(input.memberPrincipalIds ?? []);
    requested.add(actor.id);
    for (const principalId of requested) {
      const principal = await this.repository.getPrincipal(principalId);
      if (!principal || principal.workspaceId !== workspaceId) throw new PlatformError(400, "A selected member is not in this workspace.", "cross_workspace");
    }
    const at = this.timestamp();
    const conversationId = this.makeId();
    await this.repository.createConversation({ id: conversationId, workspaceId, kind: "group", title, createdByPrincipalId: actor.id, createdAt: at });
    for (const principalId of requested) await this.repository.addParticipant({ conversationId, principalId, joinedAt: at });
    await this.publish(workspaceId, conversationId, { type: "conversation", conversationId, at });
    const conversation = await this.repository.getConversation(conversationId);
    if (!conversation) throw new PlatformError(500, "The Group could not be created.", "internal");
    return this.conversationView(conversation, actorAccountId);
  }

  async openDm(actorAccountId: string, workspaceId: string, input: { withAccountId?: string; withBotId?: string }): Promise<PlatformConversation> {
    await this.membershipOrThrow(actorAccountId, workspaceId);
    const actor = await this.humanPrincipalOrThrow(actorAccountId, workspaceId);
    if ((input.withAccountId ? 1 : 0) + (input.withBotId ? 1 : 0) !== 1) throw new PlatformError(400, "Choose exactly one person or bot to message.", "invalid_target");
    let other: PrincipalRecord;
    if (input.withAccountId) {
      if (input.withAccountId === actorAccountId) throw new PlatformError(400, "You cannot start a DM with yourself.", "invalid_target");
      await this.membershipOrThrow(input.withAccountId, workspaceId);
      other = await this.humanPrincipalOrThrow(input.withAccountId, workspaceId);
    } else {
      const bot = await this.repository.getBot(input.withBotId!);
      if (!bot || bot.workspaceId !== workspaceId) throw new PlatformError(404, "No such bot.", "not_found");
      const principal = await this.repository.principalForBot(workspaceId, bot.id);
      if (!principal) throw new PlatformError(500, "The bot principal is missing.", "internal");
      other = principal;
    }
    const existing = await this.repository.findDm(workspaceId, [actor.id, other.id]);
    if (existing) return this.conversationView(existing, actorAccountId);
    const at = this.timestamp();
    const conversationId = this.makeId();
    await this.repository.createConversation({ id: conversationId, workspaceId, kind: "dm", createdByPrincipalId: actor.id, createdAt: at });
    await this.repository.addParticipant({ conversationId, principalId: actor.id, joinedAt: at });
    await this.repository.addParticipant({ conversationId, principalId: other.id, joinedAt: at });
    await this.publish(workspaceId, conversationId, { type: "conversation", conversationId, at });
    const conversation = await this.repository.getConversation(conversationId);
    if (!conversation) throw new PlatformError(500, "The conversation could not be created.", "internal");
    return this.conversationView(conversation, actorAccountId);
  }

  private async participantOrThrow(accountId: string, conversationId: string): Promise<{ conversation: ConversationRecord; principal: PrincipalRecord }> {
    const conversation = await this.repository.getConversation(conversationId);
    if (!conversation) throw new PlatformError(404, "No such conversation.", "not_found");
    await this.membershipOrThrow(accountId, conversation.workspaceId);
    const principal = await this.humanPrincipalOrThrow(accountId, conversation.workspaceId);
    if (!(await this.repository.isParticipant(conversationId, principal.id))) {
      throw new PlatformError(403, "You are not a participant in this conversation.", "not_a_participant");
    }
    return { conversation, principal };
  }

  async getConversation(accountId: string, conversationId: string, options: { after?: number; limit?: number } = {}): Promise<{ conversation: PlatformConversation; messages: PlatformMessage[] }> {
    const { conversation } = await this.participantOrThrow(accountId, conversationId);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    // Without a cursor, page the latest `limit` messages so a late prompt is
    // never clipped. An explicit `after` keeps cursor semantics.
    const after = options.after ?? Math.max(0, (await this.repository.lastSequence(conversationId)) - limit);
    const messages = await this.listMessages(accountId, conversationId, after, limit);
    return { conversation: await this.conversationView(conversation, accountId), messages };
  }

  async listMessages(accountId: string, conversationId: string, after = 0, limit = 100): Promise<PlatformMessage[]> {
    await this.participantOrThrow(accountId, conversationId);
    const bounded = Math.min(Math.max(limit, 1), 500);
    const records = await this.repository.listMessages(conversationId, Math.max(after, 0), bounded);
    return Promise.all(records.map((record) => this.messageView(record)));
  }

  /**
   * Authorized transcript search. The caller must be a member of the workspace,
   * and the repository only returns conversations that member's workspace
   * principal participates in, so an owner never sees another person's private
   * DM. Query and limit are bounded here as well as in the repository.
   */
  async search(accountId: string, workspaceId: string, query: string, limit = 20, conversationId?: string): Promise<PlatformSearchHit[]> {
    await this.membershipOrThrow(accountId, workspaceId);
    const principal = await this.humanPrincipalOrThrow(accountId, workspaceId);
    const q = query.trim();
    if (!q) throw new PlatformError(400, "Enter something to search for.", "empty_query");
    if (q.length > MAX_SEARCH_QUERY) throw new PlatformError(400, `Search is limited to ${MAX_SEARCH_QUERY} characters.`, "query_too_long");
    if (conversationId && !await this.authorizeFrame({ accountId, workspaceId, conversationId })) throw new PlatformError(403, "You cannot search this conversation.", "forbidden");
    const bounded = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : 20, 1), MAX_SEARCH_LIMIT);
    const records = await this.repository.searchMessages(workspaceId, principal.id, q, bounded, conversationId);

    const conversations = new Map<string, ConversationRecord>();
    const principals = new Map<string, PrincipalRecord>();
    const principalById = async (id: string): Promise<PrincipalRecord | null> => {
      const cached = principals.get(id);
      if (cached) return cached;
      const found = await this.repository.getPrincipal(id);
      if (found) principals.set(id, found);
      return found;
    };
    const conversationById = async (id: string): Promise<ConversationRecord | null> => {
      const cached = conversations.get(id);
      if (cached) return cached;
      const found = await this.repository.getConversation(id);
      if (found) conversations.set(id, found);
      return found;
    };

    const hits: PlatformSearchHit[] = [];
    for (const message of records) {
      const conversation = await conversationById(message.conversationId);
      // A message whose conversation vanished is not a hit.
      if (!conversation || conversation.workspaceId !== workspaceId) continue;
      const sender = await principalById(message.senderPrincipalId);
      let peer: PrincipalRecord | null = null;
      if (conversation.kind === "dm") {
        const participants = await this.repository.listParticipants(conversation.id);
        const peerId = participants.find((p) => p.principalId !== principal.id)?.principalId;
        if (peerId) peer = await principalById(peerId);
      }
      const title = conversation.kind === "group"
        ? (conversation.title?.trim() || "Group")
        : (peer?.displayName ?? "Direct message");
      const snippet = snippetAround(message.body, q);
      hits.push({
        conversationId: conversation.id,
        conversationKind: conversation.kind,
        title,
        ...(peer?.kind === "bot" && peer.botId ? { botId: peer.botId } : {}),
        messageId: message.id,
        sequence: message.sequence,
        senderPrincipalId: message.senderPrincipalId,
        senderKind: sender?.kind ?? "bot",
        senderName: sender?.displayName ?? "Unknown",
        snippet: snippet.snippet,
        matchStart: snippet.matchStart,
        matchLength: snippet.matchLength,
        createdAt: message.createdAt,
      });
    }
    return hits;
  }

  async sendMessage(accountId: string, conversationId: string, body: string): Promise<PlatformMessage> {
    const { conversation, principal } = await this.participantOrThrow(accountId, conversationId);
    const text = body.trim();
    if (!text) throw new PlatformError(400, "A message body is required.", "empty_body");
    if (text.length > MAX_BODY) throw new PlatformError(400, `Messages are limited to ${MAX_BODY} characters.`, "too_long");
    const at = this.timestamp();
    const messageId = this.makeId();
    await this.repository.appendMessage({ id: messageId, workspaceId: conversation.workspaceId, conversationId, senderPrincipalId: principal.id, sequence: 0, body: text, createdAt: at });
    const stored = await this.repository.getMessage(messageId);
    if (!stored) throw new PlatformError(500, "The message could not be saved.", "internal");
    const view = await this.messageView(stored);
    await this.publish(conversation.workspaceId, conversationId, { type: "message", conversationId, message: view, at });
    await this.setRead(accountId, conversationId, stored.sequence);
    await this.triggerBots(conversation, accountId, view);
    return view;
  }

  async markRead(accountId: string, conversationId: string, sequence: number): Promise<PlatformConversation> {
    const { conversation } = await this.participantOrThrow(accountId, conversationId);
    const last = await this.repository.lastSequence(conversationId);
    await this.setRead(accountId, conversationId, Math.min(Math.max(sequence, 0), last));
    return this.conversationView(conversation, accountId);
  }

  private async setRead(accountId: string, conversationId: string, sequence: number): Promise<void> {
    const conversation = await this.repository.getConversation(conversationId);
    if (!conversation) return;
    const at = this.timestamp();
    await this.repository.setReadCursor({ conversationId, accountId, lastReadSequence: sequence, updatedAt: at });
    await this.publish(conversation.workspaceId, conversationId, { type: "read", conversationId, accountId, lastReadSequence: sequence, at });
  }

  // ── Group membership ─────────────────────────────────────────────────

  async addGroupMember(actorAccountId: string, conversationId: string, principalId: string): Promise<PlatformConversation> {
    const { conversation } = await this.participantOrThrow(actorAccountId, conversationId);
    if (conversation.kind !== "group") throw new PlatformError(400, "Only Groups have manageable membership.", "not_a_group");
    await this.requireGroupManager(actorAccountId, conversation);
    const principal = await this.repository.getPrincipal(principalId);
    if (!principal || principal.workspaceId !== conversation.workspaceId) throw new PlatformError(400, "That member is not in this workspace.", "cross_workspace");
    await this.repository.addParticipant({ conversationId, principalId, joinedAt: this.timestamp() });
    await this.publish(conversation.workspaceId, conversationId, { type: "conversation", conversationId, at: this.timestamp() });
    return this.conversationView(conversation, actorAccountId);
  }

  async removeGroupMember(actorAccountId: string, conversationId: string, principalId: string): Promise<void> {
    const { conversation, principal } = await this.participantOrThrow(actorAccountId, conversationId);
    if (conversation.kind !== "group") throw new PlatformError(400, "Only Groups have manageable membership.", "not_a_group");
    if (principal.id !== principalId) await this.requireGroupManager(actorAccountId, conversation);
    const target = await this.repository.getPrincipal(principalId);
    await this.repository.removeParticipant(conversationId, principalId);
    await this.publish(conversation.workspaceId, conversationId, { type: "conversation", conversationId, at: this.timestamp() });
    if (target?.kind === "bot") await this.cancelRuntime([conversationId]);
    else if (target?.accountId) await this.publish(conversation.workspaceId, conversationId, { type: "revoked", workspaceId: conversation.workspaceId, conversationId, at: this.timestamp() }, { audienceAccountId: target.accountId });
    else await this.publish(conversation.workspaceId, conversationId, { type: "membership", workspaceId: conversation.workspaceId, at: this.timestamp() });
  }

  private async requireGroupManager(accountId: string, conversation: ConversationRecord): Promise<void> {
    const membership = await this.membershipOrThrow(accountId, conversation.workspaceId);
    if (ROLE_RANK[membership.role] >= ROLE_RANK.admin) return;
    const principal = await this.humanPrincipalOrThrow(accountId, conversation.workspaceId);
    if (principal.id !== conversation.createdByPrincipalId) throw new PlatformError(403, "Only a Group manager can change its membership.", "needs_group_manager");
  }

  // ── bot turns ────────────────────────────────────────────────────────

  private async triggerBots(conversation: ConversationRecord, initiatorAccountId: string, message: PlatformMessage): Promise<void> {
    const participants = await this.repository.listParticipants(conversation.id);
    const bots: PrincipalRecord[] = [];
    for (const participant of participants) {
      const principal = await this.repository.getPrincipal(participant.principalId);
      if (principal?.kind === "bot") bots.push(principal);
    }
    const directTargets = bots.filter((bot) => mentionsBot(message.body, bot.displayName));
    let targets = conversation.kind === "dm" ? bots : directTargets;
    if (conversation.kind === "group" && !directTargets.length) {
      const history = await this.history(conversation.id);
      const records = await Promise.all(bots.map((bot) => bot.botId ? this.repository.getBot(bot.botId) : null));
      const decision = chooseGroupBot({
        message: { ...message, conversationKind: "group" },
        bots: records.filter((bot): bot is BotRecord => Boolean(bot)).map((bot) => ({ id: bot.id, name: bot.name, purpose: bot.purpose })),
        history: history.map((entry) => ({ ...entry, conversationKind: "group" as const })), now: this.now().getTime(),
      });
      if (decision.action === "speak") targets = bots.filter((bot) => bot.botId === decision.botId);
    }
    for (const bot of targets) {
      if (!bot.botId) continue;
      const history = await this.history(conversation.id);
      const request: BotTurnRequest = {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        botId: bot.botId,
        botPrincipalId: bot.id,
        trigger: conversation.kind === "dm" ? "dm" : directTargets.length ? "mention" : "proactive",
        initiatorAccountId,
        message,
        history,
      };
      await this.publishTurnState({ botPrincipalId: bot.id, conversationId: conversation.id, state: "typing" });
      try {
        await this.authRuntime?.onTurn(request);
      } catch (error) {
        await this.publishTurnState({ botPrincipalId: bot.id, conversationId: conversation.id, state: "error", error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async history(conversationId: string): Promise<PlatformMessage[]> {
    const last = await this.repository.lastSequence(conversationId);
    const after = Math.max(0, last - DEFAULT_HISTORY);
    const records = await this.repository.listMessages(conversationId, after, DEFAULT_HISTORY);
    return Promise.all(records.map((record) => this.messageView(record)));
  }

  async publishTurnState(input: { botPrincipalId: string; conversationId: string; state: TurnState; messageId?: string; error?: string }): Promise<void> {
    const conversation = await this.repository.getConversation(input.conversationId);
    if (!conversation) return;
    await this.publish(conversation.workspaceId, input.conversationId, {
      type: "turn",
      conversationId: input.conversationId,
      botPrincipalId: input.botPrincipalId,
      state: input.state,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.error ? { error: input.error.slice(0, 500) } : {}),
      at: this.timestamp(),
    });
  }

  /** Stop button: cancel the runtime and publish a cancelled turn state. */
  async stopTurns(accountId: string, conversationId: string, botPrincipalId?: string): Promise<{ stopped: true }> {
    await this.participantOrThrow(accountId, conversationId);
    const participants = await this.repository.listParticipants(conversationId);
    const botIds = botPrincipalId ? [botPrincipalId] : (await Promise.all(participants.map((p) => this.repository.getPrincipal(p.principalId)))).filter((p): p is PrincipalRecord => p?.kind === "bot").map((p) => p.id);
    await this.cancelRuntime([conversationId]);
    for (const id of botIds) await this.publishTurnState({ botPrincipalId: id, conversationId, state: "cancelled" });
    return { stopped: true };
  }

  async canPublish(input: { botPrincipalId: string; conversationId: string; initiatorAccountId?: string }): Promise<boolean> {
    const principal = await this.repository.getPrincipal(input.botPrincipalId);
    if (!principal || principal.kind !== "bot") return false;
    const conversation = await this.repository.getConversation(input.conversationId);
    if (!conversation || conversation.workspaceId !== principal.workspaceId) return false;
    if (!(await this.repository.isParticipant(input.conversationId, input.botPrincipalId))) return false;
    const initiator = input.initiatorAccountId ?? (await this.dmInitiator(conversation));
    if (!initiator) return false;
    const membership = await this.repository.getMembership(conversation.workspaceId, initiator);
    if (!membership) return false;
    const human = await this.repository.principalForAccount(conversation.workspaceId, initiator);
    if (!human) return false;
    return this.repository.isParticipant(input.conversationId, human.id);
  }

  private async dmInitiator(conversation: ConversationRecord): Promise<string | undefined> {
    if (conversation.kind !== "dm") return undefined;
    for (const participant of await this.repository.listParticipants(conversation.id)) {
      const principal = await this.repository.getPrincipal(participant.principalId);
      if (principal?.kind === "human" && principal.accountId) return principal.accountId;
    }
    return undefined;
  }

  async postBotMessage(input: { botPrincipalId: string; conversationId: string; body: string; initiatorAccountId?: string }): Promise<PlatformMessage> {
    if (!(await this.canPublish(input))) throw new PlatformError(403, "This bot's access to the conversation was revoked.", "revoked");
    const text = input.body.trim();
    if (!text) throw new PlatformError(400, "A message body is required.", "empty_body");
    if (text.length > MAX_BODY) throw new PlatformError(400, `Messages are limited to ${MAX_BODY} characters.`, "too_long");
    const principal = await this.repository.getPrincipal(input.botPrincipalId);
    if (!principal) throw new PlatformError(404, "No such bot.", "not_found");
    const at = this.timestamp();
    const messageId = this.makeId();
    await this.repository.appendMessage({ id: messageId, workspaceId: principal.workspaceId, conversationId: input.conversationId, senderPrincipalId: input.botPrincipalId, sequence: 0, body: text, createdAt: at });
    const stored = await this.repository.getMessage(messageId);
    if (!stored) throw new PlatformError(500, "The message could not be saved.", "internal");
    const view = await this.messageView(stored);
    await this.publish(principal.workspaceId, input.conversationId, { type: "message", conversationId: input.conversationId, message: view, at });
    await this.publishTurnState({ botPrincipalId: input.botPrincipalId, conversationId: input.conversationId, state: "completed", messageId });
    return view;
  }

  // ── invitations ──────────────────────────────────────────────────────

  async createInvitation(actorAccountId: string, workspaceId: string, input: { role?: PlatformRole; expiresInHours?: number }): Promise<{ invitation: PlatformInvitation; token: string; url: string }> {
    await this.requireRole(actorAccountId, workspaceId, "admin");
    const role: PlatformRole = input.role === "admin" ? "admin" : "member";
    const hours = Math.min(Math.max(input.expiresInHours ?? DEFAULT_INVITE_HOURS, 1), MAX_INVITE_HOURS);
    const at = this.now();
    const token = randomBytes(32).toString("base64url");
    const record = {
      id: this.makeId(),
      workspaceId,
      role,
      tokenHash: hashToken(token),
      createdByAccountId: actorAccountId,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + hours * 3_600_000).toISOString(),
    };
    await this.repository.createInvitation(record);
    return { invitation: this.invitationView(record), token, url: this.inviteUrl(token) };
  }

  private inviteUrl(token: string): string {
    const path = `/?colonieInvite=${encodeURIComponent(token)}`;
    return this.publicOrigin ? `${this.publicOrigin}${path}` : path;
  }

  async listInvitations(accountId: string, workspaceId: string): Promise<PlatformInvitation[]> {
    await this.requireRole(accountId, workspaceId, "admin");
    const records = await this.repository.listInvitations(workspaceId);
    return records.map((record) => this.invitationView(record));
  }

  async revokeInvitation(actorAccountId: string, workspaceId: string, invitationId: string): Promise<void> {
    await this.requireRole(actorAccountId, workspaceId, "admin");
    const invitation = await this.repository.getInvitation(invitationId);
    if (!invitation || invitation.workspaceId !== workspaceId) throw new PlatformError(404, "No such invitation.", "not_found");
    if (!invitation.revokedAt) await this.repository.revokeInvitation(invitationId);
    await this.publish(workspaceId, undefined, { type: "membership", workspaceId, at: this.timestamp() });
  }

  async acceptInvitation(accountId: string, human: AuthenticatedHuman, token: string): Promise<{ workspace: PlatformWorkspace; role: PlatformRole }> {
    if (!token) throw new PlatformError(400, "An invitation token is required.", "missing_token");
    await this.ensureAccount(human);
    const invitation = await this.repository.getInvitationByHash(hashToken(token));
    if (!invitation) throw new PlatformError(404, "That invitation link is not valid.", "invalid_invitation");
    if (invitation.revokedAt) throw new PlatformError(410, "That invitation was revoked.", "revoked");
    if (invitation.acceptedAt && invitation.acceptedByAccountId && invitation.acceptedByAccountId !== accountId) {
      throw new PlatformError(409, "That invitation was already used.", "already_used");
    }
    if (!invitation.acceptedAt && Date.parse(invitation.expiresAt) <= this.now().getTime()) {
      throw new PlatformError(410, "That invitation expired.", "expired");
    }
    const at = this.timestamp();
    let result;
    try {
      result = await this.repository.acceptInvitation(invitation.id, accountId, at);
    } catch (error) {
      // The locked write re-checks the invitation; a race maps to the same
      // errors the pre-check produces.
      if (error instanceof InvitationConflictError) throw invitationConflict(error.code);
      throw error;
    }
    if (result.created) {
      await this.ensureHumanPrincipal(accountId, invitation.workspaceId, human);
      await this.publish(invitation.workspaceId, undefined, { type: "membership", workspaceId: invitation.workspaceId, at });
      await this.publish(invitation.workspaceId, undefined, { type: "resync", workspaceId: invitation.workspaceId, at });
    }
    const workspace = await this.repository.getWorkspace(invitation.workspaceId);
    if (!workspace) throw new PlatformError(404, "No such workspace.", "not_found");
    return { workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind, ownerAccountId: workspace.ownerAccountId, myRole: result.membership.role, createdAt: workspace.createdAt }, role: result.membership.role };
  }

  private async ensureHumanPrincipal(accountId: string, workspaceId: string, human: AuthenticatedHuman): Promise<PrincipalRecord> {
    const existing = await this.repository.principalForAccount(workspaceId, accountId);
    if (existing) return existing;
    const principal: PrincipalRecord = { id: this.makeId(), workspaceId, kind: "human", accountId, displayName: human.name || human.email, createdAt: this.timestamp() };
    await this.repository.createPrincipal(principal);
    return principal;
  }

  // ── connections ──────────────────────────────────────────────────────

  async listConnections(accountId: string, workspaceId: string): Promise<PlatformConnection[]> {
    // Everyone sees workspace connections plus their own personal ones.
    // Managing the workspace does not grant access to another person's
    // personal account metadata.
    await this.membershipOrThrow(accountId, workspaceId);
    const principal = await this.humanPrincipalOrThrow(accountId, workspaceId);
    const records = await this.repository.listConnections(workspaceId);
    const visible = records.filter((c) => c.audience === "workspace" || c.owningPrincipalId === principal.id);
    return Promise.all(visible.map(async (record) => this.connectionView(record, await this.maskedHint(record))));
  }

  private async maskedHint(record: { secretRefId?: string }): Promise<string | undefined> {
    if (!record.secretRefId) return undefined;
    const secret = await this.repository.getSecretReference(record.secretRefId);
    return secret?.maskedHint;
  }

  async createConnection(actorAccountId: string, workspaceId: string, input: { toolkit: string; audience: "workspace" | "personal"; actions?: string[]; secret?: string; providerAccountId?: string }): Promise<PlatformConnection> {
    const membership = await this.membershipOrThrow(actorAccountId, workspaceId);
    const toolkit = input.toolkit.trim();
    if (!toolkit) throw new PlatformError(400, "Select a toolkit.", "invalid_toolkit");
    const principal = await this.humanPrincipalOrThrow(actorAccountId, workspaceId);
    if (input.audience === "workspace" && ROLE_RANK[membership.role] < ROLE_RANK.admin) {
      throw new PlatformError(403, "Only an owner or admin can manage workspace connections.", "needs_role");
    }
    const at = this.timestamp();
    const secretRefId = input.secret ? await this.sealService(workspaceId, toolkit, input.secret, at) : undefined;
    const record = {
      id: this.makeId(),
      workspaceId,
      owningPrincipalId: principal.id,
      toolkit,
      audience: input.audience,
      actions: (input.actions ?? []).slice(0, 50),
      status: "active" as const,
      version: 1,
      grantRevision: 1,
      ...(secretRefId ? { secretRefId } : {}),
      ...(input.providerAccountId ? { providerAccountId: input.providerAccountId } : {}),
      createdAt: at,
      updatedAt: at,
    };
    await this.repository.createConnection(record);
    return this.connectionView(record, secretRefId ? await this.maskedHint(record) : undefined);
  }

  private async sealService(workspaceId: string, label: string, secret: string, at: string): Promise<string> {
    if (!this.box) throw new PlatformError(500, "The secret service is not configured; the key was not saved.", "no_secret_service");
    const sealed = this.box.seal(secret);
    const id = this.makeId();
    await this.repository.createSecretReference({ id, workspaceId, label, ciphertext: sealed.ciphertext, iv: sealed.iv, authTag: sealed.authTag, keyVersion: sealed.keyVersion, maskedHint: sealed.maskedHint, status: "active", createdAt: at, updatedAt: at });
    return id;
  }

  async rotateConnection(actorAccountId: string, workspaceId: string, connectionId: string, secret: string): Promise<PlatformConnection> {
    const membership = await this.membershipOrThrow(actorAccountId, workspaceId);
    const connection = await this.repository.getConnection(connectionId);
    if (!connection || connection.workspaceId !== workspaceId) throw new PlatformError(404, "No such connection.", "not_found");
    const principal = await this.humanPrincipalOrThrow(actorAccountId, workspaceId);
    const isWorkspace = connection.audience === "workspace";
    const allowed = isWorkspace ? ROLE_RANK[membership.role] >= ROLE_RANK.admin : connection.owningPrincipalId === principal.id;
    if (!allowed) throw new PlatformError(403, "You cannot change this connection.", "forbidden");
    const at = this.timestamp();
    const secretRefId = await this.sealService(workspaceId, connection.toolkit, secret, at);
    const next = { ...connection, secretRefId, status: "active" as const, updatedAt: at };
    await this.repository.updateConnection(next);
    // Bumping version + grantRevision invalidates every cached lease.
    const rotated = await this.repository.rotateConnection(connectionId, at);
    const final = rotated ?? next;
    return this.connectionView(final, await this.maskedHint(final));
  }

  async deleteConnection(actorAccountId: string, workspaceId: string, connectionId: string): Promise<void> {
    const membership = await this.membershipOrThrow(actorAccountId, workspaceId);
    const connection = await this.repository.getConnection(connectionId);
    if (!connection || connection.workspaceId !== workspaceId) return; // idempotent
    const principal = await this.humanPrincipalOrThrow(actorAccountId, workspaceId);
    const allowed = connection.audience === "workspace" ? ROLE_RANK[membership.role] >= ROLE_RANK.admin : connection.owningPrincipalId === principal.id;
    if (!allowed) throw new PlatformError(403, "You cannot remove this connection.", "forbidden");
    await this.repository.deleteConnection(connectionId);
  }

  /** Open a sealed secret for an authorized relay call. Never serialized. */
  async openSecret(secretId: string): Promise<string | null> {
    if (!this.box) return null;
    const secret = await this.repository.getSecretReference(secretId);
    if (!secret || secret.status !== "active") return null;
    return this.box.open(secret);
  }

  // ── account recovery (no SMTP) ───────────────────────────────────────

  /**
   * Generate a 256-bit one-time recovery key for the signed-in account. The
   * server stores only its hash and replaces any outstanding key. The plaintext
   * is returned exactly once and never persisted.
   */
  async createRecoveryKey(accountId: string): Promise<PlatformRecoverySecret> {
    const recoveryKey = randomBytes(32).toString("base64url");
    const at = this.timestamp();
    await this.repository.replaceRecoveryKey({ id: this.makeId(), accountId, tokenHash: hashToken(recoveryKey), createdAt: at });
    return { recoveryKey, createdAt: at };
  }

  /**
   * Consume a recovery key and reset the password. With the production
   * repository the consume, password write, and session revocation share one
   * transaction, so a failed write cannot burn the key. The fixture has no
   * cross-store transaction; there the password is updated first and the key
   * consumed second, so a failure likewise leaves the key intact. Nothing here
   * is logged.
   */
  async recoverAccount(input: { recoveryKey: string; newPassword: string }): Promise<void> {
    if (typeof input.newPassword !== "string" || input.newPassword.length < 8 || input.newPassword.length > 128) {
      throw new PlatformError(400, "Choose a password of at least 8 characters.", "weak_password");
    }
    const key = typeof input.recoveryKey === "string" && input.recoveryKey ? await this.repository.getRecoveryKeyByHash(hashToken(input.recoveryKey)) : null;
    if (!key) throw new PlatformError(400, "That recovery key is not valid.", "invalid_recovery_key");

    if (this.repository.resetAccountWithKey) {
      if (!this.auth.hashPassword) throw new PlatformError(501, "Account recovery is not available on this server.", "recovery_unavailable");
      const passwordHash = await this.auth.hashPassword(input.newPassword);
      const claimed = await this.repository.resetAccountWithKey({ recoveryKeyId: key.id, consumedAt: this.timestamp(), passwordHash });
      if (!claimed) throw new PlatformError(410, "That recovery key was already used.", "recovery_key_used");
      return;
    }

    if (!this.auth.recoverPassword || !this.auth.revokeSessions) {
      throw new PlatformError(501, "Account recovery is not available on this server.", "recovery_unavailable");
    }
    await this.auth.recoverPassword(key.accountId, input.newPassword);
    const claimed = await this.repository.consumeRecoveryKey(key.id, this.timestamp());
    if (!claimed) throw new PlatformError(410, "That recovery key was already used.", "recovery_key_used");
    await this.auth.revokeSessions(claimed.accountId);
  }
}
