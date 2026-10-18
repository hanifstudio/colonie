// Shared structural input: the repository's real import graph, taken from the
// TypeScript compiler.
//
// Why this is a module instead of part of one script: the guard
// (`pnpm structure:check`, `scripts/testing/import-boundaries.test.mjs`) and the
// measurement tool (`measure-graph.mjs`) must see exactly the same edges. A second
// resolver would drift, and a boundary check that disagrees with the evidence it cites
// is worse than no check at all.
//
// Everything here is read-only and asks the compiler rather than the text, because
// text matching is wrong for the cases that already bit this repository: `@/*` path
// aliases (920 of the edges come through one), extension-less bundler resolution,
// `export ... from`, dynamic `import()` and `require()`.
//
// Three programs are built because the areas compile differently and neither tsconfig
// includes `shared/` or `electron/`, which are exactly the areas a portability rule is
// about: server/** under tsconfig.server.json, src/** plus vite.config.ts under
// tsconfig.json, and shared/** plus electron/** under a readable variant of
// tsconfig.json.

import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";

const SKIP = /(^|\/)(node_modules|dist|dist-server|dist-electron|release|vendor)\//;

function readConfig(configPath) {
  const file = ts.readConfigFile(configPath, ts.sys.readFile);
  if (file.error) throw new Error(ts.flattenDiagnosticMessageText(file.error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(file.config, ts.sys, dirname(configPath));
}

function collect(root, dir, extensions) {
  return ts.sys
    .readDirectory(join(root, dir), extensions)
    .filter((name) => !SKIP.test(name))
    .map((name) => relative(root, name).split("\\").join("/"));
}

export function relativePath(root, fileName) {
  return relative(root, fileName).split("\\").join("/");
}

// Resolve a specifier to a real file inside the repository. The compiler resolver is
// asked first for every specifier, because it is the only thing that understands
// tsconfig `paths` aliases and extension-less bundler resolution; bailing out on
// non-relative specifiers was a bug in the first version of this measurement, because
// it silently dropped every `@/*` import. The file probe is a counted fallback for
// targets outside a program (`.mjs` files); a fallback that fires often means the graph
// is no longer fully compiler-derived.
export function resolveSpec(root, fromPath, spec, options) {
  const resolved = ts.resolveModuleName(spec, join(root, fromPath), options, ts.sys).resolvedModule;
  if (resolved && !resolved.resolvedFileName.includes("node_modules")) {
    const path = relativePath(root, resolved.resolvedFileName);
    if (!path.startsWith("..")) return { kind: "file", path, via: spec.startsWith(".") ? "ts" : "ts-alias" };
  }
  if (!spec.startsWith(".")) return { kind: "external" };
  const base = normalize(join(root, dirname(fromPath), spec));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, join(base, "index.ts"), join(base, "index.tsx")];
  if (spec.endsWith(".js")) candidates.unshift(base.replace(/\.js$/, ".ts"));
  for (const candidate of candidates) {
    if (ts.sys.fileExists(candidate)) return { kind: "file", path: relativePath(root, candidate), via: "probe" };
  }
  return { kind: "missing" };
}

// Folder-level grouping used by the rules and by the measurement. The feature folder
// is the unit that matters for `server/colonie/<feature>`, because feature-owned route
// adapters live beside their services.
export function label(path) {
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

export function buildGraph(root) {
  const programs = [
    { name: "server", program: programFrom(root, "tsconfig.server.json") },
    { name: "app", program: programFrom(root, "tsconfig.json") },
    { name: "portable", program: programFrom(root, "tsconfig.json", [...collect(root, "shared", [".ts"]), ...collect(root, "electron", [".mjs", ".ts"])]) },
  ];

  const edges = [];
  const missing = [];
  const fallbacks = [];
  const viewed = new Set();
  const sources = [];

  for (const { program } of programs) {
    const options = program.getCompilerOptions();
    for (const file of sourceFiles(root, program)) {
      const fromPath = relativePath(root, file.fileName);
      // A file that appears in two programs is walked once; the first program that
      // declares it owns its resolution options.
      if (viewed.has(fromPath)) continue;
      viewed.add(fromPath);
      sources.push(fromPath);
      const visit = (kind, spec) => {
        const target = resolveSpec(root, fromPath, spec, options);
        if (target.kind === "missing") missing.push({ from: fromPath, spec });
        else if (target.kind === "file") {
          if (target.via === "probe") fallbacks.push({ from: fromPath, spec, to: target.path });
          edges.push({ from: fromPath, to: target.path, spec, kind, via: target.via });
        }
      };
      const walk = (node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          const specifier = node.moduleSpecifier;
          if (specifier && ts.isStringLiteral(specifier)) {
            const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly;
            visit(typeOnly ? "type" : ts.isExportDeclaration(node) ? "reexport" : "import", specifier.text);
          }
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
          visit("dynamic", node.arguments[0].text);
        } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
          visit("require", node.arguments[0].text);
        }
        ts.forEachChild(node, walk);
      };
      walk(file);
    }
  }

  return { programs, sources, edges, missing, fallbacks };
}

export function sourceFiles(root, program) {
  return program.getSourceFiles().filter((file) => !file.isDeclarationFile && !file.fileName.includes("node_modules") && !SKIP.test(relativePath(root, file.fileName)));
}

function programFrom(root, configPath, extraRoots = []) {
  const parsed = readConfig(join(root, configPath));
  const rootNames = [...new Set([...parsed.fileNames, ...extraRoots.map((path) => join(root, path))])];
  return ts.createProgram({ rootNames, options: { ...parsed.options, allowJs: true, checkJs: false, noEmit: true } });
}
