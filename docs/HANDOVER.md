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
"landing". Still uncommitted on purpose: the concurrent approval-mode work and the
deletion of `LICENSE`, `NOTICE`, and `LICENSING.md` (needs an owner decision now
that the repository is public).

Next action: E02 first slice — inspect `server/config.ts` and
`server/message-db.ts`, pick one store/connection boundary that reads global
config, and record its outcome, scope, acceptance, and bounded checks here before
editing. Remote enforcement remains unverified until the owner decides.

## M0 trial checkpoint — still open

M0.1's agreement is consolidated in AGENTS. M0.2/M0.3 extracted shared attachment
and thread-address rules: 98 focused tests, type/lint checks, and 5 document checks
passed in the recorded checkout (see PROGRESS). Task-to-task continuation and a
planned red/green boundary check were observed. Do not repeat those extractions.

M0.4 still needs fresh-session pickup/review evidence. Review so far is self-review;
unexpected-failure recovery and unattended execution remain unproven. Preserve
these limits while scoped foundation work proceeds; do not claim M0 complete.

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
`unattended`). Edits, reruns, coordinated turns and peer asks share those
guards and stay refused: an ACP session belongs to the adapter and cannot be
rewound or handed another bot's history.

Change: the two guards now refuse only `editedMessageId`, `task.rewound`,
`compactOnly`, `coordination` and `peerAsk`. A scheduled or webhook run is a
plain forward turn in the bot's own thread and is allowed.

Acceptance: a manual routine run completes against the scripted ACP engine
(measured: `Routine "Hourly report" completed`), the routine/webhook e2e files
pass, and `pnpm exec tsc --noEmit` stays green. Verification results are in
PROGRESS.

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
chooses between the two places any more. Not started.

## Deferred items

The flat-black placeholder icon is in place (`electron/resources/colonie-icon.png`,
`build/colonie.icns`). Gated account/team/enterprise UI needs scoped cleanup
decisions.
Windows/Linux packaging and browser/computer/routine/group/delegation workflows
still need current evidence. The old VPS instance's billing removal is an owner
console follow-up; do not reconnect or redeploy it. Preserve unrelated WIP.

Later foundation proposals are workspace bootstrap ownership and run orchestration,
after this trial; see blueprint section 6.
