// Keeps docs/structure/map.md true.
//
// Why this exists: the module map is only worth reading while it matches the tree. A new
// folder that nobody maps is exactly the situation the map is supposed to prevent, so the
// check is mechanical: every folder under `server/` that holds source files of its own has
// to be named in the map, and every folder the map names has to exist.
//
// Deliberately narrow: only the server tree is required to be mapped folder by folder,
// because that is the tree this project is restructuring. Other roots are checked for dead
// references only.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".cjs"];
const MAPPED_ROOT = "server";
const KNOWN_ROOTS = ["server", "src", "shared", "electron", "scripts", "docs"];
const IGNORED = new Set(["node_modules", "dist", "dist-server", "dist-electron", "release", "vendor", "resources", ".git"]);

/** Folder paths written as `some/path/` in a document, restricted to repository roots. */
export function mentionedFolders(text) {
  const found = new Set();
  for (const match of text.matchAll(/`([A-Za-z0-9._@/-]+\/)`/g)) {
    const path = match[1];
    if (KNOWN_ROOTS.some((root) => path === `${root}/` || path.startsWith(`${root}/`))) found.add(path);
  }
  return [...found].sort();
}

/** Every folder under `server/` (any depth) that holds source files of its own. */
export function mappedFolders(root) {
  const found = [];
  const walk = (dir) => {
    const entries = readdirSync(join(root, dir), { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)))) found.push(`${dir}/`);
    for (const entry of entries) {
      if (entry.isDirectory() && !IGNORED.has(entry.name)) walk(`${dir}/${entry.name}`);
    }
  };
  walk(MAPPED_ROOT);
  return found.sort();
}

/** Pure comparison so the rule can be tested without touching the tree. */
export function compareMap(actual, mentioned, root = ".") {
  return {
    missing: actual.filter((folder) => !mentioned.includes(folder)),
    unknown: mentioned.filter((folder) => !actual.includes(folder) && !isDirectory(join(root, folder))),
  };
}

export function evaluateMap(root, docPath = "docs/structure/map.md") {
  const mentioned = mentionedFolders(readFileSync(join(root, docPath), "utf8"));
  const actual = mappedFolders(root);
  return { mentioned, actual, ...compareMap(actual, mentioned, root) };
}

function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}
