import type { ModelCatalog } from "./contracts.ts";
import { modelContextWindow } from "./colonie/providers/model-context-window.ts";

export const DEFAULT_CONTEXT_WINDOW = 128_000;
const positive = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export function contextWindowFor(model: string | undefined, catalog?: ModelCatalog, reported?: number): number {
  if (positive(reported)) return reported;
  const declared = catalog?.options.find((option) => option.id === model)?.contextWindow;
  if (positive(declared)) return declared;
  const inferred = model ? modelContextWindow(model) : undefined;
  return positive(inferred) ? inferred : DEFAULT_CONTEXT_WINDOW;
}

/** Leave headroom even for a small local model. An 8k lower bound would
 * make compaction unreachable on models whose entire window is 8k. */
export function compactBudget(window: number, compactAt?: number, nativeCompactAt?: number): number {
  if (!positive(window)) throw new Error("invalid model context window");
  const configured = positive(compactAt) ? (compactAt < 1 ? window * compactAt : compactAt) : window * 0.8;
  return Math.max(1, Math.floor(Math.min(configured, window * 0.9, positive(nativeCompactAt) ? nativeCompactAt * 0.9 : Infinity)));
}

export function shouldCompact(input: { contextTokens?: number; estimatedBytes: number; budget: number; floor?: number; window: number; nativeCompactAt?: number }): boolean {
  // Summed input across tool rounds is NOT a context-window measurement.
  const size = positive(input.contextTokens) ? input.contextTokens : Math.ceil(input.estimatedBytes / 4);
  // Regrowth avoids repeatedly folding an irreducible prompt, but cannot
  // delay the harness beyond a known provider-native compaction boundary.
  const ceiling = compactBudget(input.window, input.window, input.nativeCompactAt);
  const threshold = Math.min(ceiling, positive(input.floor) ? Math.max(input.budget, input.floor * 1.25) : input.budget);
  return size >= threshold;
}

/** The CLI compacts its own session when it approaches a window. Left alone
 * that window is the model's, so a Sonnet 5 session runs to something near a
 * million tokens before anything happens — and every model call until then
 * re-reads the whole thing. The measured food-ordering thread sat at 330k
 * tokens per call and looked perfectly healthy to the CLI.
 *
 * So the harness picks the window instead. This delegates the actual
 * compaction to the CLI, which owns the session and already has a summarizer
 * for it; the harness only decides when it is worth paying for.
 *
 * COLONIE_CLAUDE_AUTOCOMPACT takes a token count, "auto" to hand the decision
 * back to the CLI, or "off" to pass nothing at all. The CLI rejects a window
 * outside 100k-1M as a hard argument error, so a configured value is clamped
 * rather than passed through: a mistyped setting must not fail every turn. */
export function autoCompactWindow(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.COLONIE_CLAUDE_AUTOCOMPACT ?? "").trim().toLowerCase();
  if (raw === "off") return null;
  if (raw === "auto") return "auto";
  const parsed = raw ? Number(raw) : DEFAULT_AUTOCOMPACT_TOKENS;
  if (!Number.isFinite(parsed) || parsed <= 0) return String(DEFAULT_AUTOCOMPACT_TOKENS);
  return String(Math.min(1_000_000, Math.max(100_000, Math.floor(parsed))));
}

/** Generous for real work, and still a third of where a 1M-window session
 * would otherwise get to. With bot tool results gated (mcp-gate.ts) most
 * threads never reach it; this is the backstop for the ones that do. */
const DEFAULT_AUTOCOMPACT_TOKENS = 200_000;
