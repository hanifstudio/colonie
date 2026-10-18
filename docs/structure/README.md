# Structure baseline (E01 evidence)

Raw measurements behind the enforceable-architecture-checks stage
([blueprint](../COLONIE-BLUEPRINT.md#engineering-roadmap-architecture-and-consistency),
handover "Active engineering stage: E01"). These files are evidence, not rules: the
rules that follow from them live in `scripts/testing/` once E01.3 lands.

| File | Produced by | Contents |
|---|---|---|
| `history.json` | `node scripts/structure/measure-history.mjs` | Change locality and co-change pairs over the whole non-merge history. |
| `graph.json` | `node scripts/structure/measure-graph.mjs` | Import graph from the TypeScript compiler: edges, cycles, direction-rule hits, exported-but-never-imported names, public surface sizes. |

Both scripts are read-only and deterministic. They write the HEAD hash, not a
timestamp, so an artifact reproduced at the same commit is byte-identical. Both ask
`git` and the TypeScript compiler directly; neither is part of the test suite.

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

**Graph — 1,061 files, 3,710 edges (920 through the `@/*` alias), 2 unresolved.**

Four direction rules are already at zero violations, so they are cheap to enforce from
day one: nothing imports `server/index.ts`; `shared/` reaches into neither `server/`,
`src/` nor `electron/`; the server never imports renderer code; the renderer never
imports server internals. Two more were tested and **are mis-specified**:

| Candidate rule | Hits | What the hits actually are |
|---|---|---|
| features may not import `server/routes/` | 6 | Five import `routes/table.ts`, the shared route contract that the blueprint explicitly sanctions for feature-owned adapters. One real hit: `colonie/computer/desktop-viewer-targets.ts → routes/desktop-viewer.ts`. |
| features may not import `server/harness/` | 3 | Two import `harness/http.ts` (shared request/response helpers), one imports a type from `harness/registry.ts`. The intended prohibition is the composition/startup layer, not shared helpers. |

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
  (`scripts/patch-mac-updater.mjs`, `scripts/patch-appimage-updater.mjs`). Inherited
  breakage, reported here, not fixed by this measurement.

## Limits — read before quoting a number

- **The dead-export count is measured, not independently verified.** 25 spot checks
  first read as 4 wrong and 21 right, but every one of the 4 was the *check* being
  wrong, not the metric: naive `grep` matches a re-export line
  (`export { N } from "x"` is not a use) and cannot tell two same-named symbols in
  different files apart (`SignInLists` exists in both the server and the renderer).
  Verifying this metric needs an independent implementation (`knip`,
  `ts-unused-exports`), which E01.3 must add before any rule cites the number.
- The metric counts a name as dead only when it is declared in that file and never
  imported by name anywhere in the three programs; names reachable only through a
  namespace import or `export * from` are treated as used, so the figure is a lower
  bound on dead surface, not an inventory.
- The history covers the whole repository including the pre-restructure era. It is a
  baseline for locality, not a verdict on the current shape; S3.x is a small fraction
  of it.
- These tools cannot see responsibility mixing inside one file, duplicated rules
  across features, or concept leakage. Those stay a periodic review artifact.
