// Structural evidence, part 2: the real import graph, taken from the compiler.
//
// Why this exists: the first pass at this question used regular expressions over
// source text, which is wrong for exactly the cases that have already bitten this
// repo — path aliases, `export ... from`, dynamic `import()`, `.ts` specifiers and
// type-only imports. This script asks the TypeScript compiler instead, so an
// import edge is a resolved module, not a string match. It reports the module graph,
// its cycles, exported-but-never-imported surface, and the direction rules written
// down in the "Code structure" section of docs/COLONIE-BLUEPRINT.md.
//
// The graph comes from scripts/structure/graph.mjs - the same module the guard
// (`pnpm structure:check`) uses - so this measurement and the boundary check can never
// disagree about what an edge is.
//
// Run: node scripts/structure/measure-graph.mjs
// Writes docs/structure/graph.json (HEAD hash, no timestamps, so it reproduces).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { buildGraph, label, relativePath, resolveSpec, sourceFiles } from "./graph.mjs";
import { evaluate, loadMatrix } from "./import-boundaries.mjs";

const ROOT = join(import.meta.dirname, "../..");
const rel = (fileName) => relativePath(ROOT, fileName);

const { programs, sources, edges, missing, fallbacks } = buildGraph(ROOT);

// Names used by other modules, resolved to the symbol's *declaring* file rather than
// to the specifier's target. Keying by the raw import target was the second bug in
// this measure: a name re-exported by a barrel file (`export { N } from "x"`) was
// credited to the barrel, so the file that actually declares N looked dead. Following
// the alias with the checker removes the false positives instead of hiding them.
const usedNames = new Map();
const fullyUsed = new Set();

function originOf(checker, symbol) {
  if (!symbol) return undefined;
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declaration = (resolved.declarations ?? []).find((d) => !d.getSourceFile().isDeclarationFile);
  return declaration ? { path: rel(declaration.getSourceFile().fileName), name: resolved.getName() } : undefined;
}

for (const { program } of programs) {
  const checker = program.getTypeChecker();
  const options = program.getCompilerOptions();
  for (const file of sourceFiles(ROOT, program)) {
    const fromPath = rel(file.fileName);
    const markAll = (targetPath) => {
      const targetFile = program.getSourceFile(join(ROOT, targetPath));
      const symbol = targetFile ? checker.getSymbolAtLocation(targetFile) : undefined;
      if (symbol) for (const exported of checker.getExportsOfModule(symbol)) {
        const origin = originOf(checker, exported);
        if (origin) usedNames.set(origin.path + "\u0000" + origin.name, true);
      }
      fullyUsed.add(targetPath);
    };
    const walk = (node) => {
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
        const bindings = node.importClause.namedBindings;
        if (ts.isNamespaceImport(bindings)) {
          const target = resolveSpec(ROOT, fromPath, node.moduleSpecifier.text, options);
          if (target.kind === "file") markAll(target.path);
        } else {
          for (const element of bindings.elements) {
            const origin = originOf(checker, checker.getSymbolAtLocation(element.name));
            if (origin) usedNames.set(origin.path + "\u0000" + origin.name, true);
          }
        }
      } else if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveSpec(ROOT, fromPath, node.moduleSpecifier.text, options);
        if (target.kind === "file") markAll(target.path);
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
  }
}

const exportsByFile = new Map();
for (const { program } of programs) {
  const checker = program.getTypeChecker();
  for (const file of sourceFiles(ROOT, program)) {
    const symbol = checker.getSymbolAtLocation(file);
    if (!symbol) continue;
    const names = [];
    for (const exported of checker.getExportsOfModule(symbol)) {
      const resolved = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      // Only names this file declares itself: a re-export belongs to its origin.
      if (!(resolved.declarations ?? []).some((d) => d.getSourceFile() === file)) continue;
      if (!resolved.getName().startsWith("__")) names.push(resolved.getName());
    }
    if (names.length) exportsByFile.set(rel(file.fileName), names);
  }
}

const deadExports = [];
for (const [path, names] of exportsByFile) {
  if (fullyUsed.has(path)) continue;
  for (const name of names) if (!usedNames.has(path + "\u0000" + name)) deadExports.push({ path, name });
}

const labelEdges = new Map();
for (const edge of edges) {
  if (edge.from === edge.to) continue;
  const key = label(edge.from) + "\u0000" + label(edge.to);
  labelEdges.set(key, (labelEdges.get(key) ?? 0) + 1);
}

// The rules come from the matrix the guard enforces, not from a copy kept here: a
// measurement that reports a different rule set from the one that can fail a build is
// how a boundary quietly stops meaning anything.
const matrix = loadMatrix(ROOT);
const result = evaluate(edges, matrix);
const violations = result.violations;

function stronglyConnected(nodes, adjacency) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const node = frame[0];
      if (frame[1] === 0) {
        index.set(node, counter);
        low.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
      }
      const neighbours = [...(adjacency.get(node) ?? [])];
      let advanced = false;
      while (frame[1] < neighbours.length) {
        const next = neighbours[frame[1]];
        frame[1] += 1;
        if (!index.has(next)) {
          work.push([next, 0]);
          advanced = true;
          break;
        }
        if (onStack.has(next)) low.set(node, Math.min(low.get(node), index.get(next)));
      }
      if (advanced) continue;
      if (low.get(node) === index.get(node)) {
        const component = [];
        for (;;) {
          const member = stack.pop();
          onStack.delete(member);
          component.push(member);
          if (member === node) break;
        }
        if (component.length > 1) components.push(component);
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
    }
  }
  return components;
}

const fileAdjacency = new Map();
for (const edge of edges) {
  if (!fileAdjacency.has(edge.from)) fileAdjacency.set(edge.from, new Set());
  fileAdjacency.get(edge.from).add(edge.to);
}
const allFiles = new Set([...exportsByFile.keys(), ...fileAdjacency.keys(), ...[...fileAdjacency.values()].flatMap((s) => [...s])]);
const fileCycles = stronglyConnected([...allFiles], fileAdjacency)
  .map((members) => ({ size: members.length, files: members.slice(0, 10) }))
  .sort((a, b) => b.size - a.size);

const labelAdjacency = new Map();
for (const key of labelEdges.keys()) {
  const [a, b] = key.split("\u0000");
  if (!labelAdjacency.has(a)) labelAdjacency.set(a, new Set());
  labelAdjacency.get(a).add(b);
}
const labelCycles = stronglyConnected([...labelAdjacency.keys()], labelAdjacency).sort((a, b) => b.length - a.length);

const mutualPairs = [];
for (const [a, neighbours] of labelAdjacency) {
  for (const b of neighbours) {
    if (a < b && labelAdjacency.get(b)?.has(a)) {
      mutualPairs.push({ a, b, aToB: labelEdges.get(a + "\u0000" + b) ?? 0, bToA: labelEdges.get(b + "\u0000" + a) ?? 0 });
    }
  }
}
mutualPairs.sort((x, y) => y.aToB + y.bToA - (x.aToB + x.bToA));

const deadByArea = {};
for (const dead of deadExports) {
  const key = dead.path.split("/").slice(0, 2).join("/");
  deadByArea[key] = (deadByArea[key] ?? 0) + 1;
}

const artifact = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
  programs: programs.map((entry) => ({ name: entry.name, files: sourceFiles(ROOT, entry.program).length })),
  totals: {
    files: allFiles.size,
    sourceFiles: sources.length,
    edges: edges.length,
    aliasEdges: edges.filter((e) => e.via === "ts-alias").length,
    unresolvedRelativeSpecs: missing.length,
    probeResolutions: fallbacks.length,
  },
  ruleSource: "scripts/structure/import-boundaries.json",
  rules: matrix.deny.map((rule) => ({
    id: rule.id,
    why: rule.why,
    violations: result.violations.filter((v) => v.rule === rule.id).length,
    grandfathered: result.known.filter((v) => v.rule === rule.id).length,
  })),
  violations,
  newViolations: result.unknown,
  staleBaseline: result.stale,
  cycles: {
    fileLevel: { count: fileCycles.length, largest: fileCycles.slice(0, 15) },
    folderLevel: labelCycles.filter((c) => c.length > 2).map((c) => c),
    folderLevelCount: labelCycles.filter((c) => c.length > 2).length,
    mutualPairs: mutualPairs.slice(0, 60),
    mutualPairCount: mutualPairs.length,
  },
  unresolvedRelativeSpecs: missing.slice(0, 20),
  probeResolutions: fallbacks.slice(0, 20),
  deadExports: { count: deadExports.length, byArea: deadByArea, sample: deadExports.slice(0, 200) },
  largestPublicSurfaces: [...exportsByFile.entries()].map(([path, names]) => ({ path, exports: names.length })).sort((a, b) => b.exports - a.exports).slice(0, 15),
};

mkdirSync(join(ROOT, "docs/structure"), { recursive: true });
writeFileSync(join(ROOT, "docs/structure/graph.json"), JSON.stringify(artifact, null, 2) + "\n");

const t = artifact.totals;
console.log(`files ${t.files}  edges ${t.edges} (alias ${t.aliasEdges})  unresolved ${t.unresolvedRelativeSpecs}  probe-resolved ${t.probeResolutions}`);
console.log("\nboundary rules (from scripts/structure/import-boundaries.json):");
for (const rule of artifact.rules) {
  const state = rule.violations === 0 ? "ok  " : rule.grandfathered === rule.violations ? "BASE" : "FAIL";
  console.log(`  ${state} ${String(rule.violations).padStart(3)} (${rule.grandfathered} grandfathered)  ${rule.id}`);
}
console.log(`\nnew violations (not in the baseline): ${artifact.newViolations.length}`);
for (const v of artifact.newViolations.slice(0, 25)) console.log(`  ${v.rule}: ${v.from} -> ${v.to}  (${v.kind})`);
console.log(`stale baseline entries: ${artifact.staleBaseline.length}`);
console.log("\nall boundary hits:");
for (const v of violations.slice(0, 25)) console.log(`  ${v.rule}: ${v.from} -> ${v.to}  (${v.kind})`);
if (violations.length > 25) console.log(`  ... ${violations.length - 25} more`);
console.log(`\nfile-level cycles (SCCs > 1): ${artifact.cycles.fileLevel.count}; largest:`);
for (const c of artifact.cycles.fileLevel.largest.slice(0, 6)) console.log(`  ${String(c.size).padStart(4)} files: ${c.files.slice(0, 4).join(", ")}`);
console.log(`\nfolder-level cycles (>2 folders): ${artifact.cycles.folderLevelCount}`);
for (const c of artifact.cycles.folderLevel.slice(0, 6)) console.log(`  ${c.join(" -> ")}`);
console.log(`\nmutual pairs (A imports B and B imports A): ${artifact.cycles.mutualPairCount}`);
for (const p of artifact.cycles.mutualPairs.slice(0, 14)) console.log(`  ${String(p.aToB + p.bToA).padStart(3)}  ${p.a} <-> ${p.b}  (${p.aToB}/${p.bToA})`);
console.log(`\ndead exports (exported, never imported by name): ${artifact.deadExports.count}`);
for (const [area, count] of Object.entries(artifact.deadExports.byArea).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(count).padStart(5)}  ${area}`);
for (const d of artifact.deadExports.sample.slice(0, 5)) console.log(`  e.g. ${d.path}: ${d.name}`);
console.log("\nlargest public surfaces:");
for (const s of artifact.largestPublicSurfaces.slice(0, 8)) console.log(`  ${String(s.exports).padStart(4)}  ${s.path}`);
