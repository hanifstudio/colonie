// The rules a commit must pass, whichever model or person makes it. Run by
// scripts/git-hooks/pre-commit. Only the owner bypasses it (`git commit
// --no-verify`); agent settings deny that flag.
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

const HANDOVER = "docs/HANDOVER.md";
const HANDOVER_MAX_LINES = 100;
// The documents AGENTS.md allows. A new one is refused: its content belongs in one of these.
const ALLOWED_DOCS = new Set([
  "docs/COLONIE-BLUEPRINT.md", HANDOVER, "docs/tool-selection.md", "docs/verification/README.md",
  "docs/structure/README.md", "docs/structure/map.md", "docs/structure/graph.json", "docs/structure/history.json",
]);
const TEST_FILE = /\.(test|node-test|e2e\.test)\.[cm]?[jt]sx?$/;
// Codes like E02.4b, S3.37, M0.2, and the stage and question IDs the old docs used.
const CODE = /\b(?:[A-Z]\d{1,2}(?:\.\d+)+[a-z0-9]*|E0\d|J0\d|Q\d\d|W0\d|B0\d|D\d\d|P[0-7]|L[1-9])\b/g;

const isDoc = (path) => path === "AGENTS.md" || (path.startsWith("docs/") && path.endsWith(".md"));

/**
 * What is wrong with a set of staged changes. `changes` is `{ status, path }[]`
 * from `git diff --cached --name-status` (status A, M, D, or R…); `staged(path)`
 * returns that file's staged text.
 */
export function commitProblems(changes, staged) {
  const problems = [];
  for (const { status, path } of changes) {
    if (status === "D" && TEST_FILE.test(path)) {
      problems.push(`${path}: a test file is deleted. Fix the code or the test instead; only the owner removes tests.`);
    }
    if (status === "A" && path.startsWith("docs/") && !ALLOWED_DOCS.has(path)) {
      problems.push(`${path}: a new document. Put this in HANDOVER, the blueprint, or the commit message (see AGENTS.md).`);
    }
    if (status === "D" || !isDoc(path)) continue;
    const text = staged(path);
    const codes = [...new Set(text.match(CODE) ?? [])];
    if (codes.length) problems.push(`${path}: invented codes ${codes.join(", ")}. Name things in plain words.`);
    if (path === HANDOVER) {
      const lines = text.replace(/\n$/, "").split("\n").length;
      if (lines > HANDOVER_MAX_LINES) {
        problems.push(`${HANDOVER}: ${lines} lines, limit ${HANDOVER_MAX_LINES}. Delete finished work; history is in Git.`);
      }
    }
  }
  return problems;
}

/** True when anything besides documentation changed, so the code checks must run. */
export function needsCodeChecks(changes) {
  return changes.some(({ status, path }) => status !== "D" && !path.endsWith(".md"));
}

function stagedChanges(root) {
  const out = execFileSync("git", ["diff", "--cached", "--name-status", "-M"], { cwd: root, encoding: "utf8" });
  return out.split("\n").filter(Boolean).map((line) => {
    const [status, ...paths] = line.split("\t");
    return { status: status[0], path: paths.at(-1) };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(import.meta.dirname, "..");
  const changes = stagedChanges(root);
  const staged = (path) => execFileSync("git", ["show", `:${path}`], { cwd: root, encoding: "utf8" });
  const problems = commitProblems(changes, staged);
  if (problems.length) {
    console.error(`Commit refused:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  if (needsCodeChecks(changes)) {
    console.error("commit guard: running pnpm check (about a minute)…");
    const run = spawnSync("pnpm", ["-s", "check"], { cwd: root, stdio: "inherit" });
    if (run.status !== 0) {
      console.error("Commit refused: pnpm check failed. Fix the failure; do not weaken the check.");
      process.exit(1);
    }
  }
}
