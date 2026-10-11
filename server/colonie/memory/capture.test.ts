import { describe, expect, it } from "vitest";
import { capturePrompt, parseCapture } from "./capture.ts";
import type { MemoryEntry, MemorySnapshot } from "../../../shared/colonie-memory.ts";
import type { MemoryJob } from "./store.ts";

function job(text: string, at = "2026-10-11T00:00:00.000Z"): MemoryJob {
  return { id: "j1", botId: "bot-1", threadId: "t1", messageId: "m1", text, at, state: "queued", attempts: 0, ownerGeneration: 0, revision: "1" };
}

function snapshot(entries: MemoryEntry[] = []): MemorySnapshot {
  return { revision: "1", app: { enabled: true, automatic: true }, bot: { enabled: true, automatic: true }, entries };
}

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "e1",
    scope: "bot",
    botId: "bot-1",
    key: "project.stack",
    text: "The project uses TypeScript.",
    kind: "fact",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    origin: "automatic",
    ...overrides,
  };
}

describe("capturePrompt", () => {
  it("marks the version and embeds source and current entries as JSON", () => {
    const prompt = capturePrompt(job("I prefer short replies."), snapshot([entry()]));
    expect(prompt).toContain("COLONIE_MEMORY_CAPTURE_V1");
    expect(prompt).toContain("I prefer short replies.");
    expect(prompt).toContain("project.stack");
  });
});

describe("parseCapture", () => {
  it("accepts an upsert whose evidence is verbatim and confidence is high", () => {
    const changes = parseCapture(
      '[{"action":"upsert","scope":"shared","kind":"preference","key":"user.reply-style","text":"The user prefers short replies.","evidence":"I prefer short replies","confidence":0.9}]',
      job("Hello, I prefer short replies please."),
      snapshot(),
    );
    expect(changes).toEqual([
      { action: "upsert", scope: "shared", kind: "preference", key: "user.reply-style", text: "The user prefers short replies.", evidence: "I prefer short replies", confidence: 0.9 },
    ]);
  });

  it("drops fabricated evidence, low confidence, past dates and shared decisions", () => {
    const answer = JSON.stringify([
      { action: "upsert", scope: "bot", kind: "fact", text: "A.", evidence: "not in source", confidence: 0.9 },
      { action: "upsert", scope: "bot", kind: "fact", text: "B.", evidence: "hello", confidence: 0.5 },
      { action: "upsert", scope: "bot", kind: "fact", text: "C.", evidence: "hello", confidence: 0.9, until: "2000-01-01" },
      { action: "upsert", scope: "shared", kind: "decision", text: "D.", evidence: "hello", confidence: 0.9 },
    ]);
    expect(parseCapture(answer, job("hello there"), snapshot())).toEqual([]);
  });

  it("keeps a valid future until date", () => {
    const answer = JSON.stringify([{ action: "upsert", scope: "bot", kind: "fact", key: "trip.next", text: "Trip next week.", evidence: "hello", confidence: 0.9, until: "2026-10-20" }]);
    const changes = parseCapture(answer, job("hello"), snapshot());
    expect(changes[0]?.until).toBe("2026-10-20");
  });

  it("infers forget metadata from the target entry alone", () => {
    const target = entry({ key: "user.location", text: "Lives in Bandung." });
    const answer = JSON.stringify([{ action: "forget", replaces: "e1", evidence: "I moved", confidence: 0.9 }]);
    const changes = parseCapture(answer, job("I moved away last month."), snapshot([target]));
    expect(changes).toEqual([
      { action: "forget", scope: "bot", kind: "fact", key: "user.location", text: "Lives in Bandung.", evidence: "I moved", confidence: 0.9, replaces: "e1" },
    ]);
  });

  it("rejects an unknown replaces id, redacted text, and overlong text", () => {
    const unknown = JSON.stringify([{ action: "upsert", scope: "bot", kind: "fact", key: "x", text: "X.", evidence: "hello", confidence: 0.9, replaces: "missing" }]);
    expect(parseCapture(unknown, job("hello"), snapshot())).toEqual([]);
    const redacted = JSON.stringify([{ action: "upsert", scope: "bot", kind: "fact", key: "x", text: "token «redacted 12 chars»", evidence: "hello", confidence: 0.9 }]);
    expect(parseCapture(redacted, job("hello"), snapshot())).toEqual([]);
    const long = JSON.stringify([{ action: "upsert", scope: "bot", kind: "fact", key: "x", text: "y".repeat(1001), evidence: "hello", confidence: 0.9 }]);
    expect(parseCapture(long, job("hello"), snapshot())).toEqual([]);
  });

  it("refuses to turn a private correction into shared memory and surfaces malformed answers", () => {
    const proposal = JSON.stringify([{ action: "upsert", scope: "shared", kind: "fact", key: "project.stack", text: "Uses Rust.", evidence: "we use Rust", confidence: 1, replaces: "e1" }]);
    expect(parseCapture(proposal, job("we use Rust"), snapshot([entry()]))).toEqual([]);
    expect(() => parseCapture("not JSON", job("hello"), snapshot())).toThrow(/invalid response/);
  });
});
