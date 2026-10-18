import { expect, test } from "vitest";
import { autoCompactWindow, compactBudget, contextWindowFor, DEFAULT_CONTEXT_WINDOW, shouldCompact } from "./context-budget.ts";

test("the window comes from the provider first, the catalog next, the model id last", () => {
  const catalog = { options: [{ id: "local-8b", contextWindow: 32_000 }] } as never;

  expect(contextWindowFor("claude-sonnet-5", catalog, 400_000)).toBe(400_000);
  expect(contextWindowFor("local-8b", catalog)).toBe(32_000);
  expect(contextWindowFor("claude-sonnet-5", catalog)).toBe(200_000);
  expect(contextWindowFor("gpt-5", undefined)).toBe(272_000);
  expect(contextWindowFor("claude-sonnet-5-5", undefined)).toBe(1_000_000);
  // a reported or declared value that is not a usable number is ignored
  expect(contextWindowFor("local-8b", catalog, 0)).toBe(32_000);
  expect(contextWindowFor("local-8b", catalog, Number.NaN)).toBe(32_000);
  // an unknown model gets no guess, only the harness default
  expect(contextWindowFor("mystery-model", undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
  expect(contextWindowFor(undefined, undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
});

test("the compaction budget keeps headroom below every ceiling it knows", () => {
  expect(compactBudget(100_000)).toBe(80_000);
  expect(compactBudget(100_000, 50_000)).toBe(50_000);
  // a value below 1 is read as a fraction of the window
  expect(compactBudget(100_000, 0.5)).toBe(50_000);
  // never past 90% of the window
  expect(compactBudget(100_000, 99_000)).toBe(90_000);
  // nor past 90% of the provider's own boundary
  expect(compactBudget(1_000_000, 0.8, 200_000)).toBe(180_000);
  // a window too small to compact at all still yields a usable budget
  expect(compactBudget(1)).toBe(1);
  expect(() => compactBudget(0)).toThrow(/invalid model context window/);
});

test("compaction triggers on measured tokens when there are any, and bytes otherwise", () => {
  const base = { estimatedBytes: 400_000, budget: 80_000, window: 100_000 };

  // 400,000 bytes / 4 = 100,000 estimated tokens, over the 80,000 budget
  expect(shouldCompact(base)).toBe(true);
  // a summed token count is not a window measurement, but it is what triggers
  expect(shouldCompact({ ...base, contextTokens: 10 })).toBe(false);
  expect(shouldCompact({ ...base, contextTokens: 90_000 })).toBe(true);
  // regrowth: a floor raises the bar by a quarter so an irreducible prompt is not refolded
  const big = { estimatedBytes: 0, budget: 80_000, window: 1_000_000 };
  expect(shouldCompact({ ...big, contextTokens: 85_000 })).toBe(true);
  expect(shouldCompact({ ...big, contextTokens: 85_000, floor: 100_000 })).toBe(false);
  expect(shouldCompact({ ...big, contextTokens: 260_000, floor: 200_000 })).toBe(true);
  // but the window's own ceiling still wins over a floor
  expect(shouldCompact({ ...base, contextTokens: 95_000, floor: 1_000_000 })).toBe(true);
});

test("the CLI's own compaction window is chosen by the harness, within what it accepts", () => {
  expect(autoCompactWindow({})).toBe("200000");
  expect(autoCompactWindow({ COLONIE_CLAUDE_AUTOCOMPACT: "off" })).toBeNull();
  expect(autoCompactWindow({ COLONIE_CLAUDE_AUTOCOMPACT: " AUTO " })).toBe("auto");
  expect(autoCompactWindow({ COLONIE_CLAUDE_AUTOCOMPACT: "150000" })).toBe("150000");
  expect(autoCompactWindow({ COLONIE_CLAUDE_AUTOCOMPACT: "150000.7" })).toBe("150000");
  // a mistyped setting must not fail every turn
  expect(autoCompactWindow({ COLONIE_CLAUDE_AUTOCOMPACT: "fifty" })).toBe("200000");
  expect(autoCompactWindow({ COLONIE_CLAUDE_AUTOCOMPACT: "0" })).toBe("200000");
  expect(autoCompactWindow({ COLONIE_CLAUDE_AUTOCOMPACT: "-5" })).toBe("200000");
  // and a window the CLI would reject is clamped rather than passed through
  expect(autoCompactWindow({ COLONIE_CLAUDE_AUTOCOMPACT: "50000" })).toBe("100000");
  expect(autoCompactWindow({ COLONIE_CLAUDE_AUTOCOMPACT: "2000000" })).toBe("1000000");
});