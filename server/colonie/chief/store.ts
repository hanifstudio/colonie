// The durable Chief ledger: one atomically-written JSON document holding the
// delegated assignments and the idempotency operation records. A single
// document means a claimed operation and its assignment commit together, so a
// crash can never leave a mutation claimed but unrecorded, or an assignment
// pointing at an operation that was never written.
//
// Every mutation is one synchronous commit: clone, apply, write the whole
// document; if the write throws the clone is restored, so memory and disk
// never disagree. On load, an operation still "claimed" and an assignment
// still queued/running/waiting become interrupted — the app shows the
// uncertain work instead of replaying it automatically.
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../persistence/atomic.ts";
import type { ChiefAssignment, ChiefAssignmentStatus } from "../../../shared/colonie-chief.ts";

export const MAX_RECORDS = 1000;
export const MAX_MESSAGE = 8000;
export const MAX_CONTEXT = 8000;
export const MAX_RESULT = 8000;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;

export interface OperationClaim {
  key: string;
  botId: string;
  threadId: string;
  requestId: string;
  tool: string;
  argsHash: string;
}

export type ClaimResult =
  | { kind: "claimed" }
  | { kind: "replay"; status: "completed" | "failed" | "interrupted"; result?: string; error?: string }
  | { kind: "mismatch" };

const ASSIGNMENT_STATUS = z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled", "interrupted"]);
const assignmentSchema = z
  .object({
    id: z.string().min(1).max(128),
    chiefBotId: z.string().min(1).max(128),
    sourceThreadId: z.string().min(1).max(256),
    sourceTurnId: z.string().max(256),
    targetBotId: z.string().min(1).max(128),
    targetThreadId: z.string().min(1).max(256).optional(),
    message: z.string().min(1).max(MAX_MESSAGE),
    context: z.string().max(MAX_CONTEXT).optional(),
    status: ASSIGNMENT_STATUS,
    createdAt: z.string().min(1).max(64),
    updatedAt: z.string().min(1).max(64),
    result: z.string().max(MAX_RESULT).optional(),
    error: z.string().max(MAX_RESULT).optional(),
  })
  .strict();

const operationSchema = z
  .object({
    key: z.string().min(1).max(512),
    botId: z.string().min(1).max(128),
    threadId: z.string().min(1).max(256),
    requestId: z.string().min(1).max(128),
    tool: z.string().min(1).max(64),
    argsHash: z.string().min(1).max(128),
    status: z.enum(["claimed", "completed", "failed", "interrupted"]),
    result: z.string().max(MAX_RESULT).optional(),
    error: z.string().max(MAX_RESULT).optional(),
    createdAt: z.string().min(1).max(64),
    updatedAt: z.string().min(1).max(64),
  })
  .strict();

const ledgerSchema = z
  .object({ version: z.literal(1), assignments: z.array(assignmentSchema).max(MAX_RECORDS), operations: z.array(operationSchema).max(MAX_RECORDS) })
  .strict();

type Ledger = z.infer<typeof ledgerSchema>;
type Operation = Ledger["operations"][number];

function emptyLedger(): Ledger {
  return { version: 1, assignments: [], operations: [] };
}

function storeError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** "settled" means the operation will never change again: only these are
 * pruned. A claimed operation is pending ownership and is never dropped. */
function settledOperation(status: Operation["status"]): boolean {
  return status !== "claimed";
}

function settledAssignment(status: ChiefAssignmentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

export class ColonieChiefStore {
  private readonly dir: string;
  private readonly file: string;
  private state: Ledger;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "colonie-chief");
    this.file = join(this.dir, "ledger.json");
    this.ensureSafeDir();
    this.state = this.load();
  }

  private ensureSafeDir(): void {
    try {
      const stat = lstatSync(this.dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw storeError("The Chief directory is not a real directory; refusing to use it.", 500);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private load(): Ledger {
    let raw: string;
    try {
      const stat = lstatSync(this.file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw storeError("The Chief store is not a regular file; refusing to overwrite it.", 500);
      if (stat.size > MAX_LEDGER_BYTES) throw storeError("The Chief store exceeds its storage limit.", 500);
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw storeError("The Chief store is unreadable; refusing to overwrite it.", 500);
    }
    const result = ledgerSchema.safeParse(parsed);
    if (!result.success) throw storeError("The Chief store is unreadable; refusing to overwrite it.", 500);
    const ledger = result.data as Ledger;
    // Uncertain work from a previous run is shown, never replayed.
    for (const operation of ledger.operations) if (operation.status === "claimed") operation.status = "interrupted";
    for (const assignment of ledger.assignments) if (!settledAssignment(assignment.status)) assignment.status = "interrupted";
    return ledger;
  }

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
    if (Buffer.byteLength(text, "utf8") > MAX_LEDGER_BYTES) throw storeError("Chief storage is full. Remove old work before continuing.", 409);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, text, { mode: 0o600 });
  }

  /** Only settled rows are dropped; an idempotent key stays valid while claimed. */
  private prune(): void {
    if (this.state.operations.length > MAX_RECORDS) {
      const pending = this.state.operations.filter((operation) => !settledOperation(operation.status));
      const settled = this.state.operations.filter((operation) => settledOperation(operation.status)).slice(-(MAX_RECORDS - pending.length));
      this.state.operations = [...pending, ...settled];
    }
    if (this.state.assignments.length > MAX_RECORDS) {
      const pending = this.state.assignments.filter((assignment) => !settledAssignment(assignment.status));
      const settled = this.state.assignments.filter((assignment) => settledAssignment(assignment.status)).slice(-(MAX_RECORDS - pending.length));
      this.state.assignments = [...pending, ...settled];
    }
  }

  assignments(sourceThreadId?: string): ChiefAssignment[] {
    const rows = sourceThreadId ? this.state.assignments.filter((assignment) => assignment.sourceThreadId === sourceThreadId) : this.state.assignments;
    return structuredClone(rows);
  }

  assignment(id: string): ChiefAssignment | undefined {
    const row = this.state.assignments.find((assignment) => assignment.id === id);
    return row ? structuredClone(row) : undefined;
  }

  byTargetThread(threadId: string): ChiefAssignment | undefined {
    const row = this.state.assignments.find((assignment) => assignment.targetThreadId === threadId);
    return row ? structuredClone(row) : undefined;
  }

  createAssignment(job: ChiefAssignment): ChiefAssignment {
    return this.commit(() => {
      const parsed = assignmentSchema.parse(job);
      this.state.assignments.push(parsed);
      this.state.assignments = this.state.assignments.slice(-MAX_RECORDS * 2);
      this.prune();
      return structuredClone(parsed);
    });
  }

  updateAssignment(id: string, patch: Partial<Pick<ChiefAssignment, "status" | "result" | "error" | "targetThreadId">>): ChiefAssignment | undefined {
    return this.commit(() => {
      const index = this.state.assignments.findIndex((assignment) => assignment.id === id);
      if (index === -1) return undefined;
      const current = this.state.assignments[index]!;
      const next = assignmentSchema.parse({ ...current, ...patch, updatedAt: new Date().toISOString() });
      this.state.assignments[index] = next;
      return structuredClone(next);
    });
  }

  setStatusByTargetThread(threadId: string, status: ChiefAssignmentStatus): ChiefAssignment | undefined {
    return this.commit(() => {
      const index = this.state.assignments.findIndex((assignment) => assignment.targetThreadId === threadId);
      if (index === -1) return undefined;
      const next = assignmentSchema.parse({ ...this.state.assignments[index]!, status, updatedAt: new Date().toISOString() });
      this.state.assignments[index] = next;
      return structuredClone(next);
    });
  }

  /** Claim the durable idempotency key before any mutation is attempted. */
  claim(claim: OperationClaim): ClaimResult {
    return this.commit(() => {
      const existing = this.state.operations.find((operation) => operation.key === claim.key);
      if (existing) {
        if (existing.tool !== claim.tool || existing.argsHash !== claim.argsHash) return { kind: "mismatch" } as const;
        return {
          kind: "replay",
          status: existing.status === "claimed" ? "interrupted" : existing.status,
          ...(existing.result !== undefined ? { result: existing.result } : {}),
          ...(existing.error !== undefined ? { error: existing.error } : {}),
        } as const;
      }
      const now = new Date().toISOString();
      this.state.operations.push(operationSchema.parse({ ...claim, status: "claimed", createdAt: now, updatedAt: now }));
      this.prune();
      return { kind: "claimed" } as const;
    });
  }

  settleOperation(key: string, status: "completed" | "failed", value: { result?: string; error?: string }): void {
    this.commit(() => {
      const index = this.state.operations.findIndex((operation) => operation.key === key);
      if (index === -1) return;
      this.state.operations[index] = operationSchema.parse({
        ...this.state.operations[index]!,
        status,
        ...(value.result !== undefined ? { result: value.result } : {}),
        ...(value.error !== undefined ? { error: value.error } : {}),
        updatedAt: new Date().toISOString(),
      });
    });
  }

  newAssignmentId(): string {
    return randomUUID();
  }
}