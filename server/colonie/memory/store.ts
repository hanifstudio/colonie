// The Colonie memory ledger: one validated, atomically-written JSON document
// at DATA_DIR/colonie-memory/state.json. A single document means shared and
// per-bot scopes, forget protections and the capture queue all commit
// together — there is no window where a fact exists in one scope but not its
// suppression, or where a job's source was marked processed before it was
// applied.
//
// Every mutation is one synchronous commit: the in-memory ledger is cloned,
// the change is applied, and the whole document is written. If the write
// throws, the clone is restored, so memory and disk never disagree. Reads
// return deep clones, so a caller cannot mutate store state by accident.
//
// `revision` bumps only on owner-driven changes (preferences, explicit
// save/forget/clear, bot removal). Automatic captures commit without bumping
// it, so a queue of legitimate captures is not invalidated by the first one;
// an owner edit does bump it, which discards every outstanding proposal.
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../persistence/atomic.ts";
import { factIdentity, isMemoryDate } from "../../memory-entries.ts";
import { redactSecretsInText } from "../../redact.ts";
import type {
  MemoryChange,
  MemoryEntry,
  MemoryKind,
  MemoryPreferences,
  MemoryScope,
  MemorySnapshot,
  MemoryView,
} from "../../../shared/colonie-memory.ts";

export const MAX_TEXT = 1000;
export const MAX_KEY = 120;
/** Admitted source-message bound; larger than an entry so evidence stays
 * verbatim without shortening the turn. */
export const MAX_SOURCE = 16384;
export const MAX_ENTRIES = 1000;
export const MAX_JOBS = 100;
export const MAX_PROCESSED = 5000;
export const MAX_SUPPRESSIONS = 5000;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;

export interface MemoryJob {
  id: string;
  botId: string;
  threadId: string;
  messageId: string;
  text: string;
  at: string;
  state: "queued" | "running";
  attempts: number;
  /** Owner-edit generation when the turn was queued. nextJob drops the job if
   * the generation moved (an edit/clear/disable since), otherwise refreshes
   * `revision` to the current snapshot before the analyzer runs. */
  ownerGeneration: number;
  /** The public revision when the turn was queued or last refreshed. */
  revision: string;
}

const DEFAULT_PREFERENCES: MemoryPreferences = { enabled: true, automatic: true };
const REDACTION = /«redacted \d+ chars»/;

function storeError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** Collapse whitespace and bound, preserving signs, digits and language. */
function collapse(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

const preferencesSchema = z.object({ enabled: z.boolean(), automatic: z.boolean() }).strict();
const scopeSchema = z.enum(["shared", "bot"]);
const kindSchema = z.enum(["preference", "fact", "decision"]);
const untilSchema = z.string().refine((value) => isMemoryDate(value), "A calendar date in YYYY-MM-DD form.");

const sourceSchema = z
  .object({
    botId: z.string().min(1).max(128),
    threadId: z.string().min(1).max(256),
    messageId: z.string().min(1).max(256),
    at: z.string().min(1).max(64),
    quote: z.string().max(MAX_TEXT),
  })
  .strict();

const entrySchema = z
  .object({
    id: z.string().min(1).max(128),
    scope: scopeSchema,
    botId: z.string().min(1).max(128).optional(),
    key: z.string().min(1).max(MAX_KEY),
    text: z.string().min(1).max(MAX_TEXT),
    kind: kindSchema,
    createdAt: z.string().min(1).max(64),
    updatedAt: z.string().min(1).max(64),
    until: untilSchema.optional(),
    origin: z.enum(["automatic", "person"]),
    source: sourceSchema.optional(),
  })
  .strict();

const suppressionSchema = z
  .object({
    scope: scopeSchema,
    botId: z.string().min(1).max(128).optional(),
    key: z.string().min(1).max(MAX_KEY),
    identity: z.string().min(1).max(MAX_TEXT),
  })
  .strict();

const jobSchema = z
  .object({
    id: z.string().min(1).max(128),
    botId: z.string().min(1).max(128),
    threadId: z.string().min(1).max(256),
    messageId: z.string().min(1).max(256),
    text: z.string().min(1).max(MAX_SOURCE),
    at: z.string().min(1).max(64),
    state: z.enum(["queued", "running"]),
    attempts: z.number().int().min(0).max(10),
    ownerGeneration: z.number().int().min(0),
    revision: z.string().min(1).max(64),
  })
  .strict();

const botLedgerSchema = z
  .object({
    preferences: preferencesSchema,
    entries: z.array(entrySchema).max(MAX_ENTRIES),
    suppressions: z.array(suppressionSchema).max(MAX_SUPPRESSIONS),
    processed: z.array(z.string().max(800)).max(MAX_PROCESSED),
  })
  .strict();

const ledgerSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().min(1),
    ownerGeneration: z.number().int().min(0),
    app: preferencesSchema,
    shared: z
      .object({
        entries: z.array(entrySchema).max(MAX_ENTRIES),
        suppressions: z.array(suppressionSchema).max(MAX_SUPPRESSIONS),
      })
      .strict(),
    bots: z.record(z.string().max(128), botLedgerSchema),
    jobs: z.array(jobSchema).max(MAX_JOBS),
    running: z.boolean(),
    lastError: z.string().max(500).optional(),
    lastCaptureAt: z.string().max(64).optional(),
  })
  .strict();

type Ledger = z.infer<typeof ledgerSchema>;
type BotLedger = Ledger["bots"][string];

function emptyLedger(): Ledger {
  return {
    version: 1,
    revision: 1,
    ownerGeneration: 0,
    app: { ...DEFAULT_PREFERENCES },
    shared: { entries: [], suppressions: [] },
    bots: {},
    jobs: [],
    running: false,
  };
}

export class ColonieMemoryStore {
  private readonly dir: string;
  private readonly file: string;
  private state: Ledger;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "colonie-memory");
    this.file = join(this.dir, "state.json");
    this.ensureSafeDir();
    this.state = this.load();
  }

  /** The directory we own must be a real directory, never a symlink into
   * somewhere the app does not control. ENOENT is the only acceptable
   * "not there yet". */
  private ensureSafeDir(): void {
    try {
      const stat = lstatSync(this.dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw storeError("The memory directory is not a real directory; refusing to use it.", 500);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private load(): Ledger {
    let raw: string;
    try {
      const stat = lstatSync(this.file);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw storeError("The memory store is not a regular file; refusing to overwrite it.", 500);
      }
      if (stat.size > MAX_LEDGER_BYTES) throw storeError("The memory store exceeds its storage limit.", 500);
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw storeError("The memory store is unreadable; refusing to overwrite it.", 500);
    }
    const result = ledgerSchema.safeParse(parsed);
    if (!result.success) {
      throw storeError("The memory store is unreadable; refusing to overwrite it.", 500);
    }
    const ledger = result.data as Ledger;
    // An interrupted running job recovers as queued; its stored revision still
    // decides staleness, so a proposal from before the crash cannot overwrite
    // an edit made while it was down.
    for (const job of ledger.jobs) if (job.state === "running") job.state = "queued";
    ledger.running = false;
    this.pruneProcessed(ledger);
    return ledger;
  }

  /** Clone, apply, persist; restore the clone if the write throws. This is
   * the only place store state is written. */
  private commit<T>(work: () => T): T {
    const before = structuredClone(this.state);
    try {
      const result = work();
      this.persist();
      return result;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  private persist(): void {
    this.ensureSafeDir();
    const text = JSON.stringify(this.state, null, 2);
    if (Buffer.byteLength(text, "utf8") > MAX_LEDGER_BYTES) throw storeError("Memory storage is full. Remove unused memories before saving more.", 409);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, text, { mode: 0o600 });
  }

  private entryCount(): number {
    return this.state.shared.entries.length + Object.values(this.state.bots).reduce((count, bot) => count + bot.entries.length, 0);
  }

  /** Public content change (owner or automatic): a stale UI edit now 409s. */
  private bump(): void {
    this.state.revision += 1;
  }

  /** Owner-driven change: also moves the generation, which invalidates any
   * capture proposal queued before it. */
  private bumpOwner(): void {
    this.state.revision += 1;
    this.state.ownerGeneration += 1;
  }

  private requireRevision(expectedRevision: string): void {
    if (String(this.state.revision) !== expectedRevision) {
      throw storeError("Memory changed elsewhere. Refresh and try again.", 409);
    }
  }

  private botLedger(botId: string, create: boolean): BotLedger | undefined {
    const existing = this.state.bots[botId];
    if (existing) return existing;
    if (!create) return undefined;
    const record: BotLedger = {
      preferences: { ...DEFAULT_PREFERENCES },
      entries: [],
      suppressions: [],
      processed: [],
    };
    this.state.bots[botId] = record;
    return record;
  }

  private pruneProcessed(ledger: Ledger): void {
    for (const record of Object.values(ledger.bots)) this.pruneProcessedRecord(record);
  }

  private pruneProcessedRecord(record: BotLedger): void {
    if (record.processed.length > MAX_PROCESSED) record.processed = record.processed.slice(-MAX_PROCESSED);
  }

  private isExpired(entry: MemoryEntry, today: string): boolean {
    return entry.until !== undefined && entry.until < today;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Shared entries, then this bot's, newest first, expired left out. */
  private entriesFor(botId: string): MemoryEntry[] {
    const today = this.today();
    const shared = this.state.shared.entries.filter((entry) => !this.isExpired(entry, today));
    const own = (this.state.bots[botId]?.entries ?? []).filter((entry) => !this.isExpired(entry, today));
    return [...shared, ...own].sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : 1) : a.updatedAt > b.updatedAt ? -1 : 1));
  }

  private status(): MemoryView["status"] {
    const pending = this.state.jobs.filter((job) => job.state === "queued").length;
    const running = this.state.running || this.state.jobs.some((job) => job.state === "running");
    return {
      pending,
      running,
      ...(this.state.lastError ? { lastError: this.state.lastError } : {}),
      ...(this.state.lastCaptureAt ? { lastCaptureAt: this.state.lastCaptureAt } : {}),
    };
  }

  /** Always lists entries, even while memory is disabled: the person must be
   * able to review and forget what is stored. Disabling gates recall/capture
   * only. Returned entries are clones. */
  view(botId: string): MemoryView {
    return {
      revision: String(this.state.revision),
      app: { ...this.state.app },
      bot: { ...(this.state.bots[botId]?.preferences ?? DEFAULT_PREFERENCES) },
      entries: structuredClone(this.entriesFor(botId)),
      status: this.status(),
    };
  }

  snapshot(botId: string): MemorySnapshot {
    return {
      revision: String(this.state.revision),
      app: { ...this.state.app },
      bot: { ...(this.state.bots[botId]?.preferences ?? DEFAULT_PREFERENCES) },
      entries: structuredClone(this.entriesFor(botId)),
    };
  }

  updatePreferences(botId: string, scope: MemoryScope, preferences: MemoryPreferences, expectedRevision: string): void {
    this.commit(() => {
      this.requireRevision(expectedRevision);
      const parsed = preferencesSchema.parse(preferences);
      if (scope === "shared") this.state.app = parsed;
      else if (scope === "bot") this.botLedger(botId, true)!.preferences = parsed;
      else throw storeError("Unknown memory scope.", 400);
      this.bumpOwner();
    });
  }

  saveEntry(
    botId: string,
    input: { scope: MemoryScope; text: string; kind: MemoryKind; key?: string; until?: string; id?: string },
    expectedRevision: string,
  ): void {
    this.commit(() => {
      this.requireRevision(expectedRevision);
      const scope = scopeSchema.parse(input.scope);
      const kind = kindSchema.parse(input.kind);
      const text = this.requireText(input.text);
      const until = input.until === undefined ? undefined : untilSchema.parse(input.until);
      const collection = scope === "shared" ? this.state.shared.entries : this.botLedger(botId, true)!.entries;
      const now = new Date().toISOString();
      if (input.id) {
        const existing = collection.find((entry) => entry.id === input.id);
        if (!existing || existing.scope !== scope) throw storeError("That memory no longer exists.", 404);
        existing.text = text;
        existing.kind = kind;
        if (until === undefined) delete existing.until;
        else existing.until = until;
        if (input.key !== undefined) existing.key = this.requireKey(input.key);
        existing.updatedAt = now;
        existing.origin = "person";
        this.clearSuppression(scope, scope === "bot" ? botId : undefined, existing.key, existing.text);
      } else {
        const key = input.key !== undefined ? this.requireKey(input.key) : this.defaultKey(kind, text);
        if (this.entryCount() >= MAX_ENTRIES) throw storeError("Memory is full. Forget something first.", 409);
        // An explicit owner save intentionally restores a previously forgotten key.
        this.clearSuppression(scope, scope === "bot" ? botId : undefined, key, text);
        collection.push({
          id: randomUUID(),
          scope,
          ...(scope === "bot" ? { botId } : {}),
          key,
          text,
          kind,
          createdAt: now,
          updatedAt: now,
          ...(until ? { until } : {}),
          origin: "person",
        });
      }
      this.bumpOwner();
    });
  }

  forgetEntry(botId: string, id: string, expectedRevision: string): void {
    this.commit(() => {
      this.requireRevision(expectedRevision);
      const sharedIndex = this.state.shared.entries.findIndex((entry) => entry.id === id);
      const own = this.state.bots[botId]?.entries;
      const ownIndex = own ? own.findIndex((entry) => entry.id === id) : -1;
      let removed: MemoryEntry;
      if (sharedIndex >= 0) removed = this.state.shared.entries.splice(sharedIndex, 1)[0]!;
      else if (ownIndex >= 0) removed = own!.splice(ownIndex, 1)[0]!;
      else throw storeError("That memory no longer exists.", 404);
      this.addSuppression(removed.scope, removed.botId, removed.key, removed.text);
      this.bumpOwner();
    });
  }

  clear(botId: string, scope: MemoryScope, expectedRevision: string): void {
    this.commit(() => {
      this.requireRevision(expectedRevision);
      if (scope === "shared") {
        const entries = this.state.shared.entries;
        this.assertSuppressionRoom("shared", undefined, entries);
        for (const entry of entries) this.addSuppression(entry.scope, undefined, entry.key, entry.text);
        this.state.shared.entries = [];
      } else if (scope === "bot") {
        const record = this.botLedger(botId, false);
        if (record) {
          this.assertSuppressionRoom("bot", botId, record.entries);
          for (const entry of record.entries) this.addSuppression(entry.scope, botId, entry.key, entry.text);
          record.entries = [];
        }
        this.state.jobs = this.state.jobs.filter((job) => job.botId !== botId);
        this.state.running = this.state.jobs.some((job) => job.state === "running");
      } else {
        throw storeError("Unknown memory scope.", 400);
      }
      this.bumpOwner();
    });
  }

  private suppressionList(scope: MemoryScope, botId: string | undefined) {
    return scope === "shared" ? this.state.shared.suppressions : this.botLedger(botId!, true)!.suppressions;
  }

  /** A forgotten fact is suppressed by its key OR its canonical text, so a
   * paraphrase with a fresh key cannot resurrect it either. */
  private suppressionMatches(suppression: { key: string; identity: string }, key: string, text: string): boolean {
    return suppression.key === key || suppression.identity === factIdentity(text);
  }

  private assertSuppressionRoom(scope: MemoryScope, botId: string | undefined, entries: readonly MemoryEntry[]): void {
    const list = this.suppressionList(scope, botId);
    const fresh = entries.filter((entry) => !list.some((s) => this.suppressionMatches(s, entry.key, entry.text))).length;
    if (list.length + fresh > MAX_SUPPRESSIONS) {
      throw storeError("Too many forgotten markers to clear this scope. Forget individual memories instead.", 409);
    }
  }

  private addSuppression(scope: MemoryScope, botId: string | undefined, key: string, text: string): void {
    const identity = factIdentity(text);
    if (!identity) return;
    const list = this.suppressionList(scope, botId);
    if (list.some((s) => this.suppressionMatches(s, key, text))) return;
    if (list.length >= MAX_SUPPRESSIONS) throw storeError("Too many forgotten markers; clear some memory first.", 409);
    list.push({ scope, ...(scope === "bot" ? { botId } : {}), key, identity });
  }

  private clearSuppression(scope: MemoryScope, botId: string | undefined, key: string, text: string): void {
    const list = this.suppressionList(scope, botId);
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (this.suppressionMatches(list[index]!, key, text)) list.splice(index, 1);
    }
  }

  private isSuppressed(scope: MemoryScope, botId: string | undefined, key: string, text: string): boolean {
    return this.suppressionList(scope, botId).some((s) => this.suppressionMatches(s, key, text));
  }

  // ── text and key guards ──────────────────────────────────────────────

  /** Redact, then reject rather than slice: a fact cut in half is a wrong
   * fact. A value that is only redaction markers is never stored. */
  private requireText(raw: string): string {
    const text = collapse(redactSecretsInText(raw));
    if (!text) throw storeError("Memory text is required.", 400);
    if (REDACTION.test(text)) throw storeError("That text looks like a secret and was not saved.", 400);
    if (text.length > MAX_TEXT) throw storeError(`Memory text is limited to ${MAX_TEXT} characters.`, 400);
    return text;
  }

  /** Model-captured text: same rules, but a rejection drops the item. */
  private safeText(raw: string): string | null {
    const text = collapse(redactSecretsInText(raw));
    if (!text || REDACTION.test(text) || text.length > MAX_TEXT) return null;
    return text;
  }

  private requireKey(raw: string): string {
    const key = collapse(raw);
    if (!key) throw storeError("A memory key is required.", 400);
    if (key.length > MAX_KEY) throw storeError(`A memory key is limited to ${MAX_KEY} characters.`, 400);
    return key;
  }

  private defaultKey(kind: MemoryKind, text: string): string {
    const slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_KEY - kind.length - 1);
    return `${kind}:${slug}`;
  }

  // ── capture queue ────────────────────────────────────────────────────

  enqueue(input: { botId: string; threadId: string; messageId: string; text: string; at: string }): boolean {
    return this.commit(() => {
      const record = this.botLedger(input.botId, true)!;
      const sourceId = `${input.botId}|${input.threadId}|${input.messageId}`;
      if (record.processed.includes(sourceId)) return false;
      if (this.state.jobs.some((job) => job.botId === input.botId && job.threadId === input.threadId && job.messageId === input.messageId)) return false;
      if (this.state.jobs.length >= MAX_JOBS) {
        this.state.lastError = "Memory capture is busy; this turn was not remembered.";
        return false;
      }
      this.state.jobs.push({
        id: randomUUID(),
        botId: input.botId,
        threadId: input.threadId,
        messageId: input.messageId,
        text: input.text,
        at: input.at,
        state: "queued",
        attempts: 0,
        ownerGeneration: this.state.ownerGeneration,
        revision: String(this.state.revision),
      });
      this.state.lastError = undefined;
      return true;
    });
  }

  /** Claim the next queued job. A job from before an owner edit is dropped; a
   * job whose only drift is another automatic capture is refreshed to the
   * current public revision so it is not lost. */
  nextJob(): MemoryJob | null {
    return this.commit(() => {
      for (;;) {
        const job = this.state.jobs.find((entry) => entry.state === "queued");
        if (!job) return null;
        if (job.ownerGeneration !== this.state.ownerGeneration) {
          this.state.jobs = this.state.jobs.filter((entry) => entry.id !== job.id);
          continue;
        }
        job.revision = String(this.state.revision);
        job.state = "running";
        job.attempts += 1;
        this.state.running = true;
        return { ...job };
      }
    });
  }

  private finishJob(job: { id: string; botId: string; threadId: string; messageId: string; at: string }): void {
    const record = this.botLedger(job.botId, true)!;
    const sourceId = `${job.botId}|${job.threadId}|${job.messageId}`;
    if (!record.processed.includes(sourceId)) record.processed.push(sourceId);
    this.pruneProcessedRecord(record);
    this.state.lastCaptureAt = job.at;
    this.state.jobs = this.state.jobs.filter((entry) => entry.id !== job.id);
    this.state.running = this.state.jobs.some((entry) => entry.state === "running");
  }

  completeJob(jobId: string): void {
    this.commit(() => {
      const job = this.state.jobs.find((entry) => entry.id === jobId);
      if (job) this.finishJob(job);
    });
  }

  failJob(jobId: string, message: string, options: { retry?: boolean } = {}): void {
    this.commit(() => {
      const job = this.state.jobs.find((entry) => entry.id === jobId);
      this.state.lastError = message.slice(0, 500);
      if (job && options.retry && job.attempts < 2) job.state = "queued";
      else this.state.jobs = this.state.jobs.filter((entry) => entry.id !== jobId);
      this.state.running = this.state.jobs.some((entry) => entry.state === "running");
    });
  }

  cancelBot(botId: string): void {
    this.commit(() => {
      this.state.jobs = this.state.jobs.filter((job) => job.botId !== botId);
      this.state.running = this.state.jobs.some((entry) => entry.state === "running");
    });
  }

  cancelThread(botId: string, threadId: string): void {
    this.commit(() => {
      this.state.jobs = this.state.jobs.filter((job) => !(job.botId === botId && job.threadId === threadId));
      this.state.running = this.state.jobs.some((entry) => entry.state === "running");
    });
  }

  cancelAll(): void {
    this.commit(() => {
      this.state.jobs = [];
      this.state.running = false;
    });
  }

  /** Applies a validated model proposal in ONE commit at the exact revision
   * the job was queued under. Anything else — a user edit, a disable, a
   * clear, a forget — has changed the revision and the proposal is discarded
   * whole. Automatic corrections update provenance and never overwrite an
   * entry the owner edited. */
  applyCapture(job: MemoryJob, changes: readonly MemoryChange[], expectedRevision: string): { applied: number; discarded: boolean; revision: string } {
    return this.commit(() => {
      // cancelBot/cancelThread remove a job without changing the revision; a
      // late analyzer result must not resurrect it.
      if (!this.state.jobs.some((entry) => entry.id === job.id)) {
        return { applied: 0, discarded: true, revision: String(this.state.revision) };
      }
      // An owner edit after the analyzer started (or after queueing, had the
      // generation not been checked) wins.
      if (job.ownerGeneration !== this.state.ownerGeneration) {
        this.finishJob(job);
        return { applied: 0, discarded: true, revision: String(this.state.revision) };
      }
      if (String(this.state.revision) !== expectedRevision || job.revision !== expectedRevision) {
        this.finishJob(job);
        return { applied: 0, discarded: true, revision: String(this.state.revision) };
      }
      const record = this.botLedger(job.botId, true)!;
      const now = new Date().toISOString();
      let applied = 0;
      for (const change of changes) {
        const scope = change.scope;
        if (scope === "shared" && change.kind === "decision") continue;
        const collection = scope === "shared" ? this.state.shared.entries : record.entries;
        const botId = scope === "bot" ? job.botId : undefined;
        if (change.action === "forget") {
          const target = this.findTarget(collection, change);
          if (!target) continue;
          collection.splice(collection.indexOf(target), 1);
          this.addSuppression(scope, botId, target.key, target.text);
          applied += 1;
          continue;
        }
        const text = this.safeText(change.text);
        if (!text) continue;
        const target = this.findTarget(collection, change);
        if (target) {
          // A fact the owner edited outranks the model: leave it untouched.
          if (target.origin === "person") continue;
          if (this.isSuppressed(scope, botId, target.key, target.text) || this.isSuppressed(scope, botId, change.key, text)) continue;
          target.text = text;
          target.kind = change.kind;
          if (change.until) target.until = change.until;
          else delete target.until;
          target.updatedAt = now;
          target.source = {
            botId: job.botId,
            threadId: job.threadId,
            messageId: job.messageId,
            at: job.at,
            quote: change.evidence.slice(0, MAX_TEXT),
          };
          applied += 1;
          continue;
        }
        if (this.isSuppressed(scope, botId, change.key, text)) continue;
        if (this.entryCount() >= MAX_ENTRIES) {
          this.state.lastError = "Memory is full; a proposed fact was not kept.";
          continue;
        }
        collection.push({
          id: randomUUID(),
          scope,
          ...(scope === "bot" ? { botId: job.botId } : {}),
          key: change.key,
          text,
          kind: change.kind,
          createdAt: now,
          updatedAt: now,
          ...(change.until ? { until: change.until } : {}),
          origin: "automatic",
          source: {
            botId: job.botId,
            threadId: job.threadId,
            messageId: job.messageId,
            at: job.at,
            quote: change.evidence.slice(0, MAX_TEXT),
          },
        });
        applied += 1;
      }
      // Automatic changes move the public revision (so a stale UI edit 409s)
      // but never the owner generation.
      if (applied > 0) this.bump();
      this.finishJob(job);
      return { applied, discarded: false, revision: String(this.state.revision) };
    });
  }

  private findTarget(collection: readonly MemoryEntry[], change: MemoryChange): MemoryEntry | undefined {
    if (change.replaces) return collection.find((entry) => entry.id === change.replaces);
    return collection.find((entry) => entry.key === change.key);
  }

  /** Removal of a bot drops its private facts, queue and preferences. Shared
   * facts stay workspace-owned; only their provenance pointer to the removed
   * bot is stripped. */
  removeBot(botId: string): void {
    this.commit(() => {
      delete this.state.bots[botId];
      for (const entry of this.state.shared.entries) {
        if (entry.source?.botId === botId) delete entry.source;
      }
      this.state.jobs = this.state.jobs.filter((job) => job.botId !== botId);
      this.state.running = this.state.jobs.some((entry) => entry.state === "running");
      this.bumpOwner();
    });
  }
}
