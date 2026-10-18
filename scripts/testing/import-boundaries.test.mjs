// The boundary guard: `pnpm test` and `pnpm structure:check` both run this.
//
// Why this exists as a test and not only as a script: a rule nobody runs is a comment.
// `vite.config.ts` already includes `scripts/**/*.test.mjs`, so this fails the suite
// (and the CI vitest job) the moment an import crosses a boundary that
// `scripts/structure/import-boundaries.json` does not grandfather.
//
// It tests the shipped rules rather than a copy of them, because a fixture that
// re-implements the rule it is checking proves nothing: the adversarial cases below
// (a folder that merely shares a prefix) only mean something against the real matrix.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { buildGraph } from "../structure/graph.mjs";
import { compareMatrix, evaluate, loadMatrix, matchesPath, matrixAtRef } from "../structure/import-boundaries.mjs";

const ROOT = process.cwd();
const matrix = loadMatrix(ROOT);
const edge = (from, to) => ({ from, to, spec: "./x", kind: "import", via: "ts" });
const report = (violations) => violations.map((violation) => `${violation.rule}: ${violation.from} -> ${violation.to}`).join("\n");

describe("path matching", () => {
  it("treats a trailing slash as a folder and anything else as one file", () => {
    expect(matchesPath("server/harness/registry.ts", ["server/harness/"])).toBe(true);
    expect(matchesPath("server/harness/registry.ts", ["server/harness"])).toBe(false);
    expect(matchesPath("server/harness/registry.ts", ["server/harness/registry.ts"])).toBe(true);
  });

  it("does not let a neighbouring folder inherit a prefix", () => {
    expect(matchesPath("server/harness-extra/registry.ts", ["server/harness/"])).toBe(false);
    expect(matchesPath("shared-utils/a.ts", ["shared/"])).toBe(false);
    expect(matchesPath("srcx/a.ts", ["src/"])).toBe(false);
    expect(matchesPath("server/index.ts.map", ["server/index.ts"])).toBe(false);
  });

  it("reads an empty entry as anywhere", () => {
    expect(matchesPath("anything/at/all.ts", [""])).toBe(true);
  });
});

describe("the shipped rules", () => {
  it("still declares the boundaries the evidence supports", () => {
    expect(matrix.deny.map((rule) => rule.id)).toEqual([
      "no-imports-of-index",
      "shared-is-portable",
      "no-server-to-ui",
      "no-ui-to-server",
      "feature-not-to-composition",
    ]);
  });

  it("allows the edges the blueprint sanctions", () => {
    const allowed = [
      edge("server/routes/bots.ts", "server/colonie/bots/bots.ts"),
      edge("src/components/Sidebar.tsx", "shared/wire.ts"),
      edge("server/colonie/skills/routes.ts", "server/routes/table.ts"),
      edge("server/colonie/chat/card-resolvers.ts", "server/harness/http.ts"),
      edge("server/colonie/chat/chat.ts", "server/persistence/message-db.ts"),
      edge("server/colonie/chat/chat.ts", "shared/wire.ts"),
      edge("shared/wire.ts", "shared/model-request.ts"),
    ];
    expect(evaluate(allowed, matrix).violations).toEqual([]);
  });

  it("fires on every boundary crossing", () => {
    const crossings = [
      ["no-imports-of-index", edge("server/routes/bots.ts", "server/index.ts")],
      ["shared-is-portable", edge("shared/wire.ts", "server/config.ts")],
      ["shared-is-portable", edge("shared/wire.ts", "src/lib/cn.ts")],
      ["shared-is-portable", edge("shared/wire.ts", "electron/colonie-config.mjs")],
      ["no-server-to-ui", edge("server/harness/http.ts", "src/lib/cn.ts")],
      ["no-ui-to-server", edge("src/state/store.tsx", "server/persistence/store.ts")],
      ["feature-not-to-composition", edge("server/colonie/chat/chat.ts", "server/harness/registry.ts")],
      ["feature-not-to-composition", edge("server/colonie/chat/chat.ts", "server/routes/bots.ts")],
    ];
    for (const [rule, crossing] of crossings) {
      const { violations } = evaluate([crossing], matrix);
      expect(violations.map((violation) => violation.rule), report(violations)).toEqual([rule]);
    }
  });

  it("does not mistake a neighbouring folder for the boundary", () => {
    expect(evaluate([edge("server/colonie/chat/chat.ts", "server/harness-extra/thing.ts")], matrix).violations).toEqual([]);
    expect(evaluate([edge("shared-utils/format.ts", "server/config.ts")], matrix).violations).toEqual([]);
  });

  it("reports a grandfathered crossing separately from a new one", () => {
    // The shipped baseline is empty today, so the behaviour is pinned on a matrix that has
    // one: an entry explains a crossing, it does not remove it from the violation list.
    const withBaseline = { ...matrix, baseline: [{ from: "server/colonie/chat/chat.ts", to: "server/harness/registry.ts" }] };
    const { violations, known, unknown } = evaluate([
      edge("server/colonie/chat/chat.ts", "server/harness/registry.ts"),
      edge("server/colonie/chat/chat.ts", "server/routes/bots.ts"),
    ], withBaseline);
    expect(violations).toHaveLength(2);
    expect(known).toHaveLength(1);
    expect(unknown).toHaveLength(1);
  });

  it("ships no grandfathered entry, and calls one stale once its crossing is gone", () => {
    // The last two crossings were cleaned up rather than left here, so the list has to stay
    // empty: re-adding an entry means a crossing is back, and the guard exits 3 on an entry
    // nobody needs anymore.
    expect(matrix.baseline).toEqual([]);
    const withBaseline = { ...matrix, baseline: [{ from: "a.ts", to: "b.ts" }] };
    expect(evaluate([], withBaseline).stale.map((entry) => `${entry.from} -> ${entry.to}`)).toEqual(["a.ts -> b.ts"]);
  });
});

describe("the ratchet", () => {
  const base = {
    deny: [
      { id: "rule-a", from: ["server/"], to: ["src/"] },
      { id: "rule-b", from: ["shared/"], to: ["server/"], exceptTo: ["shared/kept.ts"] },
    ],
    baseline: [{ from: "a.ts", to: "b.ts" }],
  };

  it("allows a stricter matrix", () => {
    const stricter = {
      deny: [...base.deny, { id: "rule-c", from: ["electron/"], to: ["src/"] }],
      baseline: [],
    };
    const comparison = compareMatrix(base, stricter);
    expect(comparison.addedBaseline).toEqual([]);
    expect(comparison.loosened).toEqual([]);
    expect(comparison.removedBaseline).toHaveLength(1);
    expect(comparison.addedRules).toEqual(["rule-c"]);
  });

  it("catches a new grandfather", () => {
    const looser = { deny: base.deny, baseline: [...base.baseline, { from: "c.ts", to: "d.ts" }] };
    expect(compareMatrix(base, looser).addedBaseline).toHaveLength(1);
  });

  it("catches a dropped path, a dropped rule and a new exception", () => {
    expect(compareMatrix(base, { deny: [{ id: "rule-a", from: [], to: ["src/"] }, base.deny[1]], baseline: base.baseline }).loosened).toEqual([
      { rule: "rule-a", detail: 'from no longer covers "server/"' },
    ]);
    expect(compareMatrix(base, { deny: [base.deny[0]], baseline: base.baseline }).loosened).toEqual([{ rule: "rule-b", detail: "rule removed" }]);
    expect(compareMatrix(base, { deny: [base.deny[0], { ...base.deny[1], exceptTo: ["shared/kept.ts", "shared/added.ts"] }], baseline: base.baseline }).loosened).toEqual([
      { rule: "rule-b", detail: 'new exception "shared/added.ts"' },
    ]);
  });

  it("compares this repository against its base revision when that revision is available", () => {
    const atBase = matrixAtRef(ROOT, process.env.STRUCTURE_BASE_REF ?? "main");
    if (!atBase) {
      // No base revision (shallow clone, or the first introduction of the matrix): the
      // check has nothing to compare against, and says so out loud instead of passing
      // silently as if it had verified something.
      console.log(`[structure] no matrix at ${process.env.STRUCTURE_BASE_REF ?? "main"}; ratchet not verified this run`);
      return;
    }
    const comparison = compareMatrix(atBase, matrix);
    expect(comparison.addedBaseline, `new grandfather(s): ${comparison.addedBaseline.map((entry) => entry.from).join(", ")}`).toEqual([]);
    expect(comparison.loosened, `loosened: ${comparison.loosened.map((entry) => `${entry.rule} ${entry.detail}`).join(", ")}`).toEqual([]);
  });
});

describe("this repository", () => {
  let graph;
  beforeAll(() => {
    graph = buildGraph(ROOT);
  });

  it("crosses no boundary that the matrix does not grandfather", () => {
    const { unknown, violations } = evaluate(graph.edges, matrix);
    expect(unknown, report(unknown)).toEqual([]);
    expect(violations.length).toBeLessThanOrEqual(matrix.baseline.length);
  });

  it("has no stale grandfather", () => {
    const { stale } = evaluate(graph.edges, matrix);
    expect(stale, `remove these entries: ${stale.map((entry) => `${entry.from} -> ${entry.to}`).join(", ")}`).toEqual([]);
  });

  it("resolves the graph through the compiler, not through text matching", () => {
    // The alias edges are the proof: `@/*` imports only resolve if the tsconfig `paths`
    // were honoured, and an early version of this measurement silently dropped all of
    // them while still reporting a confident number.
    expect(graph.edges.filter((candidate) => candidate.via === "ts-alias").length).toBeGreaterThan(500);
    expect(graph.sources).toContain("server/index.ts");
    expect(graph.sources).toContain("src/App.tsx");
  });

  // The two tests below check the graph the rules run on, which matters more than any
  // single rule: a missing file or a missing edge makes a rule pass silently, and a
  // silent pass is worse than no check. They walk the tree from disk and parse
  // statements instead of reusing the graph builder, so a folder that no tsconfig
  // includes - or a file the compiler skipped - shows up as a failure.
  it("sees every source file the tree contains", () => {
    const missing = walkSources().filter((file) => !graph.sources.includes(file));
    expect(missing, `not in the graph: ${missing.join(", ")}`).toEqual([]);
  });

  it("contains every import statement the parser can see", () => {
    const known = new Set(graph.edges.map((candidate) => `${candidate.from}\u0000${candidate.to}`));
    const missing = [];
    let specifiers = 0;
    let needsBundler = 0;
    for (const file of walkSources()) {
      for (const specifier of specifiersIn(file)) {
        specifiers += 1;
        const target = probeSpecifier(file, specifier);
        if (!target) {
          needsBundler += 1;
          continue;
        }
        if (!known.has(`${file}\u0000${target}`)) missing.push(`${file} -> ${target} (${specifier})`);
      }
    }
    console.log(`[structure] coverage: ${graph.sources.length} files in the graph, ${specifiers} import statements, ${needsBundler} not resolvable without a bundler (.css, ?raw, JSON), ${missing.length} missing`);
    expect(missing, `imports the compiler-derived graph does not contain: ${missing.slice(0, 20).join(", ")}`).toEqual([]);
  });
});

const SKIP_DIRS = new Set(["node_modules", "dist", "dist-server", "dist-electron", "release", "vendor", "resources", ".git"]);
const SOURCE_AREAS = ["server", "src", "shared", "electron", "scripts"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];

function walkSources(area = "", found = []) {
  const areas = area ? [area] : SOURCE_AREAS;
  for (const current of areas) {
    for (const entry of readdirSync(join(ROOT, current), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) walkSources(path, found);
      else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) && !entry.name.endsWith(".d.ts")) found.push(path);
    }
  }
  return found;
}

function specifiersIn(file) {
  const text = readFileSync(join(ROOT, file), "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])) found.push(node.arguments[0].text);
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])) found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// Deliberately dumb: join the specifier onto the importing file and try the handful of
// extensions this repository uses. It only has to be right about the target path when it
// finds one, because its job is to notice edges the graph is missing.
function probeSpecifier(file, specifier) {
  if (specifier.startsWith("@/")) return probePath(join(ROOT, "src", specifier.slice(2)));
  if (!specifier.startsWith(".")) return null;
  return probePath(normalize(join(ROOT, dirname(file), specifier)));
}

function probePath(base) {
  const extensions = [...SOURCE_EXTENSIONS, ".cjs"];
  const candidates = extensions.map((extension) => `${base}${extension}`);
  // Only ever return a source file: the bare `base` counts only when it already names
  // one (otherwise `logo.png` would be reported as a module the graph is missing), and
  // the `.js` -> `.ts` mapping only applies when the specifier really ends in `.js`.
  if (extensions.some((extension) => base.endsWith(extension))) candidates.unshift(base);
  if (base.endsWith(".js")) candidates.push(base.replace(/\.js$/, ".ts"));
  candidates.push(join(base, "index.ts"), join(base, "index.tsx"), join(base, "index.mjs"));
  for (const candidate of candidates) {
    if (candidate.startsWith(ROOT) && existsSync(candidate) && statSync(candidate).isFile()) return candidate.slice(ROOT.length + 1);
  }
  return null;
}
