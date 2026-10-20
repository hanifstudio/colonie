# Structure checks

The measurements and rules behind `pnpm structure:check`, which enforces the
[code structure](../COLONIE-BLUEPRINT.md#code-structure) in the blueprint.

| File | Produced by | Contents |
|---|---|---|
| `history.json` | `node scripts/structure/measure-history.mjs` | Change locality and co-change pairs over the whole non-merge history. |
| `graph.json` | `node scripts/structure/measure-graph.mjs` | Import graph from the TypeScript compiler: edges, cycles, boundary-rule hits, exported-but-never-imported names, public surface sizes. |
| `../scripts/structure/import-boundaries.json` | hand-written, ratcheted | The rules themselves. `pnpm structure:check` and `scripts/testing/import-boundaries.test.mjs` both read this file. |
| `map.md` | hand-written, checked | What each folder under `server/` owns. `pnpm structure:check` fails when a folder that holds source files has no line here, or when a line names a folder that is gone. |

The three `.mjs` tools are read-only and deterministic. `graph.mjs` is the single
resolver: the measurement and the guard import it, so they can never disagree about
what an edge is. The measurement scripts write the HEAD hash, not a timestamp, so an
artifact reproduced at the same commit is byte-identical.

## The check

`pnpm structure:check` builds the compiler-derived graph, applies
`scripts/structure/import-boundaries.json`, checks `map.md` against the folders that
actually exist, and exits non-zero when:

1. an import crosses a boundary the matrix does not grandfather (exit 1 — the message
   names the rule, the edge and the reason for the rule);
2. the matrix was loosened relative to `--base <ref>` (exit 2): a new grandfather, a
   path dropped from a deny rule, or a new exception. Loosening is still possible, but
   only as a change to the base revision in its own commit, because a baseline anybody
   can raise in the same change that violates it just freezes today's mess;
3. a grandfathered entry became stale (exit 3): the violation was fixed, so the entry
   must go, or the same edge can come back unremarked;
4. the module map is out of date (exit 1): a folder under `server/` holds source files but
   has no line in `map.md`, or `map.md` names a folder that no longer exists. A missing map
   line is a one-line fix, and it is the notification that a new folder appeared without
   anyone deciding what it owns.

`scripts/testing/import-boundaries.test.mjs` runs the same rules on every `pnpm test`
(`vite.config.ts` includes `scripts/**/*.test.mjs`), so the check is not optional. It
tests the shipped matrix rather than a copy, plus adversarial cases: `server/harness-extra/`
must not inherit the `server/harness/` rule, `shared-utils/` must not inherit `shared/`,
`server/index.ts.map` must not count as `server/index.ts`. `scripts/testing/structure-map.test.mjs`
does the same for the map, including a guard against the walk returning a nearly empty list
and passing for the wrong reason.

Falsification evidence (the guard must be able to fail): a temporary file
`server/harness/__falsify-boundary.ts` importing `src/lib/cn.ts` produced
`no-server-to-ui: server/harness/__falsify-boundary.ts -> src/lib/cn.ts` and exit 1;
deleting the file restored exit 0. The probe was removed in the same command. The map check
was falsified the same way: a temporary `server/colonie/__falsify-map/probe.ts` produced
`MISSING  server/colonie/__falsify-map/ holds source files but has no line in the map` and
exit 1, and after deleting the folder the check was clean again with `git status --short
server/` empty.

Two further tests verify the graph the rules run on, because a missing file or a missing
edge makes a rule pass silently, and a silent pass is worse than no check. They walk the
tree from disk and parse statements instead of reusing the graph builder:

- every source file under `server/`, `src/`, `shared/`, `electron/` and `scripts/` must
  appear in the graph;
- every import statement the parser can see must appear as an edge, once a deliberately
  dumb path probe can name its target. Specifiers only a bundler can resolve (`.css`,
  `.png`, `?raw`) are counted and reported, not asserted.

Those two tests earned their place immediately. They found that
`parseJsonConfigFileContent` collects only the extensions a tsconfig enables, so
`server/testing/*.mjs` was invisible to every rule while `server/` was nominally covered;
that `ts.resolveModuleName("./x.mjs")` returns `x.d.mts` when a type stub sits beside the
implementation, so a rule about `electron/colonie.mjs` was evaluating a file that never
runs; and that `electron/fixtures/browser-closed-shadow.cjs` requires
`electron/browser-surface.cjs`, which does not exist.


## Why this exists

The restructure was steered by line counts, which is a weak proxy for the goal — an
agent can find the right file and change it without collateral damage. Measuring that
goal needs two kinds of raw material: what the change history says about coupling, and
what the compiler says about the import graph. Both are needed before writing a rule,
otherwise the rule encodes a taste instead of a fact.

## Findings at `69707a05` (October 18, 2026)

**History — 3,231 non-merge commits, 4,591 files, +1,196,132/−855,751 lines.**

- Locality is already reasonable: median change touches 3 files in 2 folders; 27% touch
  a single file; 36% a single folder. The tail is the problem: p90 is 18 files/11
  folders, p99 66/33, and the maximum is a 968-file sweep.
- The coupling centre is the old hub and its neighbours, which is a historic artifact
  of the v1 shape rather than a statement about today: `server/index.ts` appears in 817
  commits with a median 7 co-changed files; `src/state/store.tsx` 305 (co-change 15);
  `src/locales/en.json` 298 (15); `server/index.test.ts` 287 (9); `package.json` 213.
- Strongest pairs: `server/index.test.ts ↔ server/index.ts` (203),
  `server/index.ts ↔ src/state/store.tsx` (191), `server/index.ts ↔ server/store.ts`
  (145), `server/index.ts ↔ src/locales/en.json` (120).

**Graph — 1,080 source files, 3,685 edges (920 through the `@/*` alias), 4 unresolved.**

Four direction rules are already at zero violations, so they are cheap to enforce from
day one: nothing imports `server/index.ts`; `shared/` reaches into neither `server/`,
`src/` nor `electron/`; the server never imports renderer code; the renderer never
imports server internals. Two more were tested and **are mis-specified** — the two were
merged into the single `feature-not-to-composition` rule with the sanctioned modules
named as exceptions:

| Candidate rule | Hits | What the hits actually are |
|---|---|---|
| features may not import `server/routes/` | 6 | Five import `routes/table.ts`, the shared route contract that the blueprint explicitly sanctions for feature-owned adapters. One real hit: `colonie/computer/desktop-viewer-targets.ts → routes/desktop-viewer.ts`. |
| features may not import `server/harness/` | 3 | Two import `harness/http.ts` (shared request/response helpers), one imports a type from `harness/registry.ts`. The intended prohibition is the composition/startup layer, not shared helpers. |

All five rules now hold at zero violations with an empty `baseline`, so no crossing is
grandfathered anymore. The one real hit in the first row above was fixed rather than
suppressed: the viewer contract moved into the feature
(`colonie/computer/desktop-viewer-contract.ts`) and `routes/desktop-viewer.ts` imports it
from there, which is the direction the blueprint asks for. The type import behind the one
real hit in the second row was fixed by moving that file — the memory-upkeep wiring, which
its own header describes as assembly `index.ts` supplies — to `server/harness/`, where the
rest of the startup wiring lives. Both baseline entries were then deleted; the guard exits
3 if one is left unused, so a grandfather that stops being needed cannot quietly stay.

- 10 file-level cycles (SCC > 1). Largest: 14 files around `server/commands.ts`,
  `colonie/workspace/workspace.ts` and the memory store/journal. Then a 3-file
  `shared/{model-request,wire,team-setup}` cycle, a 3-file teams package cycle, a 3-file
  renderer lazy-screen cycle, and two 2-file cycles (`skills.ts ↔ skill-library.ts`,
  `src/state/store.tsx ↔ src/state/bot-patch-queue.ts`).
- 54 mutually-importing folder pairs. The top ones are the server root leftovers
  mutually coupled with features: `server (root files) ↔ server/colonie/chat` (27/66),
  `↔ harness` (15/47), `↔ colonie/providers` (11/26), `↔ colonie/computer` (15/13), and
  24 folders inside one mutual blob. `src/components ↔ src/lib` (600/3) is a renderer
  back-edge, not a server boundary question.
- 1,997 exported names are never imported by name anywhere (see limits). Largest
  public surfaces: `server/config.ts` (83 exports), `shared/package-format.ts` (53),
  `colonie/computer/container-computer.ts` (53), `src/state/store.tsx` (51).

## What this already changed

- Two candidate rules were replaced by their real content (shared contract vs
  composition layer). Without the measurement they would have flagged five
  blueprint-sanctioned imports as violations and taught the team to ignore the check.
- Folder-level cycles at this granularity are one 24-folder blob and carry no signal;
  the useful signal is the file-level SCC list and the mutual-pair list, which stays.
- Two electron test files import scripts that do not exist
  (`scripts/patch-mac-updater.mjs`, `scripts/patch-appimage-updater.mjs`), and
  `electron/fixtures/browser-closed-shadow.cjs` requires `electron/browser-surface.cjs`,
  which does not exist either. Inherited breakage, reported here, not fixed by this
  measurement. The guard prints these as warnings: an unresolved import is a broken file,
  not a boundary crossing. `scripts/desktop-server-entry.mjs` importing `./index.js` is
  the one expected entry in that list, because it names the bundled output on purpose.
- The first artifact's edge count was wrong by 38: `shared/` files are pulled into two
  programs, and the first version walked them once per program, double-counting their
  outgoing edges. Deduplicating by path (now inside `graph.mjs`) corrected 3,710 → 3,672.
  Having one resolver for both the measurement and the guard is what made that correction
  reach both at once.
- Two further defects in the graph were found by the independent walk and fixed: the
  graph missed `server/testing/*.mjs` entirely (tsconfig `include` collects only the
  extensions that config enables, so `allowJs` did not help), and a specifier naming an
  implementation file could resolve to its `.d.mts` type stub instead. Program roots are
  now listed from disk per area, and a declaration target is mapped back to its
  implementation. The graph went 3,672 → 3,682 edges and 1,061 → 1,077 files, which is
  coverage gained, not work invented.

## Limits — read before quoting a number

- **The dead-export count is measured, not independently verified.** 25 spot checks
  first read as 4 wrong and 21 right, but every one of the 4 was the *check* being
  wrong, not the metric: naive `grep` matches a re-export line
  (`export { N } from "x"` is not a use) and cannot tell two same-named symbols in
  different files apart (`SignInLists` exists in both the server and the renderer).
  Verifying this metric needs an independent implementation (`knip`,
  `ts-unused-exports`), which E01.3 must add before any rule cites the number. Neither is
  installed today, and adding a dependency is a decision rather than a cleanup, so it is
  recorded as open. The import graph — the part the guard actually runs on — was verified
  instead, because a wrong edge silently disables a rule while a wrong dead-export count
  only misinforms a reader.
- The metric counts a name as dead only when it is declared in that file and never
  imported by name anywhere in the three programs; names reachable only through a
  namespace import or `export * from` are treated as used, so the figure is a lower
  bound on dead surface, not an inventory.
- The history covers the whole repository including the pre-restructure era. It is a
  baseline for locality, not a verdict on the current shape; S3.x is a small fraction
  of it.
- These tools cannot see responsibility mixing inside one file, duplicated rules
  across features, or concept leakage. Those stay a periodic review artifact.
- Enforcement in CI is **blocked, not enabled**: commit `263666d9` ("clean slate")
  deleted `scripts/ci-scope.mjs` and the whole `scripts/testing/` tree, while
  `.github/workflows/ci.yml` still runs them, so the static job cannot pass and the
  vitest job it gates never starts. Until that is decided, `pnpm structure:check` and
  `pnpm test` are the enforcement points. Re-creating those scopes or accepting that CI
  no longer runs them is an owner decision, not a cleanup this measurement may make.
