# Colonie ACP verification (DevOne-compatible fixture paths)

Follow the isolation rules in [README.md](README.md). The DevOne fixture is
launched through the existing `launchVerificationServer` control surface with
the explicit `devone` provider option. It creates a temporary home/data dir,
selects a free server/webhook port pair and configures only the repository's
SDK-based fake agent. No native provider credentials cross into that fixture.

## Protocol and real application API

```sh
pnpm colonie:test
```

The SDK fixture verifies exact input, dropped legacy context, multi-turn native
continuity, process/session restart, Allow/Deny, Stop, parallel isolation,
crashed-process completion, rejected missing sessions and failed input recording.
The HTTP application fixture exercises direct dispatch and native resume after
restarting the whole server. Logs and action/result JSON are kept at the paths
printed by the fixture.

## Renderer and development desktop

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.devone/browsers" pnpm exec playwright install chromium
pnpm colonie:ui-check
pnpm colonie:desktop-check
node scripts/devone/ui-check.ts --claude --desktop
node scripts/devone/ui-check.ts --native --desktop
node scripts/devone/ui-check.ts --native --claude --desktop
node scripts/devone/ui-check.ts --native --desktop --context
node scripts/devone/ui-check.ts --native --claude --desktop --context
node scripts/devone/ui-check.ts --native --desktop --profile
node scripts/devone/ui-check.ts --native --claude --desktop --profile
node scripts/colonie/art-check.ts
```

These drive the real React application against the SDK agent fixture. The
desktop command uses the reused Electron shell with its own temporary profile.
Assertions include visible partial output, reload/reconnect during a turn, one
final reply, exact input dialog, continuation, Allow once, Deny, Stop and the
next turn. Screenshots and receipts are in `.devone/evidence/renderer-*` and
`desktop-*`. A simulated tool event is not proof of executing a real shell tool.

## Packaged desktop and native provider

```sh
pnpm colonie:package
pnpm colonie:package-check
node scripts/devone/package-check.ts --claude
node scripts/devone/provider-check.ts --real
node scripts/devone/provider-check.ts --real --claude
node scripts/devone/package-check.ts --real --tools
node scripts/devone/package-check.ts --real --claude --tools
node scripts/devone/package-check.ts --upgrade
node scripts/devone/package-check.ts --native
node scripts/devone/package-check.ts --native --claude
node scripts/devone/package-check.ts --real --native --claude --tools
node scripts/devone/package-check.ts --native --context
node scripts/devone/package-check.ts --claude --native --context
node scripts/devone/package-check.ts --real --claude --native --context
node scripts/devone/package-check.ts --native --profile
node scripts/devone/package-check.ts --claude --native --profile
node scripts/devone/package-check.ts --real --claude --native --profile
node scripts/devone/package-check.ts --conversations
node scripts/devone/package-check.ts --claude --conversations
node scripts/colonie/native-controls-check.ts --real --claude
```

`package-check` launches the actual built `.app`, embedded bundled server and
production renderer with isolated data/profile. Its default is the SDK fixture;
`--real` is two bounded synthetic requests using the packaged upstream adapter
and compatible native dependency with inherited authentication. `--claude`
selects Claude. `--tools` adds two bounded native file-write requests through
the actual UI: Allow produces the disposable file and Deny leaves it absent.
Both close
and reopen the app and verify the same native session id. The separate runner
check also reads one disposable fixture file with a real native tool. The
`--upgrade` fixture runs the old DevOne artifact's bundled server/production UI
and then opens Colonie with that disposable legacy home, proving path/session
preservation without a data move or dependence on the legacy desktop's native
credential startup. Packaged test teardown is bounded and reaps only owned
processes. Explicit fixture ports are honored by the Colonie desktop parent.
Artwork check covers concurrent SVG ids, states/sizes, light/dark and static
reduced-motion rendering; source uploaded-avatar regression tests remain relevant.

M7-A `--native` opens the panel before the first prompt, checks that discovery
does not send input, selects an offered effort level, then proves effective
options survive restart. The UI fixture also changes models, repairs stale
overrides, selects modes and inspects receipts. HTTP/SDK tests reject stale
snapshots, unrelated threads, changes while busy and history transfer into another
provider's session previously prepared only through preview.

The real Codex request for M7-A was blocked by the usage limit in the latest
verification session; that failed evidence is not replaced with a success claim.
Repeat the real check when quota becomes available, without automatic retries
or switching billing.

M7-B `--context` exercises the actual app-wide and bot-specific switches, saved
preview, first-dispatch pin, source manifest and changed-profile notice. Package
checks edit app instructions/SOUL after the first turn and verify the original
snapshot and native session survive a full app restart. Real Claude receives two
bounded no-tool requests: identify the app/role/SOUL label from supplied context,
then recall a disposable marker after restart. This is distinct from fake-agent
scope isolation evidence.

`server/devone/context.e2e.test.ts` uses the canonical isolated launcher for both
providers and multiple bots. It proves shared app scope, bot isolation, plain and
pre-M7-B baselines, discovery-before-edit, new-thread updates and full server
restart. The SDK fake agent serializes shared fixture state across adapter
processes. `context-integrity.test.ts` rejects cross-bot, damaged and missing pins
without dispatch, then verifies restoration resumes the same session/context.

The UX correction changes the default: app awareness, persona and SOUL are now on;
ACP inspection is independently opt-in via **Developer tools**, not merely
Advanced mode. `--profile` edits Job, About and Instructions through the normal
Simple bot profile, saves shared instructions through General settings, and sends
the first turn before enabling the developer inspector. Receipt assertions prove
the saved profile was used automatically. The recipe then explicitly enables
Developer tools through the real Settings UI to inspect evidence. Plain-baseline
HTTP fixtures explicitly disable additions inside their disposable data.

## Multiple conversations on one bot

`server/devone/conversations.e2e.test.ts` launches an isolated server with the SDK
agent for both providers. Two same-bot conversations hold separate permissions
and native sessions, Stop one without stopping the other, keep transcript/profile
ownership, then reload both sessions after full server restart. It also rejects
answering a sibling request via the wrong thread and verifies bounded text previews.

The packaged `--conversations` recipe is fixture-only: through the normal Simple
UI it creates a conversation, switches while both need approvals or are working,
allows one and denies the other, stops each independently, observes background
Unread, and resumes both after quitting/reopening the app. It exercises default
sidebar browsing, the real Show threads preference in Simple mode, and navigation
at 600px with the sidebar closed. Profile/receipt checks assert independent native
session ids and retained pins. Preview text is a bounded display-only recent tail,
not a context/memory addition. Title labeling uses fixture API patches; navigation,
messages, approvals, Stop and display settings use actual UI controls.

Evidence: `.devone/evidence/{claude-,}packaged-fixture-conversations-check.json`
and corresponding default-navigation/parallel-approvals/parallel-working/narrow
screenshots. These are real renderer/desktop workflows with simulated agents;
they do not establish native-provider parallel throughput. Existing bounded real
provider evidence remains separate, and the Codex usage-limit blocker is retained.

The scripts quit only processes they launched and remove only their owned
temporary directory. They leave evidence in the checkout and native-provider
session history under the provider's normal ownership. They do not read login
token contents or mutate the installed OpenMausBot.

## M8 connected tools

```sh
pnpm exec vitest run server/colonie/connections/connections.e2e.test.ts
node scripts/colonie/connected-tools-web-check.ts
node scripts/devone/package-check.ts --connected-tools
node scripts/devone/package-check.ts --claude --connected-tools
COMPOSIO_API_KEY="<project-key>" node scripts/colonie/composio-api-check.ts
COMPOSIO_API_KEY="<project-key>" node scripts/devone/package-check.ts --real --claude --connected-tools
```

HTTP fixtures use the canonical launcher with an explicitly validated loopback
Composio provider. They test workspace key setup, per-bot selection/revisions,
Composio toolkit enforcement, filtered helpers, Custom MCP HTTP/stdio, native
Allow/Deny, relay cancellation on Stop, tools removal/reload and full restart with
the same native session. Claude SSE is exercised separately; Codex rejects SSE
before dispatch and retains resumable history. Other bots mount no selected tools.

The web renderer recipe saves a synthetic key, imports/tests/enables a custom
local server, selects access in the bot profile and executes one fixture Composio
read. Package recipes perform the normal settings/profile workflow with an
explicit runtime credential and simulated SDK agent. Real Claude uses inherited
CLI auth and a disposable workspace/Composio user: bounded MCP search plus one
public Hacker News read, then marker recall after restart. Receipts prove actual
Composio calls/targets/statuses rather than accepting a claimed model answer alone.
The standalone API check deletes its newly created session when finished.

Evidence is under `.devone/evidence/*connected-tools*` and `composio-api-check.json`.
No credential or private connected-account content belongs in evidence. The
unsigned macOS fixture could not encrypt a new credential through safeStorage;
this failed check is recorded separately, not bypassed as a successful secure-store
write. Web/private-config and environment-backed package success do not establish
OS credential persistence. Native Codex remains quota-blocked in the latest real
verification record and was not retried for M8.

### Targeted credential follow-up (supersedes the earlier storage blocker)

```sh
node --test electron/credential-persistence.test.mjs
pnpm exec vitest run electron/secure-credential-state.test.mjs electron/secure-credentials.test.mjs server/colonie/connections/credential-status.test.ts src/components/ApiKeys.test.ts
node scripts/colonie/credential-ui-check.ts
node scripts/colonie/credential-desktop-check.ts
node scripts/colonie/credential-desktop-check.ts --migration
```

The browser fixture verifies no catalog without a project key, masked identity and
source, failed removal retaining status, non-storage IPC failures preserving their
reason, and environment-source removal hidden/refused by the backend. The packaged
fixture inherits HOME only for OS Keychain access and allocates new app data/profile,
uses a synthetic key with loopback Composio and zero model turns, then checks
encrypted save, full restart, removal, preservation of unrelated identity fields
and absence after another restart. Migration mode shows Imported from existing
workspace settings rather than claiming manual entry. Only this fixture's generated
encrypted document is inspected; returned evidence contains field names, not values.

The initial temporary-HOME encryption failure is retained historically. Subsequent
synthetic async/sync roundtrips with accessible OS Keychain succeeded on the unsigned
artifact, including its unchanged Colonie crypto name. Do not attribute all failures
to unsigned packaging or claim user-specific keychain recovery from that result.
Targeted unit tests protect unreadable stores and restore original encrypted bytes
on rejected server commits without requiring fresh encryption. No provider workflow
regression or real connected-account mutation is required for this follow-up.

## What is not claimed

These checks do not establish multiuser office deployment, signed/notarized
distribution, native rollback/forking, every provider feature,
or arbitrary long-running coding-task reliability. Record actual results and
remaining scope in `docs/PROGRESS.md`.
