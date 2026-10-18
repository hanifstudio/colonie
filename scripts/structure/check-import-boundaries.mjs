// The boundary check itself: `pnpm structure:check`.
//
// Why this exists: folder and file organisation decays one import at a time, and by the
// time a person notices, the shape is already different from the blueprint. This runs
// the rules in scripts/structure/import-boundaries.json against the compiler-derived
// import graph and exits non-zero when an edge crosses a boundary, when the matrix was
// loosened relative to the base revision, or when a grandfathered entry became stale.
//
// Usage:
//   node scripts/structure/check-import-boundaries.mjs [--base <ref>]
//
// Exit codes: 0 clean, 1 new boundary violations, 2 the matrix was loosened,
// 3 a grandfathered entry is stale (the violation was fixed; remove the entry).
// Anything it cannot decide - unresolved relative imports - is printed as a warning and
// does not change the exit code, because that is a broken file, not a boundary.

import { join } from "node:path";
import { buildGraph } from "./graph.mjs";
import { compareMatrix, evaluate, loadMatrix, matrixAtRef } from "./import-boundaries.mjs";

const ROOT = join(import.meta.dirname, "../..");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const baseRef = option("--base", "main");
const matrix = loadMatrix(ROOT);
const graph = buildGraph(ROOT);
const result = evaluate(graph.edges, matrix);
const base = matrixAtRef(ROOT, baseRef);
const ratchet = base ? compareMatrix(base, matrix) : null;

const aliased = graph.edges.filter((edge) => edge.via === "ts-alias").length;
console.log("structure: import boundaries");
console.log(`  graph: ${graph.sources.length} files, ${graph.edges.length} resolved edges (${aliased} through tsconfig paths), ${graph.missing.length} unresolved, ${graph.fallbacks.length} probe-resolved`);
console.log("  matrix:");
for (const rule of matrix.deny) {
  const hits = result.violations.filter((violation) => violation.rule === rule.id);
  const grandfathered = hits.filter((hit) => result.known.includes(hit)).length;
  const fresh = hits.length - grandfathered;
  const state = fresh > 0 ? "FAIL" : grandfathered > 0 ? "BASE" : "ok  ";
  console.log(`    ${state}  ${rule.id.padEnd(28)} ${String(hits.length).padStart(3)} violation(s)${grandfathered ? `, ${grandfathered} grandfathered` : ""}`);
}

if (result.unknown.length) {
  console.log(`\n  NEW VIOLATIONS (${result.unknown.length})`);
  for (const violation of result.unknown) {
    const rule = matrix.deny.find((entry) => entry.id === violation.rule);
    console.log(`    ${violation.rule}: ${violation.from} -> ${violation.to}  (${violation.kind})`);
    console.log(`      why: ${rule?.why ?? "no reason recorded"}`);
  }
  console.log("\n  fix the caller, or add an exception to the matrix with a reason; an exception is a loosening of the rule and has to be its own change.");
}

if (ratchet) {
  const parts = [];
  if (ratchet.addedBaseline.length) parts.push(`${ratchet.addedBaseline.length} new grandfather(s)`);
  if (ratchet.loosened.length) parts.push(`${ratchet.loosened.length} loosening(s)`);
  if (ratchet.removedBaseline.length) parts.push(`${ratchet.removedBaseline.length} removal(s)`);
  console.log(`\n  ratchet vs ${baseRef}: ${parts.length ? parts.join(", ") : "unchanged"}`);
  for (const entry of ratchet.addedBaseline) console.log(`    new grandfather: ${entry.from} -> ${entry.to}`);
  for (const entry of ratchet.loosened) console.log(`    loosened ${entry.rule}: ${entry.detail}`);
  for (const entry of ratchet.removedBaseline) console.log(`    removed grandfather: ${entry.from} -> ${entry.to} (good; keep it removed)`);
  for (const id of ratchet.addedRules) console.log(`    new rule: ${id}`);
} else {
  console.log(`\n  ratchet: ${baseRef} has no ${"scripts/structure/import-boundaries.json"}; this is the first introduction`);
}

if (result.stale.length) {
  console.log(`\n  STALE BASELINE ENTRIES (${result.stale.length}) - the violation is gone, so delete the entry or the same edge can return unremarked:`);
  for (const entry of result.stale) console.log(`    ${entry.from} -> ${entry.to}`);
}

if (graph.missing.length) {
  console.log(`\n  warning: ${graph.missing.length} relative import(s) resolve to nothing (broken file, not a boundary):`);
  for (const entry of graph.missing) console.log(`    ${entry.from} imports ${entry.spec}`);
}

let code = 0;
if (result.unknown.length) code = 1;
else if (ratchet && (ratchet.addedBaseline.length || ratchet.loosened.length)) code = 2;
else if (result.stale.length) code = 3;

console.log(`\n  result: ${code === 0 ? "clean" : "needs attention"} (exit ${code})`);
process.exitCode = code;
