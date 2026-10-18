// Structural evidence, part 1: what the change history says about coupling.
//
// Why this exists: the restructure so far was judged by file size, which is a weak
// proxy for the owner's actual goal — an agent can find the right file and change it
// without collateral damage. This script derives that property from raw material
// instead: the full `git log --numstat` history. It reports change locality (how many
// files and folders one change touches) and co-change pairs (which files keep moving
// together), so a later boundary rule can cite evidence rather than taste.
//
// Run: node scripts/structure/measure-history.mjs
// Writes docs/structure/history.json. The artifact holds the HEAD hash instead of a
// timestamp, so a third party reproduces it exactly by checking out the same commit.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const RECORD = "\u0001";
const FIELD = "\u0002";

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

// numstat prints renames as `old => new` or `dir/{old => new}/file`, and binary
// files with `-` in both count columns.
function targetPath(printed) {
  if (printed.includes("=>")) {
    return printed
      .replace(/\{[^{}]*=>\s*([^{}]*)\}/g, "$1")
      .replace(/^.*=>\s*/, "")
      .replace(/\/{2,}/g, "/")
      .trim();
  }
  return printed.trim();
}

function owner(path) {
  const parts = path.split("/");
  if (parts[0] === "server" && parts[1] === "colonie") return parts.slice(0, 3).join("/");
  if (parts[0] === "src" && parts[1] === "features") return parts.slice(0, 3).join("/");
  return parts.slice(0, 2).join("/");
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

const raw = git(["log", "--numstat", "--no-merges", "--format=" + RECORD + "%H" + FIELD + "%ad", "--date=short"]);
const commits = [];
for (const chunk of raw.split(RECORD)) {
  if (!chunk.trim()) continue;
  const newline = chunk.indexOf("\n");
  const header = newline < 0 ? chunk : chunk.slice(0, newline);
  const [hash, date] = header.split(FIELD);
  const files = [];
  for (const line of (newline < 0 ? "" : chunk.slice(newline + 1)).split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted, ...rest] = line.split("\t");
    const path = targetPath(rest.join("\t"));
    if (!path) continue;
    files.push({ path, added: added === "-" ? 0 : Number(added), deleted: deleted === "-" ? 0 : Number(deleted) });
  }
  if (files.length) commits.push({ hash, date, files });
}

const perFile = new Map();
const pairCount = new Map();
const fileCommits = [];
const dirCommits = [];
let addedTotal = 0;
let deletedTotal = 0;

for (const commit of commits) {
  const paths = [...new Set(commit.files.map((f) => f.path))];
  const dirs = [...new Set(paths.map(owner))];
  fileCommits.push(paths.length);
  dirCommits.push(dirs.length);
  for (const file of commit.files) {
    addedTotal += file.added;
    deletedTotal += file.deleted;
    const entry = perFile.get(file.path) ?? { commits: 0, added: 0, deleted: 0, coChange: [] };
    entry.commits += 1;
    entry.added += file.added;
    entry.deleted += file.deleted;
    entry.coChange.push(paths.length - 1);
    perFile.set(file.path, entry);
  }
  // Pairs only make sense for ordinary changes; a giant sweep couples everything to
  // everything and would drown the signal.
  if (paths.length < 2 || paths.length > 40) continue;
  const sorted = [...paths].sort();
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const key = sorted[i] + "\u0000" + sorted[j];
      pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
    }
  }
}

const byCommits = [...perFile.entries()].sort((a, b) => b[1].commits - a[1].commits);
const topFiles = byCommits.slice(0, 30).map(([path, entry]) => {
  const sorted = [...entry.coChange].sort((a, b) => a - b);
  return { path, commits: entry.commits, medianCoChange: percentile(sorted, 0.5), p90CoChange: percentile(sorted, 0.9) };
});
const topPairs = [...pairCount.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 40)
  .map(([key, count]) => {
    const [a, b] = key.split("\u0000");
    return { a, b, commits: count };
  });

const fileSorted = [...fileCommits].sort((a, b) => a - b);
const dirSorted = [...dirCommits].sort((a, b) => a - b);

const artifact = {
  head: git(["rev-parse", "HEAD"]).trim(),
  commits: commits.length,
  firstDate: commits.length ? commits[commits.length - 1].date : null,
  lastDate: commits.length ? commits[0].date : null,
  churn: { added: addedTotal, deleted: deletedTotal, files: perFile.size },
  locality: {
    filesPerChange: { p50: percentile(fileSorted, 0.5), p75: percentile(fileSorted, 0.75), p90: percentile(fileSorted, 0.9), p99: percentile(fileSorted, 0.99), max: fileSorted.at(-1) ?? 0 },
    foldersPerChange: { p50: percentile(dirSorted, 0.5), p75: percentile(dirSorted, 0.75), p90: percentile(dirSorted, 0.9), p99: percentile(dirSorted, 0.99), max: dirSorted.at(-1) ?? 0 },
    singleFileChanges: fileCommits.filter((n) => n === 1).length,
    singleFolderChanges: dirCommits.filter((n) => n === 1).length,
  },
  mostChanged: topFiles,
  coupledPairs: topPairs,
};

mkdirSync(join(ROOT, "docs/structure"), { recursive: true });
writeFileSync(join(ROOT, "docs/structure/history.json"), JSON.stringify(artifact, null, 2) + "\n");

const l = artifact.locality;
console.log(`commits ${artifact.commits}  files ${artifact.churn.files}  churn +${addedTotal}/-${deletedTotal}`);
console.log(`locality: files p50 ${l.filesPerChange.p50} p90 ${l.filesPerChange.p90} max ${l.filesPerChange.max}` +
  `   folders p50 ${l.foldersPerChange.p50} p90 ${l.foldersPerChange.p90} max ${l.foldersPerChange.max}`);
console.log(`single-file changes ${l.singleFileChanges}/${commits.length}   single-folder changes ${l.singleFolderChanges}/${commits.length}`);
console.log("\nmost changed (commits, median co-change):");
for (const f of topFiles.slice(0, 15)) console.log(`  ${String(f.commits).padStart(4)}  co ${String(f.medianCoChange).padStart(3)}  ${f.path}`);
console.log("\nmost coupled pairs:");
for (const p of topPairs.slice(0, 12)) console.log(`  ${String(p.commits).padStart(4)}  ${p.a}  <->  ${p.b}`);
