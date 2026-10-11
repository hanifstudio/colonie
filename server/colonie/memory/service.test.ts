import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ColonieMemoryStore } from "./store.ts";
import { ColonieMemoryService, type MemoryBot, type MemoryServiceDeps } from "./service.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "colonie-service-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function capture(answer: object[]): string {
  return JSON.stringify(answer);
}

function make(analyze: MemoryServiceDeps["analyze"], bots: Record<string, MemoryBot> = { "bot-1": { id: "bot-1", memoryEnabled: true } }) {
  const store = new ColonieMemoryStore(dir);
  const service = new ColonieMemoryService(store, {
    bot: (id) => bots[id],
    owns: () => true,
    analyze,
  });
  return { store, service };
}

describe("ColonieMemoryService", () => {
  it("queues a completed turn off the send path and captures after analysis", async () => {
    const analyze = vi.fn(async () =>
      capture([{ action: "upsert", scope: "shared", kind: "preference", key: "user.reply-style", text: "The user prefers short replies.", evidence: "prefer short replies", confidence: 0.9 }]),
    );
    const { store, service } = make(analyze);
    service.noteTurn({ botId: "bot-1", threadId: "t1", messageId: "m1", text: "Hi, I prefer short replies.", at: "2026-10-11T00:00:00.000Z" });
    expect(analyze).not.toHaveBeenCalled();
    await service.idle();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(store.view("bot-1").entries.map((entry) => entry.key)).toEqual(["user.reply-style"]);
    expect(service.recall("bot-1", "unrelated words")?.text).toContain("prefers short replies");
  });

  it("corrects an existing fact immediately, without any threshold", async () => {
    let answer = capture([{ action: "upsert", scope: "bot", kind: "fact", key: "project.stack", text: "The project uses TypeScript.", evidence: "we use TypeScript", confidence: 0.9 }]);
    const analyze = vi.fn(async () => answer);
    const { store, service } = make(analyze);
    service.noteTurn({ botId: "bot-1", threadId: "t1", messageId: "m1", text: "we use TypeScript", at: "2026-10-11T00:00:00.000Z" });
    await service.idle();
    const created = store.view("bot-1").entries[0]!;
    answer = capture([{ action: "upsert", scope: "bot", kind: "fact", key: "project.stack", text: "The project uses TypeScript and Vite.", evidence: "we use TypeScript", confidence: 0.9, replaces: created.id }]);
    service.noteTurn({ botId: "bot-1", threadId: "t1", messageId: "m2", text: "we use TypeScript", at: "2026-10-12T00:00:00.000Z" });
    await service.idle();
    expect(store.view("bot-1").entries).toHaveLength(1);
    expect(store.view("bot-1").entries[0]!.text).toContain("Vite");
  });

  it("does nothing when memory is disabled for the bot", async () => {
    const analyze = vi.fn(async () => "[]");
    const { service } = make(analyze, { "bot-1": { id: "bot-1", memoryEnabled: false } });
    service.noteTurn({ botId: "bot-1", threadId: "t1", messageId: "m1", text: "remember this", at: "2026-10-11T00:00:00.000Z" });
    await service.idle();
    expect(analyze).not.toHaveBeenCalled();
  });

  it("leaves an interrupted capture recoverable after stop", async () => {
    const analyze = vi.fn((_bot: string, _prompt: string, signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    );
    const { store, service } = make(analyze);
    service.noteTurn({ botId: "bot-1", threadId: "t1", messageId: "m1", text: "long turn", at: "2026-10-11T00:00:00.000Z" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.stop();
    expect(store.view("bot-1").status.pending).toBe(1);
  });

  it("honors a saved automatic-memory off choice while still allowing recall", async () => {
    const analyze = vi.fn(async () => "[]");
    const { store, service } = make(analyze, { "bot-1": { id: "bot-1", memoryUpkeep: false } });
    store.saveEntry("bot-1", { scope: "bot", kind: "preference", text: "Prefers short replies." }, store.view("bot-1").revision);
    service.noteTurn({ botId: "bot-1", threadId: "t1", messageId: "m1", text: "I prefer long replies", at: new Date().toISOString() });
    await service.idle();
    expect(analyze).not.toHaveBeenCalled();
    expect(service.view("bot-1").bot.automatic).toBe(false);
    expect(service.recall("bot-1", "hello")?.text).toContain("short replies");
  });

  it("cancelThread settles an analyzer that ignores abort and prevents its late result from resurrecting memory", async () => {
    let resolve!: (value: string) => void;
    const analyze = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const { store, service } = make(analyze);
    service.noteTurn({ botId: "bot-1", threadId: "t1", messageId: "m1", text: "we use TypeScript", at: new Date().toISOString() });
    await new Promise((done) => setTimeout(done, 0));
    service.cancelThread("bot-1", "t1");
    await service.idle();
    resolve(capture([{ action: "upsert", scope: "bot", kind: "fact", key: "project.stack", text: "Uses TypeScript.", evidence: "we use TypeScript", confidence: 1 }]));
    await new Promise((done) => setTimeout(done, 0));
    expect(store.view("bot-1").entries).toEqual([]);
  });

  it("recovers an interrupted durable job in a new service without double-applying its source", async () => {
    const { store } = make(async () => "[]");
    const source = { botId: "bot-1", threadId: "t1", messageId: "m1", text: "I prefer short replies", at: new Date().toISOString() };
    store.enqueue(source); store.nextJob();
    const restored = new ColonieMemoryStore(dir);
    const analyze = vi.fn(async () => capture([{ action: "upsert", scope: "shared", kind: "preference", key: "user.reply-style",
      text: "The user prefers short replies.", evidence: "I prefer short replies", confidence: 1 }]));
    const restarted = new ColonieMemoryService(restored, { bot: (id) => ({ id }), owns: () => true, analyze });
    restarted.start(); await restarted.idle();
    expect(restored.view("bot-1").entries).toHaveLength(1);
    restarted.noteTurn(source); await restarted.idle();
    expect(analyze).toHaveBeenCalledTimes(1);
    await restarted.stop();
  });
});
