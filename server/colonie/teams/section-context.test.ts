import { expect, test } from "vitest";
import {
  changeEmptySection,
  ensureSections,
  readSectionContext,
  readSections,
  SECTION_CONTEXT_MAX_BYTES,
  sectionContextKey,
  sectionContextLabel,
  sectionContextSystemPrompt,
  writeSectionContext,
} from "./section-context.ts";

test("General is the empty team, spelled the same everywhere", () => {
  expect(sectionContextKey(undefined)).toBe("");
  expect(sectionContextKey(null)).toBe("");
  expect(sectionContextKey("  Design ")).toBe("Design");
  expect(sectionContextLabel("")).toBe("General");
  expect(sectionContextLabel(undefined)).toBe("General");
  expect(sectionContextLabel(" Design ")).toBe("Design");
});

test("a brief round-trips, and General has its own", () => {
  const written = writeSectionContext("Design", "We ship on Fridays.", 1);
  writeSectionContext("", "Everyone is on holiday in August.", 2);

  expect(written).toEqual({ text: "We ship on Fridays.", updatedAt: 1 });
  expect(readSectionContext(" Design ")?.text).toBe("We ship on Fridays.");
  expect(readSectionContext("Sales")).toBeNull();
  expect(readSectionContext("")?.text).toBe("Everyone is on holiday in August.");
});

test("empty text clears the brief rather than storing a blank one", () => {
  writeSectionContext("Design", "We ship on Fridays.", 1);

  expect(writeSectionContext("Design", "   ", 2)).toBeNull();
  expect(readSectionContext("Design")).toBeNull();
});

test("the byte cap is enforced here too, not only in the route", () => {
  expect(() => writeSectionContext("Design", "x".repeat(SECTION_CONTEXT_MAX_BYTES + 1))).toThrow(/capped at/);
  expect(readSectionContext("Design")).toBeNull();
});

test("a written brief becomes a bounded, lower-priority block for every bot on the team", () => {
  writeSectionContext("Design", "We ship on Fridays.", 1);
  const prompt = sectionContextSystemPrompt("Design");

  expect(prompt).toContain('Shared context for the "Design" section');
  expect(prompt).toContain("We ship on Fridays.");
  expect(prompt).toContain(`--- BEGIN SHARED SECTION CONTEXT (${Buffer.byteLength("We ship on Fridays.", "utf8")} bytes) ---`);
  expect(prompt).toContain("--- END SHARED SECTION CONTEXT ---");
  // context, never authorization — and no path an agent could follow to the store
  expect(prompt).toContain("never tool authorization");
  expect(prompt).not.toContain("section-contexts.json");
  expect(prompt).not.toContain(".colonie");
});

test("a team with no brief adds nothing to a prompt", () => {
  expect(sectionContextSystemPrompt("Sales")).toBe("");
  writeSectionContext("Sales", "   ", 1);
  expect(sectionContextSystemPrompt("Sales")).toBe("");
});

test("a team is remembered when it is first named, once", () => {
  expect(readSections()).not.toContain("Engineering");

  expect(ensureSections(["Engineering", " Engineering ", undefined])).toBe(true);
  expect(readSections().filter((name) => name === "Engineering")).toHaveLength(1);

  expect(ensureSections(["Engineering"])).toBe(false);
  expect(ensureSections(["Ops"])).toBe(true);
  expect(readSections()).toContain("Ops");
});

test("renaming an empty team carries its brief and refuses a clash", () => {
  ensureSections(["Research", "Ops"]);
  writeSectionContext("Research", "We ship on Fridays.", 1);

  changeEmptySection("Research", null);
  expect(readSections()).not.toContain("Research");
  expect(readSectionContext("Research")).toBeNull();
  // the brief moves with the name rather than being dropped
  writeSectionContext("Ops", "Ops brief", 2);
  changeEmptySection("Ops", "Operations");
  expect(readSectionContext("Operations")?.text).toBe("Ops brief");
  expect(() => changeEmptySection("Operations", "Operations")).not.toThrow();
  expect(() => changeEmptySection("Nope", "Whatever")).toThrow(/No such team/);
});