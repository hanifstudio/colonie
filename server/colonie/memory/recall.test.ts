import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ColonieMemoryStore } from "./store.ts";
import { recallMemory, tokenize, MAX_RECALL_ENTRIES } from "./recall.ts";
import type { MemoryEntry, MemorySnapshot } from "../../../shared/colonie-memory.ts";

function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: overrides.id ?? "e1",
    scope: overrides.scope ?? "bot",
    botId: "bot-1",
    key: overrides.key ?? "k",
    text: overrides.text ?? "text",
    kind: overrides.kind ?? "fact",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-10-01T00:00:00.000Z",
    origin: "automatic",
    ...overrides,
  };
}

function stub(entries: MemoryEntry[], prefs?: Partial<MemorySnapshot>) {
  const snapshot: MemorySnapshot = {
    revision: "1",
    app: { enabled: true, automatic: true },
    bot: { enabled: true, automatic: true },
    entries,
    ...prefs,
  };
  return { snapshot: () => snapshot } as unknown as ColonieMemoryStore;
}

describe("tokenize", () => {
  it("keeps C++, C#, numeric and signed identity", () => {
    expect(tokenize("Uses C++")).toEqual(["uses", "c++"]);
    expect(tokenize("Uses C")).toEqual(["uses", "c"]);
    expect(tokenize("1.5")).toEqual(["1.5"]);
    expect(tokenize("-10")).toEqual(["-10"]);
  });
});

describe("recallMemory", () => {
  it("returns null when memory is disabled", () => {
    expect(recallMemory(stub([entry({ text: "Lives in Bandung." })], { bot: { enabled: false, automatic: true } }), "bot-1", "where do I live")).toBeNull();
  });

  it("always includes a core preference, even with no word overlap", () => {
    const context = recallMemory(stub([entry({ id: "p", kind: "preference", key: "user.reply-style", text: "The user prefers short replies." })]), "bot-1", "unrelated words entirely");
    expect(context?.entries.map((e) => e.id)).toEqual(["p"]);
  });

  it("does not match on stopwords alone", () => {
    expect(recallMemory(stub([entry({ text: "The project uses the database." })]), "bot-1", "the and of")).toBeNull();
  });

  it("keeps C++ distinct from C and -10 from 10", () => {
    const entries = [entry({ id: "cpp", text: "The team uses C++." }), entry({ id: "budget", text: "The budget is -10." })];
    expect(recallMemory(stub(entries), "bot-1", "C")?.entries ?? []).toEqual([]);
    expect(recallMemory(stub(entries), "bot-1", "C++")?.entries.map((e) => e.id)).toEqual(["cpp"]);
    expect(recallMemory(stub(entries), "bot-1", "10")?.entries ?? []).toEqual([]);
    expect(recallMemory(stub(entries), "bot-1", "-10")?.entries.map((e) => e.id)).toEqual(["budget"]);
  });

  it("ranks more relevant entries first and caps the list", () => {
    const entries: MemoryEntry[] = [];
    for (let index = 0; index < 20; index += 1) {
      entries.push(entry({ id: `e${index}`, key: `k${index}`, text: `Project alpha detail ${index}.`, updatedAt: `2026-10-${String((index % 9) + 1).padStart(2, "0")}T00:00:00.000Z` }));
    }
    entries.push(entry({ id: "strong", text: "Project alpha budget." }));
    const context = recallMemory(stub(entries), "bot-1", "project alpha budget");
    expect(context).not.toBeNull();
    expect(context!.entries.length).toBeLessThanOrEqual(MAX_RECALL_ENTRIES);
    expect(context!.entries[0]!.id).toBe("strong");
    expect(context!.text).toContain("Reference data");
  });
});

describe("recallMemory with a real store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "colonie-recall-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("leaves an expired entry out", () => {
    const store = new ColonieMemoryStore(dir);
    store.saveEntry("bot-1", { scope: "bot", kind: "fact", text: "Only valid yesterday.", until: "2000-01-01" }, store.view("bot-1").revision);
    expect(store.view("bot-1").entries).toHaveLength(0);
    expect(recallMemory(store, "bot-1", "valid yesterday")).toBeNull();
  });
});