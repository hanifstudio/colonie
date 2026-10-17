# Colonie recent progress

Product direction is in [the blueprint](COLONIE-BLUEPRINT.md). Current implementation
and the next action are in [HANDOVER](HANDOVER.md). Keep this evidence log concise.

## 2026-10-17 — rooms retirement, stage 3b part 1 (room turn engine out of `server/index.ts`)

Picked up the in-flight stage 3b edit in `server/index.ts` (only file modified; 105
insertions / 3251 deletions after this work). It did not compile: `npx tsc -p
tsconfig.server.json --noEmit` reported 98 errors, 89 of them `TS2304 Cannot find
name` for `connectorThread` (37 uses), `drainConnectorResumes`, `approvalBus`,
`stagedSkillListing`, `resolveReplyTarget`, `messageFileRootsForThread`,
`attachmentVmForTurn`, `proposalPersistence`, `skillProposalPersistence`,
`appendSkillRequestCard`, `resolveSkillRequest`, `sendSkillResolution`,
`connectorMessage`, `maybeResumeConnectors`, `ComputerResumeEntry`,
`teammateReportContext`, `deliverCalendarCall`, `CONNECTOR_SLUG`,
`stagedSkillCleanupsForThread`, `rejectDeletedThreadSkillStages`.

Diagnosis: one contiguous 556-line region (the WIP's own lines 10382–10937) that
mixed live helper definitions — connectors, learned-skill proposal cards,
peer-approval bus, computer resumes, calendar delivery, reply targeting — with
room-only declarations had been deleted wholesale; each of those names had lost
exactly its single definition. Repair: restored that region verbatim from the same
in-flight state and then deleted only what was room-only inside it
(`GROUP_CONTEXT_MESSAGES` and its stale comment, `MAX_GROUP_HOPS`,
`GroupMemberTurnOutcome`/`GroupTurnOrchestration`, `roomPostBudgets` and
`ROOM_POST_MAX_CHARS`, `StartGroupTurnOptions`). Live behaviour kept: direct peer
handoffs (`RoomHandoffs` needs `room-handoff*`), the 1:1 steered queue, routines and
the connector/skill/approval paths.

State after this part: no room turn can run. `RoomHandoffs` refuses a room node,
the answer route answers 409, the routine `goalState`/`startGoal`/`interruptGoal`
callbacks are inert, and the group turn engine plus its callers
(`startGroupTurn`, `runGroupMemberTurn`, goal runs, room post budget) are gone.

- `npx tsc -p tsconfig.server.json --noEmit` — 0 errors (was 98).
- `npx tsc -b` (renderer config) — 0 errors; `git diff --check` clean.
- `npx oxlint --deny-warnings .` — exit 0.
- `npx vitest run server/room-handoffs.test.ts server/steer-queue.test.ts
  server/direct-coordination.e2e.test.ts --maxWorkers=1` — 515 s, 114 tests:
  `room-handoffs` 1/1 file pass; `steer-queue` 29/33 (the four dispatch-receipt
  cases recorded in HANDOVER item 7); `direct-coordination.e2e` 0/36, every failure
  a first-step `send_to_bot` evidence poll, i.e. the retired plan-runner fixture
  (HANDOVER item 6).
- Both red files re-run at the parent commit (`4aed9bac`) in a detached worktree with
  `node_modules` symlinked: `direct-coordination.e2e.test.ts` 36/36 failed (467 s)
  and `steer-queue.test.ts` 4 failed / 29 passed (65 s) — the same results as after
  the repair, so the red is inherited, not a regression here.
- Live paths after the repair: `npx vitest run server/respond-replay.e2e.test.ts
  server/usage-attribution.e2e.test.ts server/notification-wiring.test.ts
  --maxWorkers=1` — 3 files, 7 tests, all pass.
- Who left the tree mid-edit: the Claude Code session that produced the pre-cut state
  stopped at 06:47:58 on its weekly limit
  (`~/.claude/projects/-Users-riaenriala-Documents-etalas-colonie/864356db-*.jsonl`).
  The 07:44–07:47 writes came from concurrent opencode sessions on other models
  (`glm-5.3-flash-free`, `beam-free`, `muse-spark-1.3-contributor`), which is why the
  file changed during the repair. Their sound removals are kept.
- Method: the working tree was being written by other sessions in this checkout, so
  the file was hash-sampled until stable (last write 07:47:42) before editing, and
  the pre-edit copy is kept under the session scratch dir. Not run: the full suite,
  the remaining native-fixture e2e migrations, the renderer, packaging.

## 2026-10-17 — the retired Linode workspace host wiped clean

The owner asked for the slept-on Linode from the retired shared-workspace
feature (`colonie-vps`, 172.104.33.55, ap-south) to be shut down or at least
emptied. It was still reachable with the Mac's own key, so it was inventoried
over SSH and everything the product left on it was removed; the host itself
still needs deleting from the Linode console, which is the only thing that
stops the billing (a stopped or emptied instance is still billed).

What it actually held, and is now gone:

- `/var/www/colonie/downloads/Colonie-0.2.0-arm64.dmg` — 359,339,798 bytes,
  uploaded 2026-10-14 20:54 UTC, sha256 `f54448b4…c4f0ee`. The only installer on
  the host, and the only file it served.
- `/usr/local/bin/colonie-caddy` (48,521,378 bytes, static Go binary) plus
  `/etc/colonie/{Caddyfile,Caddyfile.pre-platform,https.env}` and Caddy's
  `/var/lib/colonie-https` data/config. Its Caddyfile served `/downloads/*` from
  the directory above and reverse-proxied everything else to `127.0.0.1:19091`
  under an ACME `shortlived` certificate for the bare IP — no domain, so there is
  no DNS record to remove.
- The `colonie` system user (uid 999, home `/opt/colonie`, which was already
  gone) and root's one-line shell history.

Found nothing else: no database, no Docker, no web server running, no cron,
no other users, no credential, key or `.env` file anywhere under those paths.
Remaining on the host is a stock Systemd image: SSH listening on 22, four days of
uptime, 3.6 G of 157 G used. Verification after the wipe: `find / -xdev -iname
"*colonie*"` returns nothing, `/var/www` and `/etc/colonie` are gone, `getent
passwd colonie` is empty, and only the SSH listeners remain.

Consequence to remember: any already-installed old build still pointed at that
address can no longer update itself. That is the intent of retiring the host, and
releases ship through the GitHub provider configured in `electron-builder.yml`.

## 2026-10-17 — E03.1 the person's own questions over ACP elicitation

`AskUserQuestion` reached Colonie over ACP as a plain tool permission, so a
question card could only be answered Allow/Deny. ACP has its own ask —
`elicitation/create` in form mode — and the claude adapter bridges
`AskUserQuestion` to it only for a client that advertises the capability
(`this.clientCapabilities?.elicitation?.form`), which this app did not. Both
halves are in now: `clientCapabilities.elicitation.form` at initialize (url mode
is deliberately not advertised — nothing here presents the agent's own URL flow),
and a handler for the request. The ask is re-read into the card's questions and
options, and the person's answer is written back under the form's own
`question_<n>` keys, preferring the option's `const` when a form titles an option
differently from its value. An elicitation nobody can answer (no live turn, wrong
session, a non-form ask) resolves `cancel`; a turn that ends or closes cancels
the pending asks with it, and no approval mode may ever answer one.

- `vitest run server/acp/elicitation.test.ts` — 13/13: single question from the
  ask's own message, several questions ordered by field index with their own
  text/header, an array field as multi-select, a plain string enum, a
  free-text-only field kept, non-form asks refused; answers as the flat text, as
  the card's own `Q:`/`A:` blocks, value-over-label, a multi-select list, and
  nothing for an empty answer.
- `vitest run server/decision-log-wiring.test.ts` — 7/7 (was 6/7). The question
  case now sees the tool absent, the choices on the card, the questions on the
  card, `source: "question"` in the log, and `answered` from the respond route.
- `vitest run server/acp/*.test.ts` — 15 files, 62/62. A first run of the same
  files reported 4 failed files / 7 failed tests, every one an `expect.poll`
  timing out; the re-run was clean. Those e2e files spawn real servers and are
  load-sensitive, so a lone failing poll is suspect before it is a defect.
- Fixture: `FAKE_ACP_MODE=question` now asks through `elicitation/create`, with
  `FAKE_ACP_QUESTION_MESSAGE`, `FAKE_ACP_QUESTION_SCHEMA` and
  `FAKE_ACP_QUESTION_ANSWER` knobs. The permission-shaped
  `FAKE_ACP_QUESTION_OPTIONS`/`FAKE_ACP_PAD_QUESTION_OPTION` knobs had no caller
  left and are gone.
- Still red for a different cause, recorded so it is not re-diagnosed:
  `thread-aware-bots.e2e`, `notification-routing.e2e` and `live-call.e2e` point
  their instances at the retired native drivers (`driver: "claudeAgent"` with
  `FAKE_CLAUDE`), so messages to them 409 with "provider instance ... is
  unavailable" before a question can be asked anywhere. They are native-fixture
  migrations, not elicitation bugs.

## 2026-10-17 — CI result for the smoke repairs, and the Linux smoke's dead premise

CI run 38977146364 (commit `60455277`): the packaged server smoke now **passes on
Ubuntu and Windows** (it failed everywhere before). The Ubuntu package job got past
the `.desktop` file check and then failed later: `scripts/smoke-linux-package.mjs`
waited for the packaged app to contact a managed Composio broker at launch.
`server/composio.ts` reads that broker only when `COLONIE_COMPOSIO_BROKER_TOKEN` is
set, and no Colonie code supplies one since hosting was retired, so the request can
never happen. Removed the slow-broker fixture, its env var and its assertion; all
other assertions in that smoke are unchanged. Not verifiable on macOS (needs the
Ubuntu package job).

Still red, causes known: the macOS "approval mode transitions" step
(`scripts/smoke-approval-modes.cjs`) builds its fleet from the retired drivers
`claudeAgent`, `codex`, `antigravityAgent` and `grokAgent` and fails at its first send
with 409; it needs a rewrite onto the ACP fixtures (queued, not removed from CI, so
the missing evidence stays visible). Vitest shards: dominated by room tests and
`server/index.test.ts` (see the rooms entries). Renderer UI smoke: not investigated.

## 2026-10-17 — rooms retirement, stage 3a (routes and agent-facing tools)

Removed the eleven `/api/groups…` route groups from `server/index.ts` (create,
setup, tasks, task rename/delete/switch, patch, read, delete, messages, queue
cancel, queue steer, interrupt: 522 lines) and the code that became unused once
they were gone (six `channel-queue` imports, `clientGroupPatchViolation`, a request
schema, the task-switch guard). The 1:1 steered queue is separate (`steer-queue.ts`)
and untouched. The control MCP server (`scripts/mcp-server.ts`) loses its five
channel tools and the `channel` target in the task/wait/interrupt tools
(`target_type` now accepts only `bot`); `scripts/control-colonie.ts` loses the
channel commands; `scripts/verify-group-vm.ts` is deleted.

- Method note: a first cut removed only the first `if` after each `m = path.match(...)`, leaving sibling `if (m && …)` blocks that would have run on another route's match. `tsc` could not see that. Redone with sibling-aware removal and the seams inspected.
- Route guard counts lowered to 142 / 70 (`index-route-ratchet.test.ts`), never raised.
- `tsc -p tsconfig.server.json` 0 errors; `oxlint --deny-warnings .` clean.
- `vitest run server/mcp-server.test.ts server/control-colonie.test.ts`: baseline (with my changes stashed) was 56 passed / 2 failed; after, 54 passed / 2 failed, the same two ("launches, drives a real fake-engine turn…", "scripts the fake engine's tool calls…"), inherited and undiagnosed. Channel cases were deleted or rewritten to bot-only: create-channel, channel sends, channel task routes, channel wait/interrupt; two cases now assert that a `channel` target is refused.
- Left for next slices: `store.ts` tables, `server/index.ts` room orchestration (`startGroupTurn`, `runGroupMemberTurn`, goal runs, handoffs) and the room modules with their unit tests, `routines.ts`/`wire.ts` references, team backup/package flows (`verify-team-backup.ts`, `verify-threads.ts` still create groups), and the whole renderer (stage 4). The renderer's `GroupView` now calls routes that return 404, so this must not be released before stage 4.
- Not run: the e2e suites, the renderer, packaging.

## 2026-10-17 — rooms retirement, stage 1 (room-only e2e files)

Ran all 24 room/group test files (`vitest run`, `--maxWorkers=1`, background):
11 failed, 12 passed, 266 tests (118 failed, 146 passed). Deleted the ten e2e files
whose every passing case was itself a room behaviour, with 113 of their 118
failures in this set: `group-local-vm` (43/44 failed), `room-coordination` (40/40),
`group-goal-run.e2e` (11/12; the one pass validates goal-driven channel-run mode),
`decider-rooms.e2e` (8/10; the two passes are the Auto-rooms decision-model key),
`group-goal-wait-cap` (4 failed, 1 todo), `room-chat-wait` (3/3),
`room-question-tasks`, `memory-room-prompt`, `chief-rooms`, `group-thread-usage.e2e`
(1/1 each). Reason in the product: no engine turn can run in a room on the ACP-only
fleet (`server/index.ts` refuses room dispatch). No other file references them.

Kept for later stages: the 12 passing unit-test files (they test room modules that
`server/index.ts` still imports; they go with their modules in stage 3);
`post-to-room.test.ts` (21/26 pass; mixed, stage 5); `room-recovery.e2e` (passes).
Not yet re-measured: how much the deletions shrink CI's red vitest shards.

- `tsc -p tsconfig.server.json`: 0 errors; `oxlint --deny-warnings .` clean.

## 2026-10-17 — packaged server smoke repaired (two inherited faults)

CI's "packaged server smoke" failed on every OS, before and after today's commits.
Reproduced locally with `pnpm test:packaged-server` (it builds `dist-server`, then
runs the packaged server from a temp directory; no installed data touched).

- `server/proxy-paths.ts` still listed `vpsContainerMcp` → `vps-container-mcp.js`, a retired-hosting proxy that is no longer bundled and has no source or other reference. Removed the entry. Release builds run the same smoke, so this also blocked a release.
- `scripts/smoke-packaged-server.mjs` read 16 bytes of the backup header but the format is `COLONIE-WORKSPACE-1\n` (20 bytes) since the rename; the server's format was right. Now reads 20.
- After both: exit 0, six checks green (server starts without node_modules, 10 proxy paths resolve, MCP stdio, encrypted backup export, container launcher, desktop entry).
- Linux package check (DEB missing `usr/share/applications/com.colonie.app.desktop`): `package.json` `desktopName` had become `com.colonie.desktop` in the rename, while `electron/main.mjs`, `smoke-linux-*`, `verify-linux-package.mjs` and the old value's pattern all use `com.colonie.app.desktop`. electron-builder names the file and the `StartupWMClass` from `desktopName` (read in `LinuxTargetHelper.js`), so one value change fixes both expectations. Set back to `com.colonie.app.desktop`; proof only comes from the CI Ubuntu package job (needs fpm, not run on macOS).
- Not reproduced here: the same job on Windows and macOS, the macOS Electron smokes, the Ubuntu package smoke, the renderer UI e2e, and the Linux/Windows vitest shards.

## 2026-10-17 — E04.2 retired drivers deleted

Deleted the ten unreachable `server/drivers/` modules (`claude`, `claude-login-auth`,
`device-auth`, `local-inject`, `native`, `permission-command`, `prompt-split`,
`session-idle`, `acp/core`, `acp/quiet-status`) with their five test files, and four
legacy scripts: `verify-claude-auth-settings`, `verify-local-tool-selection`,
`verify-tool-scope` (already broken: it imported the nonexistent
`drivers/acp/grok.ts`) and `bench-persistence` (with its `package.json` script).
20 files, about 11,700 lines. Reasons: no importer from any bundle entry point; the
only users were each other, their own tests, and those scripts.

- Test edits, reasons recorded: `thread-log-rotation.test.ts` loses the "native tee caps its log" case (its subject `appendNative` is gone; bus-log rotation cases stay); `startup-model-catalog.test.ts` loses the case that built a driver with the deleted ACP core (the retired legacy client; the other cases stay).
- Checked before deleting: repo-wide grep for each basename including config, Docker and docs; the 16 `bundle-server.mjs` entry points all still exist.
- `tsc -b` and `tsc -p tsconfig.server.json`: 0 errors; `oxlint --deny-warnings .` clean.
- `vitest run` thread-log-rotation, startup-model-catalog, `server/drivers`, speech-text, context-budget, claude-accounts, plan-usage, verification-docs, both guards, ci-workflow, ci-scope — 14 files, all pass after the blueprint link was updated.
- Comments that pointed at deleted files were rewritten (13 files). Left alone: `server/testing/group-local-vm-hooks.mjs` still patches a `/drivers/claude.ts` URL (now a no-op); four room/VM e2e tests use that hook and belong to the rooms decision.
- Not run: packaging, desktop, real providers, the e2e suites.

## 2026-10-17 — E04.1 live helpers lifted out of the retired Claude driver

`CLAUDE_ACCOUNT_ENV_KEYS` and `resolveClaudeConfigDir` moved verbatim to
`server/claude-config.ts`; `autoCompactWindow` moved verbatim to
`server/context-budget.ts` beside `compactBudget`. `claude-accounts.ts`,
`plan-usage.ts`, `server/index.ts` and their tests import the new homes; the old
driver imports them too until E04.2 removes it. The `autoCompactWindow` clamp test
moved from `drivers/claude.test.ts` to `context-budget.test.ts` unchanged.

- `tsc -p tsconfig.server.json` clean; `oxlint --deny-warnings server` clean.
- `vitest run server/context-budget.test.ts server/claude-accounts.test.ts server/plan-usage.test.ts server/drivers/claude.test.ts` — 4 files, 208 passed, 1 skipped (skip is pre-existing).
- Reachability (TypeScript import parser from the 16 bundle entry points plus `scripts/mcp-server.ts`): unreachable `server/drivers/` files are `acp/core`, `acp/quiet-status`, `claude-login-auth`, `claude`, `device-auth`, `local-inject`, `native`, `permission-command`, `prompt-split`, `session-idle`. A first regex-based pass gave wrong answers (it also said `codex-identity` was unreachable) and was discarded.

## 2026-10-17 — typecheck repair for the elicitation commit

`8d8ab45b` (elicitation) left four `tsc` errors in `server/acp/acp-runtime.ts` that
stopped the pre-push hook and would have reddened CI's typecheck. Cause: the
capabilities constant was an untyped literal, so the SDK's typed `request`
overload failed and fell back to `unknown`; and the elicitation scope cast lacked
`toolCallId`. Fix is types only: `CLIENT_CAPABILITIES: ClientCapabilities` and the
wider cast.

- `tsc -p tsconfig.server.json` clean; `oxlint --deny-warnings server/acp` clean.
- `vitest run server/acp` plus the name-matching `acp-recovery` file: 62/64. The two failures are `acp-recovery.e2e.test.ts` "recovers ... without replay" (25 s timeout, "Matcher did not succeed in time"); they fail identically with the old `acp-runtime.ts`, and this file was already recorded as migrated but never run to completion. Not diagnosed.

## 2026-10-17 — E02.2 learned About-me facts owned at bootstrap

`server/profile-learned.ts` no longer imports `config.ts`. `LearnedFacts` takes
its JSON file path (`list/plan/commit/remove`); `server/index.ts` builds it from
the same `<data>/profile-learned.json` and hands it to the `addToAboutMe` seam and
the memory routes. `aboutMeLine`/`appendAboutMe` stay pure. File name and format
are unchanged.

- `vitest run server/memory-upkeep.test.ts server/routes/bot-memory.test.ts` — 2 files, 44/44, including a new two-file isolation test; the route tests now use a temp directory instead of the shared test data dir.
- `content-boundaries.test.ts` now takes one list of caller-owns-storage modules (connections ×3, `profile-learned.ts`). Disposable copy: current passes (8/8); a `DATA_DIR` import in `profile-learned.ts` fails.
- Guards 9/9 with the route ratchet unchanged; `tsc -p tsconfig.server.json` clean outside `server/acp/` (not filtered by me: errors seen earlier there were concurrent work); `oxlint --deny-warnings` on changed files clean.
- Not run: a real provider or desktop session; the memory-upkeep path ran only through its unit/route fixtures.

## 2026-10-17 — E01.3 erasable-syntax rule for server code

The server runs under Node's strip-only TypeScript (`dev:server`, the isolated
fixture), which rejects syntax that needs a rewrite (parameter properties, enums,
namespaces). Typecheck did not know, so E02.1's first e2e run caught it late.
`tsconfig.server.json` now sets `erasableSyntaxOnly`; `pnpm typecheck` in the CI
static job enforces it, and `tsconfig.server.build.json` inherits it.

- Existing code: one violation, a constructor parameter property in `server/browser-live.test.ts` (vitest-run, harmless); rewritten as an explicit field. `vitest run server/browser-live.test.ts` 74/74.
- Disposable copy: a plain class passes; a constructor parameter property and an `enum` each fail with TS1294.
- Not covered: `scripts/*.ts` also run under strip-only but no tsconfig typechecks them (inherited gap).

## 2026-10-17 — E02.1 connected-apps storage owned at bootstrap

`server/colonie/connections/` no longer imports `config.ts`. `BotAppPolicies`
(class in `policy.ts`) takes its directory; `ConnectedTools` and the
connected-tools routes receive it, plus the sessions directory, from
`server/index.ts`. On-disk paths are unchanged (`<data>/connected-apps/bots|sessions`).

- `vitest run server/colonie/connections scripts/testing/content-boundaries.test.ts scripts/testing/index-route-ratchet.test.ts` — 6 files, 15/15, including the new two-root isolation test and the isolated-server connections e2e (codex-acp and claude-acp fixtures).
- Repair 1/2: the first e2e run failed — the fixture server runs under Node strip-only TypeScript, which rejects a constructor parameter property. Replaced with an explicit field; nothing enforces this at typecheck yet.
- Guard: `content-boundaries.test.ts` now rejects a value import of `server/config.ts` from `connections/{policy,manager,routes}.ts`. Disposable copy: current passes, a `DATA_DIR` import fails, a type-only import passes.
- `tsc -b` + server tsc: no errors in changed files; four errors in `server/acp/acp-runtime.ts` belong to concurrent uncommitted ACP work. `oxlint --deny-warnings` on changed files clean.

Candidate next slices (importers / `DATA_DIR` uses): `acp/settings.ts` 2/3,
`profile-learned.ts` 2/3, `mcp-gate-config.ts` 2/2, `published-teams.ts` 3/3,
`acp/receipts.ts` 5/3. Real-provider and desktop behavior were not exercised.

## 2026-10-17 — inherited license files and cloudflared removed

Owner directed a full break from the OpenMaus inheritance: deleted `LICENSE`,
`NOTICE`, `LICENSING.md`, their packaging entries and CODEOWNERS lines. The root
`LICENSE` also served as cloudflared's packaged license, and cloudflared had no
runtime caller (retired tunnel feature), so its bundle went too:
`prepare-cloudflared.mjs` + test, `third_party/cloudflared/`, the electron-builder
entries, `build:cloudflared`, the bundle-server step, after-pack/Linux/Windows/
release checks, and the ARM64 installer CI job. `executableTarget` moved to
`scripts/executable-target.mjs` (+ test) for the browser scripts; the Linux
package check now forbids a `cloudflared` resource. The macOS release gate keeps
a non-empty app signing team check for the browser binaries.

- `node --check` on 7 edited scripts; YAML/JSON parse of 5 configs and package.json.
- `vitest run` after-pack, executable-target, ci-scope, ci-workflow, verification-docs, both guards — 7 files, 97/97 passed.
- `node --test electron/package-install-command.node-test.mjs` 9/9; `oxlint --deny-warnings .` clean.
- Not run: any electron-builder package, signing, or release job.

## 2026-10-17 — landing M0, E01.2, and the documentation clean slate

Main CI `0d5bc3fd` failed in the static job: committed `verification-docs.test.ts`
read deleted `enterprise/server/workspace-access.ts`; the fix was uncommitted WIP.
Landed three commits from this work line only: M0 shared extraction, E01.2, and
documentation (including `CONTRIBUTING.md`/`CODE_OF_CONDUCT.md` removal, which cited
retired files). Excluded: concurrent approval-mode WIP (`server/acp/*`,
`shared/approval-mode.ts`, `ApprovalModeSelector`, their tests) and the deletion
of `LICENSE`/`NOTICE`/`LICENSING.md` (attribution needs an owner decision).

Proof on an exported tree of HEAD plus exactly those paths (scratchpad, `node_modules`
symlinked): static selection/docs tests 79/79, guards 5/5, locale check, `tsc -b` +
server tsc (24 s), `oxlint --deny-warnings .`, Electron syntax check (108 modules),
`vite build` (16.7 s), M0 focused tests 88/88. A first run showed 24 false failures
from an exported `GIT_INDEX_FILE` leaking into `ci-scope` git calls; rerun without it
passed. The vitest shards and smokes were not run locally.

## 2026-10-17 — E01.2 architecture guards in the static CI step

Claude Code picked up from HANDOVER in a fresh session and inspected the checkout
(ci.yml/contract test had no WIP; `content-boundaries.test.ts` is untracked M0 work).
Budget: one job at a time, `--maxWorkers=1`, 120 s per command, two repairs.

- Baseline: `vitest run scripts/ci-workflow.test.ts scripts/testing/content-boundaries.test.ts scripts/testing/index-route-ratchet.test.ts` — ratchet failed: `path === "/` 143 vs 150, `path.match(` 80 vs 82. HEAD's `server/index.ts` has the same 143/80, so this is inherited from the pairing-removal commit `5eff19bc`, not WIP. Lowered the counts as the ratchet instructs.
- Change: ci.yml static job adds step "Enforce architecture boundaries" running both guards; `ci-workflow.test.ts` asserts the exact command, no `if`/`continue-on-error`, and that both files exist.
- After: same three files 24/24 passed. The static step's existing command (`ci-scope`, `ci-workflow`, `verification-docs`) 79/79; the new step's command 5/5. `oxlint --deny-warnings` on the two edited tests and `git diff --check` passed.
- Disposable proof (scratchpad copy of only the files the checks read, `node_modules` symlinked, deleted afterwards): unchanged copy passed; a shared import in `server/index.ts` passed; a renderer import in `server/index.ts`, a server import in `shared/thread-address.ts`, an added `path === "/api/e01-probe"` guard, the step removed, one guard dropped, and `if: false` on the step each failed the intended test.
- Remote, read-only: `gh api` on `hanifstudio/colonie` rules/rulesets/branch protection returned HTTP 403 (private repository, plan lacks the feature). No required check exists there. `gh` defaults to `origin` = retired `milind-soni/OpenMausBot`, whose `main-ci-gate` ruleset does not apply to this repository.

- Owner decision: `gh repo edit hanifstudio/colonie --visibility public` (now `PUBLIC`) after a filename-only history scan found no key or `.env` files (only `.env.example`). Removed remote `origin` (retired `milind-soni/OpenMausBot`) and renamed `colonie` to `origin`; branch tracking followed. `gh api .../rulesets` now returns `[]`; no ruleset created. Owner then approved the push: `git push origin main` fast-forwarded `744da8df..0d5bc3fd` (62 commits; they modify, not delete, NOTICE/LICENSING.md). The included 0.1.101→0.2.0 bump started Release run 38963869064, which failed at "Pin the release commit" with every build/draft job skipped; `gh release list` is empty. CI run on `0d5bc3fd` was in progress at entry time. The E01.2 edits stay uncommitted: the new CI step needs the untracked M0 files (`content-boundaries.test.ts`, `shared/*.ts`) committed with it.

Limits: local evidence only; GitHub Actions did not run this change. Guards stay
static-import and spelling based (computed/transitive imports and alternate route
syntax can evade them). No typecheck/build run: only test files and YAML changed.

## 2026-10-17 — Codex to Claude Code handoff

Owner requested continuation in Claude Code via the herdr skill. Verified the
Herdr environment and installed CLI; started Claude Code as `colonie-next` in
pane `w2T:pF`, same checkout and tab, without changing another agent's pane.
Herdr confirmed interactive readiness. The transfer brief directs Claude to read
AGENTS/HANDOVER, inspect the current diff, and continue E01.2; preserve concurrent
room/test recovery and existing CI changes. No new steering file or worktree.

Completed work and limits remain in the entries below. E01.1 is source inventory;
E01.2 guard inclusion/proof and later E02–E06 are unfinished. M0 fresh-session
pickup/review needs observed evidence from the receiving session, not a pass
inferred merely from launching another agent. Remote merge protection is unknown.
This entry records startup/transfer context, not Claude's implementation result.

## 2026-10-17 — every approval level maps to a real adapter mode on ACP

Owner decision: enable "Approve for me" (and the other levels) for the ACP
fleet. Cause, read from the code: `shared/approval-mode.ts:15` allowed only Ask
and Full for `claude-acp`/`codex-acp`, so a PATCH asking for `autoApprove: true`
left the bot on Ask, `autoVerdict` never took its `mode === "auto"` branch, and
an unattended run whose engine asked waited for a person who was not there.

The implementations are the adapters' own modes, read from the installed
packages rather than assumed:

- claude-agent-acp `dist/session-mode.js` `buildAvailableModes`: `default`
  ("Manual — always ask"), `acceptEdits` ("Accept edits"), `plan`, `auto`
  ("Claude handles permission decisions"), `bypassPermissions`.
- codex-acp `dist/index.js` `AgentMode`: `read-only`, `workspace-write`
  ("Workspace access"), `agent` ("Auto review — only ask for actions detected
  as potentially unsafe"), `agent-full-access` ("Full access").

So `AcpFlavor` gained optional `editsMode`/`autoMode`, `AcpRuntime.modeForApproval`
resolves a level through them, and Ask/Full keep their exact previous behaviour
including the 409 for a Full an adapter does not offer. Auto and Accept edits,
being new for ACP, keep Ask when the adapter does not advertise them — a level
never falls upward into more access. Custom stays off (an ACP adapter carries
settings, not a provider config).

Also updated: the approval selector no longer hardcodes ask/full for ACP
(`src/components/ApprovalModeSelector.tsx`), and it displays the level the
adapter will actually run, so a saved Custom reads as Ask;
`hasNativeAutoReview` counts both ACP kinds, because their Auto is a provider
reviewer and not the Ask fallback the chat-completions family gets.

Evidence: `server/approval-mode.test.ts` 22/22 with a new ACP case;
`server/acp/` green after the fixture adapter was taught to clamp Auto to Ask by
the id each flavour uses (Claude `auto`, Codex `agent`) and to advertise
`acceptEdits`/`workspace-write`; `decision-log-wiring`'s two
"logged as the provider's own request" cases now reach `native-approval`
(`FAKE_ACP_ALLOW_ALWAYS=1` supplies the "always allow" the card asserts).
`pnpm exec tsc --noEmit -p tsconfig.json` exits 0.

`decision-log-wiring` is 6/7. The last case, "a question card carries its
questions and logs the row without an origin", is the ACP question gap: the ACP
path emits no `event.questions`, so the card reads as a permission card with a
tool. The only producer of `questions` was the retired native Claude driver
(`server/drivers/claude.ts:1819`); ACP's own elicitation request is not handled
anywhere in `server/acp/`. The test itself records that this "arrives with the
ACP normalization change, which stacks independently".

## 2026-10-17 — routines and webhooks run again on the ACP fleet

Owner decision: keep routines and webhooks and make them work on ACP (not
retire them). Cause was measured first, then fixed.

Before: a manual routine run posted into the bot's own thread
`Routine "Hourly report" failed — This ACP connection supports direct native
sessions…`, from two guards that refused every automated turn for an ACP driver
(`server/index.ts`, the dispatch guard and the ACP branch's own check, both
keyed on `automationSource`/`unattended`).

Change: both guards now refuse only `editedMessageId`, `task.rewound`,
`compactOnly` and `coordination` — the kinds that need a native session Colonie
can rewind. A scheduled run, a webhook and a teammate's handoff are forward turns
in the bot's own thread, so each takes the same ACP path a typed message takes.
`peerAsk` was the third of those kinds: a delegated turn reaches
`startTurn(toBotId, text, { …, peerAsk })` from `runDelegatedTurn`, and the guard
turned it into a chip in the opener's thread instead of a turn. Allowing it made
`server/card-answerers.e2e.test.ts` 7/7 — including "follows a thread a bot
opened for a member back to that member", which failed with "the handoff never
asked" before.

Verified with the real server and the scripted ACP engine
(`$TMPDIR/opencode/probe-routine.mjs`, disposable home): the same probe that
printed `failed` before now prints `Routine "Hourly report" completed` followed
by the engine's reply. Vitest: `server/webhook-ingress.test.ts` 11/11,
`server/webhook-idempotency.test.ts` 9/9, `server/routine-run-broadcast.e2e.test.ts`
1/1, `server/card-answerers.e2e.test.ts` 7/7. `pnpm exec tsc --noEmit -p
tsconfig.json` exits 0.

Also fixed while verifying: `server/acp/acp-runtime.ts` announced a permission
request's tool as the ACP *category* (`execute`), so the decision log, the
approval card and the always-allow key read `execute` where they expect the tool
identity. A shell-command ask now folds to `shell` with the command as its
summary, exactly as the retired native drivers folded it (key `shell:echo hi`);
otherwise the agent's own programmatic tool name is used. `decision-log-wiring`
went 2/7 → 4/7 on that change alone.

Still red in that file, with the cause now known:
`native-approval` vs `no-grant` (the approval-source classification the ACP path
does not reach) and the structured question payload — the test itself records
that the ACP question normalization "stacks independently of this one" and has
not landed. `routine-cron.e2e.test.ts` and the other plan-scripted files rely on
`FAKE_CLAUDE_ROOM_PLAN`, a retired native fake's scripting hook that the
launcher still sets (`scripts/control-colonie.ts:480`) and the ACP fixture
ignores; scripting tool calls through the ACP fixture is not built.

Why `native-approval` cannot be reached, read from the code rather than guessed:
`shared/approval-mode.ts:15` gives the ACP drivers only Ask and Full access
(`if (driverKind === "codex-acp" || driverKind === "claude-acp") return mode ===
"ask" || mode === "full"`), because only those permission mappings exist on the
adapter. A PATCH asking for `autoApprove: true` therefore leaves an ACP bot on
Ask, `autoVerdict` never takes its `mode === "auto"` branch, and the card is the
person's to answer. Consequence beyond the test: an unattended routine or webhook
run whose engine asks is waiting for a person who is not there.

## 2026-10-17 — what the ACP-only fleet refuses, measured

A disposable probe (`$TMPDIR/opencode/probe-routine.mjs`: real server, temp
`HOME`, scripted ACP engine) ran a bot's direct message and then a manual routine
run. The direct turn answered `hello from fake acp`; the routine run posted into
the bot's own thread:

```
bot:Routine "Hourly report" failed

This ACP connection supports ...
```

The service-side refusal is one guard, `server/index.ts:8655`:

```
if (isColonieAcpDriver(instance.driverKind) && (opts?.editedMessageId ||
    task.rewound || opts?.compactOnly || opts?.automationSource ||
    opts?.coordination || opts?.unattended || opts?.peerAsk))
  throw ... "This ACP connection supports direct native sessions." (409)
```

A second guard at `server/index.ts:8652` refuses a turn when the thread already
holds user history on another instance (`nativeHistoryConflict`), and
`server/index.ts:11152` refuses a room turn ("room orchestration is not
enabled"). Both guards arrived with the fork commit `fa3306c0`, not with a later
retirement.

Consequence, stated plainly: on an ACP-only fleet the app runs direct, attended,
single-engine conversation only. Routines (`automationSource`, `unattended`),
webhooks (`unattended`), message edits and reruns, bot-to-bot peer asks and
aside turns, coordinated/Chief turns, and rooms are all refused at dispatch —
every one user-visible. This is the cause of most remaining red tests:
`branching` (edit 409), `decision-log-wiring`'s webhook case,
`card-answerers`' handoff case, `automatic-recovery`'s cross-instance history
case, `bot-visibility` (room turn), and the `steer-queue` drain cases whose turns
carry `unattended`.

Separate clean-slate finding: the retired brand token `maus` still runs through
the routines/webhooks plumbing (`RoutineRunOn = "maus" | "cloud"`, `runOn`
defaults, the `run_on` MCP tool argument, the system prompt, and
`data-welcome-maus` / `[maus-debug]` in `src/onboarding-preview.tsx`). The
field is vestigial: `src/components/WebhooksPanel.tsx:73` and
`src/components/RoutineCalendarPage.tsx:377` record that the "cloud computer
place" was removed and the UI now hardcodes `"maus"`.

Measured, tracked source only (empty `git ls-files .colonie-dev` — those are
untracked local evidence files): 551 lines mention `maus` outside `docs/`.
The largest parts are the character's own vocabulary — `src/styles.css` holds
163 of them (`--color-maus-line`, `--maus-eye-x/y`, `maus-character`,
`maus-motion--*`, `welcome-maus`, …) and `MausAvatar` has 65 references — and
`server/routines.test.ts` holds 112, mostly `runOn: "maus"` in fixtures. So this
is two separable slices, a field removal and a visual rename; both are recorded
in HANDOVER and neither is started.

## 2026-10-17 — architecture and consistency delivery plan

Owner requested deliberate architecture, folder/file organization, and code/design
consistency improvement. Replaced the generic structural sequence in blueprint
section 6 with E01–E06: enforceable guards, workspace ownership, HTTP/application/ACP
separation, legacy retirement, renderer state organization, and code/native-UI
consolidation. Each stage names a first task, dependencies, and structural/behavior
exit evidence. Section 7 defines responsibilities within current roots and
consistency acceptance; the speculative monorepo tree was removed. No new steering
file was introduced. AGENTS links implementation review to those standards.

HANDOVER selects E01.2 next and retains M0's open session-pickup/review checkpoint.
This owner-driven priority change does not mark M0 complete. Concurrent test/room
retirement guidance and source WIP were preserved rather than rewritten.

E01.1 inventory is complete as source inspection only. Content and route guards
are discovered by the general suite, not named in the fast static CI step. Route
guards are spelling/count-based; content guards cover direct static edges. Contrast
tooling exists but is not invoked by this workflow. Local hooks are bypassable;
remote required-check/review/bypass settings remain uninspected. Coverage gaps and
positive/negative proof recipes are in the blueprint's E01 table.

Verification: `python3 /tmp/colonie-m0-check.py vitest run
scripts/testing/verification-docs.test.ts --maxWorkers=1` ran `pnpm exec` with a
60-second process-group limit and owned cleanup: 1 file, 5 tests passed (415 ms;
wrapper 1.73 seconds, exit 0). Final repeat after concurrent document updates:
5/5 passed (355 ms; wrapper 1.46 seconds, exit 0). Scoped `git diff --check` passed. All 10 inspected
source/config hashes matched `/tmp/colonie-engineering-plan-snapshot.json` at the
recheck (HEAD `0d5bc3fd` plus WIP). These checks establish document consistency,
not architecture implementation, CI execution, or product workflow correctness.
This task changed only documentation; no app/provider/build/E2E check, dependency
installation, or remote-setting mutation was performed.

Next: E01.2's scoped fast-CI inclusion and workflow contract proof, after reconciling
existing CI/test-recovery edits. E02–E06 and remote enforcement remain unimplemented
or unverified. Use the existing queue and task-specific reference sections.

## 2026-10-17 — ACP-only test recovery, first batch

Owner-authorized clean slate: no retired native drivers, no old-brand identity,
and a maintained suite that runs against the live ACP boundary. Commits on
`main`: `249e9fbb` (dead doc pointers), `a03526f1` (fixture engine), `0d5bc3fd`
(first e2e batch).

The scripted fixture engine `server/testing/fake-acp-cli.ts` was emitting four
shapes the ACP SDK rejects, so every one was dropped without a reply and turns
looked mute rather than broken: an update with no `sessionId`, a chunk whose
`content` was a bare `{text}` instead of a discriminated ContentBlock, a
permission request with no `sessionId`, and permission options with no `name`.
All four are fixed, plus a new `FAKE_ACP_PROMPTS_FILE` that appends one JSON line
per prompt for tests that must read what the engine was handed.

Verified with Vitest against disposable homes (no live app or installed data):
`server/acp/` 16 files / 55 tests, `server/usage-ledger-api.test.ts`,
`server/usage-attribution.e2e.test.ts` (5), `server/bot-wire-privacy.e2e.test.ts`
(2), `server/notification-wiring.test.ts` (1), `server/respond-replay.e2e.test.ts`
(1), `server/routine-run-broadcast.e2e.test.ts` (1), `server/steer-queue.test.ts`
29/33. `pnpm exec tsc --noEmit -p tsconfig.json` exits 0.

Still red, each with a diagnosed cause rather than a fixture that has not been
tried:

- `server/branching.test.ts` — editing a settled thread answers 409 and version
  switching is refused for ACP by design (`server/index.ts` active-branch route).
- `server/decision-log-wiring.test.ts` (2/7) — the permission event carries the
  ACP tool *kind* (`execute`) where the decision log expects a tool identity
  (`shell`): `server/acp/acp-runtime.ts` sets `tool: request.toolCall.kind`.
  Suspected product bug, not verified as one.
- `server/card-answerers.e2e.test.ts` (6/7) — one cross-thread handoff case.
- `server/bot-visibility.e2e.test.ts` — its fixture needs a room turn.
- `server/acp-recovery.e2e.test.ts` and `server/automatic-recovery.e2e.test.ts`
  are migrated but not yet run to completion.

Two behaviours the app refuses for the ACP-only fleet, so tests for them cannot
pass and must be deleted or the feature rebuilt: room/group orchestration
(`server/index.ts` answers a room turn with "The transparent ACP connection
supports direct conversations; room orchestration is not enabled.") and native
history/version switching on the active-branch route.

Scale: the earlier inventory of 57 files that *declare* a retired driver
understates the work. About 50 more test files reach the retired native CLI
fakes through API overrides without naming a driver (`server/delta-context.e2e.test.ts`
points the claude-acp instance at `fake-claude-cli.ts`), and many retired modules
still sit in the tree: `server/drivers/acp/core.ts` (~1400 lines, imported only
for two version helpers), `server/drivers/claude.ts`, `server/drivers/native.ts`,
and the `fake-claude-cli.ts` / `fake-codex-app-server.ts` / `fake-pi-cli.ts` /
`fake-grok-login-cli.ts` fixtures. Removing them is dead-code work separate from
the test migration and is not done.

## 2026-10-17 — M0.3 shared thread addresses and combined verification

Moved 69 lines of canonical thread URL formatting/parsing, UUID recognition, and
types/constants into `shared/thread-address.ts`. Renderer exports remain compatible;
the server imports shared rules directly. All three audited server-to-renderer
content imports are removed. Existing behavior test files are unchanged.

Checks used `/tmp/colonie-m0-check.py` (60-second process-group budget, one Vitest
worker, disposable test homes, no app/provider launch):

- `vitest run src/lib/thread-refs.test.ts --maxWorkers=1`: baseline 23/23 passed (402 ms).
- Thread plus expanded boundary checks: 27/27 passed (1.03 seconds).
- `tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --skipLibCheck --target ES2023 --lib ES2023 --types node --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions shared/transcript-attachments.ts shared/thread-address.ts`: exit 0 (1.31 seconds).
- The same focused type check with `--lib ES2023,DOM,DOM.Iterable`, adding both renderer helper files: exit 0 (1.47 seconds).
- `oxlint --deny-warnings shared/transcript-attachments.ts shared/thread-address.ts src/lib/composer-attachments.ts src/lib/thread-refs.ts scripts/testing/content-boundaries.test.ts`: exit 0 (1.19 seconds).
- Final `vitest run src/lib/composer-attachments.test.ts server/composer-attachments.test.ts src/lib/thread-refs.test.ts scripts/testing/content-boundaries.test.ts --maxWorkers=1`: four files, 98/98 passed (1.33 seconds; wrapper 2.43 seconds). The four boundary cases cover direct static imports/re-exports; computed/transitive dependencies are not certified by this guard.
- `vitest run scripts/testing/verification-docs.test.ts --maxWorkers=1`: 5/5 passed (353 ms; wrapper 1.30 seconds). Scoped whitespace checks passed.
- Both moved blocks match their pre-extraction snapshots byte-for-byte. Checked-source hashes are recorded in `/tmp/colonie-m0-verified-files.json` for HEAD `de7c2bf3` plus scoped WIP; all 10 source/test hashes still matched on recheck. Original behavior tests are unchanged. The final unrelated-WIP check detected a concurrent change to `server/testing/fake-acp-cli.ts`; it was left intact and is outside these pure-helper checks. No claim of a globally unchanged checkout is made.

This is static/unit evidence and self-review, not provider, rendered UI, desktop,
package, or backup end-to-end proof. M0.2 continued into M0.3 without owner technical
clarifications. Planned failing boundary assertions became passing after the fix;
unexpected-failure recovery, independent review, and fresh-session pickup remain
unproven. M0 stays open, with M0.4 as the next action in HANDOVER.

## 2026-10-17 — M0.2 shared attachment rules

Moved the 264-line pure attachment/transcript block into
`shared/transcript-attachments.ts`; renderer exports remain compatible and the
server/backup consumers import shared rules directly. Upload, preview, clipboard,
message composition, storage, and provider code were not changed.

Commands used `/tmp/colonie-m0-check.py` to run `pnpm exec` with a 60-second
process-group timeout, owned cleanup, and `--maxWorkers=1` for Vitest:

- `vitest run src/lib/composer-attachments.test.ts server/composer-attachments.test.ts --maxWorkers=1`: baseline 71/71 passed (599 ms).
- `vitest run scripts/testing/content-boundaries.test.ts --maxWorkers=1`: 2/2 failed as expected before extraction, identifying the renderer imports; no test assertions were weakened.
- Combined attachment and boundary run: 73/73 passed (1.15 seconds; wrapper 2.27 seconds).
- `tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --skipLibCheck --target ES2023 --lib ES2023 --types node --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions shared/transcript-attachments.ts`: exit 0 (wrapper 1.80 seconds).
- Byte comparison against the pre-extraction block in `/tmp/colonie-m0-attachment-block.txt`: identical. Review was self-review, not independent verification.

Evidence is static/unit with disposable test homes and mocked uploads, not live
UI, provider, desktop, or backup end-to-end proof. The boundary test demonstrates
a planned red/green transition, not recovery from an unexpected production bug.
Next: M0.3 thread-address extraction; continuation needs no new owner decision.

## 2026-10-17 — steering simplification

Owner requested reducing duplicated guidance and routine context load. Consolidated
the loop into AGENTS, removed the separate development guide, shortened HANDOVER,
and made blueprint/progress/method reading conditional on the task. Updated links,
the instruction diagram, and reference attribution. The initial three-document
reading set was 2,428 whitespace-separated words; AGENTS plus HANDOVER now total
1,063, a 56% text reduction, not a measured token or performance improvement.

Removed universal two-repair/120-second defaults; each implementation task chooses
its bounded checks and repair budget before execution. The one-heavy-job rule and
isolated-verification boundaries remain. Earlier M0.1 limits below are historical.

Checks: `env PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm exec vitest run
scripts/testing/verification-docs.test.ts --maxWorkers=1` passed one file/five tests
(347 ms; wrapper 1.63 seconds, exit 0). This documentation job used a 120-second
subprocess-group timeout with owned cleanup. Scoped `git diff --check` passed;
a Python assertion confirmed the removed guide and active references are absent.
Only document consistency was checked; application code/data, dependencies, and
existing unrelated WIP were untouched. No build, E2E, or provider request ran.

M0 remains unproven. Next is M0.2's attachment scope/baseline inspection in HANDOVER,
followed by the bounded implementation trial; no additional steering file is needed.

## 2026-10-17 — M0.1 development agreement

The owner agreed to a consistent development loop and asked to start. Added
`docs/DEVELOPMENT.md` (later consolidated into [AGENTS](../AGENTS.md)), linked it from AGENTS and the docs index, and aligned
the blueprint's instruction map. HANDOVER now owns one active M0 trial queue
instead of pointing directly at a refactor without the agreed process.

The agreement defines technical decision authority, explicit priority changes,
task acceptance, verification/review, bounded repair, continuation, and session
pickup. Initial trial defaults are one active code task, one heavy local job,
two repair rounds, and 120 seconds for each focused document/pure-logic check.
No operating-system CPU/RAM cap or unattended runner was installed.

Verification: `env PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm exec vitest run
scripts/testing/verification-docs.test.ts --maxWorkers=1` ran under a Python
subprocess-group wrapper with a 120-second timeout and owned timeout cleanup.
One file, five tests passed; Vitest reported 558 ms, wrapper elapsed 1.77 seconds,
exit 0. `git diff --check -- AGENTS.md docs/DEVELOPMENT.md docs/HANDOVER.md
docs/README.md docs/COLONIE-BLUEPRINT.md docs/PROGRESS.md` passed. A final repeat
after the queue/status edits also passed all five tests (347 ms; wrapper 2.10
seconds, exit 0). The new guide also passed an explicit trailing-whitespace check.
These checks establish document consistency only.

No application code, dependencies, framework installation, Git commits, app data,
provider requests, build, or runtime/E2E verification changed or ran. Existing
unrelated source and documentation WIP was preserved. No owner product decision
or technical clarification was needed during M0.1.

M0 remains open: implementation, task-to-task execution, recovery from a failing
check, independent review where required, and fresh-session pickup are unproven.
Next: inspect M0.2's attachment dependency closure and test setup, record the exact
scope and bounded baseline check in HANDOVER, then perform the scoped extraction.

## 2026-10-17 — read-only architecture audit

Recorded a short owner summary, one target responsibility diagram, dated source
findings, retain/adapt/remove decisions proposed for review, and a restructuring
sequence in the blueprint. Current snapshot: HEAD `aa38ecc9` plus existing WIP.
No application implementation, deletion, deployment, or installed data changed.

Commands/evidence: `/opt/homebrew/opt/node@24/bin/node
/tmp/colonie-architecture-audit.mjs` parsed 936 non-test first-party source/tooling
files without importing application modules; its local report is
`/tmp/colonie-architecture-audit.json`. Relative and `@/` value-import graph plus
targeted `rg`/`sed` source tracing found the large composition hub, global
workspace state, three server-to-renderer imports, helper dependencies on retired
drivers, and two small UI import cycles. Computed imports, callback/runtime
relationships, generated assets, and subprocess manifests need separate tracing.
File size/import count alone is not a correctness failure.

Next: the proposed first refactor extracts shared attachment/transcript and
thread-address rules from renderer utilities, preserving content formats/UI.
Explicit workspace bootstrap and run-orchestration boundaries follow. The extra
MCP mount payload question remains unverified and unfixed. No app, provider,
browser/Electron, E2E, build, or benchmark was run. Unrelated cleanup and the
usage-ledger test WIP remain.

Document verification:

- `env PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm exec vitest run scripts/testing/verification-docs.test.ts --maxWorkers=1` — 1 file, 5 tests passed, 339 ms; static document references only.
- `git diff --check -- docs/COLONIE-BLUEPRINT.md docs/HANDOVER.md docs/PROGRESS.md` — passed.
- A Python SHA-256 comparison of the eight selected source files against the scan report found no changes during inspection. This is snapshot consistency, not workflow evidence.

## 2026-10-17 — clean-slate documentation tree

Owner explicitly requested retaining only needed documentation in the working
tree. Removed the in-repository archive, duplicate SPEC/PLAN/memory entry points,
old verification media/evidence, and obsolete ignore rules. Kept nine current
Markdown documents. The blueprint retains product direction, feature inventory,
journeys, architecture proposals, and open decisions; obsolete code snapshots and
process history were removed.

Two media files still used by `scripts/verify-chat-polish.ts` were moved byte-for-byte
to `scripts/testing/fixtures/chat-polish/`, and its two path references were updated.
The documentation checker was updated for the current docs instead of reading a
deleted enterprise file or requiring a historical number of recipes.

### Verification

- `pnpm exec vitest run scripts/testing/verification-docs.test.ts` — 1 file, 5 tests passed; reported duration 326 ms. Checks local links/headings, current source references, package commands, and the verification index without application imports or launches.
- `git diff --check -- AGENTS.md README.md docs scripts/verify-chat-polish.ts scripts/testing/verification-docs.test.ts` — passed.
- Filesystem inventory — exactly 9 Markdown files remain under `docs/`, including hidden/ignored paths; no archive or evidence/media directories remain. Removed 250 nonessential files from this tree and moved the 2 required fixture media files out.
- Both moved media files match their pre-move SHA-256 hashes. Blueprint IDs (18 directions, 35 features, 14 acceptance cases, 11 open questions, 7 behavioral proposals) and the single Local J01 journey are preserved.

No app, browser, Electron, E2E suite, provider request, build, deployment, credential
inspection, or installed-data mutation was performed. This task changed only
documentation, the static documentation checker, and fixture-media paths. Other
concurrent root/source edits were not made or reverted by this task.

### Next

Perform the read-only architecture audit: one responsibility diagram, a current-code
retain/adapt/remove map, and one bounded first-change proposal. Preserve the native UI.
