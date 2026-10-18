# Colonie recent progress

Product direction is in [the blueprint](COLONIE-BLUEPRINT.md). Current implementation
and the next action are in [HANDOVER](HANDOVER.md). Keep this evidence log concise.

## 2026-10-18 — suite recovery: measurement corrected, one product gap fixed

Single OpenCode session, Node 24.13.1 (`$HOME/.nvm/versions/node/v24.13.1/bin`),
one heavy job at a time. Raw logs stay in `.colonie-dev/` (untracked).

- **The first regression count was wrong.** `vitest run <27 red files>` in the
  pre-batch worktree `/private/tmp/colonie-base` (`fb1f0e86`) reported failures
  for 7 files that all died with `Cannot find package '@hpke/core'`: the batch
  removed that dependency from `package.json` while the old source still imports
  it (`server/phone-secret.ts`), and the worktree's `node_modules` symlink had no
  copy. Restoring it (a real `node_modules` of symlinks plus
  `@hpke/{core,common}` → `node_modules/.pnpm/@hpke+core@1.9.0/...`) and
  re-running those 7 files (`.colonie-dev/red-baseline-envfix.log`, 31 s) gives a
  partial comparison — **4 regressions, 20 unchanged, 3 improved** — that was
  still wrong, because the repair had to cover every file that died in
  `beforeAll`, not a hand-picked 7. See the full-baseline correction below.
  Regressions from that partial run: `scripts/testing/duration-sequencer.test.ts`
  (0→3, fixed), `server/claude-account-api.test.ts` (0→4),
  `server/openai-compat-vm.e2e.test.ts` (0→3),
  `server/peer-allowlist.e2e.test.ts` (0→8). Improved:
  `server/acp/start.e2e.test.ts` (1→0), `server/card-answerers.e2e.test.ts` (6→1),
  `server/control-colonie.test.ts` (3→2). `server/digest.e2e.test.ts`,
  `hooks.e2e`, `aside-e2e`, `host-lazy-claim.e2e`, `computer-engine-removal.e2e`
  are inherited red, not regressions.
- **`server/digest.e2e.test.ts` green (3/3)** from 5 failed
  (`.colonie-dev/digest-fix4.log`). The fixture now uses the two maintained
  adapters with each one's own approval vocabulary
  (`claude-acp`: default,bypassPermissions,acceptEdits,auto; `codex-acp`:
  read-only,agent-full-access,workspace-write,agent) and the scripted fake via
  `config: { cli: process.execPath, args: [fake-acp-cli.ts] }`; the strict ACP
  config schema rejects the old `fullAuto` key.
- **Product gap found and fixed in `server/index.ts`:** `checkpoints.snapshot`
  was called only on the legacy turn path, and the ACP branch (the only path
  every turn now takes) never took a pre-turn workspace snapshot. So
  `turnCheckpoints` stayed empty, `scheduleTurnDigest` returned at
  `if (!checkpoint) return;`, and the digest never named changed files for any
  bot. Diagnosed by probe (`PROBE cwd-select` never fired; `.colonie/checkpoints`
  never created) and by A/B with the change stashed. The ACP path now mirrors the
  other path (snapshot awaited before dispatch, pin = dispatch claim, release on
  a stale claim, explicit project folders only); probe shows
  `{"changed":[],"added":["retry.ts"],"deleted":[]}` and the test asserts it.
- **Second half of that test rewritten to the ACP contract:** switching a
  conversation to another engine mid-history is refused with 409 ("belongs to
  another agent's native history", `server/acp/native-history.ts`), which is what
  replaced the retired multi-engine handoff. The test now asserts that refusal
  and that the thread keeps its digest naming `retry.ts`.
- Checks: `pnpm typecheck` 0, `pnpm lint` 0, and
  `vitest run server/acp server/checkpoints.test.ts server/digest.e2e.test.ts`
  → 17/18 files, 87 passed | 2 failed | 1 skipped in 227 s.
  `server/acp-recovery.e2e.test.ts` is the one red: 2 tests fail in isolation
  **with and without** this session's `server/index.ts` change (A/B, change
  stashed), so it is not caused by the checkpoint fix and is not in the
  inherited red list either — it needs its own diagnosis.
- **Full baseline, the honest classification.** `vitest run <all 27 red files>`
  in the repaired worktree (`.colonie-dev/red-baseline-full.log`) → 24 failed
  files, 94 failed tests, 33 passed, 206 s. Per-file comparison against
  `.colonie-dev/red-current.log` (`vitest run <same 27>` on this tree: 26 failed
  files, 93 failed tests, 1,637 s) `(.colonie-dev/red-classification.json)`:
  **one real regression**, `scripts/testing/duration-sequencer.test.ts`, fixed;
  **one stale expectation from the batch's own retirement**,
  `server/presets.e2e.test.ts` (`groups: []` removed from the team-package import
  response with rooms; the assertion is gone, green 1/1,
  `.colonie-dev/presets-fix1.log`); **one flaky file**,
  `server/acp/start.e2e.test.ts`; **23 inherited with identical counts**. The
  other two "regressions" of the partial run are inherited and proved by running
  them in the repaired worktree:
  `claude-account-api.test.ts` 4 failed (`.colonie-dev/claude-account-baseline.log`)
  and `openai-compat-vm.e2e.test.ts` 3 failed
  (`.colonie-dev/openai-compat-baseline.log`) — both files' decisive source is
  byte-identical to the baseline, so their `0` was the contamination.
- **`server/peer-allowlist.e2e.test.ts` migrated and green (7/7)** from 8 failed
  (`.colonie-dev/peer-allowlist-fix3.log`). Diagnosis: the fixture named the
  retired `claudeAgent` driver, so `POST /api/bots` answered 400 and the cleanup
  loop read `bot.id` of `undefined`. Now the ACP fixture with the scripted fake;
  one roster-only test is deleted (the prompt an ordinary bot gets is the ACP
  context contract, `server/acp/context.ts`; `peer-roster.test.ts` covers the
  builder) and the engine-side token read became a real session dump assertion
  plus the mint-route format check, because an ordinary bot mounts no internal
  MCP server. `createBot` now asserts the 201 and its status text, which is what
  surfaced `model "claude-sonnet-5" is not offered by instance "plain"`.
- **`server/acp-recovery.e2e.test.ts` fixed and green (2/2, 13.6 s)** from 2/2
  red in both trees (`.colonie-dev/acp-recovery-fix2.log`). Two product gaps in
  the maintained runtime: ACP vendor diagnostics were dropped
  (`server/acp/acp-runtime.ts` now shapes `error.data.details` / `data.message` /
  `data.error.message`, redacted and bounded, so the failed-turn row says
  "Internal error: OpenCode service failure" instead of "Internal error"), and a
  child left poisoned by a JSON-RPC internal error was kept for the next turn.
  The runtime now retires that child, gated on
  `agentCapabilities.loadSession` so an adapter that cannot re-load a session
  keeps its child (Claude advertises it, Codex's default is false); the fixture
  advertises `loadSession` like the real adapter, and the retired core
  (`c61d7c86:server/drivers/acp/core.ts`) is the reference for both behaviours.
- **`server/digest.e2e.test.ts` strengthened after review:** `echo` is now
  `codex-acp` so the 409 native-history refusal really crosses adapters, and the
  ACP path gained the other path's pre-dispatch claim guard ("turn stopped before
  dispatch"), so a stopped turn no longer launches an engine. Both green
  (`.colonie-dev/digest-fix5.log`, 3/3; `pnpm typecheck` 0; `pnpm lint` 0).
- **`server/automatic-recovery.e2e.test.ts` is inherited red and flaky.** Four
  full runs (`.colonie-dev/automatic-recovery-{before,before2,after-gate,repeat}.log`),
  A/B twice in each direction: 7 failed without this session's runtime change,
  8 with it, but the membership varies (the three "does not automatically replay"
  cases trade places) and it also fails with the change stashed. Isolated
  `-t "authentication failure"` fails both ways. Cause of the standing red:
  the 409 ACP native-history rule and prompt-count timing. Not caused here.
- **Four product gaps recorded** (detailed in HANDOVER): an ACP instance reports
  its models only in-session, so `requireAvailableModel` accepts just the default
  until something calls the model-picker's `refresh-models` route; the peer-comms
  "agents" MCP mount is legacy-only; named Claude accounts still create the retired
  `claudeAgent` kind; and `integrations.localComputer` reaches no ACP turn.
- **Committed as `81b81e64`** (local `main`, not pushed): the honest
  classification, the four runtime/suite fixes above, the shard-weight list and
  the doc rewrite. `pnpm typecheck` 0 and `pnpm lint` 0 on that tree. The
  SettingsModal/Decision-model edits are not in it yet: their tests had not been
  run when it landed.
- **P1 close-out (October 18).** The three checks its acceptance still owed all
  passed: `npx vitest run src/components/SettingsModal.{simple,groups,i18n,appearance}.test.ts`
  → 4 files / 47 tests; `pnpm i18n:check` → "locale catalogs valid (10 languages,
  2788 English strings)"; `npx vitest run scripts/testing/verification-docs.test.ts`
  → 5/5 (`.colonie-dev/p1-closeout.log`). With the classification recorded and the
  touched server tests green, P1's acceptance is met and the room-retirement
  close-out is done. The 23 inherited files move to their own milestone
  (ACP-fixture migration backlog) rather than gating P1.
- Committed the SettingsModal / Decision-model removal: `git status --short` clean
  for `src/`; tests above are its evidence.
- **Six files deleted from the migration backlog** (retired-subject rule, each
  with the evidence that its subject cannot run on the maintained fleet):
  `server/openai-compat-vm.e2e.test.ts` (retired `openai-compat` driver and its
  Local VM computer tools — `computer_screenshot`/`agents_select_computer` appear
  nowhere in production), `server/host-lazy-claim.e2e.test.ts` (the gated
  host-computer mount is native-branch only; no ACP adapter declares
  `localComputerMcp`), `server/direct-screen-settlement-api.test.ts` (screen
  frames need `previewCapture`/`browserCapture`, both set only on the native
  branch), `server/cli-stop.e2e.test.ts` (asserted the retired drivers'
  whole-process-tree reap; `killCliTree` has no turn-path caller, and ACP
  interrupt is covered by `server/acp/conversations.e2e.test.ts` and
  `server/acp/codex-acp.test.ts`), `server/aside-e2e.test.ts` (aside folding needs
  `Adapter.steer` + `capabilities.queueing`; `server/acp/` implements neither),
  and `server/hooks.e2e.test.ts` (the engine-hooks channel is assembled only on
  the native branch behind a capability no ACP adapter declares; `tool.fullResult`
  has exactly one setter, the hook ingest at `server/index.ts:4737`). The four
  that were shard-weighted left `vitest-shard-weights.json` (119 → 115 entries):
  `scripts/testing/duration-sequencer.test.ts` 10/10, `pnpm typecheck` 0,
  `pnpm lint` 0 (`.colonie-dev/weight-after-deletes.log`).
- Two gaps those deletions exposed, recorded and not fixed: no registered adapter
  implements `Adapter.steer`/`capabilities.queueing`, so the aside lane
  (`server/index.ts:6603`, `12070`) is dead code on the shipped fleet; and tool
  evidence can never be `full` on ACP (`server/digest.ts` `coverageForDriver`)
  even though the runtime receives untruncated `tool_call_update` content.
- **Scope correction: the red set is bigger than the close-out saw.** The "27
  files" of the close-out were one CI quarter's share. Quarter 2
  (`npx vitest run --shard=2/4`, 196 of 754 test files, exit 1, 526.8 s,
  `.colonie-dev/suite-shard2.log`) reports 23 failed files / 50 failed tests of
  2,658, of which four are renderer UI files the close-out already knew and
  **19 are red files it never saw**: `server/index.test.ts` (11 failed),
  `server/thread-aware-bots.e2e.test.ts` (11),
  `server/notification-routing.e2e.test.ts` (7),
  `server/external-runtime.e2e.test.ts` (4), `server/bot-visibility.e2e.test.ts`
  (1), `server/chat-followups-restart.test.ts` (1),
  `server/chief-level-delegation.e2e.test.ts` (1),
  `server/command-allowlist.e2e.test.ts` (1),
  `server/delete-bot-memory.e2e.test.ts` (1),
  `server/late-question-source.e2e.test.ts` (1),
  `server/memory-layer.e2e.test.ts` (1), `server/message-search.e2e.test.ts` (1),
  `server/native-replay.e2e.test.ts` (1), `server/bot-setup.e2e.test.ts` (1),
  `server/shared-user-profile.e2e.test.ts` (1), `server/team-setup.e2e.test.ts`
  (1), `src/components/lazy-screens.test.ts` (1), plus two whose `beforeAll`
  failed so every case skipped (`server/memory-routes.test.ts`,
  `server/browser-codex-path.integration.test.ts`). The queue is therefore ~35
  files, not 23, and it is not yet classified. Measurement caveat: the split
  follows the weight list, so the deletions' edit to
  `vitest-shard-weights.json` moves files between quarters; no single quarter's
  list is a stable subset.
- **Owner-directed deletion of the red test files (October 18).** The owner chose
  deletion over repair, so the red suite stops blocking other work. All 72 red
  files found across the four CI quarters were removed with `git rm`
  (`.colonie-dev/deleted-reds.json` holds `file → failed/total → quarters`), and
  their 63 entries left `vitest-shard-weights.json` (115 → 52):
  `scripts/testing/duration-sequencer.test.ts` 10/10, `pnpm typecheck` 0,
  `pnpm lint` 0 (`.colonie-dev/after-delete-weights.log`). Because some files
  failed only part of their cases, the passing cases inside them went too:
  `server/index.test.ts` (11 of 195), `server/steer-queue.test.ts` (2 of 33),
  `src/components/lazy-screens.test.ts` (1 of 13),
  `server/bot-visibility.e2e.test.ts` (1 of 10), `server/tool-scope.e2e.test.ts`
  (1 of 7), `server/card-answerers.e2e.test.ts` (1 of 7),
  `server/control-colonie.test.ts` (2 of 20), `server/thread-capacity-api.test.ts`
  (2 of 6), `server/thread-title-regenerate.e2e.test.ts` (4 of 5),
  `server/trust-controls.e2e.test.ts` (3 of 12), `server/surface-pins.e2e.test.ts`
  (6 of 8), `server/automatic-recovery.e2e.test.ts` (7 of 11),
  `server/notification-routing.e2e.test.ts` (7 of 8). The rest failed every case.
  A cause was traced per file for a minority only (the triage agents were
  rate-limited); the traced ones are in the milestone's triage list (fixture still
  naming a retired driver, or a retired subject), and the untraced majority is
  recorded as "not traced — owner-directed deletion", not as a cause.
  Coverage now unguarded, by area — ACP context and conversation:
  `delta-context`, `steer-e2e`, `steer-unattended`, `steer-queue`,
  `thread-aware-bots`, `independent-threads-api`, `branching`,
  `context-compaction`, `native-replay`, `thread-model-follow`; memory:
  `memory-layer`, `memory-routes`, `delete-bot-memory`, `shared-user-profile`;
  notifications and routines: `notification-routing`, `routine-delegation`,
  `routine-cron`; team files: `team-lifecycle`, `team-package-skills`,
  `team-setup`, `team-template-ui`, `team-share-ui`, `team-canvas-ui`,
  `team-computers-ui`; routes and gates: `guarded-messages-api`,
  `command-allowlist`, `session-credentials`, `spend-cap-api`, `spend-cap-goal`,
  `trust-controls`, `tool-results`, `mcp-selection`, `chatgpt-plan-api`,
  `mistral-key-flow`, `key-rejected`, `openai-tools`, `codex-review`,
  `full-access-workflows`, `bot-setup`, `bot-continuity`, `boot-readiness`,
  `workspace-backup-workflow`, `comms`; the account surface:
  `claude-account-api`; the renderer: `lazy-screens`, `usage-details-ui`,
  `cloud-preview`, `bot-tools-ui`, `control-colonie-ui`, `slack-management-ui`,
  `thinking-timer-ui`, `team-template-ui`. Two red items were product faults
  rather than test rot and stay open as product work: named Claude accounts
  create the retired `claudeAgent` kind, and the packaged app appears to resolve
  the legacy fleet (HANDOVER gap list).
- **Owner decision: clean slate — all scripts and our test files removed (October 18).**
  The owner judged the test/script sprawl itself the blocker and asked to start clean on a
  new branch. On `restructure` (created from `dd6cca5e`; `main` untouched, revertible by
  discarding the branch or `git checkout main -- scripts/`), `git rm` removed **870
  files**: all 193 files under `scripts/` and all 677 test files of our own
  (`*.test.*`/`*.spec.*`/`__tests__/` under `src/`, `server/`, `electron/`, `shared/`).
  Kept deliberately: the six `third_party/bloub/**/*.test.ts` files (a vendored library's
  own tests — third-party attribution is not ours to delete) and the 39 `server/testing/`
  fixtures (the maintained fake-engine/ACP fixtures; no consumer left, but the cheapest
  base for the rebuilt suite).
  Commands that pointed into `scripts/` no longer run: `colonie`
  (`scripts/colonie/start.ts`), `build:server` (`scripts/bundle-server.mjs`),
  `i18n:check`, `gen:bodies`, `check:contrast`, `clean`, `test:packaged-server`, and the
  rest listed in the commit. `prepare` was dropped from `package.json`, otherwise every
  future `pnpm install` would fail on the deleted hook installer. Still working:
  `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm lint` — none of them use `scripts/`.
  So the app can be built and type-checked but not launched or packaged until the
  launcher/build tooling is rebuilt.
  The post-deletion full-suite run on `main` was stopped mid-flight (it measured a tree
  that no longer matters); `.colonie-dev/suite-after-delete.log` is a partial record only.
  Rebuild order now: a minimal launcher and server-bundle tooling first (without them the
  app cannot be started), then the folder restructure, then a fresh feature-based suite.
- **S1 `server/runtime/` done, and it caught a trap (October 18).** Eight process-lifecycle
  files (data-dir-lease, env-path, environment, exit, graceful-shutdown, procs,
  proxy-paths, restart) moved with `git mv`, imports repointed in 17 files by
  `.colonie-dev/move-module.py`. The first attempt committed `proxy-paths.ts` inside
  `runtime/`; its own header records that it must sit at the server root, because esbuild
  inlines modules into an entry bundle, so a nested copy resolves `SERVER_ROOT` one level
  too high and every spawned proxy points outside `Resources/server` while `/api/health`
  stays green — exactly the 0.1.24 breakage, and `/api/health` did stay green here too. The
  old `proxy-paths.test.ts` was deleted in the clean slate, so the guard was rewritten:
  `server/proxy-paths.test.ts` (SERVER_ROOT is the server directory; every `SPAWNED_PROXIES`
  entry exists inside it) and `server/runtime/graceful-shutdown.test.ts` (cleanup runs once
  and exits 0; a wedged job cannot hold the process past the timeout). 4/4 pass, typecheck
  0, lint 0, server booted on a throwaway data dir and `/api/health` answered.
  Module 2 of 23.
- **S2 `server/persistence/` done (October 18).** Six files moved — store, atomic,
  message-db, message-search-query, message-search-worker, message-search.worker — with
  imports repointed in 77 files. The search worker is referenced as
  `new URL("./message-search.worker.ts", import.meta.url)`, so it moved together with its
  loader and the relative anchor stayed correct. Guards beside the module:
  `atomic.test.ts` (a durable write leaves no temporary sibling; the if-changed variant
  writes only on a real difference) and `store.test.ts` (a test process reads a throwaway
  data directory, never the owner's). The first draft of that second assertion was simply
  wrong — it compared against `os.homedir()`, which the vitest setup has already pointed at
  the throwaway home — and the failure was in the test, not in the code. 7/7 pass,
  typecheck 0, lint 0, server booted on a throwaway data dir with `/api/health` answering.
  Module 3 of 23.
- **S3 started: the voice routes left `server/index.ts` (October 18).** The three `/api/tts/*`
  handlers became `server/routes/voice.ts` (`createVoiceRoutes({ cfg })`): 42 inline lines
  removed, one import and one `ROUTES.push` added, following `server/routes/README.md`.
  Guard: `server/routes/voice.test.ts` (declines paths and methods that are not its own;
  `prepare` answers 200 with utterances that keep the text intact). The first draft asserted a
  sentence split `toUtterances` does not perform — the failure was in the test, not the code.
  9/9 pass, typecheck 0, lint 0, and the server answered `GET /api/tts/voices` with
  `{"voices":[]}` through the new module. First of the route groups; `index.ts` 18,207 → 18,165.
- **S3.2: connectors left `index.ts`, and the verification recipe was corrected (October 18).** The
  four `/api/connectors/*` GETs plus authorize/remove became `server/routes/connectors.ts`
  (`createConnectorRoutes({ cfg, composio })`); 65 inline lines removed. Guard:
  `server/routes/connectors.test.ts` — declines paths and methods it does not own (a first draft used
  `DELETE /api/connectors/connected`, which the module legitimately reads as a service named
  "connected"), an unconfigured server answers 200 `configured:false` instead of an outage, and an
  unreadable credential store answers `credentialStore:"unavailable"` rather than an empty-looking
  success. 12/12 pass, typecheck 0, lint 0.
  Boundary: probing `/api/connectors/connected` on what I called a throwaway data directory reached the
  real Composio API twice (`{"error":"Invalid API key: ak_**HRK9"}`), because `config.json` is read from
  `homedir()` and not from `DATA_DIR`, and the shell exports `COMPOSIO_API_KEY`, which every child process
  inherits. The recipe that actually isolates is
  `env -u COMPOSIO_API_KEY HOME=$(mktemp -d) COLONIE_PROFILE=1 node server/index.ts`: with it the same
  route answers `{"configured":false,"credentialStore":"ok","services":{}}`. The provider rejected the call
  as an invalid key, so the exported key looks stale. No credential contents were read — only the masked
  form the server itself printed.
- **S3.3: the admin read routes left `index.ts` (October 18).** plan-usage, `keys/test`, decisions,
  admin-activity (JSON and CSV) and decisions.csv became `server/routes/admin-reads.ts`
  (`createAdminReadRoutes({ cfg, adminActivityRecording })`); 102 inline lines removed and 16 imports
  the hub no longer uses were pruned (`index.ts` 18,102 → 17,982). Guard:
  `server/routes/admin-reads.test.ts`, driven by a new shared `server/testing/route-context.ts` — the
  three route tests were three copies of the same fake context, and the first copy set `path` to the
  whole request line instead of `url.pathname`, so every query-string validation test silently reached
  no handler. 16/16 pass, typecheck 0, lint 0; the live server answers 400 for `/api/decisions?limit=0`
  and 200 `{"decisions":[]}` through the new module.
- **S3.4: a bot's activity and outbound routes left `index.ts` (October 18).** They became
  `server/routes/bot-activity.ts` (`createBotActivityRoutes({ store, outboundCounts })`); 27 inline lines
  removed (`index.ts` 17,982 → 17,957). Guard: `server/routes/bot-activity.test.ts` — declines other
  paths, an unknown bot is a 404 rather than an empty report on both routes, the stored policy and
  today's count come back, a bot with no threads reports no activity, and a bad `limit` is a 400.
  21/21 pass, typecheck 0, lint 0; the live server answers `{"error":"no such bot"}` for
  `/api/bots/nope/outbound`, which can only come from the new module.
- **S3.5: identity, edition and brand left `index.ts` (October 18).** `GET /api/health`, `/api/edition`
  and `/api/brand` became `server/routes/server-info.ts`
  (`createServerInfoRoutes({ staticDir, sharedWorkspaceFullAccessEnabled })`) — 20 inline lines removed
  (`index.ts` 17,957 → 17,937). The stateful browser-engine installer next to them stayed put on
  purpose: it owns install state and broadcasts config changes, so it is not a read-only move. Guard:
  `server/routes/server-info.test.ts` — the handshake echoes this process's pid, the
  `sharedWorkspaceFullAccess` capability appears only when the feature is on, `static` follows the static
  dir, and edition plus brand answer without a provider. 26/26 pass, typecheck 0, lint 0; the live server
  answers all three through the new module (`pid` matches the process it started).
- **S3.6: the team library and the scout left `index.ts` (October 18).** The catalog, a library team, a
  GitHub team, `/api/teams/scout` and `/api/teams/scout/directory` became `server/routes/team-library.ts`
  — a plain handler, since it needs no dependencies: 57 inline lines removed and three imports the hub no
  longer uses pruned (`index.ts` 17,937 → 17,880). The module keeps the split that matters: it proposes,
  and only `POST /api/teams/import` (still in the hub) creates anything. Guard:
  `server/routes/team-library.test.ts` — other paths decline, a missing or unusable folder is a 400
  instead of a guess, a GitHub import with no URL is a 400 before any network call, and scouting a real
  folder answers a profile and a suggestion. 30/30 pass, typecheck 0, lint 0; the live server answers both
  scout cases through the new module.
- **S3.7: the skills library routes left `index.ts` (October 18).** The list, one skill's text, the
  enable/disable patch and the per-bot assignment became `server/routes/skills-library.ts`
  (`createSkillsLibraryRoutes({ cfg, store })`) — 75 inline lines removed and five imports the hub no
  longer uses pruned (`index.ts` 17,880 → 17,804). Guard: `server/routes/skills-library.test.ts` — other
  paths decline, the feature being off is a 404 on every surface rather than an empty list, the list does
  not invent entries, an import without SKILL.md text is a 400, an unknown skill name is refused, and an
  unknown bot is a 404 first. 36/36 pass, typecheck 0, lint 0. Live: with a throwaway HOME the route
  answers 404; after writing `{"features":{"skillsLibrary":true}}` into that throwaway config it answers
  `{"skills":[]}`, and a bodyless import answers 400.
- **S3.8: the team sections left `index.ts` (October 18).** `GET/PATCH/DELETE/PUT/POST /api/sidebar-sections`
  became `server/routes/team-sections.ts`
  (`createTeamSectionRoutes({ store, teamComputers, wireBot, maxWorkspaceBots })`); the request schema and
  its 100-bot ceiling moved with them, and the hub's copy of the schema was removed — the ceiling itself
  stays in `index.ts` and is passed in, so there is still one place that decides it. 55 inline lines
  removed (`index.ts` 17,804 → 17,745). Guard: `server/routes/team-sections.test.ts` — other paths
  decline, the list answers the stored teams, a rename or delete without naming a team is a 400, an empty
  rename is refused before the store is touched, an unknown team is a 404, a team the store cannot build
  is a 404 rather than a silent success, and a team with neither name nor bots is refused. 43/43 pass,
  typecheck 0, lint 0; the live server answers `{"sections":[]}`, 400 and 404 through the new module.
- **S3.9: the new-bot defaults left `index.ts` (October 18).** `GET /api/bot-defaults`, the skills preview
  and the avatar preview became `server/routes/bot-defaults.ts`
  (`createBotDefaultRoutes({ cfg, store, defaultSelection })`) — 45 inline lines removed and `pickBotName`
  plus `scanSkillText` pruned from the hub's imports (`index.ts` 17,745 → 17,704). Previews stay previews:
  the avatar comes back as a data URL and the skills as unsaved templates, so nothing here writes a bot,
  a skill or an image. Guard: `server/routes/bot-defaults.test.ts` — other paths decline, a fresh install
  still answers complete defaults (schema defaults, a model selection, a suggested name), a preview without
  a source is a 400, and a broken profile is refused before any image generation. 47/47 pass, typecheck 0,
  lint 0; the live server answers `{"defaults":{...},"modelSelection":{...},"suggestedName":"Skye"}` through
  the new module.
- **S3.10: the custom MCP servers left `index.ts` (October 18).** List, add, paste-to-add import, edit,
  delete, the connection test and the whole sign-in flow became
  `server/routes/mcp-servers.ts` (`createMcpServerRoutes({ cfg, mcpOAuth, sessions, persistMcpServers,
  mcpConfigLock, savedCustomDomain, fallbackPublicUrl })`) — 199 inline lines removed and seven now-unused
  imports pruned (`index.ts` 17,704 → 17,490). Two pieces did not move as written: the busy flag is shared
  with the legacy internal peer route that also edits `mcpServers`, so the module takes an
  `mcpConfigLock` (one flag, still owned by `index.ts`) instead of growing a second one; the probe counter
  and its limit did move, since nothing else used them. `mcpServerResponse` and `mcpServerBody` moved with
  the routes that used them. Guard: `server/routes/mcp-servers.test.ts`, driven by a fixture that now
  accepts request headers — other paths decline, the list answers an empty registry, a mutation without a
  JSON content-type is a 415 and changes nothing, adding a command server stores and lists it, a duplicate
  name is a 409, a mutation while the shared lock is held is a 409 and changes nothing, an unknown server
  is a 404 on delete, a patch of anything but `enabled` is refused, and deleting forgets the sign-in.
  56/56 pass, typecheck 0, lint 0. Live on a throwaway HOME: `{"servers":[]}`, 415 without the header,
  201 with `{"name":"demo","enabled":false}`, then `{"servers":[]}` after DELETE.
- **S3.11: the team brief and team memory left `index.ts` (October 18).** `/api/team-memory`, the
  `/api/team-memory/:id` patch/delete/accept and `/api/section-context` became
  `server/routes/team-brief.ts` (`createTeamBriefRoutes({ store, teamMemory })`) — 100 inline lines removed
  and two imports pruned (`index.ts` 17,490 → 17,390). Process note worth keeping: the first draft was
  written from a read whose output had been compressed, and it invented three details (the 201 plus
  `proposed.entry.id` on a new memory, pass-through of `aliases`, and a 60-character check in the
  patch/delete branch that the original does not have). It was thrown away and re-transcribed from the
  original lines in small reads. Guard: `server/routes/team-brief.test.ts` — other paths decline, both
  surfaces demand a section even for General, an explicitly empty section is a valid known team, an
  unknown team is a 404 rather than an empty brief, a 61-character section is refused, a missing memory
  entry is a 404, a person's own entry is trusted immediately, and an unknown kind is refused. 64/64 pass,
  typecheck 0, lint 0. Live on a throwaway HOME: General reads empty, an unknown team is 404, team memory
  lists empty, and a PUT stores the brief and reads it back.
- **S3.12: a bot's SOUL, system-prompt preview and profile history left `index.ts` (October 18).** The soul
  read, `soul/apply-file`, `soul/discard-file`, `system-prompt`, `overview`, `history` and
  `history/rollback` became `server/routes/bot-profile.ts`
  (`createBotProfileRoutes({ store, wireBot, broadcast, previewSystemPrompt, botOverview })`) — 130 inline
  lines removed and four imports pruned (`index.ts` 17,390 → 17,260). The onboarding-card route that sat
  next to them stayed behind: it is about messages, not the profile. Guard:
  `server/routes/bot-profile.test.ts` — other paths decline, an unknown bot is a 404 on all four reads,
  the soul read reports the record with its size and the limit, a stale revision is a 409 before anything
  is written, a file text that is not what the read returned is refused, a rollback naming no soul entry
  is a 400 and a rollback with a stale revision is a 409 first, and the system-prompt preview and overview
  answer. One test was wrong twice before it was right: it passed `{}` where the method goes, and it
  expected the "matches the record" answer that only exists once a SOUL.md mirror is on disk.
  73/73 pass, typecheck 0, lint 0. Live on a throwaway HOME: `/api/bots/nope/soul`, `/history` and
  `/overview` all answer `{"error":"no such bot"}` through the new module.
- **S4: routines, calendar calls and webhooks moved into `server/colonie/routines/` (October 18).** Five files
  (`routines.ts`, `calendar-calls.ts`, `routine-requests.ts`, `webhooks.ts`, `webhook-ingress.ts`, 4,870 lines)
  moved with `git mv` and every relative import repointed — 17 files changed, `server/index.ts` among them.
  The mover had to be taught one thing: it assumed a file sits in the destination's sibling directory, which
  is false for `server/colonie/<feature>/`; it now locates the file anywhere in the repo first. Guard:
  `server/colonie/routines/routine-requests.test.ts` covers the pure schedule text — an interval without an
  anchor starts one interval after confirmation and says so, an interval with restrictions says the first run
  is the next allowed time, an anchored interval names its anchor and zone, `asSchedule` copies rather than
  shares the weekday array, a one-off run never carries a cadence, the consequence line states the real
  frequency (24 times a day, once a day, or the restriction sentence), a daily one counts its days, and a
  one-off run ignores the continuity flag because it has nothing to continue from. 80/80 pass, typecheck 0,
  lint 0. Live on a throwaway HOME: `/api/routines`, `/api/calendar-calls` and `/api/webhooks` all answer
  empty lists through the moved files.
- **S5: workspace and backup into `server/colonie/workspace/`, and `build:server` works again (October 18).**
  Six files moved (`workspace.ts`, `workspace-backup.ts`, `workspace-backup-http.ts`,
  `workspace-backup-maintenance.ts`, `workspace-backup-policy.ts`, `team-backup.ts`; 16 files repointed).
  `workspace-backup.worker.ts` stayed at the root on purpose. Guard:
  `server/colonie/workspace/workspace-backup-policy.test.ts` — a backup carries the portable sections
  (profile, budgets, language) and never the machine's own (provider API keys, sign-in, custom domain,
  CLI startup), a malformed config is refused by name, restoring replaces portable sections and keeps
  everything else local, lending this computer stays the machine's own decision in both directions, the
  refused authentication paths are named exactly (allowlist, OAuth, provider keys, Caddy, chrome profile,
  agent-browser, workspace credentials, browser-engine key) while ordinary files are not mistaken for
  them, and per-turn engine hooks are never exported though an old backup still restores. 87/87 pass,
  typecheck 0, lint 0. Live on a throwaway HOME: a real export ran the backup worker and produced a 3 MB
  archive (74 files); the same export and `GET /api/search` both work from the packaged bundle
  (`dist-server/index.js`).
- **S5 uncovered two build breaks, one of them mine (October 18).** `build:server` had been failing since
  S2: `message-search.worker.ts` moved into `persistence/` but the bundler entry list did not, so the
  packaged worker would have been emitted under `dist-server/persistence/` while `import.meta.url` inside
  the inlined spawner points at the bundle root. The rule is now written into `bundle-server.mjs`: a worker
  spawned by URL from a module that is not itself an entry point must be emitted beside `index.js`. The
  other was the clean slate's: `scripts/desktop-server-entry.mjs` is needed to run the packaged app and
  was restored from `main`; `scripts/mcp-server.ts` is not needed by anything the app ships, so the
  bundler skips that step with a warning and one `git checkout main -- scripts/mcp-server.ts` brings it
  back. `pnpm build:server` is green again.
- **S6: peers, delegations and comms visibility into `server/colonie/peers/` (October 18).** Seven files moved
  (`peer-approval.ts`, `peer-approval-key.ts`, `peer-delivery.ts`, `peer-provenance.ts`, `peer-roster.ts`,
  `delegations.ts`, `comms-visibility.ts`; 13 files repointed). Guards:
  `server/colonie/peers/comms-visibility.test.ts` and `peer-roster.test.ts`. The first holds the
  observability rule — a peer exchange leaves a chip in both threads, each naming the other bot, and a
  delegation names the thread it happened in rather than the sender's standing one. The second holds the
  access rules: same team by default with an unknown owner list failing closed, a Chief reaching only the
  teams the owner granted (a title alone grants nothing, names match exactly), only the sender's pair list
  bounding the pair so a bot cannot refuse its own team's Chief, a hand-edited `peers` value degrading to
  the default instead of failing a turn, a restricted teammate being unreachable by one everyone can see,
  hidden bots and self excluded, the roster a bot is told about equal to what it may reach, opened teams
  (COLONIE_OPEN_TEAMS) grouping the sidebar without widening a Chief's authority, and the harness activity
  signal winning over the busy flag. 99/99 pass, typecheck 0, lint 0. No public peer route exists to probe —
  all peer and delegation HTTP lives in the owner-gated `/api/internal/*` block — so the live check is the
  server booting on a throwaway HOME and `GET /api/bots/:id/system-prompt`, which renders through the moved
  `peer-roster.ts`, answering 1,866 bytes with no error in the log.
- **S7: memory into `server/colonie/memory/` (October 18).** The feature turned out to be two stores, so the
  folder now says so: the Colonie ledger (its own `colonie-memory/state.json`) moved into
  `colonie/memory/ledger/` — `store.ts`, `service.ts`, `capture.ts`, `recall.ts`, `routes.ts` — and the bot
  memory files (MEMORY.md and `memory/` under the bot's workspace) sit beside it as `memory-capture.ts`,
  `memory-entries.ts`, `memory-journal.ts`, `memory-organize.ts`, `memory-store.ts`, `memory-tidy.ts`,
  `memory-topics.ts`, `memory-upkeep.ts` and `recall.ts`. Nine files moved plus the five nested, 12 files
  repointed, `index.ts` included. Guard: `server/colonie/memory/memory-entries.test.ts` — a memory date is a
  real calendar day and not just the shape, an entry is one dated line with or without a source, a
  hand-written line without a date is not an entry and is never touched, the grammar reads the `until` mark,
  a strike-through and trailing `updated`/`confirmed` marks, an entry owns the indented lines and the code
  block under it, a fence that never closes claims nothing, the `until` day itself still loads while the day
  after does not, expired entries are hidden from a turn without touching the file, a safety or health fact
  always stays in what loads, a fact's identity is deliberately narrow (`-10` is not `10`, `C++` is not `C`,
  `API_KEY` is not `api_key`), and a notebook's identities skip struck entries. 110/110 pass, typecheck 0,
  lint 0. Live on a throwaway HOME: the ledger view reads, a fact writes and reads back with its key, a
  clear with a stale revision is refused with "Memory changed elsewhere" and succeeds with the fresh one.
- **Stale file paths in comments were swept (October 18),** a debt from S1–S7 leaving "see server/x.ts"
  comments behind a move. Twelve files updated by hand-verified pairs only where the old path no longer
  exists and exactly one file in the repo carries the basename: the blueprint, HANDOVER, the routes README,
  the release skill, `server/index.ts`, `server/server-launcher.ts`, the moved memory and workspace files,
  `shared/colonie-memory.ts`, and two renderer files. `docs/PROGRESS.md` was left alone: it is a log, and
  its old paths describe work as it was done.
- **S8: skills into `server/colonie/skills/` (October 18).** Five files moved — `skills.ts` (1,545 lines),
  `skill-library.ts`, `skill-fetch.ts`, `skill-learn.ts`, `skills-library-migration.ts` — joining the ledger
  pair (`routes.ts`, `service.ts`) already there; 10 files repointed. Guard:
  `server/colonie/skills/skill-learn.test.ts` — the `/learn` slash command is recognised with or without a
  request and in any case, a message that merely mentions it is ordinary chat, a multi-line request keeps
  its text trimmed only at the edges, the run card's sentence is only that sentence, the source names the
  request (or "conversation") and caps at 180 characters, the authoring prompt carries the person's request
  verbatim and states that source text is data rather than instructions, an empty request asks for the
  conversation itself, and a turn becomes the authoring prompt only when it is a learn request.
  118/118 pass, typecheck 0, lint 0. Live on a throwaway HOME: `/api/bots/:id/colonie-skills` answers through
  the moved modules, and with `{"features":{"skillsLibrary":true}}` written at `~/.colonie/config.json` the
  opt-in `/api/skills-library` answers `{"skills":[]}`. That flag is read from the data directory's config,
  not the home directory's — a wrong first attempt of mine, not a bug.
- **S9: bots into `server/colonie/bots/` (October 18).** Twelve files moved — `avatar-image.ts`,
  `bot-attachment.ts`, `bot-cwd.ts`, `bot-directory.ts`, `bot-folder.ts`, `bot-overview.ts`,
  `bot-package.ts`, `bot-profile.ts`, `bot-visibility.ts`, `new-bot-defaults.ts`, `presets.ts`,
  `system-prompt.ts` — 36 files repointed. Three basenames are ambiguous in the repo (`bot-profile`,
  `new-bot-defaults`, `presets`, the last two also under `shared/`), so the mover's explicit `old|name` form
  was used for them rather than trusting the first match. Guard: `server/colonie/bots/bot-visibility.test.ts`
  — an admin's input reads as everyone, admins or a list of people; a list that names nobody means admins
  only and never everyone; an entry that is not an address is refused with the offending value and the
  maximum is enforced; a damaged value read back from disk fails closed to admins while an absent one is
  everyone; who may see a bot, including the `@domain` suffix rule and an unusable email; an audience is
  inside another only when nobody new can see it; the people who can see both sides, where an empty
  intersection is admins only; the narrowest of several audiences; and two readings naming the same
  audience. 126/126 pass, typecheck 0, lint 0. Live on a throwaway HOME: `/api/bot-presets`,
  `/api/bot-defaults`, `/api/bots/:id/overview` and `/api/bots/:id/system-prompt` all answer through the
  moved modules.
- **S10: teams, packages and the catalog into `server/colonie/teams/` (October 18).** Twelve files moved —
  `team-computers.ts`, `team-library.ts`, `team-manifest.ts`, `team-memory.ts`, `team-setup-requests.ts`,
  `published-teams.ts`, `project-scout.ts`, `section-context.ts`, `chief-of-staff.ts`, `package-export.ts`,
  `package-import.ts`, `package-parts.ts` — 20 files repointed. Guard:
  `server/colonie/teams/section-context.test.ts` — General is the empty team spelled the same everywhere, a
  brief round-trips while unrelated teams stay unknown, empty text clears rather than storing a blank, the
  byte cap is enforced below the route too, a written brief becomes a bounded lower-priority block that
  carries the byte count and says it is context rather than authorization and that contains no path to the
  store, a team with no brief adds nothing, a team is remembered once when first named, and renaming an
  empty team carries its brief and refuses a name that does not exist. Two of the three failures while
  writing it were the test's fault, not the code's: tests in one file share the throwaway data directory, so
  expectations had to stop assuming an empty list of teams. 134/134 pass, typecheck 0, lint 0. Live on a
  throwaway HOME: `/api/sidebar-sections`, `/api/section-context?section=`, `/api/team-map` and
  `/api/teams/scout` answer through the moved modules, and `/api/teams/export` produced a 184-byte package.
  Two probes reached out rather than staying local and are reported as such: `/api/team-library/catalog`
  fetches its catalogue from GitHub (`{"error":"GitHub returned HTTP 404"}` unauthenticated) and
  `/api/teams/scout` without a folder answers as designed.
- **S11: providers, models, accounts and usage into `server/colonie/providers/` (October 18).** Sixteen files
  moved — `account-signin.ts`, `claude-accounts.ts`, `claude-config.ts`, `cli-api-setup.ts`,
  `default-model-selection.ts`, `engine-install.ts`, `key-rejections.ts`, `model-context-window.ts`,
  `model-prices.ts`, `model-requests.ts`, `plan-usage.ts`, `provider-auth-sessions.ts`, `provider-icon.ts`,
  `provider-key-check.ts`, `startup-model-catalog.ts`, `usage-ledger.ts` — 29 files repointed.
  `thread-model.ts` stayed for S14 (chat). Guard: `server/colonie/providers/key-rejections.test.ts` — a
  rejection is the key's fault only for the phrasings that say so, quota/billing/rate limits are never the
  key's fault even on a 401 or 403, a saved key counts as working until a real use says otherwise, a mark
  belongs to the key and the endpoint with a trailing slash ignored, a later accepted use clears it, saving
  or clearing drops every mark, and listeners hear a change once and stop on unsubscribe. Three of my
  expectations were wrong about the pattern and were corrected against the module rather than the other way
  round; the test now records the two phrasings that are *not* recognised ("this api key has expired", a
  bare "Your key was revoked") as a product observation for the owner, not a change. 140/140 pass,
  typecheck 0, lint 0. Live on a throwaway HOME: `/api/usage` and `/api/plan-usage` answer through the moved
  modules. `/api/keys/test` was deliberately not probed — it would send a key to a real provider.
- **S12: MCP, connectors and Composio into `server/colonie/mcp/` (October 18).** Eighteen library files moved —
  `composio.ts` (1,552 lines), `mcp-oauth.ts`, `mcp-registry.ts`, `mcp-directory.ts` (708), `mcp-http.ts`,
  `mcp-bridge.ts`, `mcp-remote-proxy.ts`, `mcp-probe.ts`, `mcp-gate.ts`, `mcp-gate-config.ts`,
  `mcp-schema-validator.ts`, `mcp-tool-schema.ts`, `mcp-tool-images.ts`, `mcp-trim.ts`,
  `mcp-oauth-discovery.ts`, `mcp-oauth-store.ts`, `connector-advertisement.ts`, `connector-card-text.ts`,
  `connector-scope-hint.ts`, `connector-verdict.ts` — 25 files repointed. Five files deliberately stayed at the
  server root, all spawned as their own process: `container-mcp.ts`, `connector-proxy.ts`, `mcp-gate.ts`,
  `mcp-remote-proxy.ts`, `harness-mcp-proxy.ts`. `proxy-paths.ts` locates every spawned file through
  `SERVER_ROOT` (`resolveProxy`), so a spawned entry keeps its path relative to `server/` however its
  neighbours are filed — the same rule as `proxy-paths.ts` and the two workers, now written into
  `bundle-server.mjs` beside the entry list. Guard: `server/colonie/mcp/mcp-schema-validator.test.ts` — both
  supported dialects compile and an unsupported one is refused by name, a schema is a contract so nothing is
  coerced/defaulted/dropped, an unknown keyword is refused strictly and ignored leniently, the custom
  `uint32`/`uint64` bounds hold, a complaint reads as a line a model can act on (with the real Ajv wording),
  the forgiving copy drops `pattern`/`patternProperties`/`format` and opens a closed object only where a
  pattern map or a composition branch did, a closed object stays closed, the forgiving check passes where the
  server would refuse, and a schema too big or uncompilable is left to the server. Three failures while
  writing it were mine: an error list I fabricated by hand did not match `ErrorObject`, and I had guessed
  Ajv's first-error choice and wording. 149/149 pass, typecheck 0, lint 0, `build:server` green. Live on a
  throwaway HOME: `/api/mcp/servers` lists and accepts a new stdio server, `/api/connectors` answers without
  reaching Composio (`COMPOSIO_API_KEY` unset), and both answer the same from `dist-server/index.js`; all ten
  `SPAWNED_PROXIES` files are emitted where `resolveProxy` looks for them.
- **S13: computers, containers, browsers and the local VM into `server/colonie/computer/` (October 18).**
  Twenty-six files moved — `container-computer.ts` (1,334 lines), `browser-engine.ts`, `browser-live.ts`,
  `browser-runtime.ts`, `browser-lifecycle-cleanup.ts`, `browser-bundle-release.ts`,
  `browser-engine-release.ts`, `browser-tool-shape.ts`, `computer-control.ts`, `computer-observation.ts`,
  `computer-selection.ts`, `computer-wait.ts`, `computer-engine-removal.ts`, `control-client.ts`,
  `desktop-viewer-targets.ts`, `auto-vm-claims.ts`, `local-vm-idle.ts`, `local-vm-inventory.ts`,
  `local-vm-lease.ts`, `local-vm-seat-pool.ts`, `local-vm-stop-reason.ts`, `private-screen-capture.ts`,
  `screen-frame-gate.ts`, `screen-frame-source.ts`, `shared-computer-control.ts`, `shared-computers.ts` —
  16 files repointed. Four stayed at the server root: `container-mcp.ts`, `local-computer.ts`,
  `local-computer-proxy.ts` and `permission-proxy.ts` are all bundle entries or spawn targets. Guards:
  `computer-selection.test.ts` — asking for a place gets that place and nothing when it is not offered, the
  turn's own place is kept rather than restarted elsewhere, a place this turn is about to wake counts as its
  own before it is up, Auto prefers a ready virtual machine over an already-ready local one, Auto walks its
  order (ready, then startable, then creatable, virtual first), and a place that cannot be used at all is
  never picked by Auto though it is still the answer when asked for by name; `screen-frame-gate.test.ts` — a
  settled frame is news only when it differs from what the reader already sees and otherwise fails open, the
  fingerprint is the frame's, and a shell command over the computer is not a screen touch. 158/158 pass,
  typecheck 0, lint 0, `build:server` green with all ten `SPAWNED_PROXIES` files emitted. Live on a throwaway
  HOME: `/api/local-computer` and `/api/local-computer/instances` answer through the moved modules, and the
  same answer comes from `dist-server/index.js` (Docker not started, reported as designed).
- **S14: chat, threads, turns and attachments into `server/colonie/chat/` (October 18).** Twenty-seven files
  moved — `turn-context.ts`, `turn-continuation.ts`, `turn-dispatch-guard.ts`, `turn-images.ts`,
  `turn-resources.ts`, `turn-watchdog.ts`, `turn-log.ts`, `member-turn.ts`, `thread-events.ts`,
  `thread-log-rotation.ts`, `thread-model.ts`, `thread-retention.ts`, `thread-starters.ts`,
  `thread-title.ts`, `steer-queue.ts`, `aside-queue.ts`, `channel-queue.ts`, `checkpoints.ts`,
  `attachments.ts`, `message-file.ts`, `delta-context.ts`, `digest.ts`, `direct-handoffs.ts`,
  `compaction-summary.ts`, `context-budget.ts`, `context-rebuild.ts`, `tool-summary.ts` — 30 files
  repointed. `message-search.worker.ts` stayed at the server root (it is a spawned process). Guard:
  `server/colonie/chat/context-budget.test.ts` — the window comes from the provider first, the catalog
  next, the model id last, with unusable numbers ignored and unknown models getting no guess; the
  compaction budget keeps headroom below 90% of the window and of the provider's own boundary, reads a
  value under 1 as a fraction, and still yields a usable budget for a 1-token window; compaction triggers
  on a measured token count when there is one and on estimated bytes otherwise, with a floor raising the
  bar by a quarter yet never past the ceiling; and the CLI's own compaction window is the harness's choice,
  clamped to what the CLI accepts rather than passed through, with a mistyped setting falling back instead
  of failing every turn. One assertion was mine, not the code's: I had placed a floor so high that it
  exceeded the ceiling it is capped by. 162/162 pass, typecheck 0, lint 0.
- **A dev-path bug from S5, found by the S14 live check (October 18).** `GET /api/search` answered "Search
  was interrupted. Try again shortly." in dev. S5 moved `message-search.worker.ts` back to the server root
  for the packaged bundle but left `new URL("./message-search.worker.ts", import.meta.url)` in
  `persistence/message-search-worker.ts`, so dev looked for the worker beside the module. The packaged app
  only worked by accident, through the `.js` fallback landing at the bundle root. A spec relative to the
  starting module cannot satisfy both layouts, because that module is inlined into `index.js` in a package
  and sits in its own folder in dev. Both workers are now `SPAWNED_PROXIES` entries started through
  `resolveProxy`, so there is one anchor; `proxy-paths.test.ts` already asserts every entry exists, so a
  future move of either file fails a test rather than a turn. Verified after the fix on a throwaway HOME:
  `GET /api/search` and a real workspace export both work from `server/index.ts` and from
  `dist-server/index.js` (`eb1dab83`).
- **S3.13: the CLI discovery and pre-save probe out of `index.ts` (October 18).** `server/routes/cli-probe.ts`
  takes `GET /api/cli-candidates` and `POST /api/cli-test` plus the three helpers only they used
  (`testCliBinary`, `cliProbeEnvironment`, `stderrOf`), all verified unused elsewhere before they moved.
  `index.ts` 17,261 → 17,166 lines. Non-internal guards 48 → 46. Guard: `server/routes/cli-probe.test.ts`
  — a request that is not its own is passed on, a candidates lookup for a name nobody has comes back empty
  rather than failed, a form post that could come from another page is refused with 415, an empty or
  multi-line path is refused before anything is executed, a binary that is there answers with the version
  line the UI shows, and a path that is not there reads as a setup problem rather than a crash. The
  environment the probe hands a wrapper is the credential-redacted one `cliProbeEnvironment` builds, which
  is why the module owns it rather than index.ts. Live on a throwaway HOME: candidates for `node` listed in
  PATH order, `node` probed as `v24.13.1`, a missing path reported as "isn't installed, or isn't on this
  app's PATH", and a `text/plain` post refused. 168/168 pass, typecheck 0, lint 0.
- **S3.14: the Live Team Map out of `index.ts` (October 18).** `server/routes/team-map.ts` takes
  `GET /api/team-map`; `index.ts` 17,166 → 17,154 lines. The route keeps its whole rule set: a viewer sees
  an edge only between bots it is already allowed to see, a queued handoff naming a hidden bot is dropped,
  a running delegation needs both ends visible and names its thread, and only ids, labels and thread ids
  leave the server (`collaborations` stays empty because stored DM rooms are retired history, not live
  connections). Guard: `server/routes/team-map.test.ts` (4). Live on a throwaway HOME:
  `{"collaborations":[],"queued":[],"running":[]}` and `POST /api/team-map` is still not a route. 172/172
  pass, typecheck 0, lint 0.
- **S3.15: routines and their runs out of `index.ts` (October 18).** `server/routes/routines.ts` takes
  `GET/POST /api/routines`, `GET /api/routines/wake`, `POST /api/routines/:id/run`, `PATCH/DELETE
  /api/routines/:id`, `POST /api/routine-runs/seen-all` and `POST /api/routine-runs/:id/(cancel|seen)`,
  plus the `hiddenRoutineTarget` helper only they used. The module declines a request that is not on one of
  its paths before it builds a VisibleSet, so pulling the routes out does not add work to every other
  request. Guard: `server/routes/routines.test.ts` (7) — a listing never shows a hidden bot's routine or run,
  a window that is not a number falls back to the manager's default, a routine aimed at a bot or room the
  caller cannot see reads as "no such bot"/"no such channel" rather than as a refusal, running/cancelling/
  acknowledging answer for the routine named, and the shell's wake question is answered by the manager. Live
  on a throwaway HOME: create (`{"type":"daily","time":"09:00"}` — the schedule key is `type`, not `kind`),
  list, wake, run, patch and delete all answered, and `/api/routine-runs/seen-all` returned an empty list.
  179/179 pass, typecheck 0, lint 0.
- **S3.83: the finished-turn notes out of `index.ts` (October 18).**
  `server/colonie/chat/completed-turn-notes.ts` (`registerCompletedTurnNotes`):
  the two `turn.completed` folds, in the order they have always run — the
  memory-upkeep capture-queue entry (only the person's own 1:1 successful turn:
  not a room, not a turn another bot or the harness started, not a failed turn)
  and the bot's daily-log line (`recent-work.ts`'s `turnOutcomeLine`, written
  through `appendMemoryLog`). Both share the same "person's own turn only" gate
  and both swallow their own failure so a missing note never fails a turn.
  `routines` and `memoryUpkeep` come in as getters, so those shared bindings stay
  in `index.ts`. `index.ts` 2,346 → 2,300 lines. Guard: new
  `completed-turn-notes.test.ts` (5) — the person's own turn queued with the
  bot's text, the ignored/internal/unattended/failed skips, the peer-ask and
  upkeep-off skips, a failing capture warning instead of throwing, and one
  daily-log line (with tools and source) plus none for a silent turn.
  `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server` 97 files / 463
  tests pass; live probe green.
- **S3.82: the turn-origin marks out of `index.ts` (October 18).**
  `server/colonie/chat/turn-origins.ts` (`createTurnOrigins`): the
  `unattendedThreads` mark (a webhook-driven turn, or one a webhook-driven bot
  handed to a teammate, does not inherit a person's auto mode; per conversation,
  ages out only while the bot is idle, refreshed on every positive read) and the
  `internalTurnThreads` mark (a turn another bot started raises no badge or
  banner). Both are module-level `const` maps/sets — never reassigned — so they
  move intact, and the surviving call sites read the imported bindings. The
  block was 1,288–1,348 lines of state and helpers (~61 lines) with the long
  rationale comments, now the module's header. `index.ts` 2,403 → 2,346 lines.
  Guard: `turn-origins.test.ts` (5) — per-conversation isolation, the
  thread-less fail-closed read, the idle-ages-out/busy-never does, the
  read-refreshes-window rule, and the peer-turn mark clearing. `pnpm typecheck`
  0, `pnpm lint` 0, `npx vitest run server` 96 files / 458 tests pass; live probe
  green.
- **S3.81: the event-log retention sweep out of `index.ts` (October 18).**
  Extended `server/colonie/chat/thread-retention.ts` — the sweep's own domain —
  with `sweepThreadEventLogsNow` (build the candidate list from the store, then
  remove the idle threads' logs) and `scheduleThreadLogRetention` (sweep once at
  boot, then daily on an unref'd timer; only the boot sweep is guarded, as
  before). `index.ts` keeps only the source callbacks, so the store shape stays
  out of the module and `retentionDays`/`threadBusy` stay live. `index.ts`
  2,430 → 2,403 lines. Guard: new `thread-retention.test.ts` (5) — an idle
  closed thread's logs go from both dirs, a fresh/busy/unread thread keeps its
  logs, retention off never even reads the store, the schedule sweeps at boot
  and again on the timer, and a failing store warns instead of crashing boot.
  `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server` 95 files / 453 tests
  pass; live probe green.
- **S3.80: the memory boot and lifecycle out of `index.ts` (October 18).**
  `server/colonie/memory/memory-boot.ts` (`createColonieMemoryBoot`): the
  feature-not-a-boot-dependency boot (a readable ledger builds the service; an
  unreadable one logs and hands over an explicitly unavailable service that
  refuses writes rather than corrupting stored data) plus its two lifecycle
  wirings — the bot-change handler that cancels memory and the Chief and drops
  the bot's pending sources on delete, and the settled-turn subscriber that
  queues a capture only when the turn's stored receipt matches the person's own
  words. `index.ts` keeps the two `let` bindings and assigns them from the
  returned `{ memoryStore, memory }`. `index.ts` 2,480 → 2,430 lines. Guard:
  `memory-boot.test.ts` (5) — one handler and one subscriber are registered, a
  deleted bot cancels everywhere and drops its job while another bot's capture
  stays queued, a read turn stops being a source, an unrelated event leaves it
  alone, and an ignored provider turn captures nothing. `pnpm typecheck` 0,
  `pnpm lint` 0, `npx vitest run server` 94 files / 448 tests pass; live probe
  green.
- **S3.79: the thread-admission gates out of `index.ts` (October 18).**
  `server/colonie/chat/thread-admission.ts` (`createThreadAdmission`):
  `botForThread`, `threadBusy`, `botAtThreadCapacity`, `hasDirectDispatch`,
  `canAdmitDirectTurn`, `unattendedDispatchState` and `requestedTaskBot` — the
  state half of admission (the bot records, the live dispatch claims and the
  configured slot count) feeding the unchanged pure policy in
  `server/admission.ts`, which this module imports directly rather than
  duplicating. Seven functions (L628–685, ~58 lines). `store` is passed as a
  getter because it is created below this point and these read it only when
  called; the wire keeps `maxConcurrentThreads: () => maxConcurrentBotThreads(cfg)`
  live to config edits. `index.ts` 2,529 → 2,480 lines. Guard:
  `thread-admission.test.ts` (6). `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 93 files / 443 tests pass; live probe green.
- **S3.78: the conversation-source helpers out of `index.ts` (October 18).**
  `server/colonie/chat/conversation-sources.ts` (`createConversationSources`):
  `resolveReplyTarget` (an absent target is allowed, a malformed one is 400, and
  a target that is gone or not a non-empty text line is 404),
  `messageFileRootsForThread` (the conversation's pinned or configured folder,
  the bot's workspace and the attachment store), `connectorThread` (only the
  sender's own main chat or one of its task threads is writable; a stored room
  thread is read-only history), and `proposalPersistence` (unknown sender or
  foreign thread is 403; otherwise the shared eight-open-card budget, skipped
  when the change applies directly). Four functions (L2096–2166, ~61 lines) that
  answer from the same store facts. The wire sits just after
  `createApprovalResolution` because `proposalPersistence` is handed over as a
  value (`canPersist`), not a getter, and so must be bound before that site reads
  it. `index.ts` 2,591 → 2,529 lines. Guard: `conversation-sources.test.ts` (6).
  `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server` 92 files / 437 tests
  pass; live probe green.
- **S3.77: the thread-title one-shot out of `index.ts` (October 18).**
  `server/colonie/chat/title-generation.ts`: `generateThreadTitle` (the cheap
  provider `generateText` one-shot behind a fresh thread's name and "Regenerate
  title" — the prompt is built by `thread-title.ts`, this only runs it, races a
  10s expiry that also aborts the provider call, and refuses anything that is not
  a plain short title) and the `titleRegenerations` set that keeps Regenerate to
  one one-shot per thread. That set is a `const Set` that is mutated but never
  reassigned, so moving it is safe; both names are still handed to the turn and
  request wirings as before. `index.ts` 2,628 → 2,591 lines.
  Guard: `title-generation.test.ts` (6) — a plain short answer is accepted, the
  conversation form is asked when regenerating, an over-long or blank answer is
  refused, a provider with no text path yields nothing, a slow one-shot is
  abandoned at the 10s cap, and the set starts empty. `pnpm typecheck` 0,
  `pnpm lint` 0, `npx vitest run server` 91 files / 431 tests pass; live probe green.
- **S3.76: the boot recovery out of `index.ts` (October 18).**
  `server/colonie/chat/boot-recovery.ts` (`createBootRecovery`): on a restart or
  workspace restore, walk the durable follow-up journal and, for every row whose
  dispatch claim was already committed, recover the user's words to the transcript
  plus a review notice and count the line as handed to the resumed session — never
  re-execute it as a turn; a claim whose owning bot, task or room is gone is
  cancelled instead, and rows that were never claimed are left to their own lane.
  The cluster then restores the steered, aside and channel queues from their
  journals. One block (L2578–2621), 44 lines. Guard: `boot-recovery.test.ts` (4) —
  an unowned claim is cancelled with no transcript write, an owned claim recovers a
  user line plus the "may have already run" notice and counts the line as handed
  before retiring the row, a room claim recovers its channel provenance while a
  foreign group's claim is cancelled, and a never-claimed row stays pending.
  `index.ts` 2,671 → 2,628 lines. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 90 files / 425 tests pass; live probe green.
- **S3.75: the staged skill cleanup out of `index.ts` (October 18).**
  `server/colonie/skills/staged-cleanup.ts` (`createStagedSkillCleanup`):
  `stagedSkillListing` (listing routes expose lifecycle metadata and never the
  staged instructions, which live only on the durable card),
  `stagedSkillCleanupsForThread` (the `(botId, stagedId)` pairs a transcript's
  skill cards own, deduplicated, with the owner read from the server-authored
  sender and the thread's own bot as fallback), and `rejectDeletedThreadSkillStages`
  (drop them before the transcript goes, so a name is never reserved for 30 days
  with no decision UI left). One block (L2207–2236), 30 lines. The extractor again
  invented a `server` dep from the word in a comment (dropped from the wire).
  Guard: `staged-cleanup.test.ts` (4) — the listing drops the staged files and
  base hashes, cards are deduplicated per bot, a card with no sender falls back to
  the thread's own bot, and neither a card-less message nor a sender-less card in a
  thread with no bot produces a cleanup. `index.ts` 2,697 → 2,671 lines.
  `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server` 89 files / 421 tests
  pass; live probe green.
- **S3.74: the bot-config proposal validation out of `index.ts` (October 18).**
  `server/colonie/bots/proposal-validation.ts` (`createProposalValidation`):
  `driverCapabilitiesFor` (an engine switch is warned about only from a live
  registry instance; a shadow or unknown one warns nothing), `chiefPeerTargetRule`
  (a Chief of Staff may target one section peer, anyone else only itself, shared by
  the profile and default-model proposals and re-checked at confirm), and
  `validateModelProposal` (the selection must resolve, the approval-level
  confirmation must have landed, and the destination driver must still carry the
  bot's existing permissions). One block (L2023–2055), 33 lines, 4 value deps.
  Guard: `proposal-validation.test.ts` (5) — capabilities come only from a live
  instance, the Chief rule's four answers, a proposal before the approval grant is
  refused, an unresolvable selection keeps the checker's own words, and an
  incompatible destination is refused while an acceptable one passes. `index.ts`
  2,723 → 2,697 lines. `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server`
  88 files / 417 tests pass; live probe green.
- **S3.73: the approval resolution out of `index.ts` (October 18).**
  `server/harness/approval-resolution.ts` (`createApprovalResolution`): the level a
  turn actually runs at (`approvalModeForTurn` — a peer's Custom becomes the
  provider's Auto, and any level the selected provider has no mapping for falls
  back to Ask), the level of the conversation that asked rather than a sibling's
  (`sourceApprovalMode`), whether that conversation is Full
  (`fullAccessForSource`), and whether a bot's routine/skill/profile/model change
  may be applied without a person (`appliesDirectly`, one state of
  `server/direct-apply.ts`). One block (L984–1026), 43 lines. Two hand fixes: the
  extractor invented a `server` dep from the word in a comment (dropped), and its
  warning that `approvalModeForTurn` was read above the wire site was real —
  `createBotSettingsView` took it as a lazy getter — so the new wire site was
  moved above that one; `sourceApprovalMode` is the module's own helper and is no
  longer destructured in `index.ts`. Guard: `approval-resolution.test.ts` (5) — an
  implemented elevated level passes through, an unimplemented one falls back to
  Ask, a peer-initiated Custom becomes Auto while the person's own stays Custom, a
  conversation with no connector thread asks and is not Full, and the level comes
  from the task's own bot (with the owner's default as the fallback). `index.ts`
  2,762 → 2,723 lines. `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server`
  87 files / 412 tests pass; live probe green.
- **S3.72: this installation's view of a team package out of `index.ts` (October 18).**
  `server/colonie/teams/package-wiring.ts` (`createTeamPackageWiring`):
  `collectTeamSkills` gathers one team's bot skills for a whole-team share ("all"
  drops a skill whose stored SKILL.md changed and lists it; an explicit list
  refuses instead, and the available names come back on refusals so the Share
  dialog can always offer another choice), `starterNotes` reads a bot's MEMORY.md
  and topic files for an import (daily logs never travel), `packageImportDeps` is
  the importer's side (pictures become local avatars, connection slots
  switched-off MCP servers, starter notes ordinary memory writes), and
  `defaultsPresetFor` turns a saved New-bot default into the export's preset. One
  block (L779–878), 100 lines. Three of the extractor's known gaps needed a hand
  fix: the object-literal shorthand `store,`/`routines: routines!` were renamed to
  `store(),`/`routines(): ...` (invalid) and became `store: store(),` /
  `routines: routines()!,`; an alias import (`picture as sharedPicture`) is not
  indexed by the tool's import scanner, so the module got it by hand; and its
  unused-import prune pass only removes a whole import declaration, so the eight
  imports whose last reader moved (`saveImage`, the five workspace memory
  helpers, `writeSectionContext`, the four skill helpers, `DEFAULTS_PRESET_KEY`,
  `presetFromDefaults`, `botAvatarUrlFromStoredPath`) were removed by name. Guard:
  `package-wiring.test.ts` (5) — a whole-team share exports every readable skill
  and reports the changed one, naming a changed or unknown skill refuses with the
  available list, a selection that is not skill names is refused, and each entry
  carries its listing fields plus instructions. `index.ts` 2,856 → 2,762 lines.
  `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server` 86 files / 407 tests
  pass; live probe green.
- **S3.71: the auto-recall prompt out of `index.ts` (October 18).**
  `server/colonie/memory/recall-prompt.ts` (`createRecallPrompt`): the block a turn
  is prefixed with (`autoRecallPrompt` draws the bot's notes and — only for a
  conversation the person started — its other chats through `buildRecall`, and
  returns nothing whenever memory or auto-recall is off), plus `withRecalled`,
  which joins it to the message. One block (L326–360), 35 lines; `cfg` goes over
  as a value and `store` as a getter. `index.ts` 2,886 → 2,856 lines.
  `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server` 85 files / 402 tests
  pass; live probe green. Guard: `recall-prompt.test.ts` (3) — a bot with memory
  off and a workspace with auto-recall off both get no block, and the recalled
  text is joined in front of the message only when there is any.
- **S3.70: the usage booking out of `index.ts` (October 18).**
  `server/colonie/providers/usage-booking.ts` (`createUsageBooking`): who a
  request is for in the usage ledger (`usageTriggerFor` — a paired or signed-in
  person, else the machine), the operator's own price list when the billing
  entitlement reads it (`operatorPrices`), one write of a settled turn's tokens
  and estimated cost that lets the spend cap and its admin notification see the
  row at once (`bookTurnUsage`), and the trigger a line queued by an older build
  still resolves to (`queuedTurnTrigger`). One block (L424–461), 38 lines. The
  only two deps (`cfg`, `broadcast`) go over as a value and a getter. The
  extractor left `import type {PriceList}` behind after the last reader moved
  (its prune pass only matches a non-`type` import), removed by hand. Guard:
  `usage-booking.test.ts` (5) — a signed-in person is billed to their email and
  label, an email-less session is still a person, a loopback request is the
  owner, a stored trigger is kept as recorded, a bot's own queued words set no
  trigger, and a queued line falls back to its sender then the owner. `index.ts`
  2,920 → 2,886 lines. `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server`
  84 files / 399 tests pass; live probe green.
- **S3.69: the direct-interrupt and emergency-stop cluster out of `index.ts` (October 18).**
  `server/colonie/chat/interrupts.ts` (`createChatInterrupts`): stopping one
  conversation's work (`interruptDirectThread` revokes the thread's connected
  tools, chief lease, memory capture queue, dispatch claim and internal
  capabilities, then asks the running adapter to interrupt behind a generation
  fence so a replacement turn's approvals are never closed) and a bot's whole
  fan-out (`interruptAllDirectThreads`, which revokes every busy sibling before
  yielding to any provider teardown), plus `stopBotForEmergencyApprovalDowngrade`
  — the fail-closed compensation Electron's private channel asks for, which
  forces every full/custom task back to Ask before it stops the direct turn and
  any routine run that may already have captured the wider permissions. Two
  blocks (L755–793, L2060–2085), 65 lines. `colonieMemory`, `colonieChief`,
  `connectedTools`, `routines`, `closeOpenApprovals`, `runningTurnInstance`,
  `pendingComputerResumes` and `colonieMemorySources` all live below the wire site
  and go over as getters. Guard: `interrupts.test.ts` (6) — the revoke pass runs
  before the adapter is asked, a turn replaced mid-interrupt keeps its approvals,
  Stop records the cancelled request on its message, a parked computer resume is
  cancelled unless the parking teardown preserves it, a whole-bot interrupt
  revokes each sibling then interrupts only the busy/claimed threads, and the
  emergency downgrade rewrites exactly the full/custom tasks and cancels the
  active run. `index.ts` 2,965 → 2,920 lines. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 83 files / 394 tests pass; live probe green.
- **S3.68: the server-side client push out of `index.ts` (October 18).**
  `server/harness/client-streams.ts` (`createClientStreams`): what a store change
  broadcasts (which also pages a bot whose active thread moved), the SSE frame
  numbering and replay buffer, the per-member narrowing of a frame, the desktop
  viewer manager and the stream teardown a revoked session uses. 189 lines across
  five blocks (L1263–1311, 1313–1314, 1318–1372, 1379–1395, 1397–1462) — the last
  big coherent feature left in `index.ts`. `let lastSeq`/`let audienceChangedAt`
  stay in `index.ts` (server-assembly reads them) and go over as getters plus
  setters; the extractor's two known gaps were fixed by hand — the `++lastSeq`
  prefix was not detected as an assignment (`setLastSeq` added), and
  `...configForAccess(...)` inside a `${…}` was not renamed (the spread's dot
  defeats the lookbehind), so the call became `configForAccess()(…)`. The
  broadcast passed at module-init to `createTrustedApprovalMessageHandler` became
  a lazy wrapper, since `broadcast` is now a `const` below that wire site. The
  route-module imports and the six now-unused imports left `index.ts`. Guard:
  `client-streams.test.ts` (6) — frames are numbered and kept for replay, an
  admin-only frame never reaches a member, a member frame is narrowed or
  withdrawn by what the member may see, `audienceChanged` marks the frame and ends
  only member streams, a cursor is trusted only from this run's stream, and
  closing one session's streams leaves the others open. `index.ts` 3,133 → 2,965
  (**under the 3,000 target**). `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 82 files / 388 tests pass; live probe green, and a
  manual SSE check saw `id:`-numbered `bot.queued`/`bot.deleted` frames arrive
  with a matching cursor.
- **S3.67: the process lifecycle out of `index.ts` (October 18).**
  `server/harness/process-lifecycle.ts` (`createProcessLifecycle`): what runs once
  the HTTP listener is up — the queued-send drain, the engine-read gate, the
  routines/memory presenters, the leftover delegation drain and the periodic sweep
  — and what a SIGINT/SIGTERM tears down, in order, before the process exits. 97
  lines (single block L3098–3194, the file's tail). 36 deps; `followupsReady` and
  `shuttingDown` are the two `let`s the block writes, so they go over as getters
  plus setters (`setFollowupsReady`, `setShuttingDown`) and `enginesRead`,
  `routines`, `calendarCalls`, `webhookIngress` and `colonieMemory` as getters. The
  extractor's comment-only false deps (`handoffs` from prose) were dropped by hand,
  along with the eight now-unused imports and the `createGracefulShutdown` import.
  Guard: `process-lifecycle.test.ts` (5) — the listener binds on loopback with both
  signals wired, the boot drains and starts the presenters, a signal tears down in
  order and exits 0, a second signal does not tear down twice, and a failed session
  close still exits (code 1). `index.ts` 3,194 → 3,133. `pnpm typecheck` 0,
  `pnpm lint` 0, `npx vitest run server` 81 files / 382 tests pass, live probe green.
- **S3.66: the browser feature's process-local construction out of `index.ts` (October 18).**
  `server/colonie/computer/browser-sessions.ts` (`createBrowserSessions`): one
  `BrowserRuntime` and the `BrowserLive` viewer that mirrors it, the map of
  throwaway guest sessions with `currentBrowserSession`/`forgetTemporaryBrowser`,
  and the `BrowserCleanupCoordinator` outbox that clears a deleted bot's or
  profile's saved engine state on every host. 81 lines across two blocks
  (L556–595, 841–881); `cfg` is the only dep. The comment-only false deps the
  extractor saw (`sessions` from a local const, `server` from prose) were
  dropped by hand. `temporaryBrowserSessions` goes over as a `const` map for the
  shutdown sweep, so the now-unused browser imports (the runtime, live viewer,
  cleanup coordinator, engine helpers and `augmentedPath`) left `index.ts`.
  Guard: `browser-sessions.test.ts` (6) — a guest session is minted once per bot
  and reused, two bots get distinct guests, a configured profile addresses its
  own partition, an unknown profile falls back to the bot's own session, and
  forgetting a guest mints a new one next time (a no-op when there is none).
  `index.ts` 3,274 → 3,194. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 80 files / 377 tests pass, live probe
  green (health/brand/bots/local-computer 200, unrouted 404, delete 200, no log
  errors).
- **S3.65: the turn's computer-seat binding out of `index.ts` (October 18).**
  `server/colonie/computer/turn-computer-binding.ts`
  (`createTurnComputerBinding`): `bindTurnComputer`, the single gate every
  computer claim passes — the claim loop with its one place per resource, the
  transcript's waiting chip and its resolution line, the
  `turn.wait_started`/`turn.wait_ended` events, and the two ways the wait ends
  without the seat (a cancelled setup throws `DirectTurnSetupCancelled`; the
  ceiling parks the turn as `ComputerWaitParked`, ADR-2/#1651). 105 lines
  (L728–832). `COMPUTER_WAIT_MAX_MS` (declared below the site) and `store` are
  getters; `ComputerWaitParked`/`DirectTurnSetupCancelled` (from the
  turn-dispatch wire), `activeInternalGenerationByThread`, `bus`,
  `claimTurnResource`, `registry` and the three resource maps are plain deps,
  so the module constructs the same classes index catches. The now-unused
  `computer-wait` import left `index.ts`. Guard: `turn-computer-binding.test.ts`
  (5) — a free seat binds without a chip, a non-exclusive claim binds without
  asking, a cancelled setup throws before binding, a held seat waits and then
  acquires (noting the wait), and the ceiling parks with the resource and
  generation. `index.ts` 3,366 → 3,274. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 79 files / 371 tests pass, live probe green.
- **S3.64: the direct-message flow out of `index.ts` (October 18).**
  `server/colonie/chat/direct-flow.ts` (`createDirectFlow`): the queued-send
  drain (`drainQueuedSends`, which starts each waiting group and then runs the
  aside lane), the aside lane's boundary pass (`drainAsideLane`), and the two
  entry points that reuse the path — `startOrQueueDirectMessage` for a new
  direct message and `deliverLateQuestionAnswer` for a late answer to a mid-turn
  question. 160 lines across two blocks (L2192–2299, 2314–2365). `followupsReady`
  (a `let` reassigned at boot) and `startTurn` (declared below the site) are
  getters; `store`, `threadBusy`, `messageSender`, `sendSequencer` and
  `usageTriggerFor` are plain. The five names above the site's wire are reached
  only from lazy getters or event callbacks. Guard: `direct-flow.test.ts` (5) —
  a full thread queues instead of starting, an idle one starts directly, the
  drain is a no-op before follow-ups are ready, and a late answer refuses a
  retired room and an unknown conversation. `index.ts` 3,514 → 3,366.
  `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server` 78 files / 366
  tests pass, live probe green.
- **S3.63: the per-turn integrations out of `index.ts` (October 18).**
  `server/harness/turn-integrations.ts` (`createTurnIntegrations`): the five
  adapters a turn's ACP session mounts — `agentsIntegration` (the agent-tools
  proxy env and its capability flags), `hooksEnabled`/`hooksIntegration` (the
  engine lifecycle hook channel), `browserIntegration` (the built-in browser
  proxy), `connectedAppsIntegration` (the composio bridge) and
  `controlIntegration` (the computer-control loopback endpoint). 156 lines
  across four blocks (L627–698, 1036–1071, 1084–1105, 1127–1152). The block-local
  `agentsProxyPath` and `AGENTS_NODE_FLAG` moved in; `engineUnavailableLogged`
  (a `let` declared below the site) is a getter plus setter, and `botForThread`,
  `currentBrowserSession` and `store` are getters. The `tts` namespace,
  `SPAWNED_PROXIES` and the browser-engine imports left `index.ts`.
  Guard: `turn-integrations.test.ts` (5) — the agent proxy env carries the turn
  ids, depth and minted token, memory is disabled when the bot disables it, the
  hook channel mints its own kind, computer control mints a per-turn bearer and
  encodes the bot id, and `hooksEnabled` follows `COLONIE_HOOKS`.
  `index.ts` 3,659 → 3,514. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 77 files / 361 tests pass, live probe green.
- **S3.62: the two settings-derived bot views out of `index.ts` (October 18).**
  `server/colonie/bots/settings-view.ts` (`createBotSettingsView`):
  `previewSystemPrompt`, the developer preview of the prompt a new conversation
  would build from current settings (the ACP branch reads the context candidate
  and reports its active sections; the legacy branch rebuilds the same policy a
  dispatch uses), and `botOverview`, the plain-language "what does this bot do"
  facts gathered from every server-only source (engine capabilities,
  connected-apps inventory, routines/webhooks/skills, recent history) and handed
  to `buildBotOverview`. 161 lines (L1479–1639). `approvalModeForTurn`,
  `engineMcpServers`, `routines`, `teamMemory` and `webhooks` (all declared
  below the site) are getters; `registry`, `listBotSkills` and `store` are plain.
  `composio` (a namespace import) and the `BotRecord`/`BotOverview` types moved
  in; eighteen now-unused imports left `index.ts` (`contextCandidate`,
  `chiefOfStaffSystemPrompt`, `peerRosterSystemPrompt`, `reachablePeers`,
  `localVmMode`, `skillAuthoringEnabled`, `supportsWorkspaceFiles`,
  `memorySystemPrompt`, `sectionContextSystemPrompt`, `skillsSystemPrompt`, the
  `setup-mode` pair, the whole `system-prompt` family,
  `BUILT_IN_BROWSER_SYSTEM_PROMPT`, the `bot-overview` pair,
  `flushProfileHistory`/`readHistory`, `describeConnectorScopes` and the
  `surface` pair). Guard: `settings-view.test.ts` (5) — only active sections
  reach the ACP preview, its totals are those sections' bytes and the /4
  ceiling, its note names it a developer preview, `botOverview` names this bot's
  routine and drops another bot's, and a fresh data dir carries no history.
  `index.ts` 3,814 → 3,659. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 76 files / 356 tests pass, live probe green.
- **S3.61: one direct turn's dispatch claim out of `index.ts` (October 18).**
  `server/colonie/chat/turn-dispatch.ts` (`createTurnDispatch`): the
  `DirectTurnDispatchClaim` record (exported as a type for `index.ts`'s own map
  and imported back as `type`), the two control-flow exceptions
  `DirectTurnSetupCancelled` and `ComputerWaitParked`, the claim phase
  transitions (`directTurnClaimIsCurrent`, `directTurnClaimExists`,
  `markDirectTurnDispatching`, `clearDirectTurnDispatch`,
  `cancelDirectTurnDispatch`), the per-thread `compactionControllers`, the
  cancelled-handshake quarantine (`markCancelledProviderHandshake`,
  `clearCancelledProviderHandshake`, `pendingCancelledProviderHandshakes`) with
  `retireProviderTurn` and `shouldIgnoreProviderEvent`, and the mid-turn staged
  attachment parking lot (`turnAttachmentsByTurn`, `turnAttachmentKey`,
  `purgeTurnAttachmentsForThread`). 167 lines across two blocks (L704–725,
  1011–1117), one wire site at 704. The compaction check reads
  `if (compacting && compacting.generation === claim.id)` — the same condition as
  index's `compacting?.generation === claim.id`, spelled for an explicit guard.
  `markCancelledProviderHandshake` is reached only from inside the module, so
  `index.ts` does not destructure it (`clearCancelledProviderHandshake` still is,
  by the shutdown path). `deleteAttachment` and the
  `PendingTurnCancellations`/`RetiredTurnRegistry`/`isTurnEventQuarantined`
  imports left `index.ts`. Guard: `turn-dispatch.test.ts` (5) — a stale id cannot
  promote a claim, a current claim needs a busy task while an existing one does
  not, clearing releases only the matching owner and re-settles the thread,
  cancelling aborts the controller of the dropped generation, and cancelling a
  dispatching claim quarantines its thread. `index.ts` 3,933 → 3,814.
  `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server` 75 files / 351 tests
  pass, live probe green.
- **S3.60: the internal capability table out of `index.ts` (October 18).**
  `server/harness/internal-capabilities.ts` (`createInternalCapabilities`):
  the `InternalCapability` record, the `sessionCredentials` bearer reuse keyed
  by the grants it was minted for (`sessionGrants`, `sessionBearer`,
  `mintInternalCapability`), generation minting/revoking
  (`beginInternalCapabilityGeneration`,
  `revokeInternalCapabilityGeneration`, `revokeEarlierTurnCapabilities`,
  `revokeInternalCapabilitiesForThread`, `revokeAllInternalCapabilities`), the
  provider-turn binding/revoke pair, and the parked `computerSelectionTurns`
  cleared with them. 157 lines (L618–774), one wire site at 618. Only
  `botForThread` (declared 1065, below) is a getter; `randomUUID`/`randomBytes`,
  the registry and `approvalModeFor` are imported. Guard:
  `internal-capabilities.test.ts` (5) — minting for an inactive generation
  throws, one generation reuses one bearer for the same grants, a new generation
  revokes the old bearer, revoking a thread drops its active generation, and a
  `perTurn` bridge gets a fresh bearer each mint. `index.ts` 4,085 → 3,933.
  `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server` 74 files / 346 tests
  pass, live probe green.
- **S3.59: the turn-digest state out of `index.ts` (October 18).**
  `server/colonie/chat/turn-digest.ts` (`createTurnDigest`): `turnStartedAt`,
  `turnCheckpoints`, `liveTurnByThread`, `forgetTurnCheckpoint`,
  `clearTurnDigestState`, and `scheduleTurnDigest` — the per-thread state a
  finished turn's digest reads and the recorder that writes the stored digest
  row. 112 lines (L2509–2620), one wire site at 2508. Only `memoryRowsByThread`
  and `store` are passed by value; `isContextMessage` (destructured from the
  delegation-lifecycle wire at 2721, below the site) is a getter, and the
  recorder's `filter(isContextMessage())` passes the returned function. The
  `checkpoints` and chat-digest imports left `index.ts`. Guard:
  `turn-digest.test.ts` (4) — clearing forgets the started time, the live turn
  and the handed memory rows; the recorder clears those before it checks
  `isCurrent` and appends nothing when it is not current; forgetting an untracked
  checkpoint is a no-op. `index.ts` 4,193 → 4,085. `pnpm typecheck` 0, `pnpm lint`
  0, `npx vitest run server` 73 files / 341 tests pass, live probe green.
- **S3.58: the client read models out of `index.ts` (October 18).**
  `server/harness/read-model.ts` (`createReadModel`): the wire shapes a client
  reads (`wireTask`, `wireBot`), the public bot with its newest page
  (`publicBot`, `publicBotQueuedMessages`), the guarded snapshot of one request
  (`guardedRequestSnapshot`, `settleTrackedRequest`), and the message-page
  helpers every HTTP/SSE reply uses (`DEFAULT_PAGE`, `pageSize`, `slimMessage`,
  `messagePage`, `messageWindow`). 155 lines across three blocks (L1732–1764,
  2010–2015, 2095–2210), one wire site at 1731. `store`, `directRequestOwners`
  and `threadBusy` are plain; `pendingTeamSetupResumes` is a getter (declared at
  3472, below the site) — the tool did not detect it because it is destructured,
  so it was wired and renamed by hand. `MESSAGE_PAGE_MAX` stays module-local.
  Guard: `read-model.test.ts` (4) — pageSize distinguishes absent/invalid/bounded,
  slimMessage strips screen pixels only, messagePage reads the tail, messageWindow
  centres and clamps. `index.ts` 4,344 → 4,193. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 72 files / 337 tests pass, live probe green (200s,
  unrouted 404 `{"error":"no route: ..."}`, DELETE 1 → 0, no error lines).
- **S3.57: identity and card answering out of `index.ts` (October 18).**
  `server/harness/identity.ts` (`createIdentity`): `messageSender`, the stable
  `personKey`, `sessionLendingPrincipal`, `actorKey`, the `cardAnswerRefusal` rule
  (owner/admin any card; on a shared workspace only the person who started the
  conversation or sent its request, plus the team-memory admin gate),
  `canManageCommandAllowlist`, `COMMAND_ALLOWLIST_DRIVERS`,
  `commandAllowlistResponse`, and the decision/card-answerer actors
  (`decisionActorFor`, `cardAnswererFor`, `answeringCardAs`). 179 lines, L320–460.
  `COMMAND_ALLOWLIST_DRIVERS` is read again by the `createServerAssembly` wire at
  3908, so it is exported with the rest; `store` is a getter (declared below the
  site) and `commandAllowlist`, `registry`, `signInAllowList`, `threadStarters`
  are plain. `ResolvedSender`/`CardAnswerer`, `SessionRecord`, `Message`/`BotRecord`,
  `DecisionActor`, `CommandAllowlistResponse` and the implicit-`any` callbacks
  moved/fixed in the module. Guard: `identity.test.ts` (2) — the same email is the
  same person regardless of session or casing, and a session with no email is keyed
  by the session itself without leaking its id. `index.ts` 4,477 → 4,344.
  `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server` 71 files / 333 tests
  pass, live probe green.
- **S3.56: bot visibility out of `index.ts` (October 18).**
  `server/harness/visibility.ts` (`createVisibility`): `viewerFor` (owner/admin →
  all, else a member named by email), the cached `threadOwners`/`visibleSets`
  lookups, `threadOwner`, `visibleTo`, `forgetVisibility`, the cached
  `threadsUsingAttachment` scan, and `subjectVisible` (the one check every member
  request naming a bot, thread, room, routine, run or attachment passes).
  101 lines, L461–535. `viewerFor`, `visibleTo` and `subjectVisible` are read below
  the site; `visibleTo` inside a function body at 2555 and `forgetVisibility` in the
  `store.onChange` closure at 2257, both safe with the destructured const. `routines`
  and `store` are getters (`routines` read as `routines()?`); `threadOwner` and
  `threadsUsingAttachment` stay internal so only four names are destructured back.
  `SEES_EVERYTHING`, `VisibleSet`, `routineVisible`, `threadsReferencing` and the
  `Viewer`/`ThreadOwner`/`PathSubject` types moved to the module's own imports.
  Guard: `visibility.test.ts` (2) — loopback and admin sessions see everything,
  another session is a member carrying the email it signed in with (or none).
  `index.ts` 4,547 → 4,477. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 70 files / 331 tests pass, live probe green.
- **S3.55: the admin-activity audit out of `index.ts` (October 18).**
  `server/harness/admin-audit.ts` (`createAdminAudit`): `adminAuditPlan` (method
  and path → what a request may change), the before-state capture, `adminAuditRows`
  (one row per bot/webhook/session/engine change, comparing only what the request
  named), `beginAdminAudit`, and the `guardedSendSchema` contract the Slack worker
  opts into. 181 lines, L633–786. Only `beginAdminAudit` and `guardedSendSchema`
  are read outside the range, both below it. `store` and `webhooks` are read
  through getters because their declarations sit below the site;
  `AdminActionRow`/`WebhookTrigger`/`RequestAuth`/`IncomingMessage` types,
  `requiredScope`, `onJsonBody`, `parsedBodyOf` and the audit helpers moved to the
  module's own imports. Guard: `admin-audit.test.ts` (5) — a well-formed send
  parses, a short send id and an empty text are refused, on-behalf-of needs an
  email or a name, and an unknown field is rejected rather than passed through.
  `index.ts` 4,692 → 4,547. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 69 files / 329 tests pass, live probe green.
- **S3.54: the parked-turn resume tables out of `index.ts` (October 18).**
  `server/colonie/chat/resume-tables.ts` (`createResumeTables`): the connector,
  credential and computer resume tables — the message lookups and markers
  (`connectorMessage`, `connectorCards`, `secretMessage`, `currentSecretState`,
  `resumeSecretCard`), the park helpers, and the drain/redispatch passes with the
  staleness rules (a replaced ask, a gone bot/thread, or a newer generation drops
  the entry). 259 lines, L4174–4402. `pendingComputerResumes`, the three drain
  functions and `registerComputerResume` are read above the wire site (in
  `releaseTurnResources`, `interruptDirectThread`, the runtime-event subscriber),
  so those wire entries stay getters and the exported map is destructured at the
  site. `connectorThread` stays in `index.ts` as a dep; `isTurnAdmissionBlocked`,
  `Message` and the implicit-`any` callbacks moved/fixed in the module. Guard:
  `resume-tables.test.ts` (3) — a drain drops an entry whose ask was replaced, one
  whose bot/thread is gone, and one a newer generation owns, and resumes none of
  them. `index.ts` 4,910 → 4,692. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 68 files / 324 tests pass, live probe green.
- **S3.53: the routine run cards out of `index.ts` (October 18).**
  `server/colonie/routines/run-cards.ts` (`createRoutineRunCards`): pick the source
  conversation for a routine's lifecycle card (`routineSourceOwner`,
  `botMainThread`, `legacyResultsThread`, `routineSourceThread`) and render plus
  upsert the one durable card per run (`routineRunCard`, `routineRunFallbackText`,
  `syncRoutineRunToSource`). 193 lines, L3720–3884. `syncRoutineRunToSource` is
  called from the `store.onChange` closure at 2422, above the wire site, but only
  when a change fires after boot, so the destructured const is in place by then.
  Deps were just `store`; `canReachPeer`, `threadTitleFrom` and the
  `RoutineRun`/`TaskRecord`/`Message` types moved to the module's own imports.
  Guard: `run-cards.test.ts` (4) — a hidden results bot, a results thread already
  carrying a run, and a run with no snapshot and no source thread all read as no
  source, while a live owned results thread is the source. `index.ts`
  5,069 → 4,910. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 67 files / 321 tests pass, live probe green.
- **S3.52: the live-screen poller out of `index.ts` (October 18).**
  `server/harness/screen-polling.ts` (`createScreenPolling`): the per-thread
  `screenPollers` table, `startScreenPoller`/`pokeScreenPoller`/`stopScreenPoller`,
  the `settledScreenHashes`/`shownScreenHash` gate, and `finalScreenFrame` (one
  last fresh frame at turn end). 172 lines, L3544–3687. Every forward reference
  from the runtime-event subscriber and the other wires above the site was already
  a getter (`() => finalScreenFrame` and friends), so the move needed no new
  getters. Two hand fixes the tool cannot see: `botComputerControlSnapshot` is a
  destructured binding, and the `ScreenCapture` type plus an implicit-`any`
  callback. Guard: `screen-polling.test.ts` (2) — a poller with no capture is never
  registered, and a poke/teardown/final with no poller are inert. `index.ts`
  5,203 → 5,069. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 66 files / 317 tests pass, live probe green.
- **S3.51: the HTTP assembly and route table out of `index.ts` (October 18).**
  `server/harness/server-assembly.ts` (`createServerAssembly`): static serving and
  page headers, the workspace-backup access object and routes, the whole
  `ROUTES.push(...)` registration block, the live-route helpers (`liveBotFor`,
  `liveHistoryFor`, `liveSignedIn`), the loopback `authorized` check,
  `handleRequest` (`createRequestHandler`), `liveCalls`, and the
  `createServer`/`desktopViewer.attach`/`calendarCalls().start()` boot. 847 lines,
  wire at old L4826–5475 (the range was cut before the top-level
  `describeEdition(await ...)` at 5476, which cannot move into the sync factory).
  The tool blind spot bit here: 46 names were destructured from earlier cluster
  wires (L1843/2660/3277/3548/4766), so they surfaced as unresolved and had to be
  added by hand to both the module's dep destructure and the index wire; `Store`,
  `composio`, `readBody` and the `node:http`/live-call types moved to the module's
  own imports and the now-unused imports were stripped from `index.ts`. `liveCalls`
  is defined in the range but used by the shutdown list below it, so the factory
  returns it and index destructures `{ server, liveCalls }`. Deferred deps lose
  inference, so ten callback params (`.some`/`.every`/`.filter`/`.map` over
  `teamComputers`, `store`, `registry`, `sessions`) got explicit `: any`
  annotations, matching `config-status.ts`. Guard: `server-assembly.test.ts` (2) —
  the exported `staticRelativePath` serves the SPA entry at `/` and strips `..`
  before the path is joined (`/../../etc/passwd` → `///etc/passwd`,
  `/a/../b` → `/a//b`, both of which `join` then normalizes inside the UI root).
  `index.ts` 5,701 → 5,203. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 65 files / 315 tests pass, live probe green (health/brand/
  bots/local-computer 200, unrouted 404, seeded bot 1 → 0, no log errors).
- **S3.50: the config/status cluster out of `index.ts` (October 18).**
  `server/harness/config-status.ts` (`createConfigStatus`): the access-filtered
  `configStatus`/`configForAccess` pair, `localVmPayload` and
  `readyLocalVmForTurn`, `existingPerBotLocalVmCount`/
  `perBotLocalVmCountForModeChange`, `engineMcpServers`, `persistMcpServers`,
  `describeInstances`, `persistProviderInstance` and `reloadProviders`. 390 lines.
  Guard: `config-status.test.ts` (2) — an admin gets the status object unchanged, a
  non-admin loses the sign-in lists, the profile email and the provider key
  identifiers while edition and browser-profile ids survive. `index.ts`
  5,993 → 5,701. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 64 files / 313 tests pass, live probe green.
- **S3.49: the card resolvers out of `index.ts` (October 18).**
  `server/colonie/chat/card-resolvers.ts` (`createCardResolvers`):
  `resolveAndSendTrust`, the profile/model/team-setup/routine resolution
  services and their resume queue, and skill-undo application. 364 lines,
  L4327–4690. The `createStartTurn` deps had to pass `drainTeamSetupResumes` as a
  getter once it moved below that wire. Guard: `card-resolvers.test.ts` (3).
  `index.ts` 6,335 → 5,993. `pnpm typecheck` 0, `pnpm lint` 0,
  `npx vitest run server` 62 files / 311 tests pass, live probe green.
- **S3.48: the local-VM/computer state out of `index.ts` (October 18).**
  `server/colonie/computer/local-vm-state.ts` (`createLocalVmState`):
  `botComputerControlKey`/`Snapshot`, `teamComputerInUse`, `mountHostComputer`,
  `botHasActiveTurn`, `turnSurfacePlan`, preview resolution,
  `continueComputerSelection`, `runningTurnEngines`/`runningTurnInstance`, the
  local-VM target/lease/idle helpers, `releaseLocalVmThread`,
  `localVmInventoryPayload`, and the startup discovery IIFE. 273 lines,
  L3282–3554. Guard: `local-vm-state.test.ts` (4). `index.ts` 6,577 → 6,335.
  Full suite 61 files / 308 tests, live probe green.
- **S3.47: the delegation lifecycle out of `index.ts` (October 18).**
  `server/colonie/peers/delegation-lifecycle.ts` (`createDelegationLifecycle`):
  waiting-on-person chips, delegation wakes + budget, incident reporting,
  context-marker bookkeeping, compaction, the `Handoffs` state, and the
  drain/sweep/retry subscribers. 510 lines, L3638–4147. The earlier
  `createDelegationWatch` wire had to pass `markTaskContextExternallyUpdated` and
  `wakeDelegationSource` as getters once their declarations moved below it.
  Guard: `delegation-lifecycle.test.ts` (5). `index.ts` 7,066 → 6,577.
  `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server` 61 files / 304 tests
  pass, live probe green.
- **S3.46: requests, cards and the stall watchdog out of `index.ts` (October 18).**
  `server/colonie/chat/requests.ts` (`createChatRequests`): `commandRememberRefusal`,
  `answerRequest`, `respondToCard`, `closeOpenApprovals`, `requestBehavior`,
  `providerLabel`, `notify`, the stall `watchdog` (and `TURN_STALL_MS`), plus the
  shared notice state (`lastReply`, `sessionModelByThread`, `nativeReviewNoticed`,
  `turnUsage`, `turnContext`, `repeats`). 303 lines, L2793–3024 + L3043–3113;
  `TURN_STALL_MS` moved with it after the live probe caught a TDZ
  (`Cannot access 'TURN_STALL_MS' before initialization`) from the eager
  `new TurnWatchdog`. Guard: `requests.test.ts` (4) — saved-command refusals,
  accept path, `providerLabel`. `index.ts` 7,335 → 7,066. `pnpm typecheck` 0,
  `pnpm lint` 0, `npx vitest run server` 60 files / 299 tests pass, live probe
  green.
- **S3.45: model/engine selection out of `index.ts` (October 18).** The engine
  choice cluster moved to `server/colonie/providers/model-selection.ts` as
  `createModelSelection(deps)`: `runColonieAssignment`, `defaultSelection`,
  `moveOffComputerEngine`, `checkedModelSelection`, `checkedTaskModelSwitch`,
  `turnSelection`, `healThreadModel`, `checkedExportSkillNames`,
  `collectExportSkills` (301 lines, L1856–1946 + L1961–2170; the `let
  computerEngineMoveRunning` and `retryComputerEngineMove` that writes it stay in
  index). Guard: `model-selection.test.ts` (5) — non-object, missing instanceId/
  model, effort+variant together, busy+changed, unchanged while busy. `index.ts`
  7,623 → 7,335 lines. `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server`
  58 files / 295 tests pass, live probe green (health/brand/bots/local-computer
  200, unrouted 404, seeded bot delete 1→0, no log errors).
- **S3.44: the runtime event bus subscriber out of `index.ts` (October 18).** The
  largest block left was not a function but a `bus.subscribe(...)` call: 598 lines
  (L4118–4715) folding provider events into stored messages, live turn state, Local
  VM leases and delegation watches. It moves to
  `server/colonie/runtime/event-subscriber.ts` as
  `createRuntimeEventSubscriber(deps)` returning the subscriber; index wires it as
  `bus.subscribe(createRuntimeEventSubscriber({...}))`. 63 deps, 19 of them getters
  (the block reaches state declared below it, so a plain pass would be a temporal
  dead zone), no setters. Guard: `event-subscriber.test.ts` (3) — an ignored event
  broadcasts nothing, a thread without a bot stops after the public frame, a tracked
  Local VM thread is touched rather than resumed. `index.ts` 8,157 → 7,623 lines.
  `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server` 58 files / 290 tests
  pass, live probe on a throwaway HOME green for `/api/health`, `/api/brand`,
  `/api/bots`, `/api/local-computer`, unrouted path 404, no startup errors.
  Two additions to the extraction tool (`.colonie-dev/extract.py`) came out of this
  slice: it now carries the whole pipeline (carve → module → wire → compiler-driven
  import/dep/prune/annotation passes) so one run is one block, and it detects
  type-only names from the *source file* (`.colonie-dev/type-import-audit.py`) after
  this block first imported `Message` as a value and the server refused to start with
  `does not provide an export named 'Message'`. The audit now reports 0 value
  imports of type-only names across 485 files, so the earlier modules are clean too.
- **S3.43: the HTTP front door out of `index.ts` (October 18).** `handleRequest`
  (1,646 lines, 108 deps) moves whole to `server/harness/request-handler.ts`, the
  largest single block left and the last named giant. Carved with
  `.colonie-dev/carve-range.py 7811 9456 handleRequest`, wrapped as
  `createRequestHandler(deps)` and wired at its original position with the same
  shape as `startTurn`: the permissive `{ [name: string]: any }` deps shape (one
  `ponytail:` note names the upgrade path), eight reassigned bindings passed as
  getters (`browserEngineInstall`, `browserEngineInstallError`,
  `customDomainRevision`, `desktopMutationToken`, `localVmProvisionBusy`,
  `routines`, `server`, `workspaceAccess`) so a pass never freezes a value, and
  four setters (`setBrowserEngineInstall`, `setBrowserEngineInstallError`,
  `setCustomDomainRevision`, `setLocalVmProvisionBusy`) because the handler is what
  writes them — that choice kept every already-moved route module untouched.
  `index.ts` 9,689 → 8,157 lines. Guard: `server/harness/request-handler.test.ts`
  (2) — the factory returns a callable handler, and building it reads none of the
  wiring (in `index.ts` the server object and several counters are declared below
  the wiring point, so an eager read would be a temporal dead zone).
  `pnpm typecheck` 0, `pnpm lint` 0, `npx vitest run server` 56 files / 285 tests
  pass. Live on a throwaway HOME (`env -u COMPOSIO_API_KEY HOME=$(mktemp -d)
  COLONIE_PROFILE=1 COLONIE_PORT=<free> node server/index.ts`): `/api/health`,
  `/api/brand`, `/api/bots`, `/api/local-computer` all 200, an unrouted path 404
  `{"error":"no route: GET /api/nope"}`, `DELETE /api/bots/<id>` on an idle bot 200
  `{"ok":true}` with the bot list 1 → 0, no startup errors in the log.
  Two generator mistakes worth remembering: rewriting import paths needs
  `"../" * depth` for `./` specs but `"../" * (depth + 1)` for `../` specs, and
  renames must skip comments and string contents — the first attempt wrote
  `server()` into user-visible text such as "email sign-in is not set up on this
  server". Both are now handled in the generator, and the tree was restored to the
  green S3.42 state before the corrected run.
- **S3.42: deleting a bot, and a runtime lesson about type imports (October 18).** `deleteBotWithLifecycle` (139
  lines, 31 deps) moves to `server/colonie/bots/delete-bot.ts`. It is the last named giant and, by index-local count,
  the most entangled of the small ones: it settles peer approvals, delegations, queued team-setup resumes, direct
  turns, calendar calls, webhooks, the browser session and the Local VM lease, and five of those bindings are handed
  over as getters because they are reassigned (or declared below the wiring). The interesting part is not the move but
  what the live check caught that every static check had passed. `TeamSetupRequest` is a *type* in `shared/team-setup.ts`,
  imported by `index.ts` with a whole-statement `import type { ... }`; the carve's import map only looked for inline
  `type` markers, so the generated module imported it as a value. TypeScript accepts that (a type may be imported
  without the keyword) and `pnpm typecheck` and lint both passed — the server then refused to start with
  `SyntaxError: The requested module '../../../shared/team-setup.ts' does not provide an export named 'TeamSetupRequest'`.
  Fixed by making it a type import, and the five earlier module extractions were audited for the same pattern
  (`skills/skill-resolution`, `peers/delegation-watch`, `bots/trusted-approval-message`, `chat/direct-send`,
  `chat/turn-start`): all clean, so S3.37–S3.41 were not affected. The lesson is worth keeping: a type-only import is
  erased only if it says so, and no typecheck can tell the difference — on this codebase only starting the server can.
  Guard evidence: 56 files / 285 tests pass, typecheck 0, lint 0; on a throwaway HOME the server boots, a direct send
  answers 202 (the turn engine's path), a delete of a *busy* bot answers 409 with `stop this bot's work before deleting
  it` (the teardown's own refusal), and a delete of an idle bot answers 200 with `{"ok":true}`, after which the bot
  list is empty — the teardown ran for real. `index.ts` 9,794 → **9,689 lines**.
- **S3.41: `startTurn` out of `index.ts` — the largest single move of the restructure (October 18).** The turn
  engine, 1,367 lines, becomes `server/colonie/chat/turn-start.ts` behind `createStartTurn(deps)`, wired at the point
  where it used to sit. `index.ts` goes 11,039 → **9,794 lines**. It closes over 121 pieces of the live state, so the
  move needed three things that the earlier slices did not: (1) six bindings are handed over as **getters**
  (`routines`, `colonieMemory`, `enginesRead`, `providerFleetReloading`, `providerInstancesChanging`, `teamMemory`) —
  the four reassigned while the server runs would otherwise be frozen at their initial value, and the two declared
  below the wiring point would read null or hit a temporal-dead-zone error; (2) the one top-level reader before the
  wiring point, `bus.subscribe(makeCapContinuationSubscriber({ store, startTurn }))`, now passes a thin arrow so the
  engine is looked up when a continuation actually fires; (3) the dependencies themselves are declared as one
  permissive shape rather than 121 hand-typed lines — see the caveat below.
  The carve also **missed four names**, which is worth recording because it is the failure mode of a mechanical
  carve: `checkpoints` and `composio` are namespace imports (`import * as`), which the analyser does not classify as
  imports, and the two types hidden in the signature were only found by the compiler. The verification of this slice
  is therefore compiler-led: `pnpm typecheck` reported 96 errors on the first wiring, every one of them a *category*
  the move itself created (44 now-unused imports, 19 names the carve missed, 13 closure parameters that lost their
  contextual type, 15 values that were narrowed by a now-`any` helper, one wrong relative path, one use-before-
  declaration), and all 96 are resolved. **Caveat, stated plainly:** inside this one module the dependencies are
  `any`, so the calls *into* it stay checked while the calls it makes out are not. That is a real loss of type
  safety, accepted here to land a 1,240-line reduction in one step, and marked in the module with a `ponytail:`
  note naming the upgrade path (a hand-typed deps interface, if a turn unit test ever needs it).
  Guard evidence, in order: 56 files / 285 tests pass, typecheck 0, lint 0; on a throwaway HOME the server boots and
  answers `/api/health`; and a **real direct send** to the seeded bot answers `202` with the transcript's user message
  — which is `startTurn` having run its admission, transcript and dispatch path for real, with no
  use-before-initialization or missing-binding error in the server log. It does not prove a real provider turn: no
  supported credentials exist in a throwaway HOME, which stays the standing limitation.
- **S3.40: refusing and accepting a direct send out of `index.ts` (October 18).** The whole direct-send cluster
  moves together — `DirectSendReceipt` (the union of what a person's message became: a transcript line, steered words,
  or a place in the queue), `DirectSendRefused`, `directSendRefusal` and `acceptDirectSend` (138 lines) — into
  `server/colonie/chat/direct-send.ts`, behind `createDirectSend(deps)` with eight deps. Moving them *together* is the
  point: the class is what the routes use to tell a refusal from an unexpected failure, and the receipt type is what
  they promise, so splitting the three across files would have left the contract in two places. `server/routes/bot-messages.ts`
  deletes its own narrow copy of `DirectSendReceipt` (`message: unknown`) and imports the real union instead — one
  definition, the queued variant included. Two facts the carve made explicit: the module needs `DATA_DIR` and
  `assertWithinBudget` (the spend cap is refused *here*, before the send is acknowledged, where the person can see
  it), and the doc comment that used to sit above the type had to travel with it rather than being orphaned above the
  new wiring. Guard test (3): a thread the bot already left is refused with its reason; a thread the bot still owns is
  not refused; a refusal carries its status and body and stands in for its message. The spend check reads nothing from
  disk in these tests because no budget is configured, which is what makes them honest *and* isolated. `index.ts`
  11,202 → **11,039 lines**; 285/285 pass, typecheck 0, lint 0, and on a throwaway HOME the server boots, answers
  `/api/health`, `/api/bots` and `/api/instances`, and `POST /api/bots/nope/messages` answers `{"error":"no such bot"}`
  — the route's own answer, not `no route`, which is what proves the moved wiring is live.
- **S3.39: the trusted-approval message handler out of `index.ts` (October 18).** `handleDesktopTrustedApprovalMessage`
  (402 lines — the biggest single move since `bot-update`) becomes
  `server/colonie/bots/trusted-approval-message.ts`, behind `createTrustedApprovalMessageHandler(deps)` with ten deps.
  It is the counterpart of S3.35 in kind: a privileged path that deliberately does **not** exist over loopback HTTP
  (a bot with shell access could curl that surface itself), reachable only through Electron's private
  utility-process channel — and the module's header now says so, where the file used to keep that fact to itself.
  It has exactly one call site, which now reads the handler from the factory. Type slips worth recording: the dep for
  `wireBot` has to be typed `=> any` rather than `=> unknown`, because the handler spreads its result into a frame;
  `supportsApprovalMode` must take `any` (not `unknown`) as its first parameter or strict function types reject the
  real function, whose parameter is narrower; and a `.then(onOk, onErr)` callback off an `any`-typed helper needs its
  `error` annotated. Guard test (4): a message that is not one of ours claims nothing; an object with no type claims
  nothing; a commit with an unusable request id is answered without acting; a commit that names no bot or no elevated
  mode is answered without acting. `index.ts` 11,593 → **11,202 lines**; 282/282 pass, typecheck 0, lint 0, and the
  server boots and answers `/api/health`, `/api/config`, `/api/bots` and `/api/instances` on a throwaway HOME.
- **S3.38: the delegation watch out of `index.ts` (October 18).** `finalizeDelegationWatch` (89 lines) and the
  `delegationWatch` map it ends entries in move together into `server/colonie/peers/delegation-watch.ts`. The map is
  the reason this one is interesting: whoever dispatches a delegated turn still puts the entry in *from `index.ts`*
  (the map is handed back out of the factory and used at four other places there), while the module owns the one
  function that takes it out — same object, by reference, so the two halves cannot drift. The factory takes three
  deps (`store`, `markTaskContextExternallyUpdated`, `wakeDelegationSource`), all function declarations in `index.ts`.
  Guard test (3): a watch that is not there ends nothing; ending a watch takes the entry out exactly once (a second
  finalize cannot re-report it); a source that is still reachable is woken with the name that answered — the last one
  took two tries to set up honestly, because the wake only happens on the 1:1 path where the source thread really has
  a task. `index.ts` 11,691 → **11,593 lines**; 278/278 pass, typecheck 0, lint 0, and the server boots and answers
  on a throwaway HOME.
- **S3.37: answering a staged skill request out of `index.ts` (October 18).** `resolveSkillRequest` (160 lines)
  and the 12-line `sendSkillResolution` move together into `server/colonie/skills/skill-resolution.ts`, which is the
  first slice that is *not* a route group: it is the decision both respond routes share (claim the card once, patch
  it, log it) plus the HTTP shape they send back. The only closed-over value was the store, so the module exports
  `createSkillResolution({ store })` and `index.ts` takes the two functions from it — the respond routes keep taking
  them as deps, unchanged. Guard test (3): a request this thread has no card for claims nothing; a card that is not a
  skill request claims nothing either; the HTTP shape answers only what was claimed (false, then 403, then 200).
  Live on a throwaway HOME: both `POST /api/threads/:id/respond` and `POST /api/bots/:id/respond` still answer 200
  `{ok:true,outcome:"unavailable"}` for a request that is not there. `index.ts` 11,862 → **11,691 lines**; 275/275
  pass, typecheck 0, lint 0.
  **Correction to S3.36:** that entry claims "typecheck 0", but typecheck was last run *before* `config.test.ts` was
  added, and the test's `ctx.auth` cast was in fact a `TS2352` until S3.37 fixed it (`as unknown as`). The suite and
  lint were green at S3.36; the typecheck claim was not verified. Every slice below this line whose test file was
  written after the last typecheck has the same caveat unless its entry says otherwise.
- **S3.36: settings (`/api/config`) out of `index.ts` (October 18).** The biggest remaining route group (343
  lines) becomes `server/routes/config.ts`: one GET that answers the whole config and one PUT/PATCH that applies a
  patch, reloads the providers it affects and drains what the change unblocked. This is the slice the holder objects
  were built for — `providerWrite.busy` (one settings write at a time) and `localVmFlags.modeChangeBusy` — and they
  are read and written through the dep, so the flag stayed one flag. Two namespace imports (`composio`, `tts`) and
  `parseConfigPatch` stay as they were: the module imports them directly rather than taking them as deps. **Carve
  lesson, hit again:** the mechanical comma-prune of five specifiers out of one long `config.ts` import line ate the
  neighbouring commas (`loadConfig localVmIdleTimeoutMinutes`, `localVmMode mcpCallTimeoutMinutes`); typecheck showed
  it as `TS1005 ',' expected` on that line, and the fix was rewriting the import line whole rather than patching
  specifiers. Guard test (4): another route is left to the next handler; reading the config asks for the admin half
  only for an admin; a patch that changes nothing is refused; a second settings write is refused while the first is in
  flight. Live on a throwaway HOME: GET 200 with 30 keys, an empty patch 400 `nothing to save`, and a **real write**
  — `features.showToolCalls` false → PUT 200 → the next GET reads true. `index.ts` 12,174 → **11,862 lines**;
  272/272 pass, typecheck 0, lint 0.
- **S3.35: the provider instances and settings writes out of `index.ts` (October 18).** The whole block of nine
  routes from the model picker through the instance settings (240 lines) becomes
  `server/routes/provider-instances.ts`: `GET /api/instances`, the icon patch, adding a ChatGPT or Claude account,
  the auth-status/refresh-models/install/auth-*/sign-out actions, the ACP sign-in, and the instance settings PATCH and
  DELETE. Two pieces of shared mutable state made this the slice that needed real work: `providerConfigBusy`
  (one settings write at a time, used by six routes) and the two Local VM flags. They are now **holder objects** —
  `providerWrite = { busy }` and `localVmFlags = { imageBusy, modeChangeBusy }` — declared once in `index.ts` and
  passed by reference, so the module and the routes still in `index.ts` (and the config family next) read and write the
  same flag. A `let` could not have been passed; a snapshot would have let two settings writes overlap. A new
  `.colonie-dev/carve-range.py` carves an explicit line range, because this family has prelude `const`s and several
  routes in one span, which `carve.py` (which stops at the next route) cannot express. Guard test (5): another route
  or verb is left to the next handler; the picker lists instances without ever sending a credential; an engine Colonie
  cannot reach is a 404 rather than an empty list; signing in refuses a form post from another page (415); an account
  without a name is refused before anything is written. Live on a throwaway HOME: the picker answered 200 with 2
  instances and their keys, an unknown engine 404 `unknown instance`, an unknown ACP sign-in 404, an empty account 400
  with the schema's own sentence, and a form post 415. `index.ts` 12,395 → **12,174 lines**; 268/268 pass, typecheck 0,
  lint 0.
- **S3.34: steering a queued message out of `index.ts` (October 18).** `POST /api/bots/:id/queue/:queueId/steer`
  (75 lines) becomes `server/routes/queue-steer.ts`: the whole queue is lifted atomically so that a settle racing this
  request either drains it as a follow-up or this request folds it into the live turn, never both for the same words.
  That atomicity is not testable with a fake — the queue is real state inside `colonie/chat/steer-queue.ts` — so the
  tests drive the **real** queue and each test takes a thread of its own, because the queue is per-thread: that is
  what made the first two attempts fail (a test that re-queued by hand left an extra item behind, and the next
  test's steer lifted it too). Guard test (4): another route or verb is left to the next handler; a queued message
  that is not there is a 404; words that cannot be steered go back to the queue (and are found again); words folded
  into a live turn are booked as steered. Live on a throwaway HOME, which is also how the route was proved *wired*:
  an unrouted path answers "no route: POST /api/nope/nope/steer" while the steer route answers `no such task` for a
  thread it does not know and `no such bot` for a bot it does not know. `index.ts` 12,460 → **12,395 lines**;
  263/263 pass, typecheck 0, lint 0.
- **S3.33: the bot form of answering a request out of `index.ts` (October 18).** `POST /api/bots/:id/respond` (80
  lines) did not get a module of its own: it is the *same* ladder as `thread-respond` (S3.27) addressed by bot
  instead of by thread, because a request raised inside a room is answered where the member's turn runs. Folding it
  into `server/routes/thread-respond.ts` cost one new dep (`requestedTaskBot`) and no new file, which is the whole
  point of taking families instead of routes. Guard test grew to 6: the bot form refuses an unknown behavior, and a
  card that may not be answered this way is refused before the card is touched. Live on a throwaway HOME: an unknown
  behavior 400, answering with no such request 200 `{ok:true,outcome:"unavailable"}`, an unknown bot 404. `index.ts`
  12,524 → **12,460 lines**; 259/259 pass, typecheck 0, lint 0.
- **S3.32: sending a message to a bot out of `index.ts` (October 18).** `POST /api/bots/:id/messages` and its
  `/guarded` variant (92 lines) become `server/routes/bot-messages.ts`. This one sends, so the boundary had to be
  drawn carefully: the module takes the whole send layer as deps (`acceptDirectSend`, `startTurn`, `messageSender`,
  `resolveReplyTarget`, `directSendRefusal`, `usageTriggerFor`, `guardedSendSchema`, `botAtThreadCapacity`,
  `threadBusy`) and — the detail that matters — takes **the `DirectSendRefused` class object itself**, so the
  `instanceof` that turns a refusal into its status and body still holds across the module line. `startTurn` is a
  dep here and moves in its own slice later. Guard test (7): another route or verb is left to the next handler; a
  body that is not an object, or says nothing, is refused; a guarded send without its safety preconditions is
  refused; an unknown bot is a 404; a refusal from the send layer is answered as it is; a refusal thrown by the send
  layer keeps its status and body; a send that lands answers 202. Live on a throwaway HOME: **a real send answered
  202 with the receipt** (threadId and message id), a silent text 400 "text required", a non-object body 400, an
  unknown bot 404. `index.ts` 12,600 → **12,524 lines**; 257/257 pass, typecheck 0, lint 0.
- **S3.31: the event stream out of `index.ts` (October 18).** `GET /api/events` (91 lines) becomes
  `server/routes/events.ts`, and the `SseClient` interface moved with it: the module now owns the shape of a
  connected stream and `index.ts` imports the type (the Set, the frame builders and the fan-out stay where they are,
  because they serve every sender, not just this route). Two pieces of state are read **live** through getters
  (`lastSeq`, `audienceChangedAt`) instead of being snapshotted at registration — a snapshot would freeze the
  stream's idea of "how far the app has got" at boot, and the test would not have caught that. The `Set` and the
  replay buffer are passed by reference, which is what makes this safe. Guard test (2): another route is left to the
  next handler; opening a stream says hello exactly once with an honest `resumed:false` and joins the fan-out, and
  closing the socket takes it out again. Live on a throwaway HOME: a stream opened and answered
  `data: {"kind":"hello","cursor":"99d50774:0","resumed":false}` — and so did a stream that offered a stale cursor,
  which is the correct answer when the buffer cannot honour it. `index.ts` 12,711 → **12,600 lines**; 250/250 pass,
  typecheck 0, lint 0.
- **S3.30: raw uploads out of `index.ts` (October 18).** The two adjacent families moved as one module,
  `server/routes/uploads.ts`: `POST /api/attachments` (a picture pasted into the composer) and `POST /api/files`
  (a document a companion app or the desktop sends as bytes), 101 lines together. They share one front door and one
  reason to exist — a partial upload is removed on error and the aggregate quota refuses rather than silently
  deleting files old prompts may still reference — so they are one module and **need no deps at all**: the saving
  lives in `colonie/chat/attachments.ts` and is imported directly. Guard test (5): another route or verb is left to
  the next handler; a picture must say it is an image; a declared size that is not a size is refused; a picture over
  the limit is refused before it is read; a document without a name is refused before it is read. Live on a throwaway
  HOME: an uploaded 1×1 PNG answered 201 and the file it named was served back 200 (the carve left the GET route
  where it was), a document 201, a document without a name 400, a non-image 400. `index.ts` 12,811 → **12,711
  lines**; 248/248 pass, typecheck 0, lint 0.
- **S3.29: importing a team out of `index.ts` (October 18).** `POST /api/teams/import` (106 lines: a team
  package, a library package, a bot package or a workspace backup, added next to what is there or projected into a
  folder) becomes `server/routes/teams-import.ts` — the pair to S3.28. What must be decided *before* the file is
  trusted stayed where it was: who may see the imported bots (the admin's `?visibility=`, never the file's), and
  the folder a template may project into. Guard test (5): another route or verb is left to the next handler; a
  folder a template may not project into is refused; an audience nobody can parse is refused; a file the app does
  not recognize is refused rather than half-imported; a backup may not be imported in project mode. Live on a
  throwaway HOME, and this is the strongest check of the slice: a **round trip** — backup export 200, then that
  same document imported 201 and the bot list grew 1 → 2; an empty body 400 "Team file version is not supported";
  project mode with a backup 400. `index.ts` 12,912 → **12,811 lines**; 243/243 pass, typecheck 0, lint 0.
- **S3.28: exporting a team out of `index.ts` (October 18).** `POST /api/teams/export` (134 lines: the team
  manifest, one team package, a library package of New-bot defaults, or a whole-workspace backup, with the skills,
  notes and avatars that travel with it) becomes `server/routes/teams-export.ts`. Guard test (4): another route or
  verb is left to the next handler; a team package without a team is refused with nothing packed; a team that is
  gone is a 404 with nothing packed; a workspace with no bots is refused with nothing packed. Live on a throwaway
  HOME: a backup export answered 200 with a real 668-byte file, a package without a team 400, an unknown team 404,
  and a library preview 400 with the app's own "New bot defaults are empty" wording. `index.ts` 13,036 → **12,912
  lines**; 238/238 pass, typecheck 0, lint 0. Eleven imports became unused in `index.ts` and were pruned one
  specifier at a time — the multi-name import lines are why a scripted prune needs a diff review.
- **S3.27: answering a running thread out of `index.ts` (October 18).** `POST /api/threads/:id/respond` (134
  lines) becomes `server/routes/thread-respond.ts`: allow, always-allow, deny or answer the question a thread is
  waiting on, whether that question is an approval, a persistent question card, a skill/routine/team-setup/profile/
  model request, or a peer request on the bus. The insight the dep list records: the *ladder* is the route and the
  *verdicts* are shared helpers, so the module routes intent and the refusals stay in one place each
  (`cardAnswerRefusal`, `commandRememberRefusal`, `resolvePeerComms`). Guard test (4): another route or verb is left
  to the next handler; a behavior that is not allow/deny/answer is refused; a card that may not be answered this way
  is refused **before the card is touched**; remembering a command is checked on its own. Live on a throwaway HOME:
  a bad behavior 400, answering a thread with no such request 200 `{ok:true,outcome:"unavailable"}`, an unknown
  thread 404. `index.ts` 13,150 → **13,036 lines**; 234/234 pass, typecheck 0, lint 0.
- **S3.26: creating a bot out of `index.ts` (October 18).** `POST /api/bots` (161 lines: profile fields, folder,
  engine, section, preset, the inheriting defaults, and the skills, routines and memory a bot is born with)
  becomes `server/routes/bot-create.ts`. Refusals that the creation dialog relies on stay exactly where they were:
  the avatar must be stored, the folder valid, the section short, the MCP selection valid, the workspace limit
  respected, and a phone session may not ask for a preset, skills, routines, memory or the wider profile fields.
  Guard test (4): another route or verb is left to the next handler; an unstored avatar is refused; a section name
  the default-profile schema rejects is refused — **by throwing**, because that is how the schema refuses and the
  server's outer catch is what turns it into an answer, module or not; a workspace at its limit refuses the next
  bot. Live on a throwaway HOME: create 201 (the bot list grew 1 → 2), a 61-character section 400 through the throw
  path, an unstored avatar 400, a non-object body 400. `index.ts` 13,299 → **13,150 lines**; 230/230 pass,
  typecheck 0, lint 0.
- **S3.25: one bot's threads out of `index.ts` (October 18).** `POST`/`PATCH`/`DELETE /api/bots/:id/tasks/:taskId`
  (177 lines: switching to a thread and the page the app asks for, renaming it, its model and approval mode, its
  surface, pinning, and deleting it) becomes `server/routes/bot-task.ts`. Deleting a thread also forgets what only
  that thread knew — its handoff, its digest state, the internal capabilities granted on it, its staged skill
  cleanups — and the test pins that. Deps: 19, including the handoff registry, the per-thread generation map and
  the routines getter. Guard test (4): another route or verb is left to the next handler; switching answers the bot
  with its settings and a bad page size is refused; a thread setting the app never sends, or one that needs a model
  selection with none, is refused; deleting forgets the thread before it is gone and an unknown thread is a 404.
  Live on a throwaway HOME: switch 200, an unknown key 400, title 200, pinned 200, an unknown thread on delete 404.
  `index.ts` 13,449 → **13,299 lines**; 226/226 pass, typecheck 0, lint 0.
  **Reading-a-block trap, second time:** the carve takes everything up to the *next* route start, so a comment
  block that documents the following route came along; it was put back before wiring. Check the last lines of the
  carved text for a trailing comment that belongs to the next route.
- **S3.24: the broad bot edit out of `index.ts` — the largest route family so far (October 18).** `PATCH
  /api/bots/:id` (566 lines: name, persona, model and effort, folder, approval level, visibility, audience, peers,
  tool scope, MCP servers, connectors, browser, memory, sections, chief-of-staff) becomes
  `server/routes/bot-update.ts`. It needed 21 deps — `store`, `cfg`, `registry`, `sessions`, the routines getter,
  `memoryUpkeep`, `browserLive`, `browserRuntime`, `broadcast`, `wireBot`, `requestedTaskBot`, `threadBusy`,
  `checkedModelSelection`, `supportsApprovalMode`, `audienceChanged`, `currentBrowserSession`,
  `interruptAllDirectThreads`, `forgetTemporaryBrowser`, `storedAvatarExists` — plus the desktop flag and the
  workspace bot cap. Everything else (validation, profile revisions, connector and tool-scope rules) is imported
  by the module from where it already lives. Guard test (5): another route or verb is left to the next handler; an
  unknown bot is a 404 and a body that is not an object a 400 with nothing stored; a rename is stored, answered
  with the bot and **not** broadcast (the room hears about a new audience instead); a change of audience
  re-announces the bot's teams and re-runs the audience fan-out; a field a phone session may not change is refused
  (403) before anything is stored. Live on a throwaway HOME: rename 200, an unknown field 200 (the original
  behaviour — only a session is held to the strict list), `visibility:"nonsense"` 400, a model without a model
  name 400, an unknown bot 404, a non-object body 400. `index.ts` 14,003 → **13,449 lines**; 222/222 pass,
  typecheck 0, lint 0.
  **Method note:** the block was carved out of `index.ts` mechanically into the new module and wrapped, rather
  than retyped, so the 566 lines of behaviour are byte-identical apart from the two `routines!` → `routines()!`
  edits and the deps destructure. Check the frame with typecheck: the extracted body needed a trailing
  `return PASS`.
- **S3.23: saved command permissions out of `index.ts`, and a regression from S3.20 repaired (October 18).**
  `server/routes/command-allowlist.ts` takes `GET`/`POST`/`DELETE /api/bots/:id/command-allowlist(?/:ruleId)`.
  Deps: the allowlist store, the provider registry, `canManage`, `requestedTaskBot`, `commandAllowlistResponse`
  and the driver set; candidate validation stays the shared function. Guard test (5): another route is left to the
  next handler; only the owner or an admin may look at all; reading answers with the rules and whether the
  provider supports them; adding checks the candidate, then the provider, then saves; removing takes a rule id and
  anything else on the path is a 405. Live on a throwaway HOME: `GET .../command-allowlist` answered 200
  (`supported:false` for the codex engine), an unknown provider answered 400 with "does not supply structured
  command approvals", `PATCH` answered 405.
  **Regression found and repaired:** S3.20's edit removed the `m = path.match(.../command-allowlist...)` line along
  with the bot-read block, so those three requests answered 404 from S3.20 until now. No test covers the inline
  blocks, but a live probe now does for every extracted route; when deleting an inline block, check the diff for a
  removed `m = path.match(...)` line that has no matching added line — the assignment above a block belongs to that
  block, not to the block being deleted.
- **S3.22: the thread-events inspector out of `index.ts` (October 18).** `GET /api/threads/:id/events`
  becomes `server/routes/thread-events.ts`; `readThreadEvents` and the two log directories are deps. Guard test (4):
  a request that is not a thread's events is left to the next handler; a bot's thread and a room's thread both read
  their logs, with the limit passed as a number; an unknown thread is a 404 with nothing read; a limit that is not
  a positive whole number (`0`, `1.5`, `all`) is refused with nothing read. Live on a throwaway HOME: `GET
  /api/threads/<id>/events` answered 200 with empty entries, `?limit=0` answered 400 and an unknown thread 404.
  `EVENTS_DIR`, `NATIVE_DIR` and `readThreadEvents` stay imported in `index.ts` because `ROUTES.push` still needs
  them.
- **S3.21: the paired-safe profile edit out of `index.ts` (October 18).** `PATCH /api/bots/:id/profile` becomes
  `server/routes/bot-profile-patch.ts` ("patch" because `bot-profile.ts` already holds the profile editor:
  SOUL, history, rollback, preview). Deps: `storedAvatarExists`, `wireBot`, `broadcast`, `store`; validation and
  the revision record stay the shared functions. Guard test (4): a request that is not an edit is left to the next
  handler; an unknown field is refused rather than ignored; an accepted edit is stored, answered and told to the
  room with the same bot payload; a well-formed but unstored avatar is refused and an unknown bot is a 404.
  Live on a throwaway HOME: `PATCH .../profile` answered 200 with the bot, `{"nickname":"x"}` answered 400
  `unsupported profile field: nickname`, an unknown bot answered 404.
  **Trap worth remembering:** `bot-profile` was already taken, and `write` overwrote the existing module and its
  test rather than failing. Both were restored from `HEAD` (`git checkout HEAD -- server/routes/bot-profile.ts
  server/routes/bot-profile.test.ts`) and the new module named `bot-profile-patch`. Check `git status` for a
  "modified" (not "created") route file before writing one.
- **S3.20: marking a bot read out of `index.ts` (October 18).** `server/routes/bot-read.ts` takes `POST
  /api/bots/:id/read`. Four handler-local helpers had to become deps rather than copied: the pinned-thread rule
  (S3.19), `requestedTaskBot`, `wireBot` and `broadcast`. Guard test (3) covers the three things that matter: a
  request that is not a read is left to the next handler, reading marks the named thread read and tells the room
  with the same bot payload it answers with, and a client session with several threads is refused (409) *before*
  anything is marked read. Live on a throwaway HOME: `POST .../read` answered 200 with the bot, an unknown bot
  answered 404 and `GET .../read` answered 404. 204/204 pass, typecheck 0, lint 0.
- **S3.19: the shared client-thread rule gets its own home (October 18).** `requirePinnedClientThread` was an
  in-handler arrow used by about eleven route groups, which blocked every one of them from moving. It is now
  `server/routes/pinned-client.ts` (`pinnedClientThread({ auth, store })`), so a module can hold the rule without
  reaching into the handler. `index.ts` keeps its call sites unchanged and just builds the function. Guard test (4)
  pins the rule: a client session on a bot with several threads must name one (409 with the app-update wording),
  one thread is unambiguous, an admin caller is not held to it, and a named thread or an explicit `null` is taken
  as given. 201/201 pass, typecheck 0, lint 0.
- **D2: the leftovers D1 exposed are gone (October 18).** `server/external-runtime.ts` (77 lines, no importer left
  after D1), the `externalRuntime` field and its type import in `index.ts`, the dead `/api/internal/` branch in
  `adminAuditPlan`, and the `/api/internal/` bypass in `server/request-auth.ts` (the test-capability clause stays).
  Two doc comments that still described the deleted routes were corrected. Evidence: typecheck 0, lint 0,
  `build:server` 0, 197/197 tests; live on a throwaway HOME seven routes answered 200 and
  `POST /api/testing/internal-capability` without its key answered 404, as designed.
- **Deliberately not deleted (needs an ACP-boundary decision, not an audit).** `agentsIntegration`,
  `hooksIntegration`, `controlIntegration` and `mcpIntegration` still build URLs for retired `/api/internal`
  routes. They are unreachable today — each is mounted only when `instance.adapter.capabilities.<kind> === true`,
  and none of the two ACP adapters declares any of those kinds — but the `integrations` object is handed to
  upstream adapters through `sendTurn`, so removing them is a contract decision rather than dead-code cleanup. The
  retired native agents driver cluster (`server/drivers/agents-call.ts`, `agents-proxy.ts`, `agents-catalog.ts`,
  reached by `server/harness-capabilities.ts`) is the same kind of call: build-live, runtime-unreachable.
- **D1: the dead `/api/internal/*` transport is gone (October 18).** Owner-approved deletion, first group. The
  capability-gated block (`if (path.startsWith("/api/internal/"))`, lines 11070–13056) and everything only it
  used — 27 + 15 + 3 declarations, plus the import specifiers nobody referenced any more — leave `index.ts`:
  16,990 → **14,050 lines**. The two *pass-through* routes that must stay (`/api/internal/colonie-mcp`,
  `/api/internal/colonie-workspace-mcp`) sat outside the block and were untouched, as the audit said they would.
  Three mistakes of mine were caught by checks rather than shipped: a first pruning pass merged two import
  declarations into one line, a second stripped the per-specifier `type ` markers (so `tsc` was happy while node
  crashed importing a type as a value — found only by booting the server), and removals glued 80 following lines
  onto the line above. All three were caught by `pnpm typecheck`, a runtime boot probe and a diff review, then
  redone from a clean revert. Evidence now: `index.ts` 14,050 lines, no glued line, every added diff line either
  an `import` or blank; typecheck 0, lint 0, `build:server` 0, 197/197 tests; live on a throwaway HOME with 14
  routes answering 200 (health, bots, config, routines, team-map, mcp/servers, connectors, local-computer, usage,
  plan-usage, webhooks, calendar-calls, auth/sessions, search) and no runtime error in the log. What is left for
  the deletion series: `server/external-runtime.ts` (now unreferenced), the retired native integrations that only
  fed the block, the `/api/internal` scope bypass, and the stale caller references inside the retired agents
  driver.
- **S3.18: signed-in devices out of `index.ts` (October 18).** `server/routes/auth-sessions.ts` takes `GET
  /api/auth/sessions` and `DELETE /api/auth/sessions/:id` — `index.ts` 16,997 → 16,990 lines. The module gets
  the session registry and the cookie name as deps and imports `clearSessionCookie` itself. Two rules are now
  pinned by tests: revoking your *own* device clears the cookie that named it while revoking another device
  leaves this browser's cookie alone, and the singular `/api/auth/session` block stays unclaimed. Live on a
  throwaway HOME: the list answered `{"sessions":[],"current":null}` and an unknown id came back 404.
  197/197 pass, typecheck 0, lint 0.
- **S3.17: reactions out of `index.ts` (October 18).** `server/routes/reactions.ts` takes `POST
  /api/threads/:id/messages/:id/reactions` — `index.ts` 17,005 → 16,997 lines. The smallest self-contained
  guard in the file: it needs only the store, no per-request locals, no shared `let`. Its guard test (5) also
  pins behaviour I would otherwise have guessed wrong: the route refuses an *absent* emoji but happily stores a
  whitespace-only one, so the test asserts the real rule rather than the tidier one. 192/192 pass, typecheck 0,
  lint 0.
- **S3.16: scheduled calls and webhook triggers out of `index.ts` (October 18).** `server/routes/
  calendar-webhooks.ts` takes `GET/POST /api/calendar-calls`, `PATCH/DELETE /api/calendar-calls/:id`,
  `GET/POST /api/webhooks`, `POST /api/webhooks/:id/(rotate|test)`, `PATCH/DELETE /api/webhooks/:id`, plus
  `roomAudienceConflict` and `calendarAudienceConflict`, which only these routes used. `index.ts` 17,096 →
  17,005 lines. The audience rule stays part of the route, not a screen's job: a call with several bots
  opens a room, so those bots must already share one audience, and the refusal names the pair. A manager's
  own validation error still reaches the caller as a 400 through the outer mapper — verified live, not
  assumed. Guard: `server/routes/calendar-webhooks.test.ts` (8) — one bot or bots sharing an audience pass, a
  mixed roster is refused with both names, what the manager refuses is a 400 rather than a crash, editing
  and deleting answer for the call named, a webhook list shows only the hooks and attempts the viewer may
  see, creating and rotating a hook hand back the URL a sender needs with the trailing slash on the ingress
  base not doubled, and testing/editing/deleting answer for the hook named. Two mistakes of mine were caught
  by the checks rather than shipped: fake bots with `{people: []}` visibility both normalised to "admins"
  (so my first audience test proved nothing), and a hand-typed expectation tripped
  `no-unsafe-optional-chaining` under `--deny-warnings`. 187/187 pass, typecheck 0, lint 0.
- **The whole suite ran (October 18).** `pnpm test` is `vitest run` over `server/` only — 20 files, 99 tests,
  all green in ~3.5 s, plus `pnpm typecheck` 0, `pnpm lint` 0 and `pnpm build:server` green. It does not run
  the renderer or the Electron `*.node-test.mjs` files, and neither the desktop window nor a real provider
  has been exercised yet on this branch.

## 2026-10-17 — five-worker batch, iteration 3 (rooms retirement checks)

Static/unit plus simulated provider (fake ACP) only; helper queue, `--maxWorkers=1`.

- Renderer waves 9-11 integrated. Passed: `tsc -p tsconfig.json` (0), `i18n:check`
  (0), `oxlint --deny-warnings .` (0). Renderer lane marked verified on those.
- `vitest run src` does not fit 120 s; ran as four shards. Shard 1 passed. Shards
  2-4 had failures: (a) companion Settings section expected by
  `SettingsModal.groups/simple/i18n/appearance` and `WelcomeGate` tests, but HEAD's
  `SettingsModal.tsx` already has no `companion` entry (inherited; deferred
  product, not re-added); (b) ~13 suites fail to load with "Cannot bundle built-in
  module node:sqlite from server/message-db.ts" (unchanged files; not baselined
  against clean HEAD, so "inherited" is unproven); (c) room-related stale copy
  assertions fixed by the renderer worker (`SettingsModal.appearance/i18n`,
  `AutomaticRecoverySettings`) and by coordinator (pt-br "turn length" line).
- Server: `tsc -p tsconfig.server.json` found `rooms` still in
  `workspace-backup-policy.ts` and a typed test in `config.test.ts`; fixed both,
  tsc then 0. Focused tests (config, workspace-backup, package-import,
  team-backup, routines) pass except `workspace-backup-workflow.test.ts`.
- `scripts/verify-workspace-backup.ts` migrated to the fake ACP assertions (args
  path, "hello from fake acp"). It now fails later at the paired-client export
  check (expects 403, gets 200); not diagnosed, not shown inherited.
- Tests lane: `recent-work.test.ts`, `peer-comms-limits.test.ts` pass;
  `team-share.e2e.test.ts` passes after the route-no-longer-returns-`groups`
  assertion fix. `tool-scope.e2e.test.ts` 6/7: the remaining case needs a product
  fix. `COLONIE_GATE_TOOL_SCOPE` is never applied to ACP connected-tool mounts
  (`gateServer` has no caller; `ConnectedTools.mount()` and `acp-runtime.ts` ignore
  `toolScope`). Reported, not fixed or weakened.
- Not run: UI e2e, desktop, real provider.

## 2026-10-17 — five-worker batch, iteration 2 (rooms retirement)

Static/unit plus simulated provider (fake ACP) evidence only; checks ran through
the helper queue (120 s, `--maxWorkers=1`).

- server wave 4 verified: traced that `coordinate_bots` could never run on ACP
  (no adapter mounts the native agents MCP, so `/api/internal/coordinate-bots`
  always answered 403, and its turns used the refused `coordination` option).
  `direct-handoffs.ts` is now a stored-history reader (unfinished stored nodes
  settle as "Interrupted by server restart; not replayed."; settled files are not
  rewritten; unreadable files stay on disk). Removed the route, the `coordination`
  turn option and its prompts, `Store.workThread`, `directHandoffLimits` (old
  `rooms.handoff*` config still parses); ratchet 135 -> 133. Live ACP Chief
  delegation is `ask_bot` on the `colonie_workspace` mount -> `runColonieAssignment`
  (unchanged). Checks: 6 unit files 455/455 (`1792245606820593000`); oxlint 0
  (`1792245807766000000`); server tsc exit 2 only in `index.test.ts` (tests lane:
  5 TS2367 + TS6133 `claudePrompts`).
- `server/colonie/chief/chief.e2e.test.ts` 2/2 fail with 409 "Wait for the Chief's
  current work to finish" on PUT `/api/colonie/chief`; identical on the pre-wave-4
  worktree (`1792245795958876000`), so inherited, not caused by this wave. Other
  chief/mcp-server files 53/53.
- renderer wave 6 verified: group-turn queue copy, steer "next" mode, the unused
  Composer `locked`/channel mention branches and `list_rooms`/`post_to_room` labels
  removed; 8 locale keys deleted. Renderer tsc 0 (`1792245571768475000`); 12 files
  222/222 (`1792245817262674000`); locale check valid, 2823 English strings
  (`1792245823872746000`).
- `thread-capacity-api.test.ts` timed out at 120 s inside a combined run (tests
  lane is migrating it to the gate launcher); not counted.

Second batch of iteration 2:
- Coordinator fixes (real defects): `botHasActiveTurn` compared a boolean with
  `null`, so every bot always looked busy and the Chief role could never be
  transferred (409); and `acp-runtime.ts` sent only `acpTools` servers in
  `session/new`/`session/load`, so the Chief's `colonie_workspace` mount never
  reached the agent although the receipt listed it ("Fixture MCP server is not
  mounted"). After both: `chief.e2e` 2/2 on codex-acp and claude-acp (`ask_bot`
  completes, result "PONG", idempotent replay). The fake ACP CLI now advertises
  HTTP MCP by default, as both maintained adapters do (checked in
  `node_modules/@agentclientprotocol/*`); otherwise a Chief turn failed setup.
- server wave 5 verified: `groups.json` loads read-only (never written; tests prove
  byte-identical across load, restart, bot deletion, team rename/delete); room
  writers, `group` frames, `WireGroup`, `groups` in `/api/state`/`/api/bots` and
  the room floor removed. Coordinator integration edits: `comms-visibility.ts`
  chips only (no pair channel), `delegations.ts` no channel, stored rooms visible
  only to a viewer who sees everything (`bot-visibility.ts`; the floor no longer
  narrows), test fallout rewritten on seeded `groups.json` (`peer-approval`,
  `auto-room-compat`) or trimmed to non-room cases (`delegations`,
  `independent-task-store`, `wire`, `comms-visibility`); `server/group-tasks.test.ts`
  deleted (room-task mutators removed); `scripts/verify-team-backup.ts` checks no
  `groups.json` is written. 25 files 752/752 (`1792247372044287000`); chief +
  mcp-server + retention + admission 69/69 (`1792247765730631000`); both tsc 0
  (`1792247732695546000`, `1792247742263224000`); oxlint src/server/shared/scripts 0
  (`1792247756362832000`).
- renderer wave 7 verified: `waitingForTeammates` UI, goal channel-mode drafts,
  orphaned `GoalRunCard`, room help sentence removed; coordinator restored the
  failed-send "restored" case on a direct draft. 132 files 1465/1465
  (`1792247469649017000`); locale valid, 2821 strings (`1792247757071373000`).
- `steer-queue.test.ts` 4 failures identical on the pre-iteration worktree
  (`1792247508429121000`; owner queue item 7, inherited).
- `index.test.ts` (tests wave 5 integrated, unverified): 30 failed / 168 passed
  (`1792247651583229000`); 3 new failures read the removed `groups` field.
- Deleted `server/direct-coordination.e2e.test.ts` and
  `scripts/testing/direct-coordination-ui.e2e.test.ts`: their subject is the
  removed `coordinate_bots` route; the run timed out at 120 s
  (`1792247872530034000`). Git index note: a coordinator mistake staged the
  deletion of `server/group-tasks.test.ts` (`D ` in status); restoring that index
  entry was refused by the permission guard, so it is left for the owner.

Third batch of iteration 2:
- server wave 6 verified: the local-computer emergency stop cancels a routine run
  before awaiting the thread interrupt (run now ends `cancelled`); dead room
  branches removed from `index.ts` (`connectorThread` returns `{ bot }`, room
  recall disclosure, team-map `collaborations` now `[]`); `waitingForTeammates`
  removed from the wire. Coordinator: fixed two leftover `group` references in the
  incident notifier; deleted `server/recall-disclosure.ts` and its test (no
  production caller); trimmed the room cases from `thinking-timer-ui.e2e` and
  `team-lifecycle-ui.e2e` (create/delete group chat; not run: UI e2e needs the
  agent-browser binary). Both tsc 0 (`1792248264963145000`, `1792248273961548000`),
  oxlint 0 (`1792248287704546000`), 24 server files 779/779 (`1792248288405954000`).
- renderer wave 8 verified: the call button is 1:1 only (room header placement,
  multi-speaker voices removed after checking no scheduled multi-bot call uses
  it), palette copy, room comments. Both tsc 0 (`1792248497288276000`,
  `1792248506064885000`), oxlint 0 (`1792248520023305000`), 136 files 1516/1516
  (`1792248528669478000`), locale valid (`1792248564888288000`).
- tests waves 6-7 integrated, not verified: `index.test.ts` 30 -> 24 -> 10 failed
  (195 cases, 185 passed; `1792248565696887000`), no new failures at any step;
  prompt-pipeline cases now assert the recorded ACP context sections. The 10 left
  are strict: one-shot title generation (ACP has no `generateText`; product gap),
  native agents/browser MCP on ACP (owner question), Claude reviewer card,
  effort/paired-model selection, question restart, credential continuation,
  chat-created routine, SOUL drift (rechecking).

## 2026-10-17 — five-worker batch, iteration 1 (rooms retirement, ACP fixtures)

Provider access returned; `claude-team.py resume` + `dispatch` restarted all five
lanes on their retained worktrees (server continued its partial edits). The
coordinator integrated each patch with `integrate` (`git apply --check` passed for
all) and ran checks through the serialized queue (120 s, `--maxWorkers=1`).
Evidence is static/unit plus simulated provider (fake ACP engine); no real
provider, renderer browser or packaged desktop run.

Verified lanes (passing post-integration check IDs recorded by the helper):
- server wave 1: team-backup import skips rooms and `room-goal` routines with
  plain warnings, export/parsing keep `groups`; package import lists rooms as
  `rooms_not_supported`. Coordinator edits: `auto-room-compat.test.ts` (skip +
  warning), `presets.test.ts` (expected skips), `scripts/verify-team-backup.ts`
  (removed `/api/groups` call; fixture reply is "hello from fake acp"). Server
  tsc 0; 10 files 390/390; oxlint 0.
- server wave 2: `room-handoffs.ts` direct-only (stored room nodes load as inert
  history), `routines.ts` keeps stored room-goal routines paused with
  `ROOM_GOAL_UNAVAILABLE`. Coordinator edits: `routine-requests.test.ts` (dropped
  the room-goal duplicate variant and "counts a room goal the bot leads"),
  `goalState` lines in presets/auto-room-compat. 6 files 326/326; 3 files 101/101;
  tsc 0; oxlint 0. `independent-threads-api.test.ts` still times out at 120 s
  (inherited, retired `claude` fake; see the earlier entry).
- fixtures waves 1-2: `server/testing/tool-plan.ts` (scripted MCP tool plans over
  stdio/http mounts from `session/new`, `FAKE_ACP_TOOL_PLAN`/`FAKE_CLAUDE_ROOM_PLAN`),
  `fake-acp-gates.ts` per-turn gates, cancel, `FAKE_ACP_USAGE`, `fail-turn`.
  `server/testing` + `control-colonie.test.ts` 37/37; tsc 0; oxlint 0.
- approval: `pnpm exec electron scripts/smoke-approval-modes.cjs` passed (all four
  levels on claude-acp/codex-acp, clamped adapters keep Ask, Custom refused,
  permission cards/answers, peer requests). First two runs failed at Edits:
  diagnosed (instrumented run) as the background memory-analysis adapter process
  overwriting the shared `FAKE_ACP_DUMP.config.json`; the smoke now turns off
  automatic memory capture for its fixture. Not a product defect.

Integrated, not verified:
- renderer wave 1 (20 room files deleted; Sidebar/App/TaskPicker/Settings/
  Visibility/team-import room UI removed; Decision model untouched). Renderer
  tsc 0; 16 files 269 passed, 8 failed — the same 8 SettingsModal remote/companion
  cases fail on the unmodified seed worktree (inherited). Composer/store
  `/api/groups` paths and `AppState.groups` remain (wave 2 running).
- tests waves 1-2: `index.test.ts` on claude-acp; seed baseline 109 failed/140
  passed (249) -> 59 failed/153 passed (212), no new failures vs wave 1. Deleted
  `recent-work.e2e.test.ts`, `room-recovery.e2e.test.ts` (room-only subjects).
  `spend-cap-api` 5 and `thread-capacity-api` 2 remaining failures are identical
  on the seed (inherited).

Renderer wave 2 integrated after this: `rg /api/groups src` empty; renderer tsc
exit 2 with 49 errors in two test files and `RoutineCalendarPage.tsx` (unused
`setRunOn`); repair round 1 fixed them (below).

Later in the same iteration:
- server wave 3 verified: `room-handoffs.ts` -> `direct-handoffs.ts` (stored file
  name unchanged), delegation strings reworded ("Your delegated requests have
  settled."), `/api/instances/:id/claude-update` removed. Coordinator edits:
  resume text in `server/testing/tool-plan.ts`, `direct-coordination.e2e`,
  `thread-aware-bots.e2e`; dropped the updater case from `cli-probe-env.test.ts`;
  deleted `server/claude-update.ts` and its test (only importer was the test);
  `scripts/verify-mentions.ts` no longer runs the retired `new-channel`. Both tsc
  0; 19 files 657/657; oxlint 0. `direct-coordination.e2e -t "sends each teammate
  result once"` fails identically on the seed (inherited, no lead evidence row).
- fixtures waves 3-4 verified: `${dump}.config.jsonl` append-only log with
  `internal` tags, `set_mode` updates the logged mode, opt-in unique session ids;
  `launchVerificationServer` 11th options parameter (per-instance FAKE_ACP_* env,
  gate dirs). `scripts/control-colonie.test.ts` + `server/testing` 48/48; tsc 0;
  oxlint 0.
- approval wave 3 verified: the smoke reads per-session evidence, enables unique
  session ids and runs with automatic memory capture on; Electron smoke passed.
- renderer waves 2-3 integrated: `AppState.groups`, Composer/store room paths and
  room strings removed; renderer tsc 0; 27 files 349 passed, 1 failed
  (`RoutineCalendarPage.simple` expects the removed "Routine type" selector);
  oxlint 2 `no-useless-spread` warnings in `SidebarBotActivity.tsx`. Repair
  dispatched; not verified.
- tests wave 3 integrated: `index.test.ts` 41 failed / 165 passed (206); the only
  new failures are the two removed `claude-update` route cases. Not verified.

- renderer wave 4 verified (with waves 1-3): "Routine type" expectation updated,
  spread warnings fixed, `ClaudeUpdatePrompt.tsx` and the Engines "Update Claude"
  path removed. Renderer tsc 0; `oxlint --deny-warnings src` 0; 32 files 439/439;
  `node scripts/generate-locale.mjs --check` valid (2908 English strings, seed
  2960). The 8 SettingsModal remote/companion failures (inherited) were not rerun.
- renderer wave 5 verified: 77 locale keys no source reads (66 `room.*`, 8
  `chat.claudeUpdate.*`, 3 `engines.*`) deleted from every catalog and
  `source-hashes.json`, kept values byte-identical. Locale check valid (2831
  English strings); renderer tsc 0; i18n tests 38/38; 32 files 439/439.
- tests wave 4 integrated: room halves rewritten as direct conversations, the two
  updater cases replaced by one 404 case, 4 managed team-computer cases deleted
  (no `/api/team-computers` route exists since `e1793036`; confirmed by grep).
  `index.test.ts` 29 failed / 170 passed (199); new vs wave 3: the rewritten
  emergency-stop case (`failed` vs `cancelled`). Server tsc exit 2 (4 TS2367 in
  `index.test.ts`). Repair round 1 dispatched; not verified.
- docs: `verification-docs.test.ts` 5/5; `git diff --check docs/` clean.

Next: integrate the tests repair, server wave 4 (ACP delegation trace) and
renderer wave 6; rerun the same checks; see HANDOVER team plan. Worker cost so
far: US$27.41 reported (US$102.41 accounted incl. unknown-cost reservations).

## 2026-10-17 — six-process startup blocked by provider usage limit

Initialized five isolated worktrees; the actual primary staged-diff SHA-256 stayed
unchanged. Started the coordinator and observed five distinct worker CLI processes
with real assistant tool activity, so parallel dispatch/authentication did work.
Then the coordinator and two workers returned API HTTP 400: "You have reached your
specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."
This is an external provider usage-cap failure, not a completed development batch
or evidence of actual account balance. No additional API retry, credential
inspection, auth/billing switch or limit change was attempted.

The launcher automatically stopped all owned workers. Final team metadata has no
remaining runner/worker PIDs. All worktrees/task briefs remain. The server worker
partially edited `server/index.ts` and `server/team-backup.test.ts` in its worktree;
the other worker diffs are empty. Nothing from the parallel workers was integrated
into the primary checkout. Local inventory: `.colonie-dev/team/interrupted-work.json`.
The roadmap page now shows the usage-cap pause in plain language. Its prior
roadmap acceptance states remain unchanged.

Interrupted calls without a final CLI result retain unknown actual cost; separate
conservative budget accounting reserves their allowance without presenting it as
reported spend. A resume operation retains existing worktrees. Next: owner checks
the provider's configured usage limit; after access returns, start the launcher
and resume retained lanes. No source/provider/desktop completion is claimed.
Follow-up local checks: the isolated team fixture suite passed, including
unknown-cost accounting and same-worktree resume; verification-docs 5/5 passed
on actual Node 24 under a 120-second process-group limit. Scoped whitespace check
passed. These checks validate recovery tooling/docs only, not resumed API access.

## 2026-10-17 — owner-authorized six-process Claude team

Owner requested five/six workers for faster outcomes. Replaced the sequential
microtask loop with one Claude coordinator plus five disjoint implementation
lanes: server/persistence, renderer rooms, ACP scripted fixtures, mixed tests,
approval smoke tooling. The old run was stopped during iteration 11; its unfinished
team-backup edits and all prior source/staged WIP are preserved, not declared done.

Local `.colonie-dev/claude-team.py` prepares isolated Git worktrees from HEAD plus
the primary checkout's staged/unstaged diff, seeded into each worktree's own index
(no commit or primary-index mutation). Known new files from earlier integrated
worker patches travel to later snapshots too. Worker patches are checked against
fixed owned paths and the baseline; commits/index changes/out-of-scope edits are
rejected, and `git apply --check` precedes integration. Worktrees/reports remain
recoverable. Workers do no heavy checks; coordinator checks are serialized with a
global lock and 120-second owned-process limit. Checked lane status requires
actual passing post-integration check records. Only coordinator writes shared
HANDOVER/PROGRESS/roadmap. Monitor lane cards show outcomes awaiting integration/
checks, without treating worker exit as milestone completion.

Validation (isolated temporary repositories and fake Claude only):
`python3 /tmp/colonie-team-check.py` passed WIP/staged-index preservation, delta-only
patch integration, new-file propagation, passing-check status, scope rejection,
cross-generation cost accounting, conflict preservation, targeted worker cleanup
and bounded-check timeout cases. Launcher and roadmap fixture checks also passed
(`/tmp/colonie-autopilot-check.py`, `/tmp/colonie-roadmap-check.py`). This validates
the local orchestration mechanisms, not the app or the new parallel outcomes.
Team estimated allowance defaults to US$300 including active reservations; all
calls explicitly use `claude-opus-5-5`. Balance remains unobservable. Next: initialize
the team, start coordinator, dispatch all five independent outcomes, then let
Claude integrate/check/checkpoint without a Codex review gate. No commits, live
app/provider fixture checks, deployments or remote changes were made by bootstrap.
Bootstrap document checks: focused verification-docs test 5/5 passed (exit 0,
120-second process-group limit); scoped `git diff --check` passed. The team's
heavy-check helper selects the actual nvm Node v24.13.1 installation when present,
instead of assuming the Homebrew path named node@24 contains Node 24.

## 2026-10-17 — room storage measured (rooms ROOMS-STORE, measurement only)

No source change. `server/room-handoffs.ts` is the live direct-delegation
engine, not room-only, so it stays; its room parts go in a later rename slice.
Room storage writers outside the store: `package-import.ts` (creates rooms),
`team-backup.ts` (exports/re-creates rooms and `room-goal` routines); readers:
`delegations.ts`, `peer-approval.ts`, ~51 `server/index.ts` sites. Plan and the
keep-files-on-disk decision are in HANDOVER (iteration 10).

Checks via `perl -e 'alarm 120; setpgrp; exec @ARGV'`, one at a time (unit evidence):
- `pnpm exec vitest run --maxWorkers=1 server/workspace-backup.test.ts
  server/team-backup.test.ts` — 2 files, 48/48, exit 0, on Node v24.13.1 (nvm).
  Note: `/opt/homebrew/opt/node@24/bin/node` reports v25.8.1 in this checkout, so any
  earlier run through that path used Node 25; the same run there also passed
  48/48. `scripts/testing/verification-docs.test.ts` 5/5 and `git diff --check`
  clean after the doc edits.

## 2026-10-17 — decision-model room routing deleted (rooms ROOMS-MODULES)

Slice: `server/decider/room-routing.ts` (126 lines), its unit test (11 cases), its
opt-in live-eval test (skipped without `COLONIE_JEV_LIVE_EVAL`) and
`fixtures/room-routing.json` (the eval's only input) deleted (unstaged `rm`). Its
one production caller was the deleted room turn engine. `shared/wire.ts`'s
`GroupDefaultResponder` comment now says nothing routes by it and stored rooms
must keep parsing. Kept: the decider core and Settings "Decision model" wiring
(config key, key test route, wire status, `decider-log` backup exclusion) and the
`roomRouting` job key; whether that section goes is an owner question (HANDOVER).
Self-review only; not committed.

Checks, each via `perl -e 'alarm 120; setpgrp; exec @ARGV'`, Node 24, one at a
time (static/unit evidence):
- Baseline `pnpm exec vitest run --maxWorkers=1 server/decider/` — 4 files passed,
  1 skipped; 67 passed, 1 skipped. After — 3 files, 56/56, exit 0 (67 − 11).
- `pnpm exec tsc -p tsconfig.server.json --noEmit` — exit 0;
  `pnpm exec tsc --noEmit -p tsconfig.json` — exit 0.
- `pnpm exec oxlint --deny-warnings shared/wire.ts` — exit 0; `git diff --check` —
  clean; `grep` for `room-routing`/`decideRoomResponder`/`roomRoutingRequest`/
  `ROOM_ROUTING` in server/src/shared/scripts/electron/.github — no match.

## 2026-10-17 — room goal-run module deleted (rooms ROOMS-MODULES)

Slice: `server/group-goal-run.ts` (168 lines) and its unit test deleted (unstaged
`rm`). `server/index.ts` no longer imported it; the only other importer was one
case in `server/decider/auto-room-compat.test.ts` (the Auto room's goal
coordinator), removed with it. The file's stored-room/package/team-backup
compatibility cases stay as ROOMS-STORE evidence. Kept: `shared/group-goal-run.ts`
(card types on store/wire/renderer), `routines.ts`'s `GroupGoalRunStatus`,
`server/decider/`. Stale renderer comment left for stage 4:
`src/lib/group-routing.ts:94` still names `selectGroupGoalCoordinator`.
Self-review only; not committed.

Checks, each in its own process group with a 120 s kill limit (Python
`start_new_session` runner), Node 24, one at a time (static/unit evidence):
- Baseline `pnpm exec vitest run --maxWorkers=1 server/decider/auto-room-compat.test.ts
  server/group-goal-run.test.ts` — 2 files, 20/20 (auto-room-compat 10); after the
  edit `auto-room-compat.test.ts` — 9/9, exit 0.
- `pnpm exec tsc --noEmit -p tsconfig.json` — exit 0; `-p tsconfig.server.json` — exit 0.
- `pnpm exec oxlint --deny-warnings server/decider/auto-room-compat.test.ts` — exit 0;
  `git diff --check` — clean; `grep` for `group-goal-run.ts"`/`selectGroupGoalCoordinator`
  in server/src/shared/scripts/electron — only the shared types import and the
  renderer comment above.

## 2026-10-17 — dead room client-scope rules removed (rooms stage 3b part 2)

Decision first: `rooms.turnTimeoutMinutes` bounds no person 1:1 turn. Only the
deleted room turn engine enforced it (`RoomTurnDeadline`, read at the parent of
`6cd01420`); its `dm` override is a bot-to-bot channel (`GroupRecord.dm`), and
`ConversationTurnLimit` renders only in `GroupView`. It retires with the room UI
(stage 4) and room config/backup parsing (ROOMS-STORE/FLOWS).

Slice: `server/request-auth.ts` granted client scope to eight `/api/groups` paths
that no route serves since stage 3a, and exported `clientGroupPatchViolation`
with no production caller. Both removed; those paths now fall back to admin
(default deny). The thread reactions rule stays. Tests: room paths moved to the
admin list, the room patch-field assertions removed. Self-review only; not committed.

Checks, each in its own process group with a 120 s kill limit (Python
`start_new_session` runner), Node 24, one at a time (static/unit evidence):
- Baseline `pnpm exec vitest run --maxWorkers=1 server/request-auth.test.ts` —
  44/44; after the edit — 44/44, exit 0.
- `pnpm exec tsc --noEmit -p tsconfig.json` — exit 0; `-p tsconfig.server.json` — exit 0.
- `pnpm exec oxlint --deny-warnings server/request-auth.ts server/request-auth.test.ts` — exit 0;
  `git diff --check` — clean; `grep -rn clientGroupPatchViolation server src shared
  scripts electron` — no match.
- Docs: `pnpm exec vitest run --maxWorkers=1 scripts/testing/verification-docs.test.ts` — 5/5.

## 2026-10-17 — handoff router room case removed (rooms stage 3b part 2)

`RoomHandoffs` calls `run`/`busy` only for non-terminal nodes; a restart fails every
stored non-terminal node and `coordinate_bots` enqueues from a direct address only,
so no room node can reach them. `server/index.ts`: `run` now refuses a room node up
front with the existing message (before it posted a request line and marked the
thread internal, then threw) and the direct path lost its `!group` wrapping; `busy`
lost its room clause. `report`/`changed` room handling stays until ROOMS-STORE (a
stored room tree's restart result is still posted once). Self-review only; not
committed.

Checks, each in its own process group with a 120 s kill limit, Node 24, one at a
time (static/unit evidence; no runtime test reaches `run` today):
- `pnpm exec tsc --noEmit -p tsconfig.json` — exit 0; `-p tsconfig.server.json` — exit 0.
- `pnpm exec oxlint --deny-warnings server/index.ts` — exit 0; `git diff --check` — clean.
- `pnpm exec vitest run scripts/testing/index-route-ratchet.test.ts scripts/testing/content-boundaries.test.ts server/room-handoffs.test.ts --maxWorkers=1` — 3 files, 54/54 passed.
- Baseline then post-edit, identical (inherited red): `chief-level-delegation.e2e` 1/1
  failed (`expect.poll` teammate provider turn never seen, line 38);
  `direct-coordination.e2e -t "announces a settled delegation"` 1 failed / 35 skipped
  ("no matching frame within 10000ms"). The full `direct-coordination.e2e` file plus
  chief together hit the 120 s limit before the edit and was not rerun whole.

Finding (not fixed): `run` passes `coordination` to `startTurn`, and the ACP path
refuses any `coordination` turn, so direct `coordinate_bots` delegation cannot run a
teammate turn on ACP. Needs its own task before Chief delegation is claimed working.

## 2026-10-17 — dead room busyBotId reads removed (rooms stage 3b part 2)

Nothing in `server/` sets a room's `busyBotId` any more (the store loads and
creates it as `null`; no `patchGroup` caller passes it). `server/index.ts` drops
its two reads: `shouldIgnoreProviderEvent`'s room clause, and the answer route's
room owner fallback, which now uses the card's `from` bot only, so a stored room
card can still be answered or closed. Behavior is unchanged because both reads were
always empty. The field stays on store/wire/notify/renderer until ROOMS-STORE and
stage 4. Self-review only; not committed.

Checks, each in its own process group with a 120 s kill limit, Node 24, one at a
time (static/unit evidence; no runtime test reaches the room answer path today —
`index.test.ts` room cases are inherited red):
- `grep -n busyBotId server/index.ts` — none.
- `pnpm exec tsc --noEmit -p tsconfig.json` — exit 0; `pnpm exec tsc --noEmit -p tsconfig.server.json` — exit 0.
- `pnpm exec oxlint --deny-warnings server/index.ts` — exit 0; `git diff --check` — clean.
- `pnpm exec vitest run server/notify.test.ts scripts/testing/index-route-ratchet.test.ts scripts/testing/content-boundaries.test.ts --maxWorkers=1` — 3 files, 21/21 passed.

Next: the router's `group` case.

## 2026-10-17 — dead room audience-reset audit removed (rooms stage 3b part 2)

Stage 3a removed `PATCH /api/groups/:id`, so `adminAuditPlan`'s `roomId`, the
`roomFloor` snapshot and the `room.audience-reset` row in `server/index.ts` could
never record (the request fails; failed requests write no row). They are removed
and `settleRoomFloor`'s comment no longer names the reset route. Decision:
`settleRoomFloor`/`roomMemberAudiences` stay until room storage and visibility go
(ROOMS-STORE), because `bot-visibility.ts` still hides a room by `audienceFloor`
and stored room transcripts stay readable; removing the narrowing now could widen
who sees them after a restricted bot changes or is deleted. Not touched: the
already-red `bot-visibility.e2e` reset cases (stage 5) and the renderer reset
button in `VisibilitySection.tsx` (stage 4; it now gets a failed request).
Self-review only; not committed.

Checks, each in its own process group with a 120 s kill limit, Node 24, one at a
time (static/unit evidence; no runtime or desktop proof):
- `pnpm exec tsc --noEmit -p tsconfig.json` — exit 0; `pnpm exec tsc --noEmit -p tsconfig.server.json` — exit 0.
- `pnpm exec oxlint --deny-warnings server/index.ts` — exit 0; `git diff --check` — clean.
- `pnpm exec vitest run server/bot-visibility.test.ts --maxWorkers=1` — 17/17 passed.
- `pnpm exec vitest run scripts/testing/index-route-ratchet.test.ts --maxWorkers=1` —
  failed as intended (`.exec(path)` now 17, written 18); lowered to 17, then with
  `content-boundaries.test.ts` 2 files, 9/9 passed.
- `grep` — no `roomFloor`, `audience-reset` or `resetAudience` left in non-test `server/`/`shared/` source.

## 2026-10-17 — roomFeedsBot retired (rooms stage 3b part 2)

Rooms no longer feed a bot's recall: `server/index.ts` drops room threads from
`autoRecallPrompt` and `session_search` (hits lose the optional `room` name),
`recentWorkSources()` hands `recent-work.ts` an empty `groups` list (that field
goes with stage 5's `recent-work` trim), and `roomFeedsBot` with its `roomFeeds`
import is gone. The turn-outcome log guard and the internal memory-write guard for
room threads are removed (no room turn can run, so neither can fire); the
memory-disabled 403 is kept. Team-memory publication from a room conversation is
now refused outright instead of filtered (safe direction). `roomFeeds` stays
exported from `bot-visibility.ts` for its own test until stage 5. Kept:
`roomMemberAudiences`/`settleRoomFloor`, memory source labels, recall disclosure.
Self-review only; not committed.

Inherited ratchet repair: `index-route-ratchet.test.ts` was already red at HEAD
(`path === "/` 135 vs written 142, `path.match(` 69 vs 70, from earlier route
removals); this slice changes neither count. Numbers lowered to 135/69 as the
ratchet's rule requires.

Checks, each in its own process group with a 120 s kill limit, Node 24, one at a
time (static/unit evidence; no runtime or desktop proof):
- `pnpm exec vitest run server/independent-threads-api.test.ts --maxWorkers=1`
  (whole file) — killed at 120 s, exit 143, inconclusive. With `-t "rejects blank
  memory|keeps A and B independent"` before the edit: 2 failed, exit 1, both on
  `beforeEach` hook timeout (30 s) configuring the retired `claude` fake-CLI
  instance. Inherited stage-5 migration failure; not usable as runtime evidence,
  so the planned runtime check is missing. `bot-visibility.e2e` (the only ACP-fixture
  file reaching these routes) builds rooms through the removed `/api/groups` routes.
- `grep roomFeedsBot server/index.ts` — 0.
- `pnpm exec tsc --noEmit -p tsconfig.json` — exit 0; `pnpm exec tsc --noEmit -p
  tsconfig.server.json` — exit 0 (the server project; covers the earlier
  uncommitted index.ts slices too).
- `pnpm exec oxlint --deny-warnings server/index.ts` — exit 0; `git diff --check` clean.
- `pnpm exec vitest run scripts/testing/index-route-ratchet.test.ts --maxWorkers=1`
  — 1 failed before the count repair (inherited), 1/1 passed after, exit 0.

Next: `settleRoomFloor` with the `PATCH /api/groups/:id` audience-reset plan.

## 2026-10-17 — groupUsageReader removal (rooms stage 3b part 2)

Removed `GroupUsageReader` from `server/index.ts` (import, startup construction and
refresh, `GET /api/bots` refresh, `publicGroupState`'s `usage`) and deleted
`server/group-thread-usage.ts` with its unit test (unstaged `rm`). Only the room
renderer `GroupView` showed that usage; the optional `WireGroup.usage` field stays
until stage 4. The per-bot usage ledger (`usage-ledger.ts`, `/api/usage`) is
untouched. `store.ts` comment updated. Self-review only; not committed.

Checks, each in its own process group with a 120 s kill limit, Node 24, one at a
time (static/unit evidence; no runtime or desktop proof):
- `grep -rn "group-thread-usage|GroupUsageReader|groupUsageReader"` over
  `server src shared scripts electron` — only the generated
  `vitest-shard-weights.json` names the long-deleted e2e file (it lists nine other
  deleted files too; left as is).
- `pnpm exec tsc --noEmit -p tsconfig.json` — exit 0.
- `pnpm exec oxlint --deny-warnings server/index.ts server/store.ts` — exit 0;
  `git diff --check` clean.
- `pnpm exec vitest run --maxWorkers=1 server/store.test.ts` — 138/138, exit 0.

Next: `roomFeedsBot`'s room filters. `rooms.turnTimeoutMinutes` is still read by
`ConversationTurnLimit` for 1:1 threads, yet no server code enforces it; decide
in its own slice.

## 2026-10-17 — roomPosts/personAskAt verification (rooms stage 3b part 2)

Scope: the unstaged `server/index.ts` slice from the first autonomous run (drop
`InternalCapability.roomPosts` and the `personAskAt` map/writes). Self-review:
the `routineRunId` clear in `startTurn` keeps its exact condition (not a card
continuation, depth 0, no automation source, not unattended, not a peer ask); only
the `personAskAt` set/delete went. No remaining reference to either name. All
commands ran in their own process group with a 120 s kill limit, one at a time,
Node 24. Evidence category: static/unit plus simulated-provider test baselines.

- `pnpm exec tsc --noEmit -p tsconfig.json` — exit 0 (14 s). This tree also lacks
  the six staged `room-cwd`/`room-post-budget`/`room-turn-end` files; `grep` finds
  no importer of them in `server src shared scripts electron`.
- `pnpm exec oxlint --deny-warnings server/index.ts` — exit 0; `git diff --check
  server/index.ts` clean.
- `pnpm exec vitest run --maxWorkers=1 server/steer-queue.test.ts
  server/turn-watchdog.test.ts` — turn-watchdog passes; steer-queue 4 failed / 29
  passed. Same four names at HEAD `50b56bcb` in a detached worktree (node_modules
  symlinked): the dispatch-acknowledgment, replacement-receipt, busy-drain and
  stop-then-steer cases (HANDOVER item 7). Inherited.
- `server/routine-results.e2e.test.ts` (the only test that sends a human message
  into a routine-run thread) — 2/2 failed, identically at HEAD: line 41 reads the
  retired fake-engine dump, line 180 an auto-applied card. Both fail before the
  `routineRunId` assertion, so the clearing has no runtime proof today.

Worktree removed after each baseline. Not committed. Next: stage 3b part 2,
`groupUsageReader`.

## 2026-10-17 — replace the activity page with an owner roadmap monitor

Owner rejected process logs as progress. Stopped the autonomous runner with its
targeted stop command to avoid concurrent writers, preserving existing source and
staged WIP. The interrupted source verification had no final checkpoint; it is
still unverified and remains the next development task.

`python3 /tmp/colonie-roadmap-monitor.py` ran a bounded, explicit
`claude-opus-5-5` task and exited 0. Claude wrote a derived roadmap snapshot and
replacement HTML template: product P0–P7, engineering E01–E06, 11 rooms-retirement
checkpoints and 13 other authorized items. The page shows done/in-progress/not
started/blocked/deferred/unverified outcomes and expandable completed/remaining
acceptance. It contains no process log, model, token, cost or run-count cards.
Future Server/collaboration/companion work stays deferred. Docs remain authoritative.

Launcher checkpoints now carry stable-ID roadmap updates, focus and a project
summary/headline. The launcher merges these atomically into the snapshot and
regenerates the standalone HTML; a local slice cannot finish its whole stage.
Done includes completed parts of open milestones; Remaining includes later work;
Blocked includes blockers inside an otherwise active milestone. The worker dot
uses the real runner status and heartbeat, not a task-completion claim.

Verification: `/tmp/colonie-roadmap-check.py` passed checkpoint merge, invalid-ID/
status rejection without snapshot overwrite, and script-safe two-snapshot HTML
embedding fixtures. `/tmp/colonie-autopilot-check.py` passed launcher lifecycle/
failure fixtures. Isolated Playwright with installed Chrome loaded the local page
without errors, exercised filters and reload, retained completed slices and deferred
work in the right views, and found no horizontal overflow at 390 px. Desktop
screenshot visually inspected. These establish monitor behavior, not app/source
workflow acceptance. Next: resume the autonomous batch on source verification.
Document checkpoint: `pnpm exec vitest run
scripts/testing/verification-docs.test.ts --maxWorkers=1` passed (1 file, 5 tests,
exit 0) under a 120-second owned-process limit; scoped `git diff --check` passed.

## 2026-10-17 — owner-directed autonomous Claude launcher

Owner superseded Codex supervision: Claude should choose the remaining authorized
tasks, implement, run bounded checks, self-review and checkpoint without a parent
review gate. Bootstrapped a local background launcher and progress HTML under
ignored `.colonie-dev/`; the application ACP integration is unchanged.

Initial real Claude task (`python3 /tmp/colonie-claude-development.py`, explicit
`claude-opus-5-5`) exited 0 and reported US$0.238713. Claude created the HTML
template and removed unused `roomPosts`/`personAskAt` bookkeeping in `index.ts`.
No source checks were assigned in that initial call. The autonomous batch must
verify this inherited change first; do not label it verified from the report.

Launcher checks: `python3 /tmp/colonie-autopilot-check.py` passed isolated fake-CLI
cases for structured completion, sequential continuation/cost accounting, invalid
checkpoint and provider-error stops, timeout/owned-child cleanup, background start,
duplicate-run exclusion and targeted stop. These are launcher fixture evidence,
not application or real-provider implementation evidence. Browser check of the
local HTML via Playwright with installed Chrome found no page errors and no
horizontal overflow at 390 px; screenshot visually inspected. Playwright's bundled
Chromium was unavailable, so installed Chrome was used without downloads.

The launcher uses explicit model/time/cost limits, one Claude process per task,
JSON-schema checkpoints, real event heartbeats, escaped standalone HTML and a
single-run lock. It stops on failures/uncertain checkpoints. Cost is a CLI estimate,
not account balance. Defaults and start/status/stop controls are in HANDOVER.
Self-review remains self-review; no independent review or all-work-done claim.
Bootstrap document check: `pnpm exec vitest run
scripts/testing/verification-docs.test.ts --maxWorkers=1` passed (1 file, 5 tests,
exit 0) under a 120-second process-group limit. Documentation evidence only.
Next: launch the autonomous batch and let Claude own subsequent source/doc edits.

## 2026-10-17 — Claude CLI read-only review trial

Owner authorized a `claude -p` review of the six already staged `room-cwd`,
`room-post-budget` and `room-turn-end` source/test deletions, then relaxed the
initial US$1 cap. The wrapper used explicit `--model claude-opus-5-5`, a US$10
ceiling, only Read/Glob/Grep/Bash tools, narrow read-only Bash allow rules,
`--permission-mode dontAsk` and `--strict-mcp-config`. No code changes, tests,
builds, app launches, credential inspection, delegation or commits were assigned.

- `python3 /tmp/colonie-claude-review.py`: stopped its owned process group at
  300 seconds (CLI exit 143). Its exact session log showed compound/`git -C`
  commands denied by the narrow rules, followed by API `ECONNRESET`. No final
  report; this attempt was incomplete, not a successful review.
- `python3 /tmp/colonie-claude-review-retry.py`: resumed the same session with
  authoritative `git diff --cached` evidence and a four-call follow-up limit.
  Streaming output captured Grep/Read use and a successful final result (exit 0,
  `is_error: false`, no permission denials). CLI reported cumulative session
  estimate US$0.4633938 and model `claude-opus-5-5`; this is not billing proof.
- Both wrappers compared Git status and SHA-256 hashes of the staged and
  unstaged diffs before/after: identical, preserving all six staged deletions.
  Review artifacts are temporary files under `/tmp/colonie-claude-room-review*`.

No deletion regression was identified. Parent source checks confirmed no remaining
references to these modules or exports, and that the deleted tests cover the
retired room contracts. The report's claim that room tools are still offered to
models was too broad: definitions/callers remain in `drivers/agents-*`, but
`AcpRuntime.capabilities` has no `agentsMcp`, and `index.ts` gates that integration
on `agentsMcp === true`. `roomPosts` has only its declaration; `personAskAt` still
has set/delete calls but no value reader. These are existing cleanup candidates,
not regressions from the six deletions. No compile/runtime proof was obtained.

Next: continue rooms retirement stage 3b part 2; keep code checks scoped to that
change. This trial establishes CLI context pickup and a reviewed static report,
not unattended implementation or complete M0 acceptance.

Parent checkpoint verification: `pnpm exec vitest run
scripts/testing/verification-docs.test.ts --maxWorkers=1` under the Node 24 PATH
and a 120-second owned-process limit passed (1 file, 5 tests, 348 ms, exit 0).
`git diff --check -- docs/HANDOVER.md docs/PROGRESS.md` passed. These checks cover
the documentation checkpoint only; application source and the index were not edited.

## 2026-10-17 — rooms retirement, stage 3b part 2 (dead room turn state out of `server/index.ts`)

Removed the two room-turn guards in the runtime fold that can no longer fire:

- the goal-coordinator envelope handling — `GroupGoalCoordinatorTurn`,
  `groupGoalCoordinatorTurns`, `groupGoalCoordinatorTurnForEvent`, the
  `groupGoalCompletionTurnId`/`parseGroupGoalDecision` import, the private-text
  buffering branches and the `completedTurnId` fold (now just `event.turnId`);
- `RoomTurnStallRegistry` — the declaration and the watchdog's
  `roomStallCompletions.stall(...)`.

Dead by construction: nothing has populated the guard map or registered a stall
handler since part 1 removed the turn engine (`grep` found only reads and deletes).
`server/room-turn-timeout.ts` and its unit test are gone with the last importer;
`server/group-goal-run.ts` stays for now because two test files still import it.

- `npx tsc -p tsconfig.server.json --noEmit` — 0 errors; `npx tsc -b` — 0 errors.
- `npx oxlint --deny-warnings .` — exit 0; `git diff --check` — clean.
- `npx vitest run server/respond-replay.e2e.test.ts
  server/usage-attribution.e2e.test.ts server/notification-wiring.test.ts
  server/room-handoffs.test.ts server/turn-watchdog.test.ts --maxWorkers=1` — 11 s,
  5 files, 58 tests, all pass.

Second slice: `groupSpeakers` and every branch only it gated. The map had no writer
since part 1, so its readers were dead by construction: the watchdog's
`stalledRoomSpeaker`/`busyBotId` cleanup, `isUnattended`'s `groupSpeakers.has`
conjunct, the fold's `speaker` (the whole room usage/digest branch, the `from:`
stamp and the `routedRoomReplies` map with its `RoutedBy` type), and the
`asker`/`waiting`/`broken` room fallbacks (`bot ?? (speaker ? … : undefined)` → `bot`).

- `npx tsc -p tsconfig.server.json --noEmit` — 0 errors; `npx oxlint --deny-warnings`
  exit 0; `git diff --check` clean.
- Wider batch over 13 files of the fold/approval/unattended/incident/digest/notify/
  recent-work smoke set — 126 tests, 9 failed in 5 files. The same 9 tests fail at
  the parent commit (`47ca8ef8`, worktree): `digest.e2e` (5), `incidents.e2e` (1),
  `late-question-source.e2e` (1), `recent-work.e2e` (1), `steer-unattended.e2e` (1).
  Inherited, not regressions.

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
- Method: the working tree was being written by other sessions in this checkout, so any
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

## 2026-10-17 — rooms retirement, iteration 3 (server wave 7)

Resumed server/renderer/tests lanes after the stop. Server worker found its
paths already retired and made no edits. Coordinator checks after integration:
`pnpm exec tsc --noEmit -p tsconfig.json` passed; vitest (store, package-import,
direct-handoffs, routines, routine-requests, delegations, bot-visibility, config,
index-route-ratchet) 9 files / 622 tests passed. Renderer wave 10 and tests wave 9
still running at this checkpoint, not integrated.
