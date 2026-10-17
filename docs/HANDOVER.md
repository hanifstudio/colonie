# Colonie handover

Updated: October 17, 2026. Current state and active work only.
Working rules live in [AGENTS](../AGENTS.md); product plans live in the
[blueprint](COLONIE-BLUEPRINT.md), read only when relevant.

## Current state

Colonie is a local macOS Electron/React app with HTTP/SSE and maintained ACP
Claude/Codex adapters. Server workspaces, invitations, and companion access are
future targets; retired hosted/VPS/pairing implementations are not supported.

Data normally lives outside the repository under `~/.colonie`. Engine configuration
is app-isolated; global CLI login does not establish the app's login.

| Area | Entry points |
|---|---|
| Native app | `electron/colonie.mjs`, `src/App.tsx` |
| ACP and app-authored context | `server/acp/` |
| Connections, memory, skills, scoped delegation | `server/colonie/` |
| HTTP composition and routes | `server/index.ts`, `server/routes/` |
| Isolated check tooling | `scripts/colonie/`, `scripts/control-colonie.ts` |

The architecture audit is in blueprint section 6. The shared-rule extraction now
has focused static/unit evidence; provider/browser/desktop/package behavior was not
requalified. Exact commands and limits are in [PROGRESS](PROGRESS.md).

## Active engineering stage: E01 — enforceable architecture checks

Owner priority is deliberate improvement of architecture, folder/file organization,
and code/design consistency. The [engineering roadmap E01–E06](COLONIE-BLUEPRINT.md#engineering-roadmap-architecture-and-consistency)
and [acceptance standards](COLONIE-BLUEPRINT.md#code-and-design-consistency-acceptance)
are the single plan; later stages are not implemented by this documentation.

E01.2 is done locally: the static CI job's "Enforce architecture boundaries" step
runs `scripts/testing/content-boundaries.test.ts` and
`scripts/testing/index-route-ratchet.test.ts` on every change, and
`scripts/ci-workflow.test.ts` fails if the step disappears, loses a guard, or
becomes skippable. The ratchet's inherited stale counts were lowered to 143/80.
Accept/reject proof ran in disposable copies (PROGRESS, "E01.2").

Ratchet note for concurrent room retirement: removing routes from
`server/index.ts` now fails the ratchet until its counts are lowered to the new
numbers in the same change. That is intended; never raise them.

E01 stays open on remote enforcement. On October 17 the owner made
`hanifstudio/colonie` public and retired the old remote: `origin` now points to
`hanifstudio/colonie` (the retired `milind-soni/OpenMausBot` remote was removed),
and `gh` resolves to it. Rulesets are now available but none exist, so CI is still
advisory. Main's last CI run (October 13) failed and local `main` is 62 commits
ahead of `origin/main`, so requiring `CI` now would block pushes to `main` until the
suite is green. Creating the ruleset waits for an explicit owner go-ahead.

M0, E01.2, and the documentation clean slate are committed; see PROGRESS
"landing". The owner then removed the inherited `LICENSE`, `NOTICE`, and `LICENSING.md`
and the unused cloudflared bundle (no runtime caller; its license copy was the
root `LICENSE`). Packaging was not run locally; the first package/release run is
its proof. `package.json` still declares `"license": "Apache-2.0"`.

GitHub CI on `2cf56367`: the static job is green again. Inherited red jobs, not
from these commits: packaged server smoke (Ubuntu/Windows/macOS), renderer UI
e2e (all five files), and the Linux package check (missing
`usr/share/applications/com.colonie.app.desktop` in the DEB). Diagnosing these
is the next CI task before requiring the `CI` check.

## Done engineering task: E02.1 — connected-apps storage owned at bootstrap

`message-db.ts` (12 importers, 30+ module functions) is too wide for a first
slice. Chosen instead: `server/colonie/connections/`, whose `policy.ts` and
`manager.ts` read `DATA_DIR` from `config.ts` directly.

- Outcome: `server/index.ts` builds one `BotAppPolicies` from an explicit
  directory and passes it, plus the sessions directory, to `ConnectedTools` and
  the connected-tools routes. Nothing in `connections/` imports `config.ts`.
- Scope: `connections/{policy,manager,routes}.ts`, their test, three composition
  lines in `server/index.ts`. On-disk layout (`<data>/connected-apps/bots|sessions`)
  is unchanged, so stored data and backups are unaffected. Shutdown already goes
  through `connectedTools.dispose()`.
- Acceptance: two disposable roots keep separate policies; the manager test and
  connections e2e pass; typecheck/lint; `content-boundaries.test.ts` rejects a
  `config.ts` import from `connections/` (red/green in a disposable copy).
- Budget: focused vitest only, 120 s per command, one job at a time, two repairs.

Done locally (PROGRESS "E02.1"). E01.3 added `erasableSyntaxOnly` to server typecheck.

## Done engineering task: E02.2 — learned About-me facts owned at bootstrap

`server/profile-learned.ts` reads `DATA_DIR` for `profile-learned.json`. Outcome:
a `LearnedFacts` class taking the file path, built once in `server/index.ts` and
passed to the memory route deps; the three `addToAboutMe` call sites use it.
`aboutMeLine`/`appendAboutMe` stay pure functions. File name and format are
unchanged. Acceptance: two disposable files stay separate; `memory-upkeep` and
`routes/bot-memory` tests pass; `content-boundaries.test.ts` rejects a `config.ts`
import from the module (red/green in a disposable copy); typecheck/lint on changed
files. Same budget as E02.1. Avoid `server/acp/*` (concurrent ACP work).
Done locally (PROGRESS "E02.2"). E02.3 was dropped: `mcp-gate-config.ts` serves
only the retired `server/drivers/` (about 15k lines), so tidying it is wasted work.

## Done engineering task: E04.1 — lift the three live helpers out of `drivers/claude.ts`

Only three exports of the retired Claude driver still reach the app:
`CLAUDE_ACCOUNT_ENV_KEYS` and `resolveClaudeConfigDir` (used by
`claude-accounts.ts`, `plan-usage.ts`) and `autoCompactWindow` (`index.ts`).
Outcome: the first two move verbatim to `server/claude-config.ts`, the last to
`server/context-budget.ts` beside `compactBudget`; their importers and tests
follow; function bodies unchanged. Then measure which `server/drivers/*` files
have no live importer (E04.2 deletes only what that measurement proves unused and
records each reason; legacy-driver tests that only cover a deleted module go with it).
Acceptance: moved-function tests pass in their new homes; `claude-accounts`,
`plan-usage`, `context-budget` tests; typecheck/lint; no importer left of the three
names in `drivers/claude.ts`. Budget as before.

Done (PROGRESS "E04.1", "E04.2"). Next: E04.3 — decide and remove the readers of
the unwritten `native/` tee (list in the item below), keeping any reader that
serves files already on a user's disk until that is a conscious choice.

## M0 trial checkpoint — still open

M0.1's agreement is consolidated in AGENTS. M0.2/M0.3 extracted shared attachment
and thread-address rules: 98 focused tests, type/lint checks, and 5 document checks
passed in the recorded checkout (see PROGRESS). Task-to-task continuation and a
planned red/green boundary check were observed. Do not repeat those extractions.

M0.4 still needs fresh-session pickup/review evidence. Review so far is self-review;
unexpected-failure recovery and unattended execution remain unproven. Preserve
these limits while scoped foundation work proceeds; do not claim M0 complete.

## Active task: rooms retirement (picked up October 17, second session)

CI evidence that justifies doing this now: after the static job went green,
the remaining red vitest shards are dominated by `server/index.test.ts` (68
failures locally and on CI; about 35 through the retired `claudeAgent` fixture
instance, the rest room/computer cases) and the 24 room/group test files below.
Measured: switching `index.test.ts`'s `claude` instance to `claude-acp` + the fake
ACP engine alone moved 68 → 60 failures, so that edit belongs to stage 5.
Stage 1 outcome: delete the room/group test files that fail by construction (each
run first, result in PROGRESS). Stage 2 outcome: delete room-only modules with no
live importer; `room-*` modules and `group-goal-run`/`group-thread-usage` are still
imported by `server/index.ts`, so they wait for stage 3 together with their unit
tests. Acceptance per stage as written below. Budget: one vitest run at a time,
`--maxWorkers=1`, background for the e2e files, two repairs per stage.

Progress: stage 1 done (ten e2e files deleted, PROGRESS). Stage 3a done: group
HTTP routes, agent-facing channel MCP tools and the control CLI's channel commands
are gone. Stage 3b part 1 done: no room turn can run — the group turn engine and
its callers are deleted and the room entry points are inert (`RoomHandoffs` refuses
a room node, the answer route answers 409, the routine goal callbacks are no-ops) —
and `server/index.ts` compiles again. The tree had been left mid-edit by other
sessions in this checkout: the Claude Code session stopped on its weekly limit at
06:47:58, then separate opencode sessions edited the same file until 07:47 and one
of them deleted a 550-line region wholesale. That region (live
connector/skill/approval/computer-resume helpers) was restored and only the
room-only declarations it carried were dropped; the other sessions' sound removals
were kept. Both inherited red files were re-verified at the parent commit, so keep
one writer per file. Evidence is in PROGRESS "rooms retirement, stage 3b part 1".
Do not release before stage 4: the renderer still calls the removed routes; a room
renders but can no longer answer.
Queued separately: rewrite `scripts/smoke-approval-modes.cjs` onto the ACP fixtures
(it still builds retired drivers; CI's macOS step fails with 409 until then).
Next: 3b part 2 — the room machinery `server/index.ts` still holds: `groupSpeakers`
and `groupUsageReader` (wire and fold), group-goal coordinator turns with the
`groupGoalCompletionTurnId`/`parseGroupGoalDecision` branch, `RoomTurnStallRegistry`
with the room timeout/end paths, the `PATCH /api/groups/:id` audience-reset plan and
the router's `group` case, `roomFeedsBot`'s room path. Then the `room-*`/`group-*`
modules with their unit tests, store tables (check backup/restore compatibility of
persisted `groups.json` before dropping reads), routines/wire/package flows, then
stage 4 renderer and stage 5 tests.

## Milestone: retire rooms and groups (owner decision, 2026-10-17)

The owner chose to delete the rooms/groups feature instead of rebuilding its
orchestration for ACP. Rooms are visible in the product but no engine turn can
run in one: `server/index.ts` answers a room dispatch with "The transparent ACP
connection supports direct conversations; room orchestration is not enabled."
About 30 test files cover rooms/groups and cannot pass.

Staged removal. Each stage leaves `pnpm exec tsc --noEmit -p tsconfig.json`
green, leaves every deleted path with no remaining importer (`grep -rn`), and
runs a targeted `pnpm exec vitest run` over the files it touches.

1. Room-only test files (their subject cannot pass by construction).
2. Room modules and the room/group routes, store tables and orchestration in
   `server/index.ts`, in one stage: a survey found every room module
   (`room-cwd.ts`, `room-turn-end.ts`, `room-turn-timeout.ts`,
   `room-post-budget.ts`, `room-handoffs.ts`, `group-goal-run.ts`,
   `group-thread-usage.ts`, `server/decider/`, `shared/group-goal-run.ts`)
   imported from `server/index.ts` alone, so the modules cannot go first.
3. Renderer: `GroupView`, `GroupCallView`, `GroupUsageChip`,
   `RoomTurnTimeoutSettings`, `GroupSettingsModal.groups`, `EngineGroupLabel`,
   nav entries and group strings.
4. Mixed tests that mention groups while covering live behaviour
   (`bot-visibility`, `spend-cap-api`, `tool-scope`, `thread-capacity-api`,
   `index.test.ts`, `mcp-server.test.ts`, `recent-work`, `team-share`,
   `routines`): trim the room cases, keep the rest.

Kept: bot visibility and audiences, Chief delegation, and the steered 1:1 queue
(rooms only supplied its group-turn bound). Stages 3-5 are sized from a
path/name survey, not from reading every call site; expect the estimate to move.

## Owner decision (2026-10-17): rebuild, do not retire, the remaining ACP gaps

Asked what to do with the three things that have no ACP counterpart today, the
owner chose to rebuild all of them, test tooling included. That fixes the queue,
in this order:

1. **Retired native drivers and their tests — done (E04.1–E04.2, PROGRESS).**
   The live helpers were lifted and the unreachable legacy drivers deleted. What
   is left of this item: the `native/<threadId>.ndjson` tee has no writer now, yet
   `server/thread-events.ts` (merge), `server/index.ts` (route), `server/store.ts`
   (delete), `server/thread-retention.ts` and the inspector UI still read it;
   decide per reader whether to keep old-file reading or remove it (E04.3). Also
   `thread-aware-bots.e2e`, `notification-routing.e2e` and `live-call.e2e` were red
   because a config naming a retired `driver` makes the instance unavailable;
   that cause is not re-measured here.
2. **Rooms and groups** — the staged plan in the milestone above.
3. **The `maus` token** — the two slices recorded in the clean-slate item above.
4. **ACP branching** (`branching.test.ts` 3 failing): an edit cannot rewind an
   adapter's session, so implement it the way this app already replays a model
   switch — open a fresh ACP session for the branch and hand it the branch's
   context (`composeContext`/`contextPin` and the `native-history` rules are the
   pieces), then keep the existing refusal only for a live turn.
5. **ACP structured questions** — **done** (`8d8ab45b`). The client now
   advertises `clientCapabilities.elicitation.form` (the gate the claude adapter
   checks before bridging `AskUserQuestion` at all) and handles
   `elicitation/create`: `server/acp/elicitation.ts` re-reads the form into the
   card's questions and options and writes the answer back under the form's own
   `question_<n>` keys, `server/acp/acp-runtime.ts` emits it as a question
   request and resolves it through `respondToRequest`, and the ACP fixture's
   question mode asks that way. `decision-log-wiring` 7/7; `server/acp/` 62/62.
6. **Scripted tool calls in the ACP fixture**, so the ~44 test files that drive
   the retired fake's plan runner can run again. The plan format and the runner
   already exist (`server/testing/room-handoff-agent.ts`, 140 lines, reads
   `{[botId]: …}` plus an evidence JSONL and calls the mounted MCP tools);
   `FAKE_CLAUDE_ROOM_PLAN` reaches the child from the launcher
   (`scripts/control-colonie.ts:480`) and is ignored by the ACP fixture today.
   The ACP fixture receives its MCP mounts in `session/new` instead of a
   `--mcp-config` flag, so the work is the adapter: same plan, same evidence
   file, ACP's mount list as the client.
7. Remaining live-subject migrations, including `steer-queue`'s four
   dispatch-receipt cases: that prelude gates the resolution of
   `adapter.sendTurn`, which for the retired drivers meant the dispatch
   acknowledgment while the turn ran on. The ACP runtime acknowledges earlier —
   it writes the `dispatching` input receipt and emits `turn.started` before
   `session/prompt` (`server/acp/acp-runtime.ts:612-620`) — so the prelude should
   gate that signal instead of the whole-turn promise.

## Test-suite recovery (owner-authorized, in progress)

The owner directed a total clean slate and a green maintained suite: no
`openmausbot`/`omb`/`devone` identity, no retired native drivers, no
pairing/companion code. Test files whose subject was a retired driver or
provider are deleted; files whose subject is live Colonie behaviour are
migrated onto the fixtures the maintained suite already uses — the scripted ACP
engine `server/testing/fake-acp-cli.ts` spawned through the `claude-acp`
adapter, or the `colonie` fixture in `scripts/control-colonie.ts`.

Acceptance: every migrated file passes when run; `pnpm exec tsc --noEmit` stays
green; each deleted file carries a recorded reason.

Commands, per-file results, diagnosed failures, and the scale correction are in
[PROGRESS](PROGRESS.md) under 2026-10-17. In short: the fixture engine had four
ACP shapes the SDK refuses (all fixed), 24 files are verified green, and the
remaining work is per-file. `server/comms.test.ts` stays excluded (it hangs).

## Milestone: ACP automation (owner decision, 2026-10-17)

The owner chose to keep routines and webhooks and make them work on the ACP
fleet, rather than retire them. Measured cause, before the change: a manual
routine run posted "Routine ... failed — This ACP connection supports direct
native sessions" into the bot's own thread, because two guards refused every
automated turn for an ACP driver (`server/index.ts`, `automationSource`,
`unattended`, `peerAsk`). Edits and reruns share those guards and stay refused:
an ACP session belongs to the adapter and cannot be rewound, replayed or handed
another bot's history.

Change: the two guards now refuse only `editedMessageId`, `task.rewound`,
`compactOnly` and `coordination`. A scheduled run, a webhook and a teammate's
handoff (`peerAsk`) are forward turns in the bot's own thread on the bot's own
engine, so each takes the same ACP path a typed message takes; only a room's
coordinated turn has no ACP equivalent.

Acceptance: a manual routine run completes against the scripted ACP engine
(measured: `Routine "Hourly report" completed`), the routine/webhook e2e files
pass, a cross-bot handoff asks its card in the new thread
(`card-answerers.e2e.test.ts` 7/7), and `pnpm exec tsc --noEmit` stays green.
Verification results are in PROGRESS.

Approval levels on ACP (owner decision, 2026-10-17): before this, the ACP fleet
offered only Ask and Full access — `shared/approval-mode.ts:15` returned
`mode === "ask" || mode === "full"` for both adapters — so "Approve for me" was
unavailable and an unattended run whose engine asked waited for a person who was
not there. The owner chose to enable it. Both adapters carry a provider mode for
every level, so the app passes them through instead of inventing a policy: Ask
(Claude `default`, Codex `read-only`), Accept edits (`acceptEdits`,
`workspace-write`), Auto — the adapter's own reviewer (`auto` "Claude handles
permission decisions", `agent` "Auto review — only ask for actions detected as
potentially unsafe") — and Full (`bypassPermissions`, `agent-full-access`).
`AcpRuntime.modeForApproval` keeps Ask when an adapter does not advertise a
level, so a level never falls upward into more access; Custom stays unsupported
(an ACP adapter carries settings, not a provider config).

Verification: `server/approval-mode.test.ts` 22/22 (new case: all four levels
offered on both ACP kinds, Custom refused, Auto counted as a native reviewer),
`server/acp/native-settings.test.ts` (the fixture adapter clamps Auto to Ask by
the id the flavour uses, and the runtime records what the agent kept), and
`decision-log-wiring`'s two "logged as the provider's own request" cases now
reach `native-approval`. Commands and results in PROGRESS.

Known gap, same area, not started: an ACP engine cannot reach the person as a
*question*. `decision-log-wiring`'s "a question card carries its questions and
logs the row without an origin" is the only red left in that file (6/7), because
the ACP path never emits `event.questions` — the only producer was the retired
native Claude driver (`server/drivers/claude.ts:1819`, Claude's AskUserQuestion),
and ACP's own elicitation request is not handled at all in `server/acp/`. So a
question-shaped ask arrives as an approval card with Allow/Deny instead of the
model's own options. Options: handle ACP elicitation (or the adapter's question
extension) and emit `questions`, or accept approval cards on ACP.

## Clean-slate item: the `maus` token (queued)

The retired brand token `maus` still runs through the routines/webhooks
plumbing: ~304 occurrences, `RoutineRunOn = "maus" | "cloud"`, `runOn` defaults
on routines, webhook triggers, routine requests, package export/import and team
backup, the model-visible `run_on` argument
(`server/drivers/agents-call.ts`, `agents-catalog.ts`), the system prompt, and
`data-welcome-maus` / `[maus-debug]` in `src/onboarding-preview.tsx`.

The field is vestigial: `src/components/WebhooksPanel.tsx:73` and
`src/components/RoutineCalendarPage.tsx:377` record that the "cloud computer
place" was removed and the UI now hardcodes `"maus"`. Plan: delete the `runOn`
field and the `run_on` argument rather than rename the token, since nothing
chooses between the two places any more.

The same brand runs through the *visual* vocabulary, which is a separate and
larger slice. A measured inventory (tracked source only; `.colonie-dev/` is
untracked local evidence and does not count):

- `MausAvatar` — 65 references.
- `src/styles.css` — 163 lines holding the character's design tokens and
  classes: `--color-maus-line`, `--maus-eye-x/y`, `--maus-burst-x/y`,
  `maus-character`, `maus-face`, `maus-eyes`, `maus-orbit`, `maus-orbit-dot`,
  `maus-specular`, `maus-ellipsis-dot`, `maus-speed-line`,
  `maus-motion--arrive/celebrate/switch/customize/thinking`, `welcome-maus`.
- `src/onboarding-preview.tsx` (`.welcome-maus`, `[maus-debug]` logs) and
  `src/mascot-preview.tsx` (`${state} maus` labels), reached from the two
  standalone preview entries `onboarding-preview.html` and `mascot-preview.html`.

Staged, each stage compiles and keeps one vocabulary consistent across the pair
of files that share it: (1) the CSS variables and classes together with every
`.tsx` that names them; (2) `MausAvatar` and its importers; (3) the `runOn`
field and the `run_on` argument, with routines/webhooks/requests, store, wire,
package export/import, team backup, the system prompt and their tests; (4) the
two preview entries. Do not rename half of a pair (a CSS class and its `.tsx`
user, or an exported component and its importers) in one commit.

Neither the field removal nor the visual rename is started.

## Deferred items

The flat-black placeholder icon is in place (`electron/resources/colonie-icon.png`,
`build/colonie.icns`). Gated account/team/enterprise UI needs scoped cleanup
decisions.
Windows/Linux packaging and browser/computer/routine/group/delegation workflows
still need current evidence. The old VPS instance (`colonie-vps`,
172.104.33.55) has been emptied — installer mirror, bundled Caddy, its config
and TLS data, and the `colonie` user are all deleted, verified by a
`find -iname "*colonie*"` that returns nothing — but the instance still exists
and is still billed, so **deleting it from the Linode console remains the
owner's step**; do not reconnect or redeploy it. Preserve unrelated WIP.

Later foundation proposals are workspace bootstrap ownership and run orchestration,
after this trial; see blueprint section 6.
