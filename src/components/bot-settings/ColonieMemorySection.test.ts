import { describe, expect, it } from "vitest";
import { initialMemorySectionState, memorySectionReducer, sourceLabel, splitEntries } from "./ColonieMemorySection";
import type { MemoryEntry, MemoryView } from "../../../shared/colonie-memory";

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "e1",
    scope: "bot",
    botId: "bot-1",
    key: "k",
    text: "Runs on Node.",
    kind: "fact",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    origin: "automatic",
    ...overrides,
  };
}

function view(overrides: Partial<MemoryView> = {}): MemoryView {
  return {
    revision: "1",
    app: { enabled: true, automatic: true },
    bot: { enabled: true, automatic: true },
    entries: [],
    status: { pending: 0, running: false },
    ...overrides,
  };
}

describe("memorySectionReducer", () => {
  it("ignores a stale response so another bot's list can never appear", () => {
    const first = memorySectionReducer(initialMemorySectionState, { type: "loaded", view: view({ revision: "1" }), seq: 1, current: 1 });
    const stale = memorySectionReducer(first, { type: "loaded", view: view({ revision: "2", entries: [entry()] }), seq: 1, current: 2 });
    expect(stale).toBe(first);
    expect(stale.view?.revision).toBe("1");
  });

  it("applies the current response and clears a previous error", () => {
    const errored = memorySectionReducer(initialMemorySectionState, { type: "failed", error: "boom", seq: 1, current: 1 });
    expect(errored.error).toBe("boom");
    const loaded = memorySectionReducer(errored, { type: "loaded", view: view({ revision: "3" }), seq: 2, current: 2 });
    expect(loaded.error).toBeNull();
    expect(loaded.view?.revision).toBe("3");
  });

  it("keeps the view visible when a save conflicts", () => {
    const loaded = memorySectionReducer(initialMemorySectionState, { type: "loaded", view: view({ revision: "1", entries: [entry()] }), seq: 1, current: 1 });
    const conflicted = memorySectionReducer(loaded, { type: "conflict" });
    expect(conflicted.conflict).toBe(true);
    expect(conflicted.view?.entries).toHaveLength(1);
  });
});

describe("splitEntries and sourceLabel", () => {
  it("separates shared from bot-scoped entries", () => {
    const split = splitEntries([entry({ id: "s", scope: "shared", botId: undefined }), entry({ id: "b", scope: "bot" })]);
    expect(split.shared.map((e) => e.id)).toEqual(["s"]);
    expect(split.bot.map((e) => e.id)).toEqual(["b"]);
  });

  it("names provenance by date, never by message id or hash", () => {
    expect(sourceLabel(entry())).toBe("Remembered automatically");
    const label = sourceLabel(entry({ source: { botId: "bot-1", threadId: "thread-secret", messageId: "msg-secret", at: "2026-10-11T00:00:00.000Z", quote: "x" } }));
    expect(label).toContain("from a conversation on");
    expect(label).not.toContain("thread-secret");
    expect(label).not.toContain("msg-secret");
    expect(sourceLabel(entry({ origin: "person" }))).toBe("Added by you");
  });
});