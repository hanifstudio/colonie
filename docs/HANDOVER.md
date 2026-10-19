# Colonie handover

Updated: October 19, 2026. Current state and active work only.
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

The distance to a public release is tracked gate by gate in the
[launch board](LAUNCH.md): the nearest milestone is L1 (one person installs the
current tree and completes the first-run journey), and its first blocker is S2
(CI on the release commit calls files this tree no longer has, and Release refuses
a commit without a passing CI verdict).

## Active engineering task: L1 — a person installs the current tree and completes the first-run journey

Owner question, October 19: "can we start to continue the development so that we can launch
Colonie to the public?" The board ([LAUNCH](LAUNCH.md)) is the map; this task is the first row.

- Outcome: one Mac that never had Colonie installs an artifact built from this tree, and a
  person completes the first-run journey — welcome, engine sign-in inside the app, a bot
  answering a real message, create and switch a workspace, quit, reopen.
- Scope (in order): the build itself (`pnpm colonie:dist`), then the journey, then whatever
  the journey breaks. S1/S2 (how this tree reaches `main`, and CI calling files it no longer
  has) are the ship-path conditions this task exposes; they are not silently assumed.
- Acceptance: each journey step either works as the board's F-rows describe, or the failure is
  recorded in the board row it belongs to with the evidence that showed it.
- Not in scope: a published release, Server workspaces, and the deferred platform work.
- Checks: `pnpm typecheck`, `pnpm lint`, `pnpm structure:check`, `pnpm test` as always; the
  artifact and the journey are verified by hand and recorded in the board.

## Active engineering task: the desktop app runs the Colonie engine system

Owner decision, October 19: "Number 3 sounds like we have to adapt into the new system."
The shipped app must run the Colonie profile (the maintained ACP engines and the Colonie
identity), not the inherited legacy fleet, whichever way the app is started.

- Scope: (1) the desktop app sets the profile for the server it starts, instead of relying
  on the dev launcher's environment, so an app opened from the installer behaves like one
  started by the launcher; (2) that profile never resolves to an empty engine list — a
  configuration whose engines cannot run there falls back to the default pair and says in
  the log which instances were left out.
- Deliberately out of scope: the app's OS integration (updater, protocol registration,
  dock), which currently reads the same flag in the app process. Those keep today's
  behaviour, because switching them would remove the Windows updater path that the release
  flow uses. Data location is unaffected either way: the desktop parent passes its own data
  directory to the server, which wins over the profile's default.
- Acceptance: a fresh throwaway instance boots with the default pair listed; a throwaway
  instance whose only configured engine is a legacy one still lists the default pair and
  names the dropped instance in its start log; unit tests cover the fallback and the
  warning; typecheck, lint and the suite stay clean; no dark launch of the OS integration.
- Checks: `npx vitest run server/acp`, `pnpm typecheck`, `pnpm lint`, `npx vitest run server
  scripts`, and a boot probe with a throwaway `HOME` plus `COLONIE_PROFILE=1` and a
  legacy-only `config.json`.

Status: both parts are implemented and verified. The desktop parent sets
`COLONIE_PROFILE` for the server it starts (`electron/main.mjs`, default `"1"`, an explicit
value still wins); `colonieInstances` returns the default pair instead of an empty map and
warns with the instance ids it left out (`server/acp/profile.ts`); `server/acp/profile.test.ts`
covers the pair, the per-engine config directory, the fallback and the warning. Evidence:
4 tests pass; `pnpm typecheck` 0 errors; `pnpm lint` clean; `pnpm structure:check` clean
(exit 0); `npx vitest run server scripts` 105 files / 515 tests pass; throwaway boot with
`COLONIE_PROFILE=1`, `COLONIE_DATA_DIR` and a `config.json` holding only
`claude-named (claudeAgent)` logged the left-out instance and served
`/api/instances` = codex-acp + claude-acp. `pnpm test:electron` fails two inherited
tests (`mac-updater`, `vendor-updater`) because they import `scripts/patch-mac-updater.mjs`
and `scripts/patch-appimage-updater.mjs`, which the clean-slate commit deleted — not
from this change.

Owner decision, also October 19: adapt those two screens to the system the app now runs,
rather than hiding them. The next task below carries it out.

## Active engineering task: a named account is a new-system engine

Owner decision, October 19: adapt the two "add account" screens to the system the app now
runs. Today they create legacy engines the profile filters out
(`POST /api/instances/claude-accounts` → `driver: "claudeAgent"`,
`POST /api/instances/chatgpt-accounts` → `driver: "codex"`), so a new user adds an account,
the request succeeds, and no engine appears.

- Scope: a named Claude account becomes a `claude-acp` instance whose directory is its own
  `CLAUDE_CONFIG_DIR`; a named ChatGPT account becomes a `codex-acp` instance with its own
  `CODEX_HOME`. The directory is one value written to both the engine's environment and the
  account's config, including when settings change it. Account identity, the
  duplicate-directory check, the per-account sign-in card and the model picker's "Claude"/
  "OpenAI" account grouping all recognise the new drivers, so the account appears where the
  person just looked. The isolation default becomes a default rather than a ceiling: an
  explicitly configured directory wins, because that is what an account means.
- Out of scope: changing how a sign-in itself runs (the engine's own auth flow and the
  printed CLI command stay as they are), and any migration of accounts already saved under
  the legacy drivers.
- Acceptance: creating either account through its route persists a `claude-acp`/`codex-acp`
  instance that `/api/instances` lists and whose sign-in card names its own directory; two
  accounts cannot share a directory; changing an account's directory updates both places;
  the default pair still runs in the isolated directories. Checks: unit tests for the
  account builders, the fleet precedence and the picker families, `pnpm typecheck`,
  `pnpm lint`, `pnpm structure:check`, `npx vitest run server src scripts`, and a throwaway
  boot that creates an account over HTTP and reads it back.

Status: implemented and verified. A named Claude account is a `claude-acp` instance and a
named ChatGPT account a `codex-acp` instance, each with its own directory written to both
the engine's environment and the account's config (`server/colonie/providers/claude-accounts.ts`
— `setClaudeAccountDirectory`, `newClaudeAccount`, `newCodexAccount`); the duplicate-directory
check, the settings write in `server/routes/provider-instances.ts`, the sign-in card in
`server/harness/config-status.ts` and the picker's families in `src/lib/engine-rail.ts` all
recognise both drivers. Evidence: `server/colonie/providers/claude-accounts.test.ts`,
`src/lib/engine-rail.test.ts`, the extended `server/acp/profile.test.ts` and
`server/routes/provider-instances.test.ts` (4 files / 18 tests); `pnpm typecheck` 0 errors;
`pnpm lint` clean; `pnpm structure:check` exit 0; `npx vitest run server src scripts`
107 files / 524 tests pass. Throwaway boot, `POST /api/instances/claude-accounts`
`{"displayName":"Second account"}`: 201, `/api/instances` lists the account as
`claude-acp` (state `unavailable` until signed in) with `claudeAccount.configDir` under
`providers/<id>` and a sign-in command targeting that same directory, while the default
`claude-acp` keeps `native/claude` and `isDefault: true`; `config.json` holds the directory
in both `environment.CLAUDE_CONFIG_DIR` and `config.configDir`; no error in the start log.
The two inherited `pnpm test:electron` failures are unchanged.

## Active engineering task: E02.1 — the workspace owns its paths

Owner decision, October 19: start the workspace foundation. The blueprint's E02 asks for
"workspace paths, configuration, credential references, repository construction, and
shutdown ownership at bootstrap", with one existing boundary migrated first. This is that
first, bounded slice.

- Outcome: a workspace scope exists in the runtime and names every path a workspace owns
  (`server/runtime/scope.ts`), and one real boundary — the bot/thread store — reads and
  writes through it instead of joining the process's data directory itself.
- Scope: the scope owns the data directory and its `native`, `events`, `bots.json`,
  `groups.json`, the thread-model-copies marker and the pre-database thread files; the
  process's active scope is still the data directory the process was started with, so the
  Local path is unchanged; `Store` takes a scope (defaulting to the active one).
- Out of scope in this slice, and still reading the process directory directly at the time:
  the message database, the events writers, bot folders and SOUL mirrors, `config.json`
  (including engine configuration), attachments, checkpoints, skill state,
  routines/webhooks/calendar files, provider account directories, MCP tool results and the
  memory journal. With one active scope today the behavior is identical. E02.2 (below)
  migrated the settings file and the message database; the rest is the remainder.
- Acceptance: two disposable scopes share no path; a store built for a workspace reads that
  workspace's bots and reads them again on restart; a store built without a scope uses the
  process's data directory; the running app still reads and writes the same data directory.
- Checks: `npx vitest run server/runtime/scope.test.ts server/persistence/store.test.ts`,
  `pnpm typecheck`, `pnpm lint`, `pnpm structure:check`, `npx vitest run server src scripts`,
  and a throwaway boot reading bots/config back over HTTP.

Status: implemented and verified. Evidence: `server/runtime/scope.test.ts` (3 tests: paths
derived from a directory, two scopes share nothing, the active scope equals the process data
directory) and `server/persistence/store.test.ts` (now 3 tests, including two disposable
workspaces whose stores see only their own bots and see them again after a restart);
`pnpm typecheck` 0 errors; `pnpm lint` clean; `pnpm structure:check` exit 0 (29 folders);
`npx vitest run server src scripts` 108 files / 529 tests pass. Throwaway boot with
`COLONIE_PROFILE=1` and a temp `COLONIE_DATA_DIR`: `/api/health` 200, `/api/bots` 200 (the
fresh workspace's default bot), `/api/instances` 200 (the default pair), and `bots.json`,
`bots/`, `events/`, `native/` and `messages.db` all appeared inside that data directory with
no error in the start log. The two inherited `pnpm test:electron` failures are unchanged.

## Active engineering task: E02.2 — the settings and the conversations belong to the workspace

Owner decision, October 19: continue with the parts that hold history and sign-ins. Those
are the settings file (`config.json`: engine setup, keys, features) and the conversation
database (`messages.db`), the two boundaries that decide whether a second workspace is
really its own.

- Outcome: the data-directory resolution itself moved into the workspace scope, so the paths
  a workspace owns have one owner and nothing has to reach back; the settings file and the
  conversation database now come from the workspace instead of the process.
- Scope: `server/runtime/scope.ts` owns `DATA_DIR`/`EVENTS_DIR`/`NATIVE_DIR` and the scope
  names `configFile` and `messageDbFile`; `server/config.ts` reads and writes the settings
  through the active workspace's `configFile` (six call sites) and re-exports the directory
  constants it always exported, so nothing else changed; `server/persistence/message-db.ts`
  opens the workspace's `messageDbFile` and creates the workspace directory.
- Still one workspace per process: `loadConfig()` and the database handle stay singletons,
  which is correct while there is one active scope. Two workspaces running at the same time
  is a later step (a scope per runtime instance), not this one.
- Out of scope: the events writers, bot folders and SOUL mirrors, attachments, checkpoints,
  skill state, routines/webhooks/calendar files, provider account directories, MCP tool
  results and the memory journal. These still build their own path from the process's data
  directory constant, which the scope now owns — so they follow the directory the process
  was started with, but they are what a per-workspace runtime still has to hand a scope to.
  Engine account directories are already inside the workspace, because they are built under
  the data directory.
- Acceptance: a workspace's settings file and conversation database are its own paths and
  two scopes share none of them; the running app writes a setting that lands in the active
  workspace's `config.json` and reads it back; the conversation database is created and
  opened inside that workspace; typecheck, lint, structure check and the suite stay clean.
- Checks: `npx vitest run server/runtime/scope.test.ts server/persistence/store.test.ts`,
  `pnpm typecheck`, `pnpm lint`, `pnpm structure:check`, `npx vitest run server src scripts`,
  and a throwaway boot that writes a setting over HTTP and inspects the workspace folder.

Status: implemented and verified. Evidence: `server/runtime/scope.ts` now resolves the data
directory and owns `configFile`/`messageDbFile`; `server/config.ts` and
`server/persistence/message-db.ts` read through the active scope (no `join(DATA_DIR,
"config.json")` or `join(DATA_DIR, "messages.db")` remains in `server/` outside the scope
module). `server/runtime/scope.test.ts` (3 tests) now also pins the settings file and the
conversation database, including that two workspaces share none of them. `pnpm typecheck` 0
errors; `pnpm lint` clean; `pnpm structure:check` exit 0; `npx vitest run server src scripts`
108 files / 529 tests pass. Throwaway boot (`COLONIE_PROFILE=1`, temp `COLONIE_DATA_DIR`):
`/api/config` reported `features.showToolCalls = false`, `PUT /api/config
{"features":{"showToolCalls":true}}` answered 200 and read back `true`; `config.json`
contained `{"showToolCalls":true}` inside that data directory; `messages.db` was created
there and held the conversation tables (`messages`, `thread_state`, `memory_files`,
`command_receipts`, `chat_followups` and the search indexes); no error in the start log. The
two inherited `pnpm test:electron` failures are unchanged.

## Active engineering task: E02.3 — the app knows which workspaces exist

Owner decision, October 19: continue to the part that lets two workspaces run together. The
engine side already does: two servers with two data directories run at once with nothing in
common (each data directory carries its own lease, and a second process on the same
directory is refused), which this task verified before writing any code. What the app itself
still lacks is knowing which workspaces exist and where each one lives.

- Outcome: the desktop can name the workspaces it knows about and resolve the directory each
  one owns; the workspace it runs now is a record, not a path the app composes inline.
- Scope: a new Electron-free module (`electron/local-workspaces.mjs`) holding the workspace
  list (`workspaces.json` in the app's own data folder, never inside a workspace — the list
  is what points at the workspaces), the default workspace at the historical directory, and
  the rule that an explicit `COLONIE_DATA_DIR` always means the default workspace, so
  isolated rigs keep working. `electron/main.mjs` resolves its data directory through the
  active workspace record; with one workspace the resolved directory is exactly what it was
  (this is asserted, not assumed).
- Not in this slice: creating a workspace (that is journey J01, with its own engine
  onboarding), stopping and starting a server when the active workspace changes, and the
  visible switcher. The module's consumer for the list is that switcher; today only the
  active-workspace resolution is on the live path.
- Acceptance: the default workspace is the directory the app has always used for an unset,
  empty and explicit `COLONIE_DATA_DIR`; a listed workspace keeps its own directory; no two
  workspaces resolve to the same directory and a malformed or unknown list degrades to the
  default rather than failing; the desktop's data directory resolves to the same value as
  before; syntax, unit tests, lint and the structure check stay clean.
- Checks: `node --test electron/local-workspaces.node-test.mjs`, `node --check
  electron/main.mjs`, `pnpm test:electron` (the two inherited `mac-updater`/`vendor-updater`
  failures stay explicit), `pnpm typecheck`, `pnpm lint`, `pnpm structure:check`, and a
  throwaway two-workspace boot as the engine-side evidence this rests on.

Status: implemented and verified. Evidence: `electron/local-workspaces.mjs` with
`electron/local-workspaces.node-test.mjs` (5 tests: the default directory for unset/empty/
explicit override, a listed workspace keeping its own directory, an explicit override always
resolving to the default workspace, no two workspaces sharing a directory — a listed copy of
the default directory, a repeated id, a nameless record and a record without a directory are
all dropped — and a missing, unreadable or unknown list leaving the default workspace).
`electron/main.mjs` resolves its data directory through the active workspace record.
`node --check electron/main.mjs` clean; `pnpm test:electron` 265 tests with 262 passing and
the same two inherited `mac-updater`/`vendor-updater` failures, the 5 new tests among the
passing; `pnpm typecheck` 0 errors; `pnpm lint` clean; `pnpm structure:check` exit 0.
Engine-side probe before writing any of this: two throwaway servers (two data directories,
two ports) both answered `/api/health` 200, each wrote and read back its own `features` in
its own `config.json`, each held its own `colonie-server.lease` with its own pid, and neither
log showed an error or a refusal. Not verified: a desktop launch with the module wired (no
isolated desktop launch was run; the resolved data directory matching the previous value is
asserted by tests, not observed in a packaged shell), and nothing visible in the UI changes.

## Active engineering task: E02.4 — a person can create a workspace and switch between them

Owner decision, October 19: take the workspace foundation to the part that is visible. E02.3 gave
the app a list of workspaces and the directory each one owns; nothing could create a workspace and
nothing could change which one runs. Split so each half is verifiable on its own.

E02.4a — create a Local workspace (this unit).
- Outcome: the app can create a Local workspace — a name, an id of its own, a data directory beside
  the first one, and a record in the list — without touching the workspace that is running.
- Scope: `createLocalWorkspace` in `electron/local-workspaces.mjs`. It validates and trims the name,
  derives a filesystem-safe id that neither repeats a listed id nor adopts a directory that already
  exists on disk, creates the directory, and appends the record to `workspaces.json`. The stored
  file never names the default workspace's directory, because that path comes from the environment
  (an explicit `COLONIE_DATA_DIR` wins) and writing it down would freeze the wrong one. A list file
  that exists but cannot be read stops the whole operation, so a recoverable list is never
  silently replaced.
- Not in this slice: IPC, any UI, engine onboarding for the new workspace (journey J01's next step)
  and starting a server for it — all of that is E02.4b.
- Acceptance: creating a workspace leaves the running workspace's directory, settings and list
  position untouched; the new record survives a re-read and resolves by id; ids are unique against
  the existing list; a name is required, trimmed, and bounded in length; an unreadable list is
  refused rather than overwritten; an existing directory is never adopted; no two workspaces
  resolve to the same directory; `node --test`, the Electron suite, typecheck, lint and the
  structure check stay clean.
- Checks: `node --test electron/local-workspaces.node-test.mjs`, `pnpm test:electron`,
  `pnpm typecheck`, `pnpm lint`, `pnpm structure:check`, and a boot probe against a directory the
  module created (server healthy, its own `config.json` and lease, and nothing written into the
  workspace that was already there).

E02.4b — the switcher, in two halves.
- E02.4b1 — the list can change which workspace runs (done). `setActiveWorkspace` in
  `electron/local-workspaces.mjs` writes the chosen id into `workspaces.json` and resolves it, so
  the next server the app starts uses that workspace's directory. Nothing is moved or copied, an id
  nobody listed is refused, and a list that cannot be read is refused rather than overwritten.
  Scope limit: the app does not call it yet — no IPC and no UI — so this half changes nothing the
  person sees. Highlighting the active workspace was done in E02.3 (it already resolves).
- E02.4b2 — the visible half, in two slices: the sidebar's profile row shows the active workspace
  and its menu lists the workspaces with a "New workspace" entry (the Local/Server choice appears
  there, with Server disabled until hosting exists); choosing one makes the app run in that
  workspace's directory, showing the honest state while it happens.
  Found on October 19 while answering "how do I create a workspace", and it widens this unit: no
  second workspace can actually run today. The installed app (`/Applications/Colonie.app`, 0.2.0,
  built October 15) predates the workspace foundation, and the source launcher (`pnpm colonie`,
  `scripts/colonie/start.ts`) exports `COLONIE_DATA_DIR` for both the server child and the Electron
  process — which `readWorkspaces` deliberately reads as "run the default workspace here", so the
  list is ignored and the dev server is pinned to one directory. This unit must therefore let the
  app own the data directory: keep the explicit override as the developer/rig escape it is, and make
  the source launcher stop pinning it. Proof of the whole feature needs a packaged build, because the
  installed app is older than the foundation it would have to read.
  - E02.4b2a — the app owns the data directory, and the list can change it (done).
  - E02.4b2b — the sidebar surface: the profile menu lists the workspaces, marks the running one,
    creates one, and reports what changing it takes (done).
  - Decision (October 19), taken while implementing E02.4b2a: changing the workspace **restarts the
    app** through its normal shutdown path (`app.relaunch()`), rather than stopping the running
    server, moving the data-directory lease and starting a second one mid-life. The restart reuses
    the paths that already exist and are exercised — lease acquired once at startup, server started
    once, window loaded once — where an in-place move would put the lease, the supervisor and the
    window's origin in a state nothing tests. The person sees the window close and reopen; unsent
    drafts in the old workspace are lost, which is why the restart is never silent. The source
    checkout cannot restart into another workspace from inside the app (the launcher owns the dev
    server), so there the app records the choice and asks the person to open Colonie again — and the
    launcher, now list-aware, lands in the chosen workspace.
  - E02.4b2a outcome (this slice): the app runs the workspace it last used, and the workspace list
    can change it. `electron/colonie.mjs` stops writing `COLONIE_DATA_DIR` into its own environment —
    that write is what pinned every start to the default directory — and seeds the directory it
    resolves instead; `electron/main.mjs` exposes `local-workspaces:list|create|switch` to this app's
    own page only, and switching validates the target, proves the target directory is free with the
    same lease a server takes, records the choice, and restarts the app.
    `scripts/colonie/start.ts` resolves the active workspace for the dev server child while leaving
    the Electron process unpinned, so a source checkout lands where the list says.
  - E02.4b2a acceptance: an installation with no list still runs `~/.colonie`; no running directory
    changes without a restart; a switch to an id nobody listed, to the already-running workspace, or
    to a directory another Colonie owns is refused — the last one without recording anything, so the
    app can never restart into a directory it cannot lease; a second workspace is never pointed at
    `~/.colonie`; and a developer's explicit `COLONIE_DATA_DIR` still wins and still means "the
    default workspace here".
  - E02.4b2a checks: `pnpm test:electron` (the new `workspace-switch` tests beside the fifteen list
    tests), `pnpm typecheck`, `pnpm lint`, `pnpm structure:check`, `pnpm test`, and an engine probe
    in a throwaway home: two workspaces, the recorded choice changed, and a server started in the
    directory the app's own resolution returns.
  - E02.4b2a not verified here: the Electron bridge and the restart need a real window, so the IPC
    handlers and `app.relaunch()` are covered by the pure switch decision and by review, not by a
    run; the packaged build carries that proof, and the launcher's platform app-data path is mirrored
    from Electron (`colonieAppData`) behind a unit test rather than launched.
  - Repaired while here: `desktop:relaunch` called `relaunchAfterDesktopRemoteChange`, which the
    companion-app removal (5eff19bc) deleted, so the macOS permission recovery's "Relaunch Colonie"
    button threw a ReferenceError. The handler now calls the `relaunchColonie()` the switch uses.
  - E02.4b2b outcome: the profile row's menu starts with the workspaces on this computer — each one
    by name, the running one marked (accent row, tick, "Open now") — then "New workspace…", which
    opens an in-menu form: a name field and the same kind rows the first-run step uses (Local chosen,
    Server disabled with "Coming later"), then Create and Cancel. Create opens the new workspace right
    away; if that half fails, the creation still stands and both facts are said. The menu reports what
    a change takes ("{app} will close and open {name}" / "Open Colonie again to use {name}"), and the
    marked row is the workspace *this session runs*, not the recorded choice — the two differ in a
    source checkout until Colonie is opened again.
  - E02.4b2b scope: `src/components/SidebarLocalWorkspaces.tsx` (the section and its answers),
    `src/lib/local-workspaces.ts` (the name rule, the notices and the four refusals, so each answer is
    testable without a bridge), `src/components/SidebarProfileMenu.tsx` (the section leads the menu;
    Settings gains a hairline when it is present) and two small additions to
    `src/components/SidebarPopoverMenu.tsx`: a `custom` row (a form field or an explanation with the
    menu's own padding) and `onOpenChange` (so a half-filled form and a note about a restart belong to
    the visit). The menu also takes a max height and scrolls, because a list of workspaces has no
    natural end. English strings only; other packs fall back. The app's name bound travels with the
    list (`LocalWorkspaceState.nameMax`), so the field refuses exactly what the workspace module
    refuses instead of a second rule that drifts.
  - E02.4b2b acceptance: the running workspace is marked and named; another one can be chosen, and the
    menu says what happens next rather than going quiet; a new workspace can be created and is opened;
    Server is visibly disabled and cannot be clicked; a name that is empty refuses with a reason; the
    menu stays honest in a source checkout, where the marked workspace does not move until Colonie is
    opened again.
  - E02.4b2b checks: `pnpm typecheck`, `pnpm lint`, `pnpm structure:check`, `pnpm test` (including the
    eight new tests in `src/lib/local-workspaces.test.ts`) and `pnpm build`, with the new strings
    confirmed in the built bundle.
  - E02.4b2b not verified: how it looks and feels. No browser or Electron window was launched here, so
    the visual pass is the owner's; and the main-window wiring — the IPC calls, the restart — needs a
    packaged build to be exercised end to end.
  - E02.4b2c — the form stays open on the click that opens it (done). The owner's first click in a
    running app: "New workspace…" appeared to do nothing. The row opened the name form and closed the
    menu in the same click, and the menu's close is what puts a half-filled form away
    (`SidebarLocalWorkspaces` clears `creating` when `menuOpen` goes false) — so the form was never
    drawn. Marking the row `keepOpen` fixes it; that is what the update row already does for its own
    in-place progress. Scope: one item in `src/components/SidebarLocalWorkspaces.tsx`. Acceptance:
    clicking "New workspace…" leaves the menu open with the name field focused; closing the menu and
    returning still starts from the list. Checks: `pnpm typecheck` 0 errors, `pnpm lint` clean. Not
    verified: the click itself, which needs a window — the owner's own next look at the menu is the
    check.

Owner decisions, October 19, that bound this unit: the current welcome/onboarding flow is not
edited at all — not its beats, layout or copy, including text about capabilities since retired —
so the first workspace is still the one the app creates for the person and no Local/Server question
is added to onboarding. The Local/Server choice belongs to the workspace surface, with **Server
shown disabled** until hosting exists, never as available. The switcher lives in the **sidebar's
profile row**. Recorded in the blueprint (J01 note and decision log). The owner refined the
onboarding half the same day: E02.5 adds the workspace-kind step to that flow.

Status: E02.4a, E02.4b1, E02.4b2a and E02.4b2b implemented and verified as far as this machine can
verify them. `createLocalWorkspace`, `setActiveWorkspace` and `readWorkspaces` live in
`electron/local-workspaces.mjs` (15 tests in its node-test file); the switch decision is
`electron/workspace-switch.mjs` (8 tests); the launcher's app-data mirror is `colonieAppData` in
`electron/colonie-config.mjs` (4 tests); the preload's channel names are pinned in
`electron/preload.node-test.mjs`; the sidebar's words are `src/lib/local-workspaces.ts` (8 vitest
tests). `pnpm typecheck` 0 errors; `pnpm lint` clean; `pnpm structure:check` exit 0; `pnpm test` 110
files / 539 tests pass; `pnpm build` succeeded with the new strings in the bundle;
`pnpm test:electron` 288 tests with 285 passing and the same two inherited
`mac-updater`/`vendor-updater` failures.

Engine evidence, E02.4a: a throwaway home where the module created "Design lab", then a server
started against that directory (its own free port, `COLONIE_PROFILE=1`) answered `/api/health` 200,
wrote and read back its own `features.showToolCalls=true`, and held its own lease — while the
workspace that already existed kept its own setting and gained no new files.

Engine evidence, E02.4b1: the same throwaway home with two workspaces created by the module; the
recorded active workspace was switched to each in turn, and a server booted against the directory
the module resolved answered `/api/health` 200 and kept its own setting — `true` in "Design lab",
`false` in "Client work" — with both directories and both records intact afterwards. Switching the
record moved no data.

Engine evidence, E02.4b2a (`.colonie-dev/probe-e02-4b2a.mjs`, throwaway home): a fresh installation
resolves `~/.colonie`; after creating "Design lab" and choosing it, the same `activeWorkspace()` call
`electron/colonie.mjs` and `scripts/colonie/start.ts` now make returns that directory, with both
records intact on disk; a server booted in it answered `/api/health` 200, kept its own
`features.showToolCalls=true` and its own lease, while the workspace that was already there gained no
files and has no `config.json`; with `COLONIE_DATA_DIR` set the resolution returns the default
workspace in that directory, as before.

Not verified: the app's own wiring — the IPC handlers, the preload bridge and `app.relaunch()` — and
how the sidebar section looks and feels. Both need a real window, so a packaged build carries that
proof; everything above is module, engine and build evidence. Nothing was pushed.

## Active engineering task: E02.5 — the welcome flow asks which kind of workspace

Owner request, October 19, refining the earlier "leave the welcome flow alone": add one step to the
existing first-run flow where the person picks the kind of workspace, built to look like it belongs
there. Nothing existing is removed or restyled.

- Outcome: after the greeting and before the rest of setup, the flow says that bots, conversations
  and connections live together in one workspace, that this one is Local, and that a Server
  workspace exists but is not available yet — shown disabled, never offered as if it worked.
- Scope: a new beat component beside the existing ones, the four places the flow machine requires
  for a beat (`BeatId`, `beatsFor`, the mascot table and the title switch in `WelcomeFlow.tsx`), and
  English strings only (other packs fall back). The flow's existing beats, copy, layout and
  animations are untouched. Nothing is persisted: Local is the only kind the app can create today,
  so the choice needs no record, the workspace config schema is not extended, and `WELCOME_VERSION`
  stays 1 so people who already finished the flow are not shown it again. A hosted workspace still
  gets its short greeting + bot flow instead of this step.
- Acceptance: the beat appears in the flow's order with a card title and the default width, reads as
  one surface with the other beats (same rise-in stagger, row and button styling, same "Continue"),
  Server is visibly disabled and cannot be clicked, and Continue advances the flow. The flow must
  still be escapable: Escape and "Skip tour" behave exactly as before.
- Checks: `pnpm typecheck` (the typed beat tables force the update), `pnpm lint`,
  `pnpm structure:check`, `pnpm test:electron`, and `pnpm build` so the renderer bundle includes the
  beat. Visual confirmation is the owner's, through the dev-only preview page
  `http://127.0.0.1:5199/onboarding-preview.html?beat=workspace` with `pnpm dev` running; there is no
  component-test environment (vitest runs in node) and the beat is presentational.
- Inherited failures in this area, not caused by this change: `pnpm i18n:check` cannot run because
  the script it calls (`scripts/generate-locale.mjs`) was deleted in the clean-slate commit, and the
  two Electron tests (`mac-updater`, `vendor-updater`) import deleted scripts.

Status: implemented and verified as far as this machine allows. Evidence: `pnpm typecheck` 0 errors,
`pnpm lint` clean, `pnpm structure:check` exit 0, `pnpm build` succeeded with the new strings present
in the built bundle, `pnpm test` 109 files / 531 tests pass (including the new render check
`src/components/onboarding/beats/WorkspaceBeat.test.ts`: Local is checked and not disabled, Server is
`aria-checked="false"` + `disabled` + "Coming later", and Continue is present), and
`pnpm test:electron` 275 tests with 272 passing and the same two inherited failures. Not verified:
how it looks — this session has no browser or Electron window, so the visual check belongs to the
owner through the dev preview page, and the beat's appearance in the real first run was not observed.

## Done task: a native session the engine no longer has

Found in the owner's own data on October 19 while answering "why did the Codex setup fail". A
conversation whose saved engine session is gone used to fail with `Codex ACP setup failed: Internal
error. Check 'codex login' or start a new conversation.` — sign-in advice for a problem that is not
sign-in — and the thread stayed dead until the person started another one.

Evidence for the finding: the owner's `Motion` (`791cc3b0…`) and `Biscuit` (`9fb4528f…`) held cursors
`01a152a2-ccb5…` and `01a152a2-3278…`; both sessions exist under `~/.codex/sessions/2026/10/19/` and
their rollouts carry the Colonie app prompt and Colonie task-workspace cwds, so a Colonie start at
12:28–12:29 ran the engines unisolated (`server/config.ts` returns the configured instances without
an isolated `CODEX_HOME` unless `COLONIE_PROFILE=1`). `pnpm colonie` at 13:34 sets the profile, so the
engines run in `<workspace>/native/codex`, where those sessions do not exist. This is also an upgrade
path: the instance ids are unchanged by isolation, so conversations saved before it point at the
other home.

- Outcome: a rejected resume costs the engine's context, not the conversation. `AcpRuntime.open`
  catches a refused `session/load` — the rejection IS the resume request, so nothing has reached the
  model and the turn is still before the accept boundary — and starts one fresh session on the same
  already-initialized connection. The turn is then sent with the transcript the harness rebuilt
  (`recoveryText` through `server/resume-recovery.ts`, the module that existed for this and was called
  from nowhere), `session.started` carries `rebuilt: true` for the harness's own bookkeeping, and the
  thread shows one line saying the session was rebuilt from the thread's history. If the fresh session
  cannot start either, both facts are reported, not just the second.
- Scope: `server/acp/acp-runtime.ts` (the load branch in `open`, the turn's text and the two events in
  `sendTurn`, and the flag cleared in the settings-discovery path so it belongs to one turn), plus
  `server/acp/resume-rebuild.test.ts`, which drives the real runtime against the deterministic ACP
  fixture (`server/acp/testing/fake-agent.ts`) that refuses a session it does not have.
- Acceptance: such a conversation answers the message and says it was rebuilt; the transcript is not
  replayed again on the following turn; a rejected cursor with no rebuild text still answers the
  message; the `codex login` advice no longer appears for a session the engine simply does not have.
- Checks: `npx vitest run server/acp/resume-rebuild.test.ts` 2 tests pass (both fail with the same
  `ACP setup failed … Unknown saved session` when the runtime change is stashed, so the test covers
  it); `pnpm test` 111 files / 541 tests pass; `pnpm typecheck` 0 errors; `pnpm lint` clean;
  `pnpm structure:check` exit 0.
- Not verified: the harness-level consequences of `rebuilt: true` — the delta-context bookkeeping that
  consumes it has no test today (its suite is part of the ACP-fixture migration backlog) — and a real
  Codex session that is genuinely gone, which needs provider auth this machine does not have. The
  person's own stuck conversations (`Motion`, `Biscuit`) were not re-run: their cursors still point
  into the other home, so the next message in them is the real check.
- Not decided: whether the person may decline the rebuild (today it is one attempt, once).

## Active engineering stage: E01 — enforceable architecture checks

Owner priority is deliberate improvement of architecture, folder/file organization,
and code/design consistency. The [engineering roadmap E01–E06](COLONIE-BLUEPRINT.md#engineering-roadmap-architecture-and-consistency)
and [acceptance standards](COLONIE-BLUEPRINT.md#code-and-design-consistency-acceptance)
are the single plan; later stages are not implemented by this documentation.

E01.2 was built and proven locally, but **nothing enforces it today**. The step
"Enforce architecture boundaries" ran `scripts/testing/content-boundaries.test.ts`
and `scripts/testing/index-route-ratchet.test.ts`, and `scripts/ci-workflow.test.ts`
failed if the step disappeared, lost a guard, or became skippable (the ratchet's
inherited stale counts had been lowered to 143/80). Commit `263666d9` ("Owner
decision: clean slate") then deleted `scripts/ci-scope.mjs` and all of
`scripts/testing/` while `.github/workflows/ci.yml` still names them, so the static
job cannot pass and the vitest job behind it never starts. Live enforcement is
`pnpm test` (which runs the guard tests) plus `pnpm structure:check`; re-creating
those scopes or dropping the steps is an owner decision (see E01.3 below).

The index-route ratchet is gone with that clean slate, so removing routes from
`server/index.ts` no longer fails anything locally. The current guards are the
import-boundary matrix and the module map; both are shrink-only, and the acceptance
standard still says never raise a count.

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

## Active milestone: restructure the code shape (`restructure` branch)

Owner direction (October 18): start clean on a new branch so it stays revertible —
local commits only, never push; one heavy job at a time. An intermediate order
(keep the green suite as the net while restructuring) was put to the owner and
accepted, then set aside in the same session: the owner judged the sprawl itself
the blocker and directed that every script and every one of our test files go, on
the branch, before anything else. That is now done — 870 files, recorded in
PROGRESS with the counts, what was kept, and the commands it broke. The cost is
explicit rather than hidden: no suite, no launcher, no server-bundle tooling, and
no real Claude/Codex quota until next week. A fresh suite is being rebuilt one
module at a time (47 tests in 13 files so far) and the launcher tooling is back;
changes are judged by `pnpm typecheck`, `pnpm lint`, those tests, the app being
started, and review.

- `restructure` was created from `dd6cca5e`; `main` is untouched and revertible.
- Script inventory (166 files under `scripts/`): 111 referenced by something, 38
  discovered by the test glob, 37 referenced by nothing. Those 37 are mostly
  manual verification instruments (`verify-*.ts`, `scripts/colonie/*-check.ts`),
  not junk, and their legacy subjects (qwen, grok, whop, podman, opencode) still
  exist in `server/` and `src/`, so they cannot be deleted as "dead subject".
  Only `scripts/verify-pi-tool-scope.ts` has no subject left (zero `pi-tool`
  references in `server/` and `src/`), and
  `scripts/verify-codex-instructions.mjs` / `verify-codex-sandbox.mjs` verify the
  retired native Codex protocol. The ACP instruments (`verify-real-turn.mjs`,
  `verify-claude-account.ts`, `verify-codex-account.ts`, the `verify-codex-*`
  acceptance files, `verify-routines.ts`) are gone now — the clean slate below
  removed them; restore them from `main` before P2.
- Launcher and server-bundle tooling came back in Langkah 0 (`scripts/colonie/start.ts`,
  `scripts/bundle-server.mjs`, `pnpm colonie`, `build:server`). `scripts/desktop-server-entry.mjs`
  came back with S5: `build:server` cannot finish without it and `electron/server-child-launch.mjs`
  forks it. `scripts/mcp-server.ts` stays out (nothing the app ships launches it, only `pnpm mcp`);
  the bundler skips that step with a warning and restores it with
  `git checkout main -- scripts/mcp-server.ts`. Still broken and known: `i18n:check`, `clean`,
  `check:contrast`, the packagers.
- Done: `server/runtime/` (S1), `server/persistence/` (S2), `server/colonie/routines/` (S4),
  `server/colonie/workspace/` (S5), `server/colonie/peers/` (S6), `server/colonie/memory/` with the
  ledger nested under `colonie/memory/ledger/` (S7), `server/colonie/skills/` (S8),
  `server/colonie/bots/` (S9), `server/colonie/teams/` (S10), `server/colonie/providers/` (S11),
  `server/colonie/mcp/` (S12), `server/colonie/computer/` (S13), `server/colonie/chat/` (S14), and
  route groups out of `index.ts` (S3, still partial) — voice, connectors, admin reads, bot
  activity/outbound, server info, team library and scout, skills library, team sections, new-bot
  defaults, custom MCP servers, the team brief with team memory, and a bot's SOUL, history and
  overview. `index.ts` 18,207 → 17,261 lines; roughly 67 inline non-internal route guards are still
  in it.
- Files that stay at the `server/` root, because a path lookup fails silently otherwise:
  `proxy-paths.ts` (the anchor every spawned file resolves through; moving it broke every proxy path,
  S1 `0a0af8b4`), the spawned workers `message-search.worker.ts` / `workspace-backup.worker.ts`, and
  the spawned proxies (`container-mcp.ts`, `connector-proxy.ts`, `mcp-gate.ts`, `mcp-remote-proxy.ts`,
  `harness-mcp-proxy.ts`, `local-computer.ts`, `local-computer-proxy.ts`, `permission-proxy.ts`).
  The rule: a spawned file's path is built from `SERVER_ROOT` by `resolveProxy`, so it keeps its path
  relative to `server/` however its neighbours are filed — and a spec written relative to the *starting*
  module cannot satisfy both layouts, because that module is inlined into `index.js` in a package yet
  sits in its own folder in dev. That is what broke dev message search between S5 and S14
  (`eb1dab83`); the bundler header and `bundle-server.mjs`'s entry list both state the rule, and
  `proxy-paths.test.ts` asserts every `SPAWNED_PROXIES` entry exists.
- Each unit ships its own test, per `server/routes/README.md`: 29 files, 162 tests, all green beside
  `pnpm typecheck`, `pnpm lint` and `pnpm build:server`. The old ratchet test is gone with the clean
  slate, so route counts live in PROGRESS.
- Verification recipe, learned the hard way: `env -u COMPOSIO_API_KEY HOME=$(mktemp -d)
  COLONIE_PROFILE=1 node server/index.ts`. `COLONIE_DATA_DIR` alone is not isolation —
  `config.json` is read from `homedir()`, and the shell exports `COMPOSIO_API_KEY`,
  which every child inherits. Probe local routes only; never one that reaches a provider.
- Swarms are authorized by the owner (October 18) for S3 and after. The rule that makes them safe: **one
  writer per file**. Extraction of inline routes always edits `server/index.ts`, so only one lane may write
  it; parallel lanes are read-only (audit of the dead `/api/internal/*` block, mapping of the remaining
  groups, caller searches), and heavy local jobs (vitest, typecheck, `build:server`) run one at a time.
- Deletion series (owner approved October 18, small groups): D1 removed the dead `/api/internal/*` block and
  everything only it used (16,990 → 14,050 lines in `index.ts`); D2 removed `server/external-runtime.ts`, the
  `externalRuntime` field, the dead `/api/internal` branch in `adminAuditPlan` and the scope bypass in
  `request-auth.ts`. Left alone on purpose, because it is an ACP-contract decision rather than dead code: the
  integration builders that still target retired `/api/internal` URLs (`agentsIntegration`, `hooksIntegration`,
  `controlIntegration`, `mcpIntegration`) and the retired native agents driver cluster under `server/drivers/`.
  Both are unreachable with the current two ACP adapters, which declare none of those capabilities.
- Next in this task: **S3's remaining `index.ts` groups, smallest first.** A read-only mapping pass
  (October 18) ordered all 38 remaining live groups; the shared blockers named then are now resolved or scoped:
  `requirePinnedClientThread` lives in `server/routes/pinned-client.ts` (S3.19), so the groups that used it can
  move. Groups sharing mutable `let` state — `events` (SSE fan-out), the Local VM flags, `providerConfigBusy`,
  `browserEngineInstall` — must take that state as an explicit dep, not be extracted independently.
  `/api/testing/internal-capability` stays with what is left of the internal machinery. Done since: bot-read
  (S3.20), the paired-safe profile edit, `bot-profile-patch` (S3.21), thread-events (S3.22), saved command
  permissions (S3.23), the broad bot edit, `bot-update` (S3.24, 566 lines — the largest family), one bot's threads,
  `bot-task` (S3.25), creating a bot, `bot-create` (S3.26), answering a running thread,
  `thread-respond` (S3.27), exporting a team, `teams-export` (S3.28), importing one, `teams-import` (S3.29), raw uploads, `uploads` (S3.30), the event stream, `events` (S3.31), sending a message, `bot-messages` (S3.32), the bot form of answering, folded into
  `thread-respond` (S3.33), steering a queued message,
  `queue-steer` (S3.34), the provider instances and settings
  writes, `provider-instances` (S3.35), settings,
  `config` (S3.36), skill resolution,
  `colonie/skills/skill-resolution` (S3.37), the delegation
  watch, `colonie/peers/delegation-watch` (S3.38), the trusted-approval
  message handler, `colonie/bots/trusted-approval-message` (S3.39), and the
  direct-send cluster, `colonie/chat/direct-send` (S3.40), the turn
  engine itself, `colonie/chat/turn-start` (S3.41), the bot teardown,
  `colonie/bots/delete-bot` (S3.42), and the HTTP front door itself,
  `harness/request-handler` (S3.43), the runtime event bus subscriber,
  `colonie/runtime/event-subscriber` (S3.44), and the model/engine selection
  cluster, `colonie/providers/model-selection` (S3.45), and the request/card/watchdog
  cluster, `colonie/chat/requests` (S3.46), the delegation lifecycle,
  `colonie/peers/delegation-lifecycle` (S3.47), the local-VM/computer state,
  `colonie/computer/local-vm-state` (S3.48), and the card resolvers,
  `colonie/chat/card-resolvers` (S3.49), the config/status cluster,
  `harness/config-status` (S3.50), the HTTP assembly and route table,
  `harness/server-assembly` (S3.51), the live-screen poller,
  `harness/screen-polling` (S3.52), the routine run cards,
  `colonie/routines/run-cards` (S3.53), the parked-turn resume tables,
  `colonie/chat/resume-tables` (S3.54), the admin-activity audit,
  `harness/admin-audit` (S3.55), bot visibility,
  `harness/visibility` (S3.56), identity/card answering,
  `harness/identity` (S3.57), the client read models,
  `harness/read-model` (S3.58), the turn-digest state,
  `colonie/chat/turn-digest` (S3.59), the internal capability table,
  `harness/internal-capabilities` (S3.60), one direct turn's dispatch claim,
  `colonie/chat/turn-dispatch` (S3.61), the two settings-derived bot views,
  `colonie/bots/settings-view` (S3.62), the per-turn integrations,
  `harness/turn-integrations` (S3.63), the direct-message flow,
  `colonie/chat/direct-flow` (S3.64), the computer-seat binding,
  `colonie/computer/turn-computer-binding` (S3.65), the browser feature's
  process-local construction, `colonie/computer/browser-sessions` (S3.66), the
  process lifecycle, `harness/process-lifecycle` (S3.67), and the server-side
  client push, `harness/client-streams` (S3.68). Every
  route group named
  in S3 is out of `index.ts`, and the non-route helpers have started moving (S3.37).
  `index.ts` is now 2,138 lines — **under the owner's 3,000 target**. The owner
  asked for it pushed further, toward the older still-open ~1,000–1,500 target, by
  keeping whole coherent clusters (a domain module, never a catch-all) coming out;
  S3.69+ is that long tail.

  Every named giant is now out (S3.43 was the last: the 1,646-line `handleRequest`,
  carved whole into `harness/request-handler.ts`). The largest remaining top-level
  function in `index.ts` is `collectTeamSkills` at 40 lines; everything
  else of size is the shared state and small declarations that no single feature owns,
  which is the next job and a different kind of one: moving a
  mutable binding to a module is safe only while every reader imports that same
  binding, and the state reads `cfg`, so the groups have to be chosen by what they
  close over, not by name. The body reached 108 deps; eight of them are reassigned
  while the server runs, so the wiring passes them as getters, and the four that the
  handler itself writes go over as getters plus setters (`setBrowserEngineInstall`,
  `setBrowserEngineInstallError`, `setCustomDomainRevision`, `setLocalVmProvisionBusy`),
  which keeps the readers in the already-moved route modules untouched.

  The 1,000-1,500 line target is **not** reachable by moving route groups and named
  giants alone — `handleRequest` moved at S3.43, the last of them. What is left below 2,138 lines is state and small
  declarations, a separate and larger job than S3. Say so before starting it. `.colonie-dev/carve.py`
  carves a block and lists the deps; the static-path sweep on a throwaway HOME runs
  after every extraction. The dead native transport (`/api/internal/*` peer block and
  friends, ~3,400 lines) stays untouched: it is owner-gated, not a default cleanup.
- After S3: R1–R6 (`src/features/chat|bots|teams|settings|computer`, then `src/components` + `src/lib`),
  X1 (`shared/`) and X2 (`electron/`). Each is a move plus a guard, same shape as S1–S14, and each needs
  the same check the S-modules got: typecheck, lint, the suite, and a live probe on a throwaway HOME.
- Two blockers recorded: the desktop window has never been opened on this branch (it uses the owner's
  real data), and real Claude/Codex provider verification waits for next week's quota. A compiled tree is
  not evidence of either.

### E01.3 Phase 0 — structure baseline measured (October 18, 2026)

Scope: measure the goal ("an agent finds the right file and changes it without collateral damage") from
raw material **before** writing any rule. No product code, no behaviour change, no rule installed yet.
Acceptance: two read-only deterministic measurement tools plus committed artifacts, and a written
statement of what the numbers do and do not support. Bounded checks: `pnpm lint` and `pnpm typecheck`;
the measurement touches neither `server/` nor `src/`, so no live probe applies.

- Tools: `scripts/structure/measure-history.mjs` (git locality and co-change) and
  `scripts/structure/measure-graph.mjs` (compiler-derived import graph). Artifacts, method, numbers and
  limits: [docs/structure/README.md](../structure/README.md). HEAD `69707a05`: 1,061 files, 3,710
  edges (920 via `@/*`), 10 file-level cycles, 54 mutually-importing folder pairs, 1,997 exported names
  never imported by name (unverified figure).
- Two results already changed the plan. The candidate rules "a feature may not import `server/routes/`"
  and "… `server/harness/`" are **mis-specified**: five of their nine hits are blueprint-sanctioned
  imports of the shared route contract (`routes/table.ts`) and shared HTTP helpers (`harness/http.ts`).
  Folder-level cycles at this granularity are one 24-folder blob with no signal, so the rule set keeps
  file-level SCCs and mutual pairs instead. Four direction rules are already at zero violations and are
  safe to enforce from day one.
- The measurement caught two bugs in itself (alias imports dropped; re-exported names credited to the
  barrel), and the first verification of the dead-export metric was itself wrong twice — a re-export line
  is not a use, and `SignInLists` is two different symbols. The count stays labelled unverified until an
  independent tool (`knip`/`ts-unused-exports`) compares, as E01.3 requires.
- Inherited breakage reported, not fixed: `electron/mac-updater.node-test.mjs` and
  `electron/vendor-updater.node-test.mjs` import `scripts/patch-mac-updater.mjs` and
  `scripts/patch-appimage-updater.mjs`, and neither script exists.
- Phase 1 landed: `scripts/structure/import-boundaries.json` (five rules; the two sanctioned shared
  modules `server/routes/table.ts` and `server/harness/http.ts` named as exceptions), `scripts/structure/graph.mjs` as the single compiler-driven
  resolver shared by the measurement and the guard, `pnpm structure:check` (exit 1 new crossing, 2 matrix
  loosened, 3 stale grandfather), and `scripts/testing/import-boundaries.test.mjs` (run by
  `pnpm test` because `vite.config.ts` includes `scripts/**/*.test.mjs`). Falsification: a temporary
  `server/harness/__falsify-boundary.ts` importing `src/lib/cn.ts` produced
  `no-server-to-ui … exit 1`, and deleting the file restored exit 0.
- Enforcement in CI is **blocked, not enabled**: `263666d9` ("clean slate") deleted `scripts/ci-scope.mjs`
  and all of `scripts/testing/` while `.github/workflows/ci.yml` still runs them, so the static job cannot
  pass and the vitest job behind it never starts. Until that is decided, `pnpm structure:check` and
  `pnpm test` are the enforcement points; re-creating the scopes or dropping the steps is an owner choice.
- Phase 2a landed: the graph the guard runs on is verified by a method-different second pass (walk the
  tree from disk, parse every statement, require full file coverage and full edge coverage). It found two
  defects that would have let rules pass silently — `server/testing/*.mjs` was invisible because a
  tsconfig `include` collects only the extensions that config enables, and `./x.mjs` could resolve to the
  type stub `x.d.mts` instead of the file that runs — both fixed in `scripts/structure/graph.mjs`; the
  graph is now 1,078 files / 3,683 edges. It also surfaced
  `electron/fixtures/browser-closed-shadow.cjs` requiring `electron/browser-surface.cjs`, which does not
  exist (inherited breakage, reported, not fixed).
- Phase 2b landed: both grandfathered crossings are fixed, not suppressed, so the matrix is now five rules
  with zero violations and an **empty baseline**. The memory-upkeep wiring moved to `server/harness/` (it
  is assembly that `index.ts` supplies collaborators to), and the desktop-viewer contract moved into
  `colonie/computer/desktop-viewer-contract.ts` so the route adapter imports the feature, not the reverse.
  Verified with a live probe of a throwaway instance (boot clean; `/api/health`, `/api/bots`,
  `/api/local-computer` all 200, no error in the start log).
- Phase 2c landed: `docs/structure/map.md` names all 29 folders under `server/` that hold source files,
  one line each (the blueprint §7 tree is a target shape, so there was no current map to read).
  `scripts/structure/map.mjs` walks the tree and `pnpm structure:check` now fails when a folder has no
  map line or the map names a folder that is gone; `scripts/testing/structure-map.test.mjs` (6 tests)
  enforces it on every `pnpm test`. The CLI was renamed with its scope,
  `check-import-boundaries.mjs` → `check-structure.mjs` (the `pnpm structure:check` entry point is
  unchanged). Falsification: a temporary `server/colonie/__falsify-map/probe.ts` produced the MISSING
  line and exit 1; deleting it restored exit 0.
- Next actions, and they need an owner choice rather than another autonomous step:
  (a) the CI question above;
  (b) the restructure size target is **retired by measurement** (October 19): `server/index.ts` is 2,138
  lines, of which ~1,400 are feature-wiring calls, and its 34 remaining helpers are 13 lines or shorter,
  so shrinking it further moves declarations rather than improving comprehension;
  (c) the **engine-fleet defect verified on October 19**: in Colonie profile a created named Claude account
  is dropped by the ACP filter and the fleet comes back empty, so the person loses every engine
  (`claude-accounts.ts:68` → `config.ts:1611` → `colonieInstances`, reproduced against the pure function).
  Three repairs are known and each one is a product choice: fall back to the default ACP pair (never show
  zero engines, the account stays invisible), create the account as a `claude-acp` instance (blocked on the
  `CLAUDE_CONFIG_DIR` precedence in `acp/profile.ts:20-23`), or refuse the creation with a message;
  (d) nothing in `electron/` sets `COLONIE_PROFILE` — only `scripts/colonie/start.ts:23` does — so an app
  launched straight from the dmg runs the legacy fleet with `~/.colonie`; that is a product decision too;
  (e) the dead-export verification (needs a dev dependency decision), and the paused renderer work R1–R6.

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

## Done task: P1 close-out — the room retirement is proven

Closed October 18. The acceptance below is met for the red set as measured:
PROGRESS carries the classified red list with commands and results (one real
regression and one stale expectation fixed, one flaky file, 23 inherited with
before/after counts on all 27); `pnpm typecheck`, `pnpm lint` and `pnpm i18n:check`
are green; every touched test file passes (SettingsModal 4 files / 47 tests,
digest 3/3, acp-recovery 2/2, peer-allowlist 7/7, presets 1/1, duration-sequencer
10/10); and the document checks pass
(`scripts/testing/verification-docs.test.ts` 5/5). The work is committed locally
on `main`. **Correction, same day:** those 27 files were one CI quarter of 754,
so the close-out's "every red case recorded" holds for the measured quarter only;
measuring quarter 2 found 19 more red files (see the migration-backlog milestone
below), which is the honest remaining scope of "a green maintained suite". The 23 inherited files are **not** this task's
leftovers — they are the ACP-fixture migration backlog, which is the active
milestone below and does not gate this close-out.

Owner stopped the `claude -p` batch on October 17 and asked for verified work
instead of fast work. This task ran in the owner's OpenCode session and was
recorded here before any code edit, per the development loop.

- Outcome: the room retirement is proven by checks, and every red case is either
  fixed as a regression or recorded as inherited with the run that shows it.
- Scope: `server/`, `src/`, `scripts/testing/`, docs. Dead room leftovers only
  where no live caller remains; the Decision model Settings section comes out
  (owner decision) while `server/decider/` stays.
- Acceptance: PROGRESS carries the classified red list with the actual command
  and result; regressions fixed; `tsc`, `oxlint`, `i18n:check` and each touched
  test file pass; document edits pass
  `scripts/testing/verification-docs.test.ts`.
- Bounded checks: one heavy job at a time, reproduced as CI shards
  (`pnpm exec vitest run --shard=N/4`) rather than a guessed full run; each fix
  gets its own targeted file; two repairs per red before recording it inherited.
- Owner-directed deviation: the batch's no-commit rule was lifted once, so the
  stopped batch's work would not be lost (commit `842da736`, 226 files). Commits
  stay owner-gated.
- Missing evidence: a solo session's checks are self-review, and these rules
  require independent review; the owner decides whether to provide a verifier.

State carried over from the batch, still current: rooms are read-only legacy
storage (`groups.json` never written, stored rooms admin-only, no pair DM
channels); room screens and navigation are gone from `src/`; `coordinate_bots` is
retired and live Chief delegation is `ask_bot`. Open red: `index.test.ts` 10
cases, `tool-scope.e2e` 6/7, `workspace-backup-workflow` paired client export
200 vs 403, `steer-queue` 4 cases, plus the src failures listed in PROGRESS
"iteration 3". Product gap found: tool selection is not forwarded to ACP
connected-tool mounts (see PROGRESS); needs an owner/product decision before fix.
Do not release yet: P1 and the room-retirement milestone remain unproven.

Owner monitor correction (October 17): progress means roadmap outcomes and gaps,
not a tool/process log. The local monitor must derive product P0–P7, engineering
E01–E06 and the active cleanup queue from the blueprint/HANDOVER/PROGRESS. Show
done, in progress, not started, blocked/deferred and unverified outcomes, with
plain-language completed work and remaining acceptance. No logs, model/token/cost
cards or run counts in the main view. Refresh the derived roadmap snapshot after
each checkpoint; it is a view of these docs, not a second planning authority.
The first autonomous verification run was interrupted to replace the monitor;
source WIP is preserved and no final verification checkpoint was returned. Resume
the same source verification after this tooling correction; do not mark it done.
The replacement derived its snapshot from these documents. Owner decision
(October 19): those local monitor artifacts were deleted as stale — the roadmap
snapshot, the progress pages, the monitor script and its state, and the dispatch
files. A derived view is produced from these documents on request and never
replaces them. The rules the monitor carried stay in force: a checkpoint returns
outcomes, remaining acceptance and references for its stable roadmap IDs, a
finished slice cannot mark an entire P/E stage done, and deferred future work
stays deferred.

Owner workflow update (October 17, superseding the parent-review trial): Claude
runs the authorized work itself through `claude -p` (task selection, checks,
self-review, checkpoints) without waiting for a Codex review. The launcher, team
helper and HTML monitor live under ignored `.colonie-dev/`; they are development
tools, not application features.

Completed room-retirement slices (static/unit evidence each; details in PROGRESS
under the quoted headings): stage 1 (ten room e2e files deleted); stage 3a (group
HTTP routes, channel MCP tools and control-CLI channel commands gone); stage 3b
part 1 (room turn engine deleted, room entry points inert, "rooms retirement,
stage 3b part 1"); and from stage 3b part 2: `roomPosts`/`personAskAt`,
`groupUsageReader` (module deleted), `roomFeedsBot` (rooms stop feeding recall;
ratchet 135/69), the dead `room.audience-reset` audit plan, the dead `busyBotId`
reads, the handoff router's `group` case for `run`/`busy`, the dead `/api/groups`
client-scope rules (a client session now gets 403 on old room paths),
`server/group-goal-run.ts`, and `server/decider/room-routing.ts` with its eval.

Decisions and findings still in force:
- `rooms.turnTimeoutMinutes` is room-only (enforced only by the deleted engine);
  UI/wire go with the renderer stage, config/backup parsing keeps accepting it.
- `settleRoomFloor` stays until room storage/visibility go: `bot-visibility.ts`
  still hides stored rooms by `audienceFloor`.
- `server/room-handoffs.ts` is the live direct-delegation engine
  (`coordinate_bots`); only its room parts go. Node schema keeps optional `groupId`.
- `coordinate_bots`/direct-handoffs dispatch is retired (unreachable on ACP);
  stored `room-handoffs.json` trees load as settled history. The native agents
  MCP tools (`ask-bot`/`delegate-bot` routes, pair-DM mirror, prompts) are also
  unreachable on ACP but stay until the owner decides (see questions below).
- Storage (reversible, no deletion): `groups.json` and room transcripts stay on
  disk and in workspace backups; the app stops creating rooms, then stops reading
  them. `package-import.ts` and `team-backup.ts` no longer create rooms; the
  remaining creator is the ask_bot DM channel (`comms-visibility.ts`
  `getOrCreateChannel` via `store.createGroup`); read-only: `delegations.ts`,
  `peer-approval.ts`.
- Do not release before the renderer stage lands: the renderer still calls the
  removed routes; a room renders but can no longer answer.
- Owner answered the room questions on October 17 (details in the blueprint's
  [decision log](COLONIE-BLUEPRINT.md#decision-and-research-log)): drop the
  Settings "Decision model" section from the interface while the `server/decider/`
  core stays for a future real job; a read-only view or export of old room
  conversations may come later at low priority; retire rather than rebuild the
  native agents MCP delegation tools (`delegate_bot`, native `ask_bot`, pair DM
  channels), which no ACP adapter mounts today.
- P0 is closed and its answers are not open questions again: the owner answered
  Q01–Q11 on October 17, recorded in the blueprint's
  [open decisions table](COLONIE-BLUEPRINT.md#10-open-decisions-and-next-work).
  What remains there is machine research (provider entitlement, reference
  behavior, hosting benchmark), not owner decisions. Owner instruction: finish
  the P1 foundation/rooms milestone first; those research items stay queued
  after it unless the owner reprioritizes.

Batch harness (stopped October 17 by owner decision): the five-lane `claude -p`
experiment under `.colonie-dev/` is kept for its records and stops being the
working plan. Lane states at stop: server, fixtures and approval verified;
renderer verified for static/i18n; tests integrated and partly verified. Retained
as policy: one heavy job at a time, a report is not check evidence, self-review is
not independent review, and no publishing, deployment, remote ruleset changes or
sweeping WIP into commits. Retained follow-ups: `steer-queue` item 7 (gate the
`dispatching` receipt, not the turn); UI e2e files still reading removed `groups`
(`team-lifecycle-ui`, `thinking-timer-ui`); ACP reports no adapter cost
(`acp-runtime.ts` `turnUsage`/`finish`), so spend-cap cost assertions need a
runtime decision. Lane task files stay in `.colonie-dev/team/tasks/` and
`python3 .colonie-dev/claude-autopilot.py status` reports the stopped state (its
`state.json` still names worktree paths that no longer exist). The batch's progress
page was deleted on October 19 with the other stale monitor artifacts; the batch's
record is PROGRESS. The 35 worktrees under `.worktrees/claude-team-20261017-192725/`
were audited on October 19 and removed, together with the older
`/private/tmp/colonie-base` worktree (its commit is in `main`): every uncommitted
change of every lane, including renames, is preserved in
`.colonie-dev/batch-wip-20261017.tar.gz`, every patch verified to apply onto the
base commit, and the lanes turned out to be intermediate drafts of work the history
already carries — the samples differed from the integrated result by a few lines.
One follow-up from that work was closed: `src/components/ThreadRefs.tsx` was binary to git because
its template literal held raw NUL bytes, so no diff of it could be reviewed; it now writes those
separators as `\u0000`/`\u0001` instead, with the same strings proved and the file text again.
These ignored local tools do not change application ACP.

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

Close-out state (October 18): the acceptance above is met — see the P1 close-out
section at the top of this document for the exact checks. The 23 inherited files
are **not** this task's leftovers: they are the ACP-fixture migration backlog,
tracked as its own milestone below, so this close-out does not wait on them.

## Milestone: ACP-fixture migration backlog (owner-directed direction)

Active since October 18 (P1's close-out did not wait on it). The owner directed a
green maintained suite. **Scope correction (October 18):** the close-out's "27
red files" are one CI quarter's share of 754 test files, not the whole red set.
Quarter 2 (`npx vitest run --shard=2/4`, `.colonie-dev/suite-shard2.log`, 196
files, 526.8 s) found 19 further red files the close-out never saw — among them
`server/index.test.ts` (11 failed), `server/thread-aware-bots.e2e.test.ts` (11),
`server/notification-routing.e2e.test.ts` (7), `server/external-runtime.e2e.test.ts`
(4), and `server/memory-routes.test.ts` / `server/browser-codex-path.integration.test.ts`
whose `beforeAll` fails so every case skips — plus 14 single-case files and
`src/components/lazy-screens.test.ts`. The queue is ~35 files, not 23, and the
inventory is complete only once every quarter is measured (3–4 running). The
split follows the weight list, so the deletions' edit to
`vitest-shard-weights.json` moved files between quarters: no quarter's list is a
stable subset. Classification of the newly found files has not started.

Each red file is resolved one at a time with a recorded reason:

- the subject is retired → delete the file and record why (one line in PROGRESS);
- the subject is live Colonie behaviour → port the fixture onto
  `server/testing/fake-acp-cli.ts` (or the `colonie` fixture in
  `scripts/control-colonie.ts` for launcher-based files) and run it green.

Acceptance: every one of the 23 is either deleted with a reason or passing when
run; `pnpm typecheck`/`lint` stay green; PROGRESS records the command and result
per file; CI shards 2–4 are then measured once. Patches may be drafted read-only
in parallel, but each file is applied and run serially here. Bounded checks:
target the file that changed — never re-run the whole red set.

Triage (read-only agents, October 18) and disposition, one line each:

- **deleted (`a5786fdc`)** — `openai-compat-vm.e2e.test.ts` (retired
  `openai-compat` driver + native-only Local VM tools),
  `host-lazy-claim.e2e.test.ts` (native-branch gated host-computer mount),
  `direct-screen-settlement-api.test.ts` (screen frames need a native-only
  capture path), `cli-stop.e2e.test.ts` (asserts the retired native drivers'
  whole-process-tree reap; ACP interrupt is covered by `server/acp/*`),
  `aside-e2e.test.ts` (aside folding needs `Adapter.steer` + `queueing`, absent
  from `server/acp/`), `hooks.e2e.test.ts` (the engine-hooks channel is native
  assembly behind `capabilities.hooks`; `tool.fullResult` has one setter).
- **migrate, fixture only** — `team-package-skills.e2e.test.ts` (one string:
  `hello from fake claude` → `fake acp`); `card-answerers.e2e.test.ts` (delete the
  `/api/groups` room block at :190, the task-thread case covers the rule;
  expected 7/7); `control-colonie.test.ts` (rename `FAKE_CLAUDE_PROBE` →
  `FAKE_ACP_PROBE`; `FAKE_CLAUDE_TOOL_CALLS` → a `FAKE_ACP_TOOL_PLAN` file);
  `mcp-selection.e2e.test.ts` (read `<dump>.mcp.json` instead of
  `dump.mcpConfig`, drop the three `systemPrompt` assertions and the room case).
- **migrate, fixture + test body** — `computer-engine-removal.e2e.test.ts` (drop
  retired Boat/cloud-computer assertions), `team-lifecycle.e2e.test.ts` (delete the
  post-`new-channel` room/group half, keep the team-file import/restart half),
  `incidents.e2e.test.ts` (ACP fixture; the Chief's incident chip and
  `retry_thread` are live), `create-bot-model.e2e.test.ts` (ACP `echo-gated`
  hold, model advertisement, capability mint), `profile-card-lifecycle.e2e.test.ts`
  and `tool-results.e2e.test.ts` (both blocked on the launcher's missing
  test-capability option below), `server/delta-context.e2e.test.ts` (its fixture
  repoints the maintained ACP instances at the retired native fakes so no turn can
  start; per-test remap, four groups retired).
- **product fix behind a test** — `claude-account-api.test.ts`: named Claude
  accounts still create the retired `claudeAgent` kind; the maintained shape is a
  `claude-acp` instance per account whose `environment.CLAUDE_CONFIG_DIR` points at
  that account's directory, which also needs `server/acp/profile.ts` isolation to
  yield to an explicit per-account dir. Planned in full on October 18 from a
  read-only agent — **not a fixture port** (~15 files): the account carries its
  directory in `environment.CLAUDE_CONFIG_DIR` (legacy `config.configDir` still
  read for old saves); `profile.ts` lets the explicit dir win over the app-wide
  isolated one (today it is overwritten); the three gates in `server/index.ts`
  (`describeInstances`, PATCH, DELETE) move from `claudeAgent` to `claude-acp`;
  `server/colonie/workspace/workspace-backup.ts` and `server/plan-usage.ts` read the new field; the
  UI family folds (`src/lib/engine-rail.ts`, `EnginesSettings.tsx`,
  `ProviderIcons.tsx`, `EngineLibrary.tsx`) accept `claude-acp`; and
  `server/acp/acp-runtime.ts` must keep `authStatus.account`
  (email/organization) from the adapter's `_auth/status_update`, which it drops
  today. The test moves onto `server/testing/fake-acp-cli.ts` behind a new opt-in
  `--account-fixture` mode (a per-account `hang` file, and
  `account:<dirname>` replies from the account directory's basename).
  Decisions it depends on: a malformed saved directory stays a repairable
  no-sign-in shadow; the built-in Claude entry keeps the id `claude-acp` while the
  legacy id `claude` is also "default"; the terminal sign-in command stays the
  native-style one; and the separate workspace-API-key Claude instance
  (`claudeApi`, already a shadow) is left alone.
- **still being triaged** — the four renderer UI e2e files
  (cloud-preview/team-canvas-ui/team-share-ui/trust-controls-ui).

**Closed by owner decision (October 18).** After the scope correction above, the
owner chose deletion over repair so the red suite stops blocking other work. All
72 red files were removed (`git rm`; `.colonie-dev/deleted-reds.json` and PROGRESS
carry the per-file failed/total counts and the areas whose coverage is now
unguarded), the weight list went 115 → 52, `duration-sequencer` 10/10 and
typecheck/lint 0. Two items were product faults rather than test rot and move to
the product list below: named Claude accounts still create the retired
`claudeAgent` kind, and the packaged app appears to resolve the legacy fleet. The
plan below is kept as the record of what was triaged; none of it is queued for
repair now.

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

Measured by the OpenCode session on October 17–18: shard 1 of the CI split
(`pnpm exec vitest run --shard=1/4 --maxWorkers=3`) reported 30 failed files and
94 failed tests of 2,369 in 1,922 s on Node v22.23.1 while `.nvmrc` pins
24.13.1; on 24.13.1 the same 27 red files give 26 failed files and 93 failed
tests in 1,637 s, so the version was not the cause. Shards 2–4 are not measured.

The baseline comparisons were wrong twice over and are superseded. The pre-batch
worktree (`fb1f0e86` at `/private/tmp/colonie-base`, since removed under the
owner's before-17-October rule; the commit is in `main`) had lost `@hpke/core`,
which the batch removed from `package.json` while the old source still imports
it through `server/phone-secret.ts`. Every file touching that module died in
`beforeAll` and looked greener than it was — vitest reports a `beforeAll` failure
as "all tests skipped", which the first comparison read as "0 failed". Repairing
the link and re-running a hand-picked short list only moved the error: the
comparison has to cover all 27 red files at once. With the link restored
(`.colonie-dev/red-baseline-full.log`: 24 failed files, 94 failed tests, 33
passed, 206 s) the honest classification is:

- **one real regression, fixed** — `scripts/testing/duration-sequencer.test.ts`
  (0→3: the shard weight list carried 13 deleted files; it now holds the 119 that
  exist, 10/10);
- **one stale expectation left by the batch's own retirement** —
  `server/presets.e2e.test.ts` asserted `groups: []` in the team-package import
  response, a field rooms retirement removed deliberately; the assertion is gone
  and the file is green;
- **one flaky file** — `server/acp/start.e2e.test.ts` failed in the shard run and
  passes on re-run;
- **23 inherited** — identical failure counts before and after, i.e. the ACP
  migration backlog, not batch damage. `server/claude-account-api.test.ts` (4)
  and `server/openai-compat-vm.e2e.test.ts` (3), the other two "regressions" of
  the first comparison, are inherited too, each proved by running it in the
  repaired baseline worktree (`.colonie-dev/claude-account-baseline.log`,
  `.colonie-dev/openai-compat-baseline.log`). A full re-run of all 27 on this
  tree (`.colonie-dev/red-current-full.log`) was stopped on purpose: the first
  file, `server/delta-context.e2e.test.ts`, alone spent 21 minutes timing out its
  39 tests (every `session/new` against a native-only fake), and the fixed files
  already carry their own logs (`digest-fix5`, `acp-recovery-fix2`,
  `peer-allowlist-fix3`, `presets-fix1`, `duration-sequencer`).

`server/peer-allowlist.e2e.test.ts` (0→8 in the first comparison) is inherited as
well: its fixture still named the retired `claudeAgent` driver, so every bot
creation answered 400 and the cleanup ran on `undefined`. Migrated onto the
maintained ACP fixture it is green, 7/7. One roster-only test is deleted — an
ordinary bot's prompt is the ACP context contract now, and `peer-roster.test.ts`
still covers the builder — and the engine-side token assertion moved to the route
that mints the per-turn capability, because an ordinary bot mounts no internal
MCP server.

Fixed and green, in the same pass:

- `server/digest.e2e.test.ts` (3/3). Its fixture names the two maintained
  adapters (`claude-acp`, `codex-acp`) with each adapter's own approval modes, and
  it exposed a real product gap — the ACP turn path took no pre-turn workspace
  checkpoint, so `turnCheckpoints` stayed empty and the work digest never named
  changed files for any bot. `server/index.ts` now snapshots on the ACP path
  exactly as the other path does (pin = dispatch claim, release on a stale claim,
  explicit project folders only); the digest names `retry.ts`, proven by probe and
  by the test. After review the cross-engine half really crosses adapters
  (`gated` = claude-acp, `echo` = codex-acp) and the ACP path gained the other
  path's pre-dispatch claim guard, so a stopped turn launches no engine.
- `server/acp-recovery.e2e.test.ts` (2/2; red 2/2 in both trees before). The
  maintained runtime had dropped two things the retired ACP core did: the
  vendor's own diagnostic (from `error.data.details`, `data.message`,
  `data.error.message`) and the retirement of a poisoned child after a JSON-RPC
  internal error (-32603). A person now reads "Internal error: OpenCode service
  failure" instead of "Internal error", and the next explicit message resumes the
  recorded session on a fresh process — but only where the adapter advertises
  `loadSession` (Claude does, Codex's default is false), because retiring a child
  an adapter cannot re-load would end the conversation instead of continuing it.
  The fixture advertises `loadSession` the way the real Claude adapter does.

Aligned with the retired pages but not yet re-run: the Decision model Settings
section comes out (owner decision) and the phone-pairing "Remote access" page's
stale assertions are updated in `src/components/SettingsModal.simple.test.ts`,
`SettingsModal.groups.test.ts`, `SettingsModal.i18n.test.ts` and
`SettingsModal.appearance.test.ts`; retired section ids resolve to Appearance.
`WelcomeGate.test.ts` still seeds `appSettingsSection: "companion"`.

Not caused by this session and not fixed: `server/automatic-recovery.e2e.test.ts`
fails 7–8 of 11 tests either way (A/B twice in each direction,
`.colonie-dev/automatic-recovery-*.log`). Which "does not automatically replay"
case fails varies run to run on this 8-core machine, and its 409s come from the
ACP native-history rule, so the file is inherited red plus timing-flaky. Its
fixture is already ACP.

Migrating `peer-allowlist` and diagnosing the rest exposed four product gaps to
record (each is a rebuild decision, not a test tweak):

- **The ACP model catalogue is populated on demand, not at startup.** An ACP
  adapter can only report its models inside a session, so it exposes
  `refreshModels` — the route `POST /api/instances/:id/refresh-models` the model
  picker calls before it offers a choice (`AcpRuntime.discoverModels` opens a
  throwaway session). `server/index.ts` already runs a startup refresh loop over
  `instance.startupModelRefresh`, but no adapter sets that field, so the loop has
  nothing to do: until a picker refresh lands, a bot created by any other client
  with `requireAvailableModel: true` is refused every model id but the default.
- **The peer-comms "agents" MCP mount is behind a capability ACP never claims.**
  `agentsIntegration` (`server/index.ts:1682`) is mounted only when
  `commsDepth < MAX_COMMS_DEPTH && capabilities.agentsMcp === true`, and
  `AcpRuntime.capabilities` (`server/acp/acp-runtime.ts:204`) does not set
  `agentsMcp`. So the peer tool surface reaches only the retired native path: an
  ACP turn receives the connected-apps mount and `colonie_workspace` (the Chief,
  or a bot with assigned skills). The internal endpoints and their gate stay live
  and tested.
- **Named Claude accounts still create the retired `claudeAgent` kind**
  (`server/claude-accounts.ts` and the account routes), so anything the API or UI
  creates there is a shadow instance.
- **No ACP mid-turn seam.** No registered adapter implements `Adapter.steer` or
  `capabilities.queueing` (`server/acp/` has neither), so the aside lane
  (`server/index.ts:6603`, `12070-12113`) — a peer ask folded into a running turn —
  is unreachable on the shipped fleet, as is the steer path.
- **Tool evidence can never be `full` on ACP.** The only setter of
  `tool.fullResult` is the native hook ingest (`server/index.ts:4737`), so
  `server/digest.ts` reports `preview` even though the ACP runtime receives
  untruncated `tool_call_update` content.
- **The tool-result route has no live caller on ACP.** `POST /api/internal/tool-result`
  is called only by the agents MCP proxy, which is behind `capabilities.agentsMcp`
  (the gap above), so `server/tool-results.ts` (16k preview, 128k cap, TTL, paging)
  serves a route no ACP turn can reach. Either an ACP turn mounts a result-caching
  surface or the route and `tool-results.e2e.test.ts` are dead.
- **The launcher cannot hand a fixture a test capability.** `launchVerificationServer`
  forwards only `FAKE_ACP_*`, so `POST /api/testing/internal-capability` is
  unreachable from a launcher fixture and every e2e needing a bot-turn bearer
  spawns its own server (~40 duplicated lines × ≥6 files). A documented
  `testCapabilityKey` option removes the duplication; two queued files wait on it.
- **The ACP context does not name the mounted MCP servers.** `customMcpPrompt`
  (`server/system-prompt.ts:138`) is wired only into the retired native prompt
  builder, while the ACP agent learns them from `session/new` — probably intended
  (the protocol carries the truth) but an unrecorded difference.
- **`FAKE_CLAUDE_*` knobs are inert for launcher-based fixtures.** 49 files still
  name them; where the fixture is the ACP instance they are silently ignored, and
  two launcher-side producers still set `FAKE_CLAUDE_ROOM_PLAN`. A hazard for the
  rest of this queue, worth a sweep after it.
- **The ACP fleet is the launcher's configuration, not the packaged app's default.**
  Colonie's own launcher sets it (`scripts/colonie/start.ts:23`,
  `COLONIE_PROFILE: "1"`) and `server/config.ts:1611` then resolves
  `colonieInstances` (ACP only), while `DEFAULT_FLEET` (`server/config.ts:1626`)
  still seeds 17 retired engines. `electron/main.mjs` builds the server child env
  without setting the profile (it inherits `process.env`), so a packaged app
  started from Finder plausibly resolves the legacy fleet — 17 unavailable
  shadows and no live engine unless a saved config carries the ACP entries.
  Owner-level decision: set the profile in the packaged child env, or make
  `DEFAULT_FLEET` the two ACP engines. It is also why ~89 test files that never
  set the profile can fail on "instance unavailable"; the measured probe of how
  many of those a test-side profile default fixes is queued after the inventory.
- **`integrations.localComputer`** ("Works on: Local VM" / this computer) is built
  only on the retired native branch (`server/index.ts:7905`–`8015`, dispatched
  with the other `integrations` fields) — the ACP dispatch passes its mount pair
  instead and `server/acp/acp-runtime.ts` never reads `integrations`, so no ACP
  turn receives a Colonie computer mount.

Next in this task: the 23 inherited files are the migration queue, not
regressions. Each is either a retired subject (delete it and record the reason)
or live Colonie behaviour whose fixture still names a retired driver (port it
onto `server/testing/fake-acp-cli.ts`). One heavy job at a time: patches are
drafted read-only in parallel, then applied and run here one file at a time and
recorded. Still to measure after the queue: CI shards 2–4.

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
