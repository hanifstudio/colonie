// Structural evidence, part 2: the real import graph, taken from the compiler.
//
// Why this exists: the first pass at this question used regular expressions over
// source text, which is wrong for exactly the cases that have already bitten this
// repo — path aliases, `export ... from`, dynamic `import()`, `.ts` specifiers and
// type-only imports. This script asks the TypeScript compiler instead, so an
// import edge is a resolved module, not a string match. It reports the module graph,
// its cycles, exported-but-never-imported surface, and the direction rules written
// down in docs/COLONIE-BLUEPRINT.md section 7.
//
// Three programs are built because the areas compile with different options (the
// server imports `.ts` specifiers, the app is compiled by Vite, and `shared/` plus
// `electron/` belong to neither): server/** under tsconfig.server.json, src/** and
// vite.config.ts under tsconfig.json, and shared/** + electron/** under a readable
// variant of tsconfig.json.
//
// Run: node scripts/structure/measure-graph.mjs
// Writes docs/structure/graph.json (HEAD hash, no timestamps, so it reproduces).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "../..");
const SKIP = /(^|\/)(node_modules|dist|dist-server|dist-electron|release|vendor)\//;

function readConfig(configPath) {
  const file = ts.readConfigFile(configPath, ts.sys.readFile);
  if (file.error) throw new Error(ts.flattenDiagnosticMessageText(file.error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(file.config, ts.sys, dirname(configPath));
}

function programFrom(configPath, extraRoots = []) {
  const parsed = readConfig(join(ROOT, configPath));
  const rootNames = [...new Set([...parsed.fileNames, ...extraRoots.map((p) => join(ROOT, p))])];
  return ts.createProgram({ rootNames, options: { ...parsed.options, allowJs: true, checkJs: false, noEmit: true } });
}

function collect(dir, extensions) {
  const out = [];
  for (const name of ts.sys.readDirectory(join(ROOT, dir), extensions)) {
    if (!SKIP.test(name)) out.push(relative(ROOT, name).split("\\").join("/"));
  }
  return out;
}

const projects = [
  { name: "server", program: programFrom("tsconfig.server.json") },
  { name: "app", program: programFrom("tsconfig.json") },
  { name: "portable", program: programFrom("tsconfig.json", [...collect("shared", [".ts"]), ...collect("electron", [".mjs", ".ts"])]) },
];

const rel = (fileName) => relative(ROOT, fileName).split("\\").join("/");

function sourceFiles(program) {
  return program.getSourceFiles().filter((f) => !f.isDeclarationFile && !f.fileName.includes("node_modules") && !SKIP.test(rel(f.fileName)));
}

// Resolve a specifier to a real file inside the repo. The compiler resolver is asked
// first for every specifier, because it is the only thing that understands tsconfig
// `paths` aliases (`@/*` -> `src/*`) and extension-less bundler resolution. Bailing out
// on non-relative specifiers was a bug in the first version: it silently dropped
// hundreds of alias imports and made thousands of live exports look dead.
function resolveSpec(fromPath, spec, options) {
  const resolved = ts.resolveModuleName(spec, join(ROOT, fromPath), options, ts.sys).resolvedModule;
  if (resolved && !resolved.resolvedFileName.includes("node_modules")) {
    const path = rel(resolved.resolvedFileName);
    if (!path.startsWith("..")) return { kind: "file", path, via: spec.startsWith(".") ? "ts" : "ts-alias" };
  }
  if (!spec.startsWith(".")) return { kind: "external" };
  const base = normalize(join(ROOT, dirname(fromPath), spec));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, join(base, "index.ts"), join(base, "index.tsx")];
  if (spec.endsWith(".js")) candidates.unshift(base.replace(/\.js$/, ".ts"));
  for (const candidate of candidates) if (ts.sys.fileExists(candidate)) return { kind: "file", path: rel(candidate), via: "probe" };
  return { kind: "missing" };
}

const edges = [];
const missing = [];
const fallbacks = [];
const viewed = new Set();

for (const { program } of projects) {
  const options = program.getCompilerOptions();
  for (const file of sourceFiles(program)) {
    const fromPath = rel(file.fileName);
    if (viewed.has(fromPath + ":" + options.module)) continue;
    viewed.add(fromPath + ":" + options.module);
    const visit = (node, kind, spec) => {
      const target = resolveSpec(fromPath, spec, options);
      if (target.kind === "missing") missing.push({ from: fromPath, spec });
      else if (target.kind === "file") {
        if (target.via === "probe") fallbacks.push({ from: fromPath, spec, to: target.path });
        edges.push({ from: fromPath, to: target.path, spec, kind, via: target.via });
      }
    };
    const walk = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const spec = node.moduleSpecifier;
        if (spec && ts.isStringLiteral(spec)) {
          const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly;
          visit(node, typeOnly ? "type" : ts.isExportDeclaration(node) ? "reexport" : "import", spec.text);
        }
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        visit(node, "dynamic", node.arguments[0].text);
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        visit(node, "require", node.arguments[0].text);
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
  }
}

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

for (const { program } of projects) {
  const checker = program.getTypeChecker();
  const options = program.getCompilerOptions();
  for (const file of sourceFiles(program)) {
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
          const target = resolveSpec(fromPath, node.moduleSpecifier.text, options);
          if (target.kind === "file") markAll(target.path);
        } else {
          for (const element of bindings.elements) {
            const origin = originOf(checker, checker.getSymbolAtLocation(element.name));
            if (origin) usedNames.set(origin.path + "\u0000" + origin.name, true);
          }
        }
      } else if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveSpec(fromPath, node.moduleSpecifier.text, options);
        if (target.kind === "file") markAll(target.path);
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
  }
}

const exportsByFile = new Map();
for (const { program } of projects) {
  const checker = program.getTypeChecker();
  for (const file of sourceFiles(program)) {
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

function label(path) {
  const parts = path.split("/");
  if (parts[0] === "server") {
    if (parts.length === 2) return "server (root files)";
    if (parts[1] === "colonie") return parts.length > 3 ? `server/colonie/${parts[2]}` : "server/colonie (root)";
    return `server/${parts[1]}`;
  }
  if (parts[0] === "src") {
    if (parts[1] === "features" && parts.length > 3) return `src/features/${parts[2]}`;
    if (parts.length === 2) return "src (root files)";
    return `src/${parts[1]}`;
  }
  return parts[0];
}

const labelEdges = new Map();
for (const edge of edges) {
  if (edge.from === edge.to) continue;
  const key = label(edge.from) + "\u0000" + label(edge.to);
  labelEdges.set(key, (labelEdges.get(key) ?? 0) + 1);
}

const RULES = [
  { id: "no-imports-of-index", why: "index.ts is the entry point; nothing may depend on it (blueprint section 7)", hit: (e) => e.to === "server/index.ts" },
  { id: "shared-is-portable", why: "shared/ is imported by both sides and may not reach into server, UI or the shell", hit: (e) => label(e.from) === "shared" && ["server", "src", "electron"].includes(label(e.to).split("/")[0]) },
  { id: "no-server-to-ui", why: "the server may not import renderer code", hit: (e) => label(e.from).startsWith("server") && label(e.to).startsWith("src") },
  { id: "no-ui-to-server", why: "the UI may not reach into server internals (SQL, credentials, providers)", hit: (e) => label(e.from).startsWith("src") && label(e.to).startsWith("server") },
  { id: "feature-not-to-harness", why: "a feature may not import the composition/startup layer", hit: (e) => label(e.from).startsWith("server/colonie/") && label(e.to) === "server/harness" },
  { id: "feature-not-to-routes", why: "route adapters depend on features, never the reverse", hit: (e) => label(e.from).startsWith("server/colonie/") && label(e.to) === "server/routes" },
];
const violations = [];
for (const edge of edges) {
  const withLabels = { ...edge, fromLabel: label(edge.from), toLabel: label(edge.to) };
  for (const rule of RULES) if (rule.hit(withLabels)) violations.push({ rule: rule.id, from: edge.from, to: edge.to, spec: edge.spec, kind: edge.kind });
}

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
  programs: projects.map((p, i) => ({ name: projects[i].name, files: sourceFiles(p.program).length })),
  totals: {
    files: allFiles.size,
    edges: edges.length,
    aliasEdges: edges.filter((e) => e.via === "ts-alias").length,
    unresolvedRelativeSpecs: missing.length,
    probeResolutions: fallbacks.length,
  },
  rules: RULES.map((rule) => ({ id: rule.id, why: rule.why, violations: violations.filter((v) => v.rule === rule.id).length })),
  violations,
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
console.log("\ndirection rules:");
for (const rule of artifact.rules) console.log(`  ${rule.violations === 0 ? "ok  " : "HIT "} ${String(rule.violations).padStart(3)}  ${rule.id} — ${rule.why}`);
console.log("\nviolations:");
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
