import { expect, test } from "vitest";
import {
  alwaysCore,
  factIdentity,
  isExpired,
  isMemoryDate,
  lineFactIdentity,
  notebookIdentities,
  parseMemoryEntries,
  untilMark,
  withoutExpired,
} from "./memory-entries.ts";

test("a memory date is a real calendar day, not just the shape", () => {
  expect(isMemoryDate("2026-02-28")).toBe(true);
  expect(isMemoryDate("2026-02-30")).toBe(false);
  expect(isMemoryDate("2026-2-3")).toBe(false);
  expect(isMemoryDate("tomorrow")).toBe(false);
  expect(isMemoryDate(20260228)).toBe(false);
});

test("an entry is one dated line, with or without a source", () => {
  const [withSource, without] = parseMemoryEntries([
    '- 2026-09-25 · from chat "Riaen" · likes the ocean',
    "- 2026-09-26 · moved to Bandung",
  ].join("\n"));

  expect(withSource?.body).toBe("likes the ocean");
  expect(withSource?.prefix).toBe('- 2026-09-25 · from chat "Riaen" · ');
  expect(without?.body).toBe("moved to Bandung");
  expect(without?.date).toBe("2026-09-26");
  expect(without?.struck).toBe(false);
});

test("a hand-written line without a date is not an entry and is never touched", () => {
  const entries = parseMemoryEntries(["# Memory", "", "Just a note.", "- likes the ocean"].join("\n"));

  expect(entries).toEqual([]);
});

test("the entry grammar reads the until mark, a strike-through and its trailing marks", () => {
  const [expiring, struck, superseded] = parseMemoryEntries([
    "- 2026-09-25 · on holiday · until 2026-10-01",
    "- 2026-09-25 · ~~used to live in Jakarta~~",
    "- 2026-09-25 · moved to Bandung · updated 2026-09-26 · confirmed 2026-09-27",
  ].join("\n"));

  expect(expiring?.until).toBe("2026-10-01");
  expect(expiring?.body).toBe("on holiday");
  expect(struck?.struck).toBe(true);
  expect(struck?.body).toBe("used to live in Jakarta");
  expect(superseded?.body).toBe("moved to Bandung");
  expect(superseded?.raw).toContain("updated 2026-09-26");
});

test("an entry owns the lines under it: indented ones and a code block it opens", () => {
  const text = [
    "- 2026-09-25 · a recipe",
    "  - 2 eggs",
    "- 2026-09-26 · a snippet",
    "```",
    "print(1)",
    "```",
    "- 2026-09-27 · plain",
    "a line that is not part of anything",
    "- 2026-09-28 · last",
  ].join("\n");
  const entries = parseMemoryEntries(text);

  expect(entries.map((entry) => [entry.line, entry.end])).toEqual([[0, 2], [2, 6], [6, 7], [8, 9]]);
});

test("a fence that never closes claims nothing", () => {
  const [entry] = parseMemoryEntries(["- 2026-09-25 · a", "```", "print(1)"].join("\n"));

  expect(entry?.end).toBe(1);
});

test("the until day itself still loads, the day after does not", () => {
  const expiring = parseMemoryEntries("- 2026-09-25 · on holiday · until 2026-10-01")[0]!;

  expect(isExpired(expiring, "2026-10-01")).toBe(false);
  expect(isExpired(expiring, "2026-10-02")).toBe(true);
  expect(isExpired({ until: "2026-01-01", struck: true }, "2026-12-31")).toBe(false);
  expect(isExpired({ until: null, struck: false }, "2026-12-31")).toBe(false);
});

test("expired entries are hidden from a turn without touching the file", () => {
  const text = ["- 2026-09-25 · on holiday · until 2026-10-01", "- 2026-09-26 · moved to Bandung"].join("\n");
  const hidden = withoutExpired(text, "2026-11-01");

  expect(hidden.hidden).toBe(1);
  expect(hidden.text).toBe("- 2026-09-26 · moved to Bandung");
  expect(withoutExpired(text, "2026-09-30")).toEqual({ text, hidden: 0 });
});

test("a safety or health fact always stays in what loads every turn", () => {
  expect(alwaysCore("is vegetarian")).toBe(true);
  expect(alwaysCore("allergic to peanuts")).toBe(true);
  expect(alwaysCore("uses a wheelchair")).toBe(true);
  expect(alwaysCore("takes medication daily")).toBe(true);
  expect(alwaysCore("likes the ocean")).toBe(false);
  expect(alwaysCore("prefers dark mode")).toBe(false);
});

test("a fact's identity is deliberately narrow", () => {
  expect(factIdentity("- likes the   ocean")).toBe("likes the ocean");
  expect(factIdentity("1) likes the ocean.")).toBe("likes the ocean");
  // numbers, punctuation and case are part of the fact
  expect(factIdentity("Balance is -10")).not.toBe(factIdentity("Balance is 10"));
  expect(factIdentity("writes C++")).not.toBe(factIdentity("writes C"));
  expect(factIdentity("1.5 cups")).not.toBe(factIdentity("15 cups"));
  expect(factIdentity("API_KEY")).not.toBe(factIdentity("api_key"));
});

test("a notebook's identities ignore struck and expired-by-mark entries", () => {
  const identities = notebookIdentities([
    "- 2026-09-25 · likes the ocean",
    "- 2026-09-26 · ~~used to live in Jakarta~~",
    "a plain hand-written line",
  ].join("\n"));

  expect([...identities].sort()).toEqual(["a plain hand-written line", "likes the ocean"]);
  expect(lineFactIdentity("- 2026-09-25 · likes the ocean")).toBe("likes the ocean");
  expect(lineFactIdentity("- 2026-09-25 · ~~gone~~")).toBe("");
  expect(untilMark("2026-10-01")).toBe(" · until 2026-10-01");
  expect(untilMark(undefined)).toBe("");
});