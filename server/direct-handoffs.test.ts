import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DirectHandoffs } from "./direct-handoffs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

/** Runs a test against a temp storage file the test writes first. */
async function fixture(test: (file: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "direct-handoff-unit-"));
  try { await test(join(dir, "room-handoffs.json")); }
  finally { await removeTempDir(dir); }
}
const at = 1_700_000_000_000;
const base = { key: "k", text: "Build it", createdAt: at, result: "", executions: 0, approvalGranted: false, kind: "work" };

describe("stored direct handoff history", () => {
  it("settles an interrupted direct tree on load without reporting or resuming it later", () => fixture(file => {
    writeFileSync(file, JSON.stringify([
      { ...base, id: "root", rootId: "root", threadId: "chief-chat", botId: "chief", status: "waiting", reported: true },
      { ...base, id: "done", rootId: "root", parentId: "root", threadId: "builder-chat", botId: "builder", status: "completed", result: "Built", reported: false },
      { ...base, id: "busy", rootId: "root", parentId: "root", threadId: "reviewer-chat", botId: "reviewer", status: "running", reported: false },
      { ...base, id: "later", rootId: "root", parentId: "root", threadId: "tester-chat", botId: "tester", status: "queued" },
    ]));
    const history = new DirectHandoffs(file);
    expect(history.nodes.get("root")).toMatchObject({ status: "failed", result: "Interrupted by server restart; not replayed.", reported: true });
    expect(history.nodes.get("done")).toMatchObject({ status: "completed", result: "Built", reported: true });
    expect(history.nodes.get("busy")).toMatchObject({ status: "failed", reported: true });
    expect(history.nodes.get("later")).toMatchObject({ status: "failed", reported: true });
    expect(history.children("root").map(node => node.id)).toEqual(["done", "busy", "later"]);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Array<{ status: string; reported: boolean }>;
    expect(stored.every(node => ["completed", "failed"].includes(node.status) && node.reported)).toBe(true);
  }));

  it("loads a stored room tree as the same inert history", () => fixture(file => {
    writeFileSync(file, JSON.stringify([
      { ...base, id: "root", rootId: "root", groupId: "room", threadId: "room-thread", botId: "chair", status: "waiting", reported: true },
      { ...base, id: "child", rootId: "root", parentId: "root", groupId: "room", threadId: "room-thread", botId: "peer",
        status: "completed", reported: false, kind: "assignment", requestBatchKey: "batch" },
    ]));
    const history = new DirectHandoffs(file);
    expect(history.nodes.get("root")).toMatchObject({ status: "failed", groupId: "room" });
    expect(history.nodes.get("child")).toMatchObject({ status: "completed", reported: true, requestBatchKey: "batch" });
  }));

  it("leaves already settled history byte-for-byte untouched", () => fixture(file => {
    const settled = JSON.stringify([
      { ...base, id: "root", rootId: "root", threadId: "chief-chat", botId: "chief", status: "completed", reported: true },
      { ...base, id: "child", rootId: "root", parentId: "root", threadId: "builder-chat", botId: "builder", status: "completed", reported: true },
    ], null, 2);
    writeFileSync(file, settled);
    expect(new DirectHandoffs(file).nodes.size).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(settled);
  }));

  it("starts empty without creating a file when nothing was stored", () => fixture(file => {
    expect(new DirectHandoffs(file).nodes.size).toBe(0);
    expect(existsSync(file)).toBe(false);
  }));

  it("keeps unreadable or forged storage on disk for repair and reads nothing from it", () => fixture(file => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(file, "{corrupt");
      expect(new DirectHandoffs(file).nodes.size).toBe(0);
      expect(readFileSync(file, "utf8")).toBe("{corrupt");
      const forged = JSON.stringify([{ ...base, id: "child", rootId: "missing", parentId: "missing", threadId: "t", botId: "b", status: "running" }]);
      writeFileSync(file, forged);
      expect(new DirectHandoffs(file).nodes.size).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(forged);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  }));
});
