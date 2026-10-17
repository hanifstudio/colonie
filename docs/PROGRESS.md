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
- Not yet run after the deletion: the full suite, desktop, real provider.

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
