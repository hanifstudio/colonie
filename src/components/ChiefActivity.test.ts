import { describe, expect, it } from "vitest";
import { assignmentPreview, assignmentStatusLabel, chiefActivityReducer, initialChiefActivityState } from "./ChiefActivity";
import type { ChiefAssignment, ChiefView } from "../../shared/colonie-chief";

function assignment(overrides: Partial<ChiefAssignment> = {}): ChiefAssignment {
  return {
    id: "a1",
    chiefBotId: "chief",
    sourceThreadId: "t1",
    sourceTurnId: "turn-1",
    targetBotId: "worker",
    message: "summarize the report",
    status: "running",
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}

function view(overrides: Partial<ChiefView> = {}): ChiefView {
  return { chief: null, revision: "chief", assignments: [], ...overrides };
}

describe("chiefActivityReducer", () => {
  it("ignores a response for a sibling conversation", () => {
    const first = chiefActivityReducer(initialChiefActivityState, { type: "loaded", view: view({ assignments: [assignment()] }), seq: 1, current: 1 });
    const stale = chiefActivityReducer(first, { type: "loaded", view: view({ assignments: [assignment({ id: "a2" })] }), seq: 1, current: 2 });
    expect(stale).toBe(first);
    expect(stale.view?.assignments.map((row) => row.id)).toEqual(["a1"]);
  });

  it("clears a previous error on a fresh load", () => {
    const errored = chiefActivityReducer(initialChiefActivityState, { type: "failed", error: "boom", seq: 1, current: 1 });
    const loaded = chiefActivityReducer(errored, { type: "loaded", view: view(), seq: 2, current: 2 });
    expect(loaded.error).toBeNull();
  });
});

describe("assignmentStatusLabel and assignmentPreview", () => {
  it("names every task state in plain words", () => {
    expect(assignmentStatusLabel("queued")).toBe("Queued");
    expect(assignmentStatusLabel("running")).toBe("Working");
    expect(assignmentStatusLabel("waiting")).toBe("Needs your approval");
    expect(assignmentStatusLabel("completed")).toBe("Done");
    expect(assignmentStatusLabel("failed")).toBe("Failed");
    expect(assignmentStatusLabel("cancelled")).toBe("Stopped");
    expect(assignmentStatusLabel("interrupted")).toBe("Stopped");
  });

  it("prefers the actual result and shows an error only when there is none", () => {
    expect(assignmentPreview(assignment({ result: "final answer" }))).toBe("final answer");
    expect(assignmentPreview(assignment({ status: "failed", error: "provider exploded" }))).toBe("provider exploded");
    expect(assignmentPreview(assignment())).toBe("");
  });
});