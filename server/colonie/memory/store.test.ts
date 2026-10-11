import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ColonieMemoryStore, MAX_TEXT } from "./store.ts";
import type { MemoryChange } from "../../../shared/colonie-memory.ts";

let dir: string;
const stores: ColonieMemoryStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "colonie-memory-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  stores.length = 0;
});
function make(): ColonieMemoryStore {
  const store = new ColonieMemoryStore(dir);
  stores.push(store);
  return store;
}

function upsert(overrides: Partial<MemoryChange> = {}): MemoryChange {
  return {
    action: "upsert",
    scope: "bot",
    kind: "fact",
    key: "project.stack",
    text: "The project uses TypeScript.",
    evidence: "we use TypeScript",
    confidence: 0.9,
    ...overrides,
  };
}

describe("ColonieMemoryStore", () => {
  it("returns cloned entries from view and snapshot", () => {
    const store = make();
    store.saveEntry("bot-1", { scope: "bot", kind: "fact", text: "Runs on Node." }, store.view("bot-1").revision);
    const view = store.view("bot-1");
    view.entries[0]!.text = "mutated";
    expect(store.view("bot-1").entries[0]!.text).toBe("Runs on Node.");
    const snap = store.snapshot("bot-1");
    snap.entries[0]!.key = "mutated";
    expect(store.snapshot("bot-1").entries[0]!.key).not.toBe("mutated");
  });

  it("rolls back the in-memory ledger when persistence throws", () => {
    const store = make();
    const before = store.view("bot-1");
    // Plant a directory where the ledger file goes: the atomic rename fails.
    mkdirSync(join(dir, "colonie-memory", "state.json"), { recursive: true });
    expect(() => store.saveEntry("bot-1", { scope: "bot", kind: "fact", text: "Should not stick." }, before.revision)).toThrow();
    const after = store.view("bot-1");
    expect(after.entries).toHaveLength(0);
    expect(after.revision).toBe(before.revision);
  });

  it("rejects overlong text and secret-shaped text instead of slicing", () => {
    const store = make();
    const rev = store.view("bot-1").revision;
    expect(() => store.saveEntry("bot-1", { scope: "bot", kind: "fact", text: "x".repeat(MAX_TEXT + 1) }, rev)).toThrow(/limited/);
    expect(() => store.saveEntry("bot-1", { scope: "bot", kind: "fact", text: `token ghp_${"a".repeat(30)}` }, rev)).toThrow(/secret/);
  });

  it("refuses a symlinked memory directory", () => {
    const target = mkdtempSync(join(tmpdir(), "colonie-target-"));
    symlinkSync(target, join(dir, "colonie-memory"));
    try {
      expect(() => new ColonieMemoryStore(dir)).toThrow(/real directory/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("refuses a corrupt ledger instead of overwriting it", () => {
    mkdirSync(join(dir, "colonie-memory"), { recursive: true });
    writeFileSync(join(dir, "colonie-memory", "state.json"), "{ not json");
    expect(() => new ColonieMemoryStore(dir)).toThrow(/unreadable/);
  });

  it("blocks a forgotten key from being re-added with paraphrased text", () => {
    const store = make();
    const rev = store.view("bot-1").revision;
    store.saveEntry("bot-1", { scope: "bot", kind: "fact", key: "user.location", text: "Lives in Bandung." }, rev);
    const entry = store.view("bot-1").entries[0]!;
    store.forgetEntry("bot-1", entry.id, store.view("bot-1").revision);
    // Same key, different wording: still suppressed.
    store.enqueue({ botId: "bot-1", threadId: "t1", messageId: "m1", text: "I live in Bandung", at: "2026-10-11T00:00:00.000Z" });
    const job = store.nextJob()!;
    const result = store.applyCapture(job, [upsert({ key: "user.location", text: "The user resides in Bandung." })], job.revision);
    expect(result.applied).toBe(0);
    expect(store.view("bot-1").entries).toHaveLength(0);
  });

  it("does not let an automatic correction overwrite an owner-edited fact, but updates provenance otherwise", () => {
    const store = make();
    store.enqueue({ botId: "bot-1", threadId: "t1", messageId: "m1", text: "we use TypeScript", at: "2026-10-11T00:00:00.000Z" });
    const job = store.nextJob()!;
    store.applyCapture(job, [upsert()], job.revision);
    const created = store.view("bot-1").entries[0]!;
    expect(created.origin).toBe("automatic");
    expect(created.source?.messageId).toBe("m1");

    // Automatic correction updates text and provenance.
    store.enqueue({ botId: "bot-1", threadId: "t1", messageId: "m2", text: "we use TypeScript and Vite", at: "2026-10-12T00:00:00.000Z" });
    const job2 = store.nextJob()!;
    store.applyCapture(job2, [upsert({ replaces: created.id, key: created.key, text: "The project uses TypeScript and Vite.", evidence: "we use Typescript" })], job2.revision);
    const corrected = store.view("bot-1").entries[0]!;
    expect(corrected.text).toContain("Vite");
    expect(corrected.source?.messageId).toBe("m2");

    // Owner edits it; a later capture must not overwrite it.
    store.saveEntry("bot-1", { scope: "bot", kind: "fact", id: corrected.id, text: "The project uses TypeScript (owner note)." }, store.view("bot-1").revision);
    const owned = store.view("bot-1").entries[0]!;
    expect(owned.origin).toBe("person");
    store.enqueue({ botId: "bot-1", threadId: "t1", messageId: "m3", text: "we use Rust", at: "2026-10-13T00:00:00.000Z" });
    const job3 = store.nextJob()!;
    store.applyCapture(job3, [upsert({ replaces: owned.id, key: owned.key, text: "The project uses Rust." })], job3.revision);
    expect(store.view("bot-1").entries[0]!.text).toContain("owner note");
  });

  it("discards a job queued before an owner edit at claim time", () => {
    const store = make();
    const rev = store.view("bot-1").revision;
    store.enqueue({ botId: "bot-1", threadId: "t1", messageId: "m1", text: "hello", at: "2026-10-11T00:00:00.000Z" });
    store.saveEntry("bot-1", { scope: "bot", kind: "fact", text: "Edit first." }, rev);
    expect(store.nextJob()).toBeNull();
    expect(store.view("bot-1").status.pending).toBe(0);
    expect(store.view("bot-1").entries).toHaveLength(1);
  });

  it("keeps sibling captures valid because captures do not move owner generation", () => {
    const store = make();
    store.enqueue({ botId: "bot-1", threadId: "t1", messageId: "m1", text: "one", at: "2026-10-11T00:00:00.000Z" });
    store.enqueue({ botId: "bot-1", threadId: "t2", messageId: "m2", text: "two", at: "2026-10-11T00:00:00.000Z" });
    const first = store.nextJob()!;
    store.applyCapture(first, [upsert({ key: "a", text: "First fact." })], first.revision);
    expect(store.nextJob()).not.toBeNull();
  });

  it("will not resurrect a job removed by cancelBot", () => {
    const store = make();
    store.enqueue({ botId: "bot-1", threadId: "t1", messageId: "m1", text: "hello", at: "2026-10-11T00:00:00.000Z" });
    const job = store.nextJob()!;
    store.cancelBot("bot-1");
    const result = store.applyCapture(job, [upsert()], job.revision);
    expect(result.discarded).toBe(true);
    expect(store.view("bot-1").entries).toHaveLength(0);
  });

  it("cancelThread drops only that thread's queued job", () => {
    const store = make();
    store.enqueue({ botId: "bot-1", threadId: "t1", messageId: "m1", text: "one", at: "2026-10-11T00:00:00.000Z" });
    store.enqueue({ botId: "bot-1", threadId: "t2", messageId: "m2", text: "two", at: "2026-10-11T00:00:00.000Z" });
    store.cancelThread("bot-1", "t1");
    expect(store.nextJob()!.threadId).toBe("t2");
  });

  it("lists entries while memory is disabled and gates nothing in the view", () => {
    const store = make();
    const view = store.view("bot-1");
    store.saveEntry("bot-1", { scope: "bot", kind: "fact", text: "Kept while off." }, view.revision);
    store.updatePreferences("bot-1", "bot", { enabled: false, automatic: false }, store.view("bot-1").revision);
    expect(store.view("bot-1").bot.enabled).toBe(false);
    expect(store.view("bot-1").entries).toHaveLength(1);
  });
});