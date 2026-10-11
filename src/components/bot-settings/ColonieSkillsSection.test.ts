import { describe, expect, it } from "vitest";
import {
  initialSkillsSectionState,
  instructionsFromSkillMd,
  skillOriginLabel,
  skillsSectionReducer,
} from "./ColonieSkillsSection";
import type { ColonieSkill, ColonieSkillsView } from "../../../shared/colonie-skills";

function skill(overrides: Partial<ColonieSkill> = {}): ColonieSkill {
  return {
    name: "weekly-report",
    description: "Use when the user asks for the weekly report.",
    enabled: true,
    source: "learn:colonie",
    sha256: "a".repeat(64),
    editable: true,
    origin: "private",
    warnings: [],
    ...overrides,
  };
}

function view(overrides: Partial<ColonieSkillsView> = {}): ColonieSkillsView {
  return { revision: "1", skills: [], library: [], assignedSkills: [], ...overrides };
}

describe("skillsSectionReducer", () => {
  it("ignores a stale response so another bot's list can never appear", () => {
    const first = skillsSectionReducer(initialSkillsSectionState, { type: "loaded", view: view({ revision: "1" }), seq: 1, current: 1 });
    const stale = skillsSectionReducer(first, {
      type: "loaded",
      view: view({ revision: "2", skills: [skill()] }),
      seq: 1,
      current: 2,
    });
    expect(stale).toBe(first);
    expect(stale.view?.revision).toBe("1");
    expect(stale.view?.skills).toEqual([]);
  });

  it("applies the current response and clears a previous error", () => {
    const errored = skillsSectionReducer(initialSkillsSectionState, { type: "failed", error: "boom", seq: 1, current: 1 });
    expect(errored.error).toBe("boom");
    const loaded = skillsSectionReducer(errored, { type: "loaded", view: view({ revision: "3" }), seq: 2, current: 2 });
    expect(loaded.error).toBeNull();
    expect(loaded.view?.revision).toBe("3");
  });

  it("keeps the view (and thus the draft) visible when a save conflicts", () => {
    const loaded = skillsSectionReducer(initialSkillsSectionState, {
      type: "loaded",
      view: view({ revision: "1", skills: [skill()] }),
      seq: 1,
      current: 1,
    });
    const conflicted = skillsSectionReducer(loaded, { type: "conflict" });
    expect(conflicted.conflict).toBe(true);
    expect(conflicted.view?.skills).toHaveLength(1);
    expect(skillsSectionReducer(conflicted, { type: "clearConflict" }).conflict).toBe(false);
  });
});

describe("skillOriginLabel and instructionsFromSkillMd", () => {
  it("names an origin without any hash or path", () => {
    expect(skillOriginLabel(skill({ origin: "private" }))).toBe("This bot");
    expect(skillOriginLabel(skill({ origin: "library" }))).toBe("Library");
  });

  it("strips the authored frontmatter envelope for editing", () => {
    const text = '---\nname: "weekly-report"\ndescription: "Use when asked."\n---\n\n1. Gather.\n2. Summarize.\n';
    expect(instructionsFromSkillMd(text)).toBe("1. Gather.\n2. Summarize.\n");
    expect(instructionsFromSkillMd("no frontmatter here")).toBe("no frontmatter here");
  });
});