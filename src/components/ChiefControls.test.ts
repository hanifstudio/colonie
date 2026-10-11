import { describe, expect, it } from "vitest";
import { chiefControlsReducer, initialChiefControlsState, isChief } from "./ChiefControls";
import type { ChiefView } from "../../shared/colonie-chief";

function view(overrides: Partial<ChiefView> = {}): ChiefView {
  return { chief: { id: "chief", name: "Chief", title: "", description: "", modelSelection: { instanceId: "i", model: "m" } }, revision: "chief", assignments: [], ...overrides };
}

describe("chiefControlsReducer", () => {
  it("drops a stale response so another bot's role cannot appear", () => {
    const first = chiefControlsReducer(initialChiefControlsState, { type: "loaded", view: view(), seq: 1, current: 1 });
    const stale = chiefControlsReducer(first, { type: "loaded", view: view({ revision: "other" }), seq: 1, current: 2 });
    expect(stale).toBe(first);
    expect(stale.view?.revision).toBe("chief");
  });

  it("applies the current response and clears a previous error", () => {
    const errored = chiefControlsReducer(initialChiefControlsState, { type: "failed", error: "boom", seq: 1, current: 1 });
    expect(errored.error).toBe("boom");
    const loaded = chiefControlsReducer(errored, { type: "loaded", view: view(), seq: 2, current: 2 });
    expect(loaded.error).toBeNull();
  });
});

describe("isChief", () => {
  it("is true only for the bot currently holding the role", () => {
    expect(isChief(view(), "chief")).toBe(true);
    expect(isChief(view(), "worker")).toBe(false);
    expect(isChief(null, "chief")).toBe(false);
  });
});