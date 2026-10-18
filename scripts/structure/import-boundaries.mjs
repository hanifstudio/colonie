// The boundary rule set: load it, apply it to a real import graph, and compare two
// versions of it so the matrix can only ever get stricter on its own.
//
// Why the ratchet lives here and not in a comment: a baseline that anybody can raise
// in the same commit that violates it freezes today's mess as the standard. So the
// working matrix must not grandfather an edge the base revision did not, must not drop
// a path from a deny rule, and must not add an exception. Loosening is still possible,
// but only by changing the base revision in its own reviewable change.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MATRIX_FILE = "scripts/structure/import-boundaries.json";

export function loadMatrix(root) {
  return JSON.parse(readFileSync(join(root, MATRIX_FILE), "utf8"));
}

// The matrix as of a git revision, or null when that revision has none (the first
// introduction of the file, or a shallow checkout without the ref).
export function matrixAtRef(root, ref) {
  if (!ref) return null;
  try {
    const shown = execFileSync("git", ["show", `${ref}:${MATRIX_FILE}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(shown);
  } catch {
    return null;
  }
}

// An entry ending in "/" matches that folder and everything below it; any other entry
// matches exactly one file; an empty entry matches every path. The trailing slash is
// load-bearing: without it "shared/" would also match "shared-utils/a.ts" and
// "server/harness/" would match "server/harness-extra/b.ts", so a boundary would appear
// to hold while the module it is about had moved next door.
export function matchesPath(path, entries = []) {
  return entries.some((entry) => entry === "" || path === entry || (entry.endsWith("/") && path.startsWith(entry)));
}

export function evaluate(edges, matrix) {
  const violations = [];
  for (const edge of edges) {
    for (const rule of matrix.deny) {
      if (!matchesPath(edge.from, rule.from)) continue;
      if (!matchesPath(edge.to, rule.to)) continue;
      if (matchesPath(edge.to, rule.exceptTo)) continue;
      violations.push({ rule: rule.id, from: edge.from, to: edge.to, spec: edge.spec, kind: edge.kind });
      break;
    }
  }

  const key = (from, to) => `${from}\u0000${to}`;
  const grandfathered = new Set(matrix.baseline.map((entry) => key(entry.from, entry.to)));
  const unknown = violations.filter((violation) => !grandfathered.has(key(violation.from, violation.to)));
  const known = violations.filter((violation) => grandfathered.has(key(violation.from, violation.to)));
  // A baseline entry that no longer matches anything is debt that was paid; keeping it
  // would silently pre-authorise the same edge coming back.
  const stale = matrix.baseline.filter((entry) => !violations.some((violation) => violation.from === entry.from && violation.to === entry.to));

  return { violations, known, unknown, stale };
}

export function compareMatrix(base, working) {
  const key = (entry) => `${entry.from}\u0000${entry.to}`;
  const baseBaseline = new Set(base.baseline.map(key));
  const workingBaseline = new Set(working.baseline.map(key));

  const addedBaseline = working.baseline.filter((entry) => !baseBaseline.has(key(entry)));
  const removedBaseline = base.baseline.filter((entry) => !workingBaseline.has(key(entry)));

  const loosened = [];
  const workingRules = new Map(working.deny.map((rule) => [rule.id, rule]));
  for (const rule of base.deny) {
    const after = workingRules.get(rule.id);
    if (!after) {
      loosened.push({ rule: rule.id, detail: "rule removed" });
      continue;
    }
    for (const field of ["from", "to"]) {
      for (const entry of rule[field] ?? []) {
        if (!(after[field] ?? []).includes(entry)) loosened.push({ rule: rule.id, detail: `${field} no longer covers "${entry}"` });
      }
    }
    for (const entry of after.exceptTo ?? []) {
      if (!(rule.exceptTo ?? []).includes(entry)) loosened.push({ rule: rule.id, detail: `new exception "${entry}"` });
    }
  }

  const addedRules = working.deny.filter((rule) => !base.deny.some((baseRule) => baseRule.id === rule.id)).map((rule) => rule.id);
  return { addedBaseline, removedBaseline, loosened, addedRules };
}
