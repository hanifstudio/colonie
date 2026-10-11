# Colonie progress

## Onboarding adaptation to Colonie (implemented, isolated fixture-verified)

- Owner asked to reuse the inherited OpenMausBot first-run UI for Colonie. The
  welcome flow was already mounted (`src/App.tsx`) but was still OpenMausBot
  shaped. Owner-decided scope: keep the feature reel as-is, keep Hello /
  Permissions / Meet your bot, make the phone beat "coming soon", frame the
  engines beat as Codex / Claude Code, and disable the guided tour + first
  conversation spotlights for now.
- Changes: `GuidedTour` and `FirstConversationTour` are no longer mounted; the
  welcome flow no longer opens a tour on finish
  (`src/components/onboarding/WelcomeGate.tsx`) and Settings drops its "Replay
  app tour" button (`src/components/SettingsModal.tsx`). The engines beat drops
  the organisation sign-in row, which Colonie does not have, and adds the
  provider-choice framing and "never installed either?" helper copy
  (`src/components/onboarding/beats/EnginesBeat.tsx`). The phone beat is a
  coming-soon note (`src/components/onboarding/beats/PhoneBeat.tsx`). Three new
  English keys were added; other locales fall back to English.
- Evidence (isolated, no live app/data):
  - `pnpm typecheck`, `pnpm exec oxlint --deny-warnings` on the touched files,
    and `pnpm i18n:check` (10 languages, 3706 English strings) all passed.
  - `pnpm exec vitest run src/components/onboarding src/lib/onboarding.test.ts
    src/lib/guided-tour.test.ts src/lib/first-conversation.test.ts
    src/lib/i18n.test.ts` — **100 passed across 10 files**; the two updated
    onboarding component tests pass. `SettingsModal` suite — **84 passed**.
  - `node --experimental-strip-types scripts/verify-onboarding-ui.ts
    <handle>` against a fresh `control-omb ui launch` fixture — **passed**. The
    real renderer/fake-engine recipe proves profile-save retry, reduced-motion
    reel, the engines beat's provider framing + inventory-refresh failure,
    the phone coming-soon beat, welcome completion with **no** guided tour,
    dismissed-after-reload, Settings replay (no app-tour button), and a
    skip-while-saving. Screenshots:
    `.omb-scratch/verify-evidence/onboarding/{welcome,reel,engines,meet-bot,complete}.png`.
- Not covered: the real Electron preload bridge, provider sign-in, and a real
  phone pairing (not part of this slice). The tour code is retained, not
  deleted, so re-enabling it is a small follow-up.

## Onboarding owner feedback round (implemented, isolated fixture-verified)

- Owner ran the rebuilt app and asked for five changes, all applied:
  1. Hello beat: name and email are required; "Maybe later" removed. The
     top-right "Skip tour" still leaves the whole flow.
  2. Feature reel: visible `OpenMausBot`/`Maus` strings changed to `Colonie`
     (Terminal command, terminal welcome/ready lines, browser tab title,
     mini-card title; Hands bot name and composer placeholder; Channels member
     name). Reel content is otherwise unchanged per the owner's earlier call.
  3. Phone beat removed from the flow entirely (component deleted; `beatsFor`
     updated; no `phone` BeatId).
  4. Meet your bot: a Bloub **body** picker added next to the color picker
     (patches `mascotBody`); the bot preview and the welcome-flow guide now use
     `followGlobalPointer`, so the eyes follow the pointer anywhere in the
     window (the agent confirmed the onboarding already renders the updated
     Bloub engine via `MausAvatar = BloubAvatar` — the missing part was the
     global-gaze flag, not the engine).
  5. `ProgressDots`: the active pill is vertically centered against the dots
     via `inset-y-0 my-auto` instead of `top-1/2 -translate-y-1/2`.
- Evidence (isolated, no live app/data): `pnpm typecheck`, `pnpm lint`,
  `pnpm i18n:check` (10 languages, 3708 English strings) clean.
  `pnpm exec vitest run src/components/onboarding src/lib/onboarding.test.ts
  src/lib/i18n.test.ts` — **84 passed**. The isolated recipe
  `scripts/verify-onboarding-ui.ts` passed end to end against a fresh
  `control-omb ui launch` fixture (no phone beat; name/email required), with
  refreshed screenshots. `pnpm colonie:package` rebuilt
  `release/colonie/mac-arm64/Colonie.app` and
  `node scripts/devone/package-check.ts` passed with isolated data.
- Brand-sweep evidence (isolated, no live app/data): `pnpm typecheck`,
  `pnpm lint`, `pnpm i18n:check` clean; the changed test files + locales ran
  **490 passed**.
- Owner follow-up: the global "Skip tour" is now disabled on the greeting
  (name/email) beat, so that step is truly mandatory; other beats keep it.
- Colonie brand sweep (owner: "replace OpenMausBot with Colonie wherever you
  find it"): 83 English i18n values and ~30 renderer files changed, plus the
  tests that asserted that copy; changed English keys were dropped from the
  non-English packs and `source-hashes.json` so `pnpm i18n:check` stays green
  (they fall back to English). Deliberately left unchanged because they are not
  user-facing copy and changing them would break things: GitHub repository
  URLs, the `openmausbot://` deep-link scheme, `OMB_*`/format/backup
  identifiers, `server/cli-*` text, and the server-side brand default (177
  server files still reference the historical name). The one English test that
  uses the deep-link scheme (`ChatMarkdown.renderers.test.ts`) keeps the
  original `OpenMausBot://` scheme case.
- Fresh-install seed fix (owner: "I want to feel what a user feels"):
  `electron/colonie-config.mjs` `initializeColonieData` used to write a new
  `config.json` with onboarding **already complete** and every `tour.*` hint
  filled in — a phase-1 choice that suppressed the inherited welcome flow, so
  no fresh install ever saw onboarding. It now seeds an empty record
  (`completedAt: ""`, `version: 0`, `hintsSeen: []`). Confirmed by wiping the
  data dir and relaunching the rebuilt app: `~/.colonie/config.json` shows the
  empty record and the welcome flow appears. `server/devone/branding.test.ts`
  passes (it only asserts an existing config is not overwritten).
- Second suppressor found while re-testing: `src/main.tsx` called
  `setEmailGateDone("skipped")` on every boot, so `welcomeDue`'s legacy-grace
  rule (`!completedAt && legacyDone`) made it return false even with an empty
  record. Removed the call (and its import); the gate now reflects real browser
  storage, so a fresh profile is a new user and sees the flow, while genuinely
  legacy installs keep the one-release grace. `pnpm typecheck`, `pnpm lint`, and
  the `lazy-screens` + onboarding suites pass (**71 passed**). Rebuilt and
  re-verified on a wiped data dir/profile.
- Known non-issue / open: `server/store.ts` `seedIfEmpty` still creates one
  starter bot ("Codex", purple, greeting "Hi! What would you like help with?")
  so the app is never empty; the welcome flow's "Meet your first bot" beat is
  meant to rename it. If the owner prefers no pre-made bot or a neutral name,
  that is a separate, small change.
- Not covered: real provider sign-in and the real Electron preload bridge, and
  the server-side brand default / protocol identifiers (left deliberately).

## Provider-agnostic assistant foundation (implemented, isolated fixture-verified)

- Owner approved a general behavioral foundation after an empty-SOUL Biscuit
  conversation volunteered connector sign-in during small talk. Runtime code
  changes are confined to `server/devone/context.ts`; concurrent UI/icon work
  was inspected and preserved.
- Factory identity v2 now supplies the agreed task-agnostic foundation: respond
  to intent, adapt to conversation/persona, progress on actionable requests,
  ground capability/result claims, and mention operational details when relevant.
  Removed the application/provider ownership explanation from model-facing text.
  Capabilities v3 uses shorter factual wording, distinguishes app-selected tools
  from possible native tools, and makes Composio connection guidance conditional
  on the requested task being blocked. Persona/SOUL, dispatch and persistence
  contracts are retained.
- Verification used Node 25.8.1 via
  `PATH="/opt/homebrew/opt/node@24/bin:$PATH"` (the local node@24 path currently
  resolves to that version):
  - `pnpm exec vitest run server/devone/context.e2e.test.ts
    server/devone/context-integrity.test.ts server/devone/application.e2e.test.ts
    server/devone/codex-acp.test.ts` — **23 passed across four files**. Canonical
    disposable SDK/HTTP fixtures cover both providers, context isolation,
    exact input, continuation/restart, plain baselines and integrity guards.
  - `pnpm typecheck` and
    `pnpm exec oxlint --deny-warnings server/devone/context.ts` — **passed**.
  - Disposable `colonie-foundation-check.ts` under the approved OpenCode temp
    directory — **passed**, using canonical `launchVerificationServer` and
    `runControlOmb` with explicit fixture URL. Two empty-SOUL bots (Claude/Codex)
    each received greeting, capability and email-draft requests. Six completed
    receipts prove v2/v3 context delivery, unchanged user messages, empty SOUL,
    stable native sessions/snapshots and exact fake-agent input.
    Evidence: `/var/folders/1n/rxzlp39527zgdbz2chq7p41h0000gn/T/openmausbot-verification-evidence/server-1791711062539-5457.log.foundation.json`.
- This is simulated-provider execution evidence, not proof of real-model answer
  quality. No live app/data/credentials, real-provider request, renderer/desktop
  check or package rebuild was involved. Existing conversations retain their
  pinned factory foundation; dynamic capability text updates per dispatch.
- **Desktop rebuild required:** `pnpm colonie:package`, then quit/reopen the
  rebuilt app and use **New conversation** for the new foundation. Packaging is
  pending while parallel application changes are active. Next: coordinate a
  combined rebuild/package smoke, then a bounded real-Claude behavioral check in
  a disposable workspace if requested. The source of the screenshot's six
  native/account connector claims remains unresolved.

## Bloub global gaze + tight camera for the active bot (implemented, unit-verified)

- Owner request: Bloub eyes should follow the pointer anywhere in the window
  (active bot only), and the mascot should render larger without touching
  engine internals.
- New foundation `src/components/bloub-gaze.ts`: pure `bloubLookForPointer`
  (per-axis linear gaze saturating at the hover-path maxima, 40 yaw / 25
  pitch, 320px soft radius), rAF-throttled `useGlobalBloubGaze` hook
  (mouse/pen only, touch ignored, rests on blur/mouseleave/unmount/disable,
  honours `prefers-reduced-motion`), and camera helpers (`bloubViewHalf`:
  tight ±120 at rest, full ±158 while decor arcs are visibly drawn).
- Measured, not guessed: `bloub-frame-fit.test.ts` sweeps all app-reachable
  states × shapes × expressions × look extremes — arc-free frames peak at
  ~105 units (fits tight), visible decor reaches ~155 (needs full, never
  exceeds it). Future upstream geometry drift fails loudly instead of
  silently cropping.
- `Avatar.tsx`: opt-in `followGlobalPointer` (requires `trackPointer` +
  `animated`). `BloubAvatar.tsx` wires the hook (replaces, not stacks,
  local hover handlers) and derives the SVG viewBox per sampled frame, so
  orbit/comet transitions keep their rings. `Sidebar.tsx`: only the selected
  row stays live + follows globally (one bounded rAF loop); idle rows remain
  static. `ChatView.tsx` `EmptyChat` hero follows globally.
  `public/colonie.svg`: viewBox tightened (static idle frame, arc-free).
- Out of scope: CallView (still hover-tracked); PNG/icns icon regen from the
  tightened SVG (needs playwright/sips run).
- Coordination note: parallel HugeIcons work reverted parts of this slice
  mid-flight (restored from stash, then re-applied after that session's
  CLEAR); no open conflict remains.
- Evidence (isolated, no live app/data): `pnpm typecheck` clean;
  `oxlint --deny-warnings` on all touched files clean; vitest on
  bloub-gaze/frame-fit/BloubAvatar/Avatar (22 passed) and
  SidebarBotListItem/simple-mode (56 passed). No renderer, desktop,
  real-provider, or rebuild check was run for this slice.

## Bloub gaze direction fix + body palette contrast (implemented, unit-verified)

- Owner-reported bug: Bloub's pointer gaze was vertically inverted — a pointer
  below the avatar made it look up. Horizontal (yaw) was correct.
- Root cause: screen y grows downward, but the pinned engine reads a POSITIVE
  pitch as "look up" (`third_party/bloub/src/bot/face.ts`: forward tips toward
  up). The pointer→pitch mapping did not negate, so both the global gaze
  (`bloub-gaze.ts` `bloubLookForPointer`) and the local hover path
  (`BloubAvatar.tsx`) looked the wrong way. Both now negate pitch; `-0` is
  normalised to `0` so the resting value compares cleanly.
- `bloub-gaze.test.ts` documented the inverted behaviour; it now asserts the
  gaze follows the pointer (up-right -> positive pitch, down-left -> negative).
- Owner-reported concern: the body palette was too pastel and low-contrast
  against the light `#fcfaff` eyes. `BloubAvatar.tsx` `COLORS` was deepened and
  saturated: every tone now holds >= 3:1 against the eyes (WCAG non-text
  minimum; the old set sat at 1.6-3.5:1). The static app-icon ink in
  `scripts/colonie/icons.ts` was moved to the matching deep purple.
- Evidence (isolated, no live app/data): `pnpm typecheck`, `pnpm lint`,
  `git diff --check` clean; `pnpm exec vitest run` on `Avatar.test.ts`,
  `BloubAvatar.test.ts`, `bloub-gaze.test.ts`, `bloub-frame-fit.test.ts` and
  `server/devone/branding.test.ts` — 23 passed.
- Rebuild: `pnpm colonie:package` passed under Node 25.8.1; artifact
  `release/colonie/mac-arm64/Colonie.app` rebuilt with the deep palette in the
  production bundle. Packaged smoke `node scripts/devone/package-check.ts`
  passed with an isolated temp data dir, simulated provider (`real: false`)
  and zero renderer errors.

## HugeIcons migration — all remaining surfaces (implemented, packaged)

- Owner request: extend the HugeIcons migration to every area still on
  Lucide, via the shared `src/components/HIcon.tsx` wrapper. All 164
  remaining `lucide-react` import sites were migrated across seven parallel
  batches plus lead follow-ups; only `SidebarBotActivity.tsx` needed a shape
  change (`attentionRowStatus` now returns icon data instead of a component).
  Co-located tests asserting `lucide-*` classes were updated to HugeIcons
  path-data markers.
- Process note: a concurrent session (Herdr pane `bloub-fixes`, Bloub gaze
  feature) was active in the same tree mid-migration; parallel git operations
  reverted ~70 files both ways. All icon work was recovered and re-verified;
  the other session's `Avatar.tsx`/`BloubAvatar.tsx` changes were restored
  from the leftover stash, and a mutual pause on tracked-file git operations
  was agreed and cleared through Herdr. Two unused imports in their
  `BloubAvatar.test.ts` were removed to keep the lint gate green; their
  gaze/camera tests now pass.
- Two client tests that still asserted the pre-rename product name while the
  copy now renders `brand().name` ("Colonie") were updated:
  `SettingsModal.updates.test.ts` and `OrganisationRow.test.ts`. Tests whose
  source strings are literally still "OpenMausBot" (server brand default,
  Cloud/backup copy, PairPage) were left unchanged and still pass.
- Evidence (isolated, no live app/data): `pnpm typecheck`, `pnpm lint`,
  `pnpm i18n:check`, `git diff --check` clean. Full unit suite: 13006 passed,
  16 failed — the failures are pre-existing environment issues (the client
  environment cannot bundle `node:sqlite`, the Node-24 launcher guard, a
  fake-engine `pi` engine listing, and four 20s timeouts) plus the two
  rename assertions fixed above; none were icon-caused. Targeted re-runs of
  the affected files pass, including the three Bloub gaze tests (20 tests).
- Rebuild: `pnpm colonie:package` passed under Node 25.8.1; artifact
  `release/colonie/mac-arm64/Colonie.app` rebuilt with HugeIcons paths in the
  production bundle. Packaged smoke `node scripts/devone/package-check.ts`
  passed with an isolated temp data dir, simulated provider (`real: false`)
  and zero renderer errors (`.devone/evidence/packaged-fixture-check.json`).
  No real-provider check was run for this slice.

## Profile menu — phone disabled, help/feedback removed (implemented, unit-verified)

- Owner request: keep Connect your phone and Get the phone app visible but
  disabled, and remove Help Center and Send Feedback from the profile menu.
- `src/components/SidebarProfileMenu.tsx`: `phoneMenuItems` now marks every
  phone entry `disabled: true`; the `help`/`feedback` items are removed
  (Settings, Keyboard shortcuts, Check for updates and About remain).
- Evidence (isolated, no live app/data): profile/popover suites passed;
  `pnpm typecheck` and `pnpm lint` clean; disposable check proved all phone
  items disabled and no `help`/`feedback` keys in the menu source.

## Sidebar plus-menu — only New Bot enabled (implemented, unit-verified)

- Owner request: in the sidebar header plus-menu, disable New group chat,
  Create team and Templates; New Bot stays enabled.
- `src/components/Sidebar.tsx`: the three entries now render `disabled`.
  The archived-bots entry is unchanged.
- Evidence (isolated, no live app/data): header-menu suites passed; a
  disposable render check proved New Bot enabled while the other three are
  disabled.

## HugeIcons migration — composer bar (implemented, packaged)

- Owner request: migrate icons to HugeIcons, starting with the composer bar.
  Swap-only: layout and behaviour unchanged.
- Installed `@hugeicons/react` plus `@hugeicons/core-free-icons` (Stroke
  Rounded, MIT). New `src/components/HIcon.tsx` wrapper mirrors the Lucide
  call-site shape with `src/components/HIcon.test.ts` covering it.
- Swapped in `Composer.tsx`, `ApprovalModeSelector.tsx`,
  `PlaceIcon.tsx`/`PlaceChip.tsx`, `CallView.tsx`, `ComposerAttachments.tsx`
  and `ComposerQueuedMessages.tsx`.
- Evidence: unit suites passed; `pnpm colonie:package` passed under Node
  25.8.1 and the packaged smoke passed with zero renderer errors
  (`.devone/evidence/packaged-fixture-check.json` at that time).

## HugeIcons migration — profile menu and Settings (implemented, unit-verified)

- Same swap for the profile menu and the Settings modal, plus
  `cursor-pointer` on each menu row.
- `SidebarProfileMenu.tsx` (phone, settings, shortcuts, about, update
  states), `SidebarFooterNav.tsx` (Apps puzzle), `SettingsModal.tsx` (all
  rail icons, search, close) and `AboutMeSettings.tsx` (About me help).
  `cursor-pointer` on popover rows and both Settings rail variants.
- Evidence (isolated): static gates clean; profile/footer/popover suites —
  83 passed; disposable check proved SVG rendering and cursor-pointer.

## Current state

M0–M6 are implemented and verified: the built product is **Colonie**, with
Bloub-based artwork and both Codex/Claude ACP core workflows. Existing fork
data/profile/session paths are preserved in place. Current artifact:
`release/colonie/mac-arm64/Colonie.app`; run guide: `docs/COLONIE.md`.
M7-A native controls are also implemented and verified with both provider fixtures
and real Claude. The real Codex request for this slice hit the account usage limit.
M7-B scoped app awareness/persona/SOUL is implemented and enabled by default.
Normal bot-profile editing is sufficient; ACP inspection is separately opt-in
for developers. Both-provider
fixtures and bounded packaged real Claude passed; real Codex remains quota-blocked.
M8 Composio and Custom MCP are implemented and verified for scoped app/bot tools.
Credential source/origin UI and encrypted save/remove persistence now pass targeted
synthetic checks on this machine. Memory, Chief delegation and
automation remain subsequent milestones.
Bot-level multiple conversations are now available in the default interface and
verified with both-provider HTTP and production packaged desktop SDK fixtures.
ACP is the app's only execution path — a fixed property, not a mode: the puzzle
entry opens the Apps panel directly. Colonie also keeps its own state separate
from the user's plain CLI: the ACP engines run with a per-engine config dir under
`~/.colonie/native/...` (M8-D), and the app shows whether each engine is signed in
and signs in through the engine's own flow (M8-E). This file describes observed
results, not intended success.

## Roadmap update — marketplace consolidation and deferred legacy retirement

- Owner approved separating immediate navigation/marketplace/UX consolidation from
  full source retirement. Added M8-C and deferred architecture milestone D1 to
  `PLAN.md`, with boundaries and acceptance criteria recorded in `SPEC.md`.
- M8-C reuses the upstream marketplace, stabilizes the puzzle destination and
  removes dual-product presentation. Lead ownership: entry/marketplace, integration
  and verification. Frontend-only cleanup may be delegated through Herdr/OpenCode
  with Muse 1.3 Free when available; require a full bounded plan, disjoint files,
  one-pass report and lead review. No pane/agent has been started for this update.
- D1 explicitly covers frontend/backend legacy logic, provider registrations,
  dispatch/routes, startup/package dependencies and ownership extraction, preceded
  by dependency/data-compatibility audit. Preserve shared infrastructure and approved
  future-feature source. Schedule after M8-C based on the audit; full deletion is
  deferred, not folded into the free-model UX task.
- Documentation-only update. Verification: cross-document scope/order review and
  `git diff --check`; no runtime workflow or implementation pass is claimed.

## M8-C — puzzle entry and ACP-only identity (implemented, client)

- Decision: ACP is the only execution path the app works through, not a mode and
  not something inferred from the provider/driver list. No `mode`/`ACP_ONLY`
  style switch is introduced; a single-flag design was rejected as implying ACP
  is optional.
- `SidebarAppsButton` now always opens the Apps panel (`togglePlugins`). The
  earlier branch that sent an ACP fleet to Settings → connections is removed; the
  button keeps its `nav-apps` guided-tour anchor and "Apps" label.
- Updated `src/components/SidebarFooterNav.test.ts`: the Apps button opens the
  Apps panel for simple, advanced and ACP-engine states; the ACP case asserts no
  automation rows, not a "Connected tools" label.
- Apps-panel content adapted to the Colonie boundary: `PluginsPanel` keeps the
  shared Composio catalog (the same `/api/connectors/catalog` list and logos) plus
  the Custom MCP section, and drops the ready-to-use Whop card, its search/filter
  branch, its connect flow and the whop refresh wiring. Composio is the only
  built-in integration; other services are Custom MCP.
- One connect surface: Settings → connections is now the Composio project-key
  entry only (masked identity, source/origin, replace/remove, and a button to open
  the Apps panel). The duplicate catalog and Custom MCP list were removed from
  Settings; app accounts and Custom MCP live in the Apps panel. `hideWhop` is set
  on both `McpServersPanel` uses.
- Updated the isolated verification helpers for the new navigation
  (`scripts/colonie/connected-tools-ui.ts`, `credential-ui-check.ts`): the key is
  reached through the profile menu → Settings, the catalog through the Apps panel.
- Deliberately deferred (owner chose "leave for now"): the remaining
  `instances.every(isColonieAcpDriver)` hiding in `SidebarFooterNav` and
  `SettingsModal`, plus the legacy Routines/Triggers/Team menu and legacy Settings
  sections. They stay hidden, remain dead code, and are cleaned with D1.
- Evidence: `pnpm lint` and `pnpm typecheck` clean;
  `pnpm vitest run src/components/SidebarFooterNav.test.ts
  src/components/PluginsPanel.navigation.test.ts
  src/components/McpServersPanel.embedded.test.ts` — 35 passed.
  `node scripts/colonie/credential-ui-check.ts` and
  `node scripts/colonie/connected-tools-web-check.ts` both passed against the
  isolated fixture (simulated Composio, renderer, no real providers/model turns).

## M8-D — Colonie CLI state isolation (implemented)

- Decision: Colonie always runs the ACP engines with their own config directory
  under the app data dir, so its sessions/sign-in/history never mix into the
  user's own `~/.codex`/`~/.claude`. This is how the app runs — not a mode and not
  a toggle. The user signs in once inside Colonie (accepted).
- `server/devone/profile.ts`: `devoneInstances(configured, nativeBase)` injects
  `CODEX_HOME` (codex-acp) and `CLAUDE_CONFIG_DIR` (claude-acp) into every ACP
  instance environment, pointing at `native/<codex|claude>`; app-set values win so
  separation is guaranteed regardless of stored config.
- `server/config.ts`: `instanceConfigs` passes `NATIVE_DIR`; `ensureDirs` creates
  `native/codex` and `native/claude` at boot.
- Limit stated, not hidden: account/service-level facts (e.g. usage counting)
  cannot be separated from the account.
- Evidence: `server/devone/profile.test.ts` asserts the injection and that `HOME`
  is not overridden; new `server/devone/isolation.e2e.test.ts` boots the isolated
  fixture and proves both engines spawn with the config dir under the app data
  dir (`native/codex`, `native/claude`) — 2 passed. `pnpm lint` and
  `pnpm typecheck` clean. `server/devone/` suite: 274 passed; the single
  `start.e2e.test.ts` failure is the pre-existing Node-22-vs-24 launcher guard,
  not this change.

## M8-E — ACP connection status and in-app sign-in (implemented)

- The UI could not tell whether a Claude/Codex ACP engine was signed in, and
  offered no sign-in. With M8-D isolating the config dir this became a hard stop:
  a fresh engine is signed out with no way to log in.
- Research finding (direct probe of the two installed adapters, on this machine):
  **Claude can be isolated** — `CLAUDE_CONFIG_DIR` to an empty dir makes the
  adapter report signed out and `claude auth status` says `loggedIn: false`. Both
  `claude-agent-acp` and `codex-acp` announce the account over a `_meta` push
  `_auth/status_update` (`{ authStatus: { kind } }`, `kind: "none"` = signed out).
  The earlier probe, which relied on `session/new` throwing `auth_required`, was
  right for Codex but wrong for Claude, which never gates session creation on
  auth — that is the bug that made Claude look connected while turns failed.
- `AcpRuntime.authStatus()` now reads that push (via a params-parser notification
  handler), falling back to `session/new` only for agents that do not announce
  auth. Cached ~5 minutes; `snapshot.authenticated` drives the existing
  `needsSignIn` card. Never reads stored credentials.
- Sign-in is the engine's own CLI in a Terminal, the same for Codex and Claude:
  `POST /api/instances/:id/acp-auth` returns `{ terminal: { command } }` and
  `AcpSignIn` runs it via the `engine:sign-in-terminal` IPC. The main process
  builds `<CODEX_HOME|CLAUDE_CONFIG_DIR>="<data>/native/<engine>" <cli login>` from
  the app's own data dir (renderer text never becomes a process argument) and
  launches it through `openTerminalWithCommand`. The adapters' in-app
  `authenticate` browser path was dropped for consistency and predictability.
  Login lands in the isolated config dir (M8-D); a signed-out engine re-probes
  within ~5s, so the badge updates soon after the login finishes.
- Model list before the first message: ACP engines report their models only inside
  a session, so the picker used to show just the agent default until the first
  turn. `AcpRuntime.discoverModels()` opens one throwaway session on demand, wired
  to the provider's `refreshModels`; the picker calls it when it shows a signed-in
  ACP engine, so the full list appears without sending a message.
- Bot creation: when no engine can run yet, `/api/bot-defaults` returns an empty
  selection; the New Bot dialog now shows "Sign in to a model provider…" and
  disables Create (plus a link to model settings), instead of submitting an empty
  model and failing server validation.
- Evidence: `server/devone/auth.e2e.test.ts` (fixture `devone-unauth`: engines
  spawn signed out via the push, `/api/bot-defaults` is empty, the endpoint signs
  in, and the snapshot flips to signed-in) and `server/devone/isolation.e2e.test.ts`
  pass; `server/devone/application.e2e.test.ts` still passes. `pnpm lint`,
  `pnpm typecheck` clean; client component tests for NewBotDialog/EngineSetup pass.
  `pnpm colonie:test`: 49 passed; the one `start.e2e.test.ts` failure is the
  pre-existing Node-22-vs-24 launcher guard.
- Not verified here: a real provider browser sign-in for Codex and a real Claude
  terminal sign-in (both need completing login), and the desktop renderer card.

## Composio credential provenance / Clear / storage — implemented and verified

- Owner reported that Configured/Clear and working OAuth contradict an apparently
  empty key field. Authorized read-only live metadata diagnosis, then isolated
  implementation/testing; no live configuration mutations are permitted.
- Read-only `/api/health` and `/api/config` on the identified Colonie listener:
  HTTP 200, Composio `configured: true`, `mode: self-hosted`. This establishes an
  effective project key, not a managed broker. The old API cannot distinguish its
  environment/secure-store/config provenance. No credential content was read.
- Code audit found boot Composio migration mutates the in-memory credential before
  encrypted persistence succeeds. A failed migration can therefore inject a key
  into the runtime even though it was not committed to secure storage. This is a
  confirmed code flaw, not proof of this live key's exact origin.
- Next: transactional migration, explicit owner-only masked credential provenance,
  operation-specific save/remove errors and source-aware removal; investigate
  synthetic safeStorage roundtrips in an isolated packaged fixture. Use targeted
  tests and a scoped renderer/storage smoke, not a full provider regression run.
- Added owner/admin-only read-only metadata at `/api/colonie/composio/credential`:
  available, masked key, source, origin, storage condition, removability and an opaque
  revision. Full key values are never returned. Normal UI separates key availability,
  service readiness and app-account connection state. No key means setup only;
  environment-source removal is hidden and refused server-side. Existing/imported
  keys show their origin rather than implying the person entered them in Colonie.
- Save and Remove have distinct failures. Only real storage/encryption failures get
  a Keychain explanation; IPC provider/HTTP failures retain their actual reason.
  Failed mutations keep the previous masked/source state; successful removal hides
  the catalog. Source changes cancel old catalog/auth requests and reload the view.
- Migration now derives copies and commits memory after encrypted persistence.
  Last empty-document removal requires no encryption. Rejected server commits
  restore original encrypted bytes without re-encryption; unreadable documents are
  protected and unrelated credential/identity fields are retained. Configuration-only
  removal does not rewrite an unrelated encrypted document. Removing a stored
  override exposes an existing runtime-environment key honestly, rather than
  claiming all access disappeared.
- Synthetic crypto diagnosis:
  `node scripts/colonie/credential-crypto-probe.ts` failed encryption with temporary
  HOME. `node scripts/colonie/credential-crypto-probe.ts --system-keychain` passed
  async/sync roundtrips on the unsigned Colonie artifact with accessible OS Keychain,
  isolated data/profile and unchanged Colonie crypto name. A fresh-name variant
  also passed. The earlier assertion that unsigned status itself caused the failure
  was not established and is corrected here. No existing app credential was read.
- Targeted checks, Node 24.13.1:
  - `node --test electron/credential-persistence.test.mjs` — **3 passed** for
    transactional migration, last-document removal/rollback and unreadable/other-key
    protection. An initial command used the Node runner for two existing Vitest
    files; rerunning them with their intended runner passed.
  - `pnpm exec vitest run electron/secure-credential-state.test.mjs
    electron/secure-credentials.test.mjs` — **17 passed**.
  - `pnpm exec vitest run server/colonie/connections/credential-status.test.ts
    src/components/ApiKeys.test.ts` — **10 passed**; source/masking and failure reasons.
  - Final origin follow-up with the status and two Electron files — **19 passed**.
  - `node scripts/colonie/credential-ui-check.ts` — **passed** actual React UI with
    loopback Composio and synthetic keys: empty/setup, masked saved/config source,
    failed removal, real rejected-key reason, removal/catalog disappearance, and
    immutable environment-source removal. Evidence: `.devone/evidence/credential-ui-check.json`.
  - `pnpm colonie:package` — **passed**, including TypeScript and production renderer/
    server build; final artifact rebuilt with origin metadata.
  - `node scripts/colonie/credential-desktop-check.ts` and `--migration` — **passed**
    on the production unsigned app with isolated app data/profile and inherited HOME
    solely for OS Keychain access. Verified encrypted save (no plaintext key in
    config), correct source/origin, persistence after full app restart, removal,
    preservation of `companionClientInstanceId` and continued absence after another
    restart. Initial recipe issues were corrected: an identity field meant the
    document was not actually empty after key removal, and Electron evaluation
    needed encrypted bytes passed in rather than dynamic fs import. The final checks
    assert key removal and preservation of unrelated fields, not blanket file deletion.
- Evidence: `.devone/evidence/credential-desktop-check.json`,
  `credential-desktop-migration-check.json`, crypto probe JSON and credential UI
  screenshots. All provider/account traffic is loopback simulated, with **zero model
  turns and zero real-provider requests** in this follow-up. Full/provider regression
  suites were not repeated. Historical failed storage evidence is retained and marked
  superseded by these bounded results; arbitrary locked/corrupt/device recovery is
  not claimed.
- The live app was only queried for health and boolean mode metadata; its data was
  not changed. Exact historical live-key provenance remains unavailable from its
  old API. Quit/reopen the rebuilt Colonie artifact to see the new Source/Origin
  and masked identity on that installation. The key supplied in chat was never
  installed into that live data by these verification recipes.
- Final artifact includes persisted origin markers for user entry versus workspace
  migration; both packaged variants passed against that artifact. Inspected the
  imported-key screenshot, with masked identity, Saved on this device and Imported
  from existing workspace settings shown independently. Final lint, locale check,
  TypeScript/package build and `git diff --check` passed. No commit was requested.

## M8 — Composio and Custom MCP (implemented; secure-store blocker retained)

- Owner selected Composio and supplied a project key. A bounded authenticated
  GET to the official auth-config endpoint returned HTTP 200; output retained only
  status/count, never the credential or config contents. The key is not stored in
  source or evidence. Current Composio session/MCP documentation was reviewed.
- Audited upstream credential/account/session helpers and legacy connector proxy.
  The latter depends on old turn-capability/card-continuation infrastructure and
  will not be mounted implicitly. Both pinned maintained ACP adapters advertise
  HTTP MCP; Claude also advertises SSE, while Codex rejects SSE.
- Recorded scoped M8 contract in SPEC/PLAN. Next: independent Composio policy/session
  manager and loopback relay, official-SDK HTTP MCP mounting and lifecycle, normal
  app/bot settings UI, isolated fixture and bounded real-provider evidence. Include
  the reported small sidebar +/actions spacing adjustment in this milestone.
- Owner paused implementation to clarify scope, then approved continuing end to
  end: only Composio is ready-to-use; other services use Custom MCP. The common
  mount contract/registry precedes provider-specific Composio setup. Existing
  command/remote/OAuth registry infrastructure is reused, without vendor presets.
- Implemented provider-neutral `AcpToolMount` and the new modules under
  `server/colonie/connections/`: per-bot policy, Composio session client, lifecycle/
  relay manager, policy routes, and result-status inspection. Custom servers reuse
  the existing command/URL/header/env/OAuth registry and organization filtering.
  Both official adapters receive app-selected MCP servers on session new/load;
  transport capability is checked explicitly. Tool selection/configuration changes
  restart/load the same native session, never silently reset its history.
- Composio mounts use an ephemeral loopback bearer, not a project key. Each
  conversation's Composio session keeps the workspace user and selected toolkit
  scope; local enforcement rejects unauthorized target apps and sandbox helpers.
  Idle discovery is allowed but tool execution requires an active turn. Stop
  cancels in-flight relay calls. Missing remote sessions are recreated only on
  404/410 with the same scope/user. Network/auth failures never widen access.
- Added non-secret mount and Composio call/target/status metadata to exact receipts.
  Nested multi-execute target failure is distinguished from a successful outer
  transport envelope. Prompt capabilities describe only app-selected tools; native
  provider/project context and tools remain provider-owned.
- Added normal app setup (Composio plus Custom MCP), registry import/Test/enable,
  and a Connected apps and tools card in Simple/Advanced bot profiles. Access is
  explicit per bot. OAuth/account linking reuses the existing server flow; after
  signing in, the person refreshes connections and sends a follow-up. Automatic
  legacy card continuation was not reconnected. Simple sidebar +/actions spacing
  was corrected by removing the unused folder-button slot.
- Initial HTTP recipe failure was a fixture assumption: registry POST/import saves
  new servers off even when incoming JSON says enabled. The fixture now uses the
  explicit enable PATCH, matching actual UI. Both-provider HTTP/MCP flow passed.
- Node 24.13.1 focused regression:
  `pnpm exec vitest run server/devone/ server/colonie/ server/mcp-registry.test.ts
  server/mcp-http.test.ts server/mcp-oauth.test.ts server/config.test.ts
  server/store.test.ts scripts/control-omb.test.ts src/components/SidebarFooterNav.test.ts
  src/components/McpServersPanel.test.ts src/components/McpServersPanel.embedded.test.ts
  src/components/BotSettingsDialog.simple.test.ts src/components/Sidebar.simple-mode.test.ts
  src/state/store.test.ts` — **686 tests passed across 24 files**.
- Later lifecycle/receipt checks:
  `pnpm exec vitest run server/colonie/ server/devone/native-settings.test.ts
  server/devone/codex-acp.test.ts src/components/McpServersPanel.test.ts
  src/components/McpServersPanel.embedded.test.ts src/components/SidebarFooterNav.test.ts`
  — **55 passed across seven files**, including idle discovery/no idle execution,
  bearer revocation, key redaction, Composio missing-session recovery, native
  continuity, Stop statuses, Claude SSE and Codex SSE refusal/recovery.
- `COMPOSIO_API_KEY=<explicit supplied key> node scripts/colonie/composio-api-check.ts`
  — **passed** against the real service using a newly generated disposable user.
  Discovered tools and executed the public `HACKERNEWS_GET_TOP_STORIES` read;
  retained only shapes/success/public-ID presence and deleted the created session.
  Evidence: `.devone/evidence/composio-api-check.json`.
- `pnpm colonie:package` passed and rebuilt the arm64 artifact. The initial
  packaged key-entry attempt **failed** in the disposable macOS home/profile:
  `safeStorage.encryptStringAsync` could not encrypt the value. This is an
  unresolved unsigned desktop secure-store check, not reported as passed and not
  replaced with an automatic plaintext fallback. Normal error copy now explains
  that the key was not saved. Package fixtures use explicit runtime credentials;
  the separate web renderer exercises its supported private-config save path.
- `node scripts/colonie/connected-tools-web-check.ts` — **passed** synthetic
  credential save, write-only public config, custom import/Test/enable, profile
  access selection and a Composio fixture execution through actual React UI.
  Evidence: `.devone/evidence/connected-tools-web-check.json` and screenshots.
- `node scripts/devone/package-check.ts --claude --connected-tools` and the same
  command without `--claude` — **passed** actual production renderer/server/Electron
  with Composio/SDK fixtures. Both select Composio and a local Custom MCP through
  the normal UI, execute Allow, refuse Deny, and preserve native session/tool policy
  after app restart. An initial Test-result locator incorrectly required an exact
  standalone tool name; it was fixed to match the actual combined result text.
  Evidence: `.devone/evidence/{claude-,}packaged-fixture-connected-tools-check.json`.
- `COMPOSIO_API_KEY=<explicit supplied key> node scripts/devone/package-check.ts
  --real --claude --connected-tools` — **passed** inherited native CLI auth,
  disposable workspace/user, Composio search plus public Hacker News read via
  the Colonie relay, and marker recall after a full app restart. Receipts prove
  actual completed calls/targets; this is not merely an assistant success claim.
  Evidence: `.devone/evidence/claude-packaged-real-connected-tools-check.json`.
  Key values are absent from prompt/receipt/evidence. No real Codex request was made.
- Typecheck, lint and locale check passed. Inspected app/profile screenshots and
  real receipts. Final nested-outcome check, package rebuild, fixture smoke and
  documentation update are next. Full upstream suite was not run. The macOS
  secure-store write and real Codex quota remain separate unresolved blockers.
- Final guard follow-ups preserve organization filtering, forbid Composio credential
  redirects, block policy mutation during active turns/discovery at the write
  boundary, allow idle catalog discovery while denying idle execution, recover
  only missing remote sessions with unchanged scope, and synchronously mark
  cancelled relay calls. The later seven-file **55-test** run passed these checks.
  `pnpm exec vitest run server/colonie/connections/outcome.test.ts
  src/components/ApiKeys.test.ts` — **9 passed** for partial target failures and
  existing key-row behavior. Selected missing/disabled connections remain visible
  and removable in bot profiles instead of trapping the person in a stale policy.
- Rebuilt with `pnpm colonie:package`, then both packaged connected-tools fixtures
  passed against the revised runtime. The bounded real-Claude package recipe also
  passed again, verifying actual completed Composio calls after the final outcome/
  lifecycle changes; no private connected accounts were used. A final cosmetic
  simplification removed the unsupported second-account shortcut; final rebuild
  and `node scripts/devone/package-check.ts --claude --connected-tools` passed
  afterward. No additional real request was made for that UI-only adjustment.
- The supplied project key is absent from source/docs and evidence (a file-name-only
  exact-match check passed). No key was hardcoded, committed or copied into native
  agent configuration. The secure-store failure is preserved explicitly in
  `.devone/evidence/composio-secure-store-blocker.json`; passing runtime-backed
  package results are not used to overwrite that evidence boundary.
- M8's connection/execution scope is complete: Composio only as ready-to-use,
  generic Custom MCP, per-bot access, normal UI, recorded exact inputs/calls, and
  continuity/cancellation. Artifact: `release/colonie/mac-arm64/Colonie.app`.
  The next concrete priority is the unsigned macOS credential-store persistence
  blocker before claiming a fully verified packaged key-entry workflow. M9 remains
  the next feature milestone. Native Codex real-tool evidence waits for quota.
- Session closed after final package smoke and documentation alignment. Final
  `pnpm lint` and `git diff --check` passed; required build TypeScript and the locale
  check also passed. No commit was requested or created.

## Bot-level conversations — implemented and fixture-verified

- User approved making multiple conversations per bot available in the default
  UI before M8. Audited upstream tasks, sidebar display preferences and switcher,
  ACP per-thread sessions/context pins and concurrency (default three active turns
  per bot). Simple mode currently hides the tree and creation; ChatView does not
  mount the existing full switcher.
- Next: expose normal Conversations/New conversation navigation, preserve advanced
  folder controls, then verify same-bot parallel sessions, scoped permissions/Stop
  and restart with both-provider isolated HTTP/desktop/package fixtures.
- Added an always-available Conversations/New conversation bar for ACP chat, active
  title, searchable history picker, status indicators and recent text previews.
  Sidebar display choice now applies independently of Simple/Advanced mode;
  folder creation remains Advanced-only. Hidden tree and closed/narrow sidebar
  do not hide the chat controls. Legacy untitled records display as New conversation
  without rewriting their saved titles. Clicking a bot retains its last selection.
- Previews read at most ten recent rows and normalize/cap display text at 180
  characters. They are derived wire data, not saved profile/model context; tool and
  digest rows are skipped. The ACP runtime/session/pinning boundary is reused.
- `pnpm exec vitest run server/devone/conversations.e2e.test.ts
  src/lib/thread-preferences.test.ts src/components/TaskPicker.test.ts` —
  **28 passed**, including both-provider same-bot concurrent permissions,
  wrong-thread answers, independent Stop, transcripts/profile versions and full
  server restart with two distinct native sessions.
- Initial renderer regressions exposed stale test assumptions (Simple thread
  gating, old pixel-suffixed avatar dimensions and direct-hook fixtures). Row
  presentation now takes an explicit conversations prop; tests preserve legacy
  presentation and verify the new Simple behavior. The eight-file UI set then
  passed **181 tests**. A later broader run caught the missing profile-helper
  import in the new preview projection and old OpenMausBot updater-label
  expectations; corrected both and reran instead of counting failed runs as passes.
- Final focused regression command:
  `pnpm exec vitest run server/devone/ src/state/store.test.ts
  src/lib/thread-preferences.test.ts src/components/TaskPicker.test.ts
  src/components/Sidebar*.test.ts src/components/BotThreads.test.ts
  src/components/ChatView.controls.test.ts src/components/ChatView.follow.test.ts`
  — **552 tests passed across 38 files**. Storage/capacity follow-up:
  `pnpm exec vitest run server/store.test.ts server/thread-capacity-api.test.ts`
  — **146 passed**. Full upstream suite not run.
- Packaged UI recipe initially caught the old absolute inspector button colliding
  with the conversation bar. Moved the opt-in inspector into the chat header.
  Two recipe issues were also corrected: Electron's unset viewport size needed
  explicit restoration after a narrow check; multi-receipt inspection must target
  visible blocks rather than a collapsed older receipt. Screenshots now finish
  finite menu animations before capture.
- `pnpm colonie:package` passed with TypeScript, renderer/server builds and staged
  native adapters; inherited CSS optimizer/chunk notices were nonfatal.
  `node scripts/devone/package-check.ts --claude --conversations` and the same
  command without `--claude` **passed** through the production packaged app and
  SDK fixtures. The normal Simple UI creates/switches conversations, displays
  parallel approval/working and background Unread, routes Allow/Deny/Stop, retains
  both native sessions/profiles after quit/reopen, and works with hidden trees and
  at 600px. API patches only give fixture conversations unambiguous titles.
  Evidence: `.devone/evidence/{claude-,}packaged-fixture-conversations-check.json`
  and default-navigation/parallel-approvals/parallel-working/narrow screenshots.
- Inspected screenshots and receipts. This milestone's provider behavior is
  **simulated**, with actual production renderer/server/Electron evidence. No
  real-provider request was made for this slice; native parallel throughput is not
  inferred. Real Codex quota remains an unresolved separate follow-up.
- Typecheck, lint, locale check (10 languages/3700 English strings), and
  `git diff --check` passed. Final rebuild/check after the tooltip-copy adjustment
  is next; M8 remains the next feature milestone.
- Final `pnpm colonie:package` passed after the tooltip adjustment. Both
  `node scripts/devone/package-check.ts --claude --conversations` and
  `node scripts/devone/package-check.ts --conversations` passed again against that
  exact artifact; renderer errors are empty. Inspected the final narrow screenshot
  with completed menu animation and the JSON isolation/restart results. Final lint
  and `git diff --check` passed. This slice is complete for the recorded fixture
  acceptance scope. Next: M8 native custom-MCP contract audit; separate bounded
  real-provider multi-conversation evidence remains a follow-up, with Codex quota
  still blocked in the last real-provider check.

## M7-B UX correction — nontechnical users (implemented and verified)

- User clarified that awareness/persona/SOUL must be on by default and configured
  through the bot profile. ACP context is for developer inspection, not onboarding.
  Recorded this audience/default rule in `AGENTS.md` and `SPEC.md`.
- Next: change defaults, restore a simple ACP bot-profile editor, hide receipts and
  hashes behind an explicit Developer tools preference, and verify default chat
  plus profile editing in isolated fixtures and the rebuilt desktop package.
- Implemented on-by-default workspace awareness/persona/SOUL preferences; explicit
  saved preferences and conversation pins remain unchanged. Normal Simple profile
  editing now works for ACP bots (Name, Job, About, Instructions); unsupported
  learned-skills controls are absent. Shared instructions have a normal General
  settings editor with revision-guarded owner API, independent of a bot/thread.
- Added a separate device-local Developer tools preference, always off by default
  even in Advanced mode. Only explicit opt-in reveals ACP receipts/manifest/preview
  links. Normal bot settings show no transport/hash/setup copy.
- `pnpm typecheck` and `pnpm lint` passed. Isolated HTTP/default/isolation/restart
  and SDK integrity retest: `pnpm exec vitest run server/devone/context.e2e.test.ts
  server/devone/application.e2e.test.ts server/devone/context-integrity.test.ts` —
  **5 passed**. A fresh default turn now proves app, persona and saved SOUL are
  included without any context configuration call; plain fixtures explicitly opt out.
- `node scripts/devone/ui-check.ts --claude --desktop --profile --native` —
  **passed** with the SDK fixture and real React/Electron. Normal profile/shared
  instruction editing preceded the first turn; the inspector was hidden until
  explicitly enabled through Settings. Allow/Deny/Stop/reconnect also passed.
  Two earlier recipe failures were stale locators: the Simple provider picker uses
  provider ids, and the full sidebar opens Settings through the You menu. These
  were fixed rather than skipped; the profile fixture selects its provider at setup.
- Fresh greeting and normal option-panel copy now use plain language. The chat
  button reads **Agent options**; provider/session identifiers and option category
  ids appear only with Developer tools. Existing saved greetings are not rewritten.
- The first parallel build attempt exceeded its 120-second deadline; the Codex
  desktop fixture also timed out during the last streaming turn while that build
  was running. Reran the fixture alone without changing its assertions/timeouts:
  `node scripts/devone/ui-check.ts --desktop --profile --native` — **passed**.
  A separate `pnpm colonie:package` run with a 240-second command deadline
  **passed**, including TypeScript/build/staged providers, and rebuilt the final
  artifact. These earlier timeouts were not reported as passes.
- `node scripts/devone/package-check.ts --claude --native --profile` and
  `node scripts/devone/package-check.ts --native --profile` — **passed** against
  the final production app with isolated SDK fixtures. Both prove profile/shared
  instructions edited through normal UI, no default inspector, first-turn context
  applied automatically, explicit developer opt-in, and pin/session continuity
  after profile updates and full app restart. Evidence:
  `.devone/evidence/{claude-,}packaged-fixture-profile-defaults-check.json` and
  matching default-chat/native-settings/context/chat screenshots.
- `node scripts/devone/package-check.ts --real --claude --native --profile` —
  **passed** with two bounded no-tool requests and inherited native auth in a
  disposable workspace. Profile editing was through the normal UI before any ACP
  inspection. Claude returned `Colonie|Context verifier|CONTEXT_SOUL_471`, then
  `DEVONE_PACKAGE_471` after full restart; receipts retain the same pin/session.
  Evidence: `.devone/evidence/claude-packaged-real-profile-defaults-check.json`.
  No real Codex request was made; its quota blocker remains separately recorded.
- Focused regression:
  `pnpm exec vitest run server/devone/ server/store.test.ts src/state/store.test.ts
  src/lib/interface-mode.test.ts src/components/BotSettingsDialog.simple.test.ts
  src/components/BotSettingsDialog.caption.test.ts
  src/components/SkillsSection.behavior.test.ts src/components/SkillsSection.test.ts`
  — **369 tests passed across 16 files**. Full upstream suite not run.
- `node scripts/devone/ui-check.ts --claude --desktop --native --context` also
  **passed** with the updated Simple provider picker and explicit developer opt-in.
  Final lint, locale check (10 languages/3700 English strings), package TypeScript
  checks and `git diff --check` passed. Inspected the packaged default-chat image
  and real receipts. The audience rule is persisted in `AGENTS.md`; M8 is next.

## M7-B — scoped context (original implementation record)

- User explicitly clarified app-wide versus bot-specific context and requested
  implementation. Audited existing per-bot profile/SOUL storage, ACP dispatch,
  discovery, receipts and settings UI. Recorded the scoped contract in `SPEC.md`.
- Added independent workspace awareness/shared instructions and per-bot
  persona/SOUL switches, all defaulting off. Bot profile/SOUL editors reuse
  upstream persistence without reconnecting its prompt/memory/team assembly.
  Instance instructions have their own scope. Factory and UI copy is English (US).
- Shared `context.ts` composes named ACP user-content blocks with scope, source,
  version, SHA-256 and active/disabled/empty status. Exact receipts include a
  manifest and input block mapping. Runtime model/mode capabilities are generated
  per dispatch; permission enforcement remains native/runtime-owned.
- Stable context is captured for the admitted first request and pinned after native
  setup, before prompt dispatch. Discovery does not pin it. Existing pre-M7-B
  native conversations stay plain for app/bot additions; other conversations keep
  their pin through edits and restart. New conversations pick up saved updates.
  Missing/damaged/cross-bot snapshots refuse dispatch instead of silently changing
  context. Preview and inspector explain pinning and changed-profile state.
- Initial scope fixtures exposed two verification issues: bot creation does not
  accept a SOUL field (the fixture now uses the supported profile PATCH), and
  multiple fake adapter processes overwrote a shared state file. The SDK fake
  agent now serializes read/update/write, and turn assertions require a new receipt.
  Both-provider scope fixtures then passed, including actual native prompt bytes,
  app sharing, bot isolation, plain/legacy baseline, discovery-before-profile-edit,
  effective mode changes, new-thread updates and full server restart.
- Node 24.13.1 commands:
  - `pnpm exec vitest run server/devone/context.e2e.test.ts
    server/devone/codex-acp.test.ts server/devone/native-settings.test.ts` —
    **28 tests passed**.
  - `pnpm exec vitest run server/devone/ server/store.test.ts server/config.test.ts
    server/harness/registry.test.ts src/state/store.test.ts
    src/components/ChatView.follow.test.ts src/components/BloubAvatar.test.ts
    shared/approval-mode.test.ts src/components/ApprovalModeSelector.test.tsx` —
    **543 tests passed across 14 files**. The full upstream suite was not run.
  - `pnpm exec vitest run server/devone/context-integrity.test.ts` — **1 passed**;
    cross-bot input, damaged/missing pin, no-dispatch failure and restored continuity.
  - `node scripts/devone/ui-check.ts --claude --desktop --native --context` and
    `node scripts/devone/ui-check.ts --desktop --native --context` — **passed**.
    Real React/Electron with SDK fixtures proves controls, preview, manifest,
    pinned-change notice, streaming/reconnect, Allow/Deny, Stop and continuation.
    Evidence: `.devone/evidence/{claude-,}desktop-scoped-context-check.json`.
  - `pnpm colonie:package` — **passed**, including renderer/server TypeScript checks,
    rebuilt arm64 artifact with inherited nonfatal CSS/chunk notices.
  - `node scripts/devone/package-check.ts --claude --native --context` and
    `node scripts/devone/package-check.ts --native --context` — **passed** through
    the production renderer/server with disposable SDK fixtures, including full
    app restart and pinned original context after app/SOUL edits.
  - `node scripts/devone/package-check.ts --real --claude --native --context` —
    **passed** with inherited native authentication and two bounded no-tool
    requests in a disposable workspace. Claude returned
    `Colonie|Context verifier|CONTEXT_SOUL_471` from supplied app/persona/SOUL context,
    then `DEVONE_PACKAGE_471` after full app restart. Both receipts keep the same
    native session/snapshot and offered effort `low`; renderer errors were empty.
    Evidence: `.devone/evidence/claude-packaged-real-scoped-context-check.json`
    and matching preview/context/chat screenshots. No real Codex request was made.
- `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check` and `git diff --check` passed.
  Final cross-bot input guard/block-index display were added after the real run;
  integrity test and package rebuild passed afterward. Final packaged fixture
  smoke follows below. Real Codex quota remains a separate blocker.
- Final review corrected legacy-pin comparison so an unchanged old/plain profile
  does not falsely show a settings-change notice. Reran
  `pnpm exec vitest run server/devone/context.e2e.test.ts
  server/devone/context-integrity.test.ts` — **3 passed**; rebuilt the final artifact
  with `pnpm colonie:package` and ran
  `node scripts/devone/package-check.ts --claude --native --context` — **passed**.
  The earlier final-package `node scripts/devone/package-check.ts --native` also
  passed the plain Codex baseline. Final lint and `git diff --check` passed.
  No extra real-provider requests were needed for these guard/inspector changes.
  M7-B is complete for this scoped acceptance matrix; M8 custom MCP is next.

## Product language update — English (US)

- The user confirmed that the product primarily serves US users. Recorded English
  (US) for app-authored UI, factory/application context, built-in persona/SOUL
  templates, help and project documentation in `AGENTS.md`, `SPEC.md`, `PLAN.md`
  and `COLONIE.md`. Working communication remains in Bahasa Indonesia; user
  content and native provider output retain their own language.
- Translated the Native panel and application-authored stale-override warning
  into English. Translated the Indonesian sections of the fork's spec, roadmap,
  progress, run guide and ACP verification guide, preserving their evidence and
  the real Codex usage-limit blocker.
- With Node 24.13.1 on PATH, `pnpm colonie:package` passed, including renderer and
  server TypeScript checks, and rebuilt `release/colonie/mac-arm64/Colonie.app`.
  Existing CSS optimizer/chunk-size notices were nonfatal. `pnpm lint`,
  `pnpm i18n:check` and `git diff --check` passed.
- `node scripts/devone/package-check.ts --claude --native` passed against the
  packaged production renderer/server with a disposable SDK agent fixture,
  home, data, profile and workspace. Discovery sent zero prompts; native effort
  and the session survived a full app restart; renderer errors were empty.
  Inspected `.devone/evidence/claude-packaged-fixture-native-settings.png` and
  confirmed the visible panel copy is English. Result:
  `.devone/evidence/claude-packaged-fixture-check.json` (`real: false`, `ok: true`).
- This update establishes product language and updates existing copy; M7-B
  context composition/persona/SOUL implementation is still next. No real-provider
  request was made for this copy change; the real Codex blocker remains open.

## M7-A — native controls (implemented, explicit evidence boundaries)

- The user requested the next milestone and working communication in Bahasa
  Indonesia; this preference is recorded in `AGENTS.md`.
- Audit: the ACP execution boundary was already shared, but model discovery still
  depended on the first turn. Idle configuration updates were not processed, and
  legacy mode labels did not show all native capabilities. This was addressed
  through a per-thread native settings API/panel rather than new prompts or drivers.
- Target: open a session without a prompt for explicit discovery, show the
  model/effort/modes actually offered, validate changes against the current
  snapshot, persist per-thread/provider overrides, and record effective settings
  in receipts. Persona/SOUL remains a separate milestone after these controls.
- Verification used isolated fixtures; actual results follow.
- Added the per-thread Native panel, prompt-free discovery, revision/session
  snapshots, agent-offered model/effort/mode/boolean options, persisted overrides,
  revalidation after model changes, and effective settings in receipts. Identical
  discovery is coalesced so React Strict Mode/multiple tabs do not create a second
  session; change operations are locked per thread.
- Further audit found another provider's preview cursor does not prove history
  ownership. The guard now uses the last dispatch owner; fixtures prove pre-chat
  preview does not allow silent history transfer after chat starts. Configuration
  callbacks also revalidate application choices before saving model/session changes.
- `pnpm typecheck` and `pnpm lint` passed. Configuration + core runner fixtures:
  24 tests passed; HTTP/history fixtures: 4 tests passed. Native desktop UI passed
  for both providers, including model changes, stale effort repair, mode,
  reconnect, approval, Stop and receipts with the selected settings.
- `node scripts/colonie/native-controls-check.ts --real --claude`: passed discovery,
  offered native effort, a bounded request and the effective receipt.
- The same command without `--claude`: discovery/settings were accepted, but the
  model request **hit the Codex account usage limit**. The agent returned a quota
  message and the turn failed. Evidence: `.devone/evidence/codex-acp-native-controls.json`.
  No retry or billing change was attempted. Codex fixtures still passed;
  real-provider M7-A Codex is not reported as passed until quota is available again.
- Package rebuild and Native controls verification through the production Claude
  renderer and both provider package fixtures were planned here and completed
  in the following results.
- The final package was rebuilt from the current source. Commands
  `node scripts/devone/package-check.ts --native`, `--claude --native`, and
  `--real --claude --native --tools` **passed**. The recipe selects effort in the
  production Native panel, ensures discovery has not sent a prompt, tests offered
  modes and restoration, then proves effort survives restart. Real Claude also
  passed fixture file Allow/Deny through the UI.
- The first package recipe run caught a `Native mode` test selector also matching
  `Native model`; it was corrected to an exact accessible-name match. This was a
  verification locator failure, not skipped or reported as success.
- Final regression: **569 tests passed across 15 files**, covering the runner,
  native controls, history, HTTP/restart/queue, store/config/registry, UI state and
  selector. Typecheck, lint and renderer/server/package builds passed with nonfatal
  inherited CSS optimizer/chunk-size notices.
- No additional real Codex request followed the usage limit. This feature slice
  is implemented and fixture-verified, with the real Codex blocker still recorded.
  Package/receipt/screenshot evidence is under `.devone/evidence/`.
- The package was rebuilt after changing conflict responses to HTTP 409;
  the final `node scripts/devone/package-check.ts --claude --native` recipe passed.
  Native settings/history retest: 10 tests passed; final lint, locale check and
  `git diff --check` passed. No additional Codex model request was made.

## M5/M6 implementation record — Colonie branding and Claude

- Added Colonie app/package identity, primary commands and a dedicated build
  config. Existing `~/.devone` data and DevOne Electron profiles are reused in
  place when present; fresh installs use Colonie paths. No native cwd/session
  paths are rewritten and compatibility environment/command aliases remain.
- Adopted pinned MIT Bloub engine code with provenance and a React/SVG wrapper.
  Default art uses a violet pebble, saved old body/state identifiers map through
  explicit fallbacks, uploaded avatars keep their original rendering path.
  Static app/Dock/startup/favicon assets are generated from that same engine.
- `node scripts/colonie/icons.ts`: generated SVG, PNG and macOS ICNS assets.
  `vitest run server/devone/branding.test.ts src/components/BloubAvatar.test.ts`:
  3 tests passed (path preservation, independent masks/static rendering and mapping).
- `pnpm colonie:package`: built the arm64 Colonie app and included maintained
  Codex and Claude adapters/native dependencies plus Bloub notices.
- `node scripts/devone/package-check.ts --upgrade`: passed. Launched the old
  DevOne artifact with disposable legacy data, then the Colonie artifact without
  an explicit data override; the same native session/history continued. Evidence:
  `.devone/evidence/devone-upgrade-check.json`.
- `node scripts/devone/package-check.ts --real`: passed the Colonie artifact with
  real Codex and full application restart/native continuity.
- Extracted the shared ACP runner to `server/devone/acp-runtime.ts`; provider
  descriptors own executable, native mode ids and setup guidance. Claude uses
  upstream adapter `0.88.0`, SDK/native dependency `0.3.293`, native existing login,
  manual `default` mode and explicit Full `bypassPermissions` when available.
- `node scripts/devone/provider-check.ts --real --claude`: passed bounded real
  Claude reply, native session reload/marker and disposable file read.
- `node scripts/devone/ui-check.ts --claude --desktop`: passed the real Electron
  UI against the SDK fixture: streaming/reconnect, context, Allow/Deny, Stop and
  next turn. `node scripts/devone/package-check.ts --real --claude`: passed real
  Claude through the packaged UI, including app restart and same native session.
- Shared protocol suite expanded to both providers. It exposed test receipt
  cross-contamination from repeated thread ids; the per-test receipt directory
  is now reset inside the isolated test home. Regression rerun is next.

- Shared protocol suites now pass for **both Codex and Claude** (18 cases).
  Whole-application fixtures now pass for both providers, including a follow-up
  queued behind permission and native session loading after server restart
  (20 tests across those two files).
- `node scripts/colonie/art-check.ts`: passed 30 simultaneous avatars, unique SVG
  masks, status previews at 24/44/80/140px, Midnight/Daylight screenshots and static
  reduced-motion rendering. The wrapper pauses hidden/offscreen animation loops
  and cleans listeners/observers on unmount.
- Focused regression set (provider/runtime, storage/config, avatar/uploaded
  identity, settings, branding, UI state): **590 tests passed across 16 files**.
  Typecheck, lint and Electron syntax checks passed (158 modules).
- Provider switches on an already-native conversation now refuse starting an
  empty session for another agent without context: start a new thread for a
  different provider. Codex and Claude histories remain independently owned.

- The Claude desktop UI recipe now selects Claude through the real model picker
  before the first turn, rather than preselecting its provider through the API.
  Streaming, reconnect, context, Allow/Deny, Stop and continuation passed again.
- `node scripts/colonie/permission-check.ts --real --claude` and the same command
  without `--claude`: passed **native interactive Allow/Deny for both providers**.
  Allow produced only the disposable fixture file with the exact contents; Deny
  raised a native permission request and left the file absent. Evidence:
  `.devone/evidence/{claude-acp,codex-acp}-native-permissions.json`.

### Final verification and handoff

- Final packaged commands
  `node scripts/devone/package-check.ts --real --claude --tools` and
  `node scripts/devone/package-check.ts --real --tools` passed for both providers.
  These use the actual Colonie desktop composer/approval controls, prove native
  session memory after application restart, produce the allowed disposable file,
  and leave the denied file absent. Exact input receipts have empty app
  instructions. Evidence: `claude-packaged-real-check.json`,
  `packaged-real-check.json` and corresponding screenshots under `.devone/evidence`.
- The expanded app fixtures also prove queued follow-ups and server restart for
  both providers. The Claude desktop fixture chooses Claude through the real
  model picker. Both development desktop/UI recipes passed with the SDK fixture.
- Final artifact is rebuilt from current source and includes both native
  runtime dependencies and their notices, Bloub license/provenance, new app icons,
  production renderer and embedded server. Package uses `com.colonie.desktop`.
- An upgrade recipe rerun exposed a legacy desktop startup stall and an
  unbounded Playwright close wait. It is now bounded; cleanup reaps only its
  owned process. The deterministic compatibility recipe runs the old artifact's
  bundled server/production UI, then the new packaged desktop with the same
  disposable legacy home. **The updated upgrade recipe passed**, with the same
  native session id and preserved absolute cwd. It does not operate on the
  user's currently running DevOne app.
- Colonie now keeps desktop logs under its own selected profile, honors explicit
  fixture server ports, and skips creation of the unsupported phone-credential
  identity at startup. Earlier isolated logs showed an optional phone-key
  encryption error; this path is not part of local ACP chat.
- `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check`, `pnpm check:electron` passed.
  158 Electron modules syntax-checked. Electron Node test suite also passed.
  Focused regression set: 590 passed across 16 files; later changed-area set:
  60 passed across nine files. A final appearance/seed-color adjustment passed
  154 avatar/storage cases and the artwork recipe. The full upstream suite was
  not run; these named sets define the test evidence.
- Fresh Colonie contacts default to violet. Existing saved color identities
  remain recognizable (green stays green), old body ids map to Bloub shapes,
  and uploaded-avatar crop/zoom behavior is preserved. Light/dark and
  reduced-motion evidence covers 30 concurrent avatars at several sizes.
- `docs/COLONIE.md` is the current source/build/update/verification guide.
  `DEVONE.md` and old launch environment/command names are compatibility aliases.

M5 and M6 are complete for the recorded core acceptance scope. The build remains
local unsigned macOS arm64; optional protocol extensions, all native agent
features and later personalization/automation are not claimed as complete.

## Product direction update — 2026-10-09

- User feedback: Codex works smoothly in the current app. This is user-reported
  experience, not an additional automated check or evidence of Claude support.
- Naming priority: rename the project/product to **Colonie** before expanding
  features. The latest user decision supersedes the earlier Normie choice;
  no runtime rename had been implemented for either name in this session.
- Subsequent priority clarified by the user: **full Claude integration like
  the current Codex experience immediately after rename**, then other features.
  This supersedes the earlier proposed order that placed Claude after
  personalization/custom MCP, and the suggestion of only a compatibility probe.
  M6 now requires actual desktop/core-workflow parity and provider evidence.
- Visual direction added by the user: replace the OpenMausBot blob/mascot with
  assets/code from `https://github.com/jeremy-prt/bloub`, to differentiate Colonie.
  Recorded as part of M5 branding, before M6 Claude integration.
- Read Bloub README, architecture and LICENSE. Reviewed revision:
  `b4bb3c1b5f93c7b87a2e8d620f667c4093d97749`. It offers animated SVG, a framework-free
  TypeScript engine and a Vue component, under MIT (Jérémy Perret). Its README
  explicitly identifies the x.ai visual reference and separates code licensing
  from the imitated design. No Bloub files/assets have been imported yet.
- Initial local visual audit: `Avatar.tsx` wraps CursorAvatar; `mascot.ts` selects
  runtime expressions/states; `shared/mascot-bodies.ts` is a generated body catalog.
  Integration must map old stored settings/statuses, not merely replace one icon.
- Personalization is wanted: persona, SOUL and Chief are future requirements.
  The user's objection is unwanted/preconfigured context, not user-controlled
  personalization. Future additions should be explicitly configured and visible
  in the existing exact-input inspection model.
- Previous-message editing is not needed; browser is not prioritized. Other
  missing upstream features remain candidates, not already-connected features.
- `SPEC.md` records the name, requirements and rename acceptance criteria;
  `PLAN.md` records approved M5/M6 and the proposed subsequent feature milestones.
- This session changes documentation only. No runtime rename, artwork replacement,
  data migration, persona/SOUL/Chief integration or Claude support is claimed. Historical phase-1
  command/artifact evidence below keeps its original DevOne names.

Verification for this update: documentation consistency reviewed;
`git diff --check` passed. No runtime behavior changed, so application tests were
not run for this documentation milestone.

## Completed

- Cloned OpenMausBot into this workspace at upstream commit
  `974670059884139d5a7c115e4bfae2b5ee778fec`.
- Read root agent instructions and `docs/verification/README.md`.
- `pnpm install --frozen-lockfile`: passed (834 packages); installed from the
  upstream lockfile. Node 22 warning is expected before bootstrap to Node 24.
- `npm exec --yes --package=node@24.13.1 -- node --version`: `v24.13.1`.
- Installed local CLI detected: `codex-cli 0.158.0`. Authentication not yet checked.
- Published packages checked: ACP SDK `1.7.0`, Codex ACP adapter `2.1.1`.

## Audit map

| Concern | Upstream location | Fork treatment |
| --- | --- | --- |
| Driver and instance contract | `server/contracts.ts` | Reuse contract |
| Provider registry | `server/harness/registry.ts` | Reuse lifecycle boundary |
| Old ACP client | `server/drivers/acp/` | Replace on new path |
| Direct/room dispatch | `server/index.ts` | Add transparent new-path boundary |
| Persona and context assembly | `server/system-prompt.ts`, `server/drivers/prompt-split.ts` | Exclude from new path |
| Durable transcripts/events | `server/store.ts`, `shared/runtime-events.ts` | Reuse |
| Live event fold | `src/state/store.tsx` | Add new-path incremental output |
| Chat renderer | `src/components/ChatView.tsx` | Reuse UI |
| Desktop process/profile | `electron/main.mjs` | Reuse with isolated fork launcher |
| Isolated verification | `scripts/control-omb.ts`, `docs/verification/` | Follow; extend for ACP fixture |

Important discovery: upstream intentionally discards in-flight reply deltas in
the renderer. Streaming needs a real UI change. Dispatch-time code also prepends
automatic recall and builds persona/SOUL/context before calling the driver;
replacing only transport would not solve unwanted instructions.

## Verification

- Pinned ACP SDK `1.7.0` and Codex ACP adapter `2.1.1` installed.
- `PATH=<Node-24-bin>:$PATH pnpm typecheck`: passed for the new runner.
- `PATH=<Node-24-bin>:$PATH pnpm exec vitest run server/devone/codex-acp.test.ts`:
  8 tests passed. Real SDK/stdio fixture proves exact input, ignored legacy
  context, streaming, multi-turn continuity, process restart/load, allow/deny,
  Stop, parallel-thread isolation, and failure without silent empty-session fallback.
- `node scripts/devone/provider-check.ts --real` under Node 24: passed three
  bounded requests with inherited Codex authentication in a disposable workspace.
  The model returned `DEVONE_OK`, remembered `DEVONE_SESSION_829` after runner
  restart, and read `fixture.txt` as `DEVONE_FILE_OK` using a native tool.
  Exact receipts and events: `.devone/evidence/provider-check.json`.
- Initial checks caught TypeScript strip-only parameter properties and SDK API
  type differences; both were corrected before the successful real-provider run.

Real-provider evidence above is runner-only. Desktop and full renderer/server
workflow evidence is listed separately below.

### M2 — application integration

- A DevOne runtime profile registers only the new `codex-acp` driver. Data and
  Electron profile are separate from the installed OpenMausBot.
- Direct dispatch takes the new path before legacy compaction, persona, SOUL,
  memory, recall, skills, setup/learn rewrites and application MCP assembly.
- Added exact input receipts, a chat `ACP context` dialog, and incremental reply
  rendering with snapshot hydration and SSE offset deduplication.
- Unsupported history editing is refused before transcript mutation. Unsupported
  legacy bot-settings and automation controls are hidden in the phase-1 fleet.
- `pnpm exec vitest run server/devone/application.e2e.test.ts`: passed. Isolated
  HTTP flow proves input fidelity despite unwanted bot metadata, native continuity,
  approval, persistence and native session loading after the application server
  restarts. Evidence is printed as a persistent fixture log and `.devone.json`.
- `node scripts/devone/ui-check.ts`: passed. Real Chromium renderer + isolated
  SDK fixture: live text before completion, exact input dialog, continuation,
  Allow once, Deny, Stop and a subsequent turn. Screenshots and receipts:
  `.devone/evidence/renderer-*`.
- `node scripts/devone/ui-check.ts --desktop`: passed the same workflow through
  the reused Electron shell with an isolated profile. Evidence:
  `.devone/evidence/desktop-*`. This was development Electron + simulated agent,
  not yet the packaged application or a real provider through the UI.
- Typecheck and full lint passed. Focused regression set: 390 tests passed in
  seven files; application restart fixture separately passed. An earlier footer
  fixture lacked `instances` in its mock; it was updated and a phase-1 visibility
  assertion added. Electron syntax checks passed; Electron unit suite: 637 passed,
  3 platform-specific skips, zero failures.
- `pnpm devone:build`: passed; frontend, bundled server and staged Codex runtime.
  Bundled adapter `2.1.1` uses compatible Codex `0.159.3`.
- `pnpm exec electron-builder --config electron-builder.devone.yml --mac --dir
  --publish never`: passed; local arm64 app at
  `release/devone/mac-arm64/DevOne.app`. Packaged workflow verification followed
  in M3/M4 below.

### M3/M4 — packaged native verification and handoff

- Packaged smoke checks caught and resolved three issues before acceptance:
  the startup icon was excluded from ASAR; the default onboarding record used
  a field rejected by upstream's strict config schema; electron-builder's
  resource matcher skipped nested `node_modules` in the staged adapter. The
  package now includes the icon and both Codex package roots explicitly. A
  regression test proves schema-valid initial configuration.
- Native process stderr is now kept as a bounded, redacted diagnostic, so a
  missing runtime dependency is reported instead of only "connection closed".
- Input-recording failure refuses dispatch and cleans up the session. Failure
  to update a completed receipt cannot leave the application permanently busy.
- Final focused regression run:
  `pnpm exec vitest run server/devone/ server/store.test.ts
  server/harness/registry.test.ts server/config.test.ts scripts/control-omb.test.ts
  src/state/store.test.ts src/components/ChatView.follow.test.ts
  src/components/BotSettingsDialog.test.ts src/components/SidebarFooterNav.test.ts`
  — **532 tests passed across 10 files**. A subsequently added source-launcher
  fixture passed separately (1 test); it proves the documented command boots,
  uses valid defaults, and exposes only `codex-acp` in an isolated workspace.
- Final `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check`, and
  `pnpm check:electron`: passed. Locale catalogs valid; 156 Electron modules
  syntax-checked. The earlier Electron unit suite passed 637 tests with three
  platform-specific skips.
- Final `pnpm devone:ui-check` and `pnpm devone:desktop-check`: passed, now
  including a renderer reload during streaming and no duplicate final reply.
- Final `pnpm devone:package`: passed and rebuilt the actual arm64 `.app`.
  Upstream CSS `::highlight` optimizer and large-chunk notices are non-fatal.
- Final `pnpm devone:package-check`: passed with the deterministic SDK agent.
  It launches the production renderer and embedded server, sends through the
  composer, inspects exact context, quits/reopens the app and loads the same
  persisted native session. `.devone/evidence/packaged-fixture-check.json`.
- Final `node scripts/devone/package-check.ts --real`: **passed with real Codex
  through the packaged desktop UI**. Two bounded prompts returned
  `DEVONE_PACKAGED_OK` and, after complete application restart,
  `DEVONE_PACKAGE_471`. Both receipts show the same native session, no added
  instructions, and the effective native model `gpt-5.6-terra`.
  Runtime manifest: adapter `2.1.1`, compatible bundled CLI `0.159.3`.
  Evidence: `.devone/evidence/packaged-real-check.json`, `packaged-real-chat.png`,
  `packaged-real-context.png`. Renderer error list is empty. The first debug
  launch emitted macOS task-policy diagnostics, without affecting the workflow.
- The earlier independent real-provider runner check also proved a native read
  of one disposable fixture file. Real write/approval reliability on arbitrary
  projects is not inferred from the deterministic permission fixtures.
- Fork startup uses separate data/profile, disables upstream signup/analytics,
  automatic binary updating, computer-daemon startup and app registration. Fresh
  startup shows a Codex contact and a neutral application greeting. Unsupported
  legacy guided-tour steps are skipped in fresh DevOne data.
- Added `docs/DEVONE.md` with run, configuration, build, verification and update
  commands, and `docs/verification/devone-acp.md` with evidence boundaries.
- All verification used owned disposable data/profile/workspaces. Existing CLI
  login was inherited by the explicitly bounded real checks; token contents were
  not read. User-installed OpenMausBot data was not used for verification.

## Acceptance summary

| Flow | Evidence |
| --- | --- |
| Exact input/no implicit app prompt | Protocol, HTTP fixture, context dialog, packaged real receipts |
| Streaming + reconnect | Real renderer and Electron with SDK agent fixture |
| Tool activity | SDK fixture; native file-read in real-provider runner check |
| Allow/Deny/Stop + next turn | SDK fixture through real renderer/Electron |
| Native continuity/restart | Runner, whole-server fixture, packaged fake and real desktop |
| Build/desktop startup | Production arm64 app launch, embedded server and bundled runtime |
| Documentation/maintainability | SPEC, PLAN, PROGRESS, AGENTS, run/update and verification guides |

## Remaining phase scope

The local build is unsigned/unnotarized and only macOS arm64 was packaged here.
Claude, registry-driven installation, multiuser office access, native history
rollback/forking, detailed usage/effort controls and legacy team/cloud/automation
features are later milestones. Ask maps to native read-only mode; Full maps to
native full access. There is no custom automatic permission reviewer in phase 1.
The full upstream test suite was not run; results above name the tested scope.

## Next action

M8-C is complete (puzzle → Apps panel; that panel Composio + Custom MCP only;
Settings → connections is the project-key entry alone). M8-D is complete: the ACP
engines run isolated under `~/.colonie/native/...`, verified end-to-end. M8-E is
complete: the app shows signed-in/signed-out per ACP engine and signs in through
the engine's own flow, verified with the signed-out fixture. Rebuild the packaged
app for the owner; the real provider sign-in still needs a real account to confirm
on the packaged build, and the desktop renderer card is unverified. Next feature
milestone is Skills
on the ACP boundary (M10 in `PLAN.md`): reuse the upstream Agent Skills store,
links and UI, expose the ACP bot-profile Skills section, and deliver the index
through the app-owned ACP context. The deferred legacy hiding (footer menu, legacy
Settings sections, non-ACP branches) and D1 source retirement stay for the
post-consolidation cleanup; ACP is the app, so no `mode`-style switch is added.
M9 (memory/Chief/routines) remains before or alongside M10. Any reported
installation-specific credential-store issue uses bounded metadata diagnosis, not credential
inspection or reset.
Repeat real Codex native-controls/scoped-context checks when quota becomes
available as a separate follow-up. Chief coordination, memory and routines remain
M9; naming/configuring a Chief does not establish delegation. Product-authored
context, UI and documentation continue to use English (US).
