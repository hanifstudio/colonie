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
    const grandfathered = matrix.baseline[0];
    const { violations, known, unknown } = evaluate([edge(grandfathered.from, grandfathered.to)], matrix);
    expect(violations).toHaveLength(1);
    expect(known).toHaveLength(1);
    expect(unknown).toEqual([]);
  });

  it("calls a baseline entry stale once its crossing is gone", () => {
    const { stale } = evaluate([], matrix);
    expect(stale.map((entry) => `${entry.from} -> ${entry.to}`)).toEqual(matrix.baseline.map((entry) => `${entry.from} -> ${entry.to}`));
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
});
