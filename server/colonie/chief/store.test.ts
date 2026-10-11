import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ColonieChiefStore } from "./store.ts";
import type { ChiefAssignment } from "../../../shared/colonie-chief.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "colonie-chief-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function assignment(overrides: Partial<ChiefAssignment> = {}): ChiefAssignment {
  return {
    id: "a1",
    chiefBotId: "chief",
    sourceThreadId: "t1",
    sourceTurnId: "turn-1",
    targetBotId: "bot-1",
    message: "do the thing",
    status: "queued",
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}

function claim(store: ColonieChiefStore, overrides: Partial<Parameters<ColonieChiefStore["claim"]>[0]> = {}) {
  return store.claim({ key: "chief:t1:req-1", botId: "chief", threadId: "t1", requestId: "req-1", tool: "create_bot", argsHash: "hash-a", ...overrides });
}

describe("ColonieChiefStore idempotency", () => {
  it("claims once, replays a completed result and refuses a different operation under the same key", () => {
    const store = new ColonieChiefStore(dir);
    expect(claim(store).kind).toBe("claimed");
    store.settleOperation("chief:t1:req-1", "completed", { result: "created bot-2" });

    const replay = claim(store);
    expect(replay).toEqual({ kind: "replay", status: "completed", result: "created bot-2" });

    const mismatch = claim(store, { argsHash: "hash-b" });
    expect(mismatch.kind).toBe("mismatch");
    const otherTool = claim(store, { tool: "delete_bot" });
    expect(otherTool.kind).toBe("mismatch");
  });

  it("does not replay a failed operation as success", () => {
    const store = new ColonieChiefStore(dir);
    claim(store);
    store.settleOperation("chief:t1:req-1", "failed", { error: "no such bot" });
    expect(claim(store)).toEqual({ kind: "replay", status: "failed", error: "no such bot" });
  });

  it("turns a claimed operation and unfinished assignment into interrupted after restart", () => {
    const first = new ColonieChiefStore(dir);
    expect(claim(first).kind).toBe("claimed");
    first.createAssignment(assignment({ id: "a-restart", status: "running", targetThreadId: "task-1" }));

    const second = new ColonieChiefStore(dir);
    const replay = claim(second);
    expect(replay.kind).toBe("replay");
    expect(replay).toMatchObject({ status: "interrupted" });
    const restored = second.assignment("a-restart");
    expect(restored?.status).toBe("interrupted");
    // Ownership of the old target thread is gone: a stale child cannot be treated as current.
    expect(second.byTargetThread("task-1")?.status).toBe("interrupted");
  });
});

describe("ColonieChiefStore assignments", () => {
  it("filters by source thread and updates status through the target thread", () => {
    const store = new ColonieChiefStore(dir);
    store.createAssignment(assignment({ id: "a1", sourceThreadId: "t1", targetThreadId: "task-1", status: "running" }));
    store.createAssignment(assignment({ id: "a2", sourceThreadId: "t2", targetThreadId: "task-2", status: "running" }));

    expect(store.assignments("t1").map((row) => row.id)).toEqual(["a1"]);
    expect(store.assignments().map((row) => row.id)).toEqual(["a1", "a2"]);

    store.setStatusByTargetThread("task-2", "completed");
    expect(store.byTargetThread("task-2")?.status).toBe("completed");
    expect(store.byTargetThread("task-1")?.status).toBe("running");

    const returned = store.assignments("t1");
    returned[0]!.status = "failed";
    expect(store.assignment("a1")?.status).toBe("running");
  });
});