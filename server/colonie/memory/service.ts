// The memory service: the only piece that talks to a model. It sits between
// the ACP turn lifecycle and the ledger. noteTurn never calls a model — it
// validates, redacts and queues, so the person's send path is untouched.
// A single bounded analyzer call then drains the durable queue, rechecking
// ownership and policy before it runs and again before it commits.
import type { AcpMemoryContext, CompletedMemoryTurn, MemoryPreferences, MemoryScope, MemoryView } from "../../../shared/colonie-memory.ts";
import { capturePrompt, parseCapture } from "./capture.ts";
import { recallMemory } from "./recall.ts";
import { ColonieMemoryStore, MAX_SOURCE, type MemoryJob } from "./store.ts";
import { redactSecretsInText } from "../../redact.ts";

export interface MemoryBot {
  id: string;
  memoryEnabled?: boolean;
  memoryUpkeep?: boolean;
}

export interface MemoryServiceDeps {
  bot(id: string): MemoryBot | undefined;
  owns(botId: string, threadId: string): boolean;
  analyze(botId: string, prompt: string, signal: AbortSignal): Promise<string>;
  log?(message: string): void;
}

export const ANALYZE_TIMEOUT_MS = 60_000;

function isAbort(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "AbortError" || name === "TimeoutError";
}

export class ColonieMemoryService {
  readonly store: ColonieMemoryStore;
  private readonly deps: MemoryServiceDeps;
  private controller: AbortController | null = null;
  private currentJob: MemoryJob | null = null;
  private draining = false;
  private stopped = false;
  private waiters: Array<() => void> = [];

  constructor(store: ColonieMemoryStore, deps: MemoryServiceDeps) {
    this.store = store;
    this.deps = deps;
  }

  private effectiveCapture(botId: string): boolean {
    const bot = this.deps.bot(botId);
    if (!bot || bot.memoryEnabled === false || bot.memoryUpkeep === false) return false;
    const snapshot = this.store.snapshot(botId);
    return snapshot.app.enabled && snapshot.app.automatic && snapshot.bot.enabled && snapshot.bot.automatic;
  }

  private effectiveRecall(botId: string): boolean {
    const bot = this.deps.bot(botId);
    if (!bot || bot.memoryEnabled === false) return false;
    const snapshot = this.store.snapshot(botId);
    return snapshot.app.enabled && snapshot.bot.enabled;
  }

  /** Queue one completed owner turn. No model call on this path: the drain is
   * deferred to a microtask, so nothing model-shaped starts in the send call. */
  noteTurn(input: CompletedMemoryTurn): void {
    if (this.stopped) return;
    if (!this.deps.owns(input.botId, input.threadId)) return;
    if (!this.effectiveCapture(input.botId)) return;
    const text = scrub(input.text);
    if (!text) return;
    if (!this.store.enqueue({ ...input, text })) return;
    this.schedule();
  }

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => void this.drain());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    await this.idle();
  }

  idle(): Promise<void> {
    if (!this.draining) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  cancelBot(botId: string): void {
    if (this.currentJob?.botId === botId) this.controller?.abort();
    this.store.cancelBot(botId);
  }

  cancelThread(botId: string, threadId: string): void {
    if (this.currentJob?.botId === botId && this.currentJob.threadId === threadId) this.controller?.abort();
    this.store.cancelThread(botId, threadId);
  }

  cancelAll(): void {
    if (this.currentJob) this.controller?.abort();
    this.store.cancelAll();
  }

  view(botId: string): MemoryView {
    const view = this.store.view(botId);
    // A saved base off (bot.memoryEnabled === false) shows as off even after
    // this ledger has entries; turning it back on is an explicit preference.
    if (this.deps.bot(botId)?.memoryEnabled === false) view.bot = { ...view.bot, enabled: false };
    if (this.deps.bot(botId)?.memoryUpkeep === false) view.bot = { ...view.bot, automatic: false };
    return view;
  }

  recall(botId: string, userText: string): AcpMemoryContext | null {
    if (!this.effectiveRecall(botId)) return null;
    return recallMemory(this.store, botId, userText);
  }

  updatePreferences(botId: string, scope: MemoryScope, preferences: MemoryPreferences, expectedRevision: string): void {
    this.store.updatePreferences(botId, scope, preferences, expectedRevision);
    if (scope === "shared") {
      if (!preferences.enabled || !preferences.automatic) this.cancelAll();
    } else if (!preferences.enabled || !preferences.automatic) {
      this.cancelBot(botId);
    }
  }

  saveEntry(botId: string, input: { scope: MemoryScope; text: string; kind: "preference" | "fact" | "decision"; key?: string; until?: string; id?: string }, expectedRevision: string): void {
    this.store.saveEntry(botId, input, expectedRevision);
  }

  forgetEntry(botId: string, id: string, expectedRevision: string): void {
    // An explicit forget inside a running proposal's window must win: the
    // suppression is recorded, and the proposal's revision no longer matches.
    this.store.forgetEntry(botId, id, expectedRevision);
  }

  clear(botId: string, scope: MemoryScope, expectedRevision: string): void {
    this.store.clear(botId, scope, expectedRevision);
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped) {
        const job = this.store.nextJob();
        if (!job) break;
        if (!this.effectiveCapture(job.botId) || !this.deps.owns(job.botId, job.threadId)) {
          this.store.completeJob(job.id);
          continue;
        }
        await this.runJob(job);
      }
    } catch (error) {
      // A ledger write failure must not become an unhandled rejection; queued
      // jobs stay durable and are retried on the next drain.
      this.deps.log?.(`Memory capture drain error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.draining = false;
      this.currentJob = null;
      const waiters = this.waiters;
      this.waiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private async runJob(job: MemoryJob): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.currentJob = job;
    const timer = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);
    let abort!: () => void;
    try {
      const snapshot = this.store.snapshot(job.botId);
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(Object.assign(new Error("Memory capture was cancelled or timed out."), { name: "AbortError" }));
        controller.signal.addEventListener("abort", abort, { once: true });
      });
      const answer = await Promise.race([this.deps.analyze(job.botId, capturePrompt(job, snapshot), controller.signal), cancelled]);
      if (this.stopped) {
        this.store.failJob(job.id, "Memory capture stopped; this turn will be retried.", { retry: true });
        return;
      }
      // Ownership and policy are rechecked after the await: a Stop, delete,
      // disable or clear that happened mid-call wins.
      if (!this.effectiveCapture(job.botId) || !this.deps.owns(job.botId, job.threadId)) {
        this.store.failJob(job.id, "Memory capture was cancelled.", {});
        return;
      }
      const changes = parseCapture(answer, job, snapshot);
      this.store.applyCapture(job, changes, job.revision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.failJob(job.id, message, { retry: isAbort(error) });
      this.deps.log?.(`Memory capture failed for ${job.botId}: ${message}`);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      this.controller = null;
      this.currentJob = null;
    }
  }
}

/** Redact, bound, and keep the turn's own whitespace so evidence stays a
 * verbatim substring; an overlong or all-redacted turn is skipped whole. */
function scrub(value: string): string {
  const text = redactSecretsInText(value).trim();
  if (!text || text.length > MAX_SOURCE) return "";
  if (/^«redacted \d+ chars»$/.test(text) || text.includes("«redacted")) return "";
  return text;
}
