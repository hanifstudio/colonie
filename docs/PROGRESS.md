# Colonie progress

## 2026-10-14 — M11 step 5 proven, step 4b prepared (not yet run on the host)

Commit `322ad8f5`. The VPS exists: Ubuntu 24.04, x86_64, 8 GB RAM, 4 vCPU,
160 GB (Linode `g6-dedicated-4`, region ap-south). Above the 4 GB floor, and
x86_64, which the Codex adapter's per-architecture binary requires.

### Step 5 — `OMB_LOOPBACK_TRUST=service` — proven

Both modes run against an isolated headless fixture (`env -i`, scratchpad
`HOME` and `OMB_DATA_DIR`), session-less loopback requests:

| route | default (`owner`) | `OMB_LOOPBACK_TRUST=service` |
|---|---|---|
| `/api/health` | 200 | 200 |
| `/api/config` | **200** | **403** |
| `/api/instances` | **200** | **403** |
| `/api/sessions` | — | **403** |
| `/api/usage` | **200** | **403** |

Server log confirms the choice each way: `local requests: owner trust
(self-hosted default)` versus `local requests: service trust
(OMB_LOOPBACK_TRUST)`. This matters because every bot's shell is a loopback
caller: under the default, a workspace member could ask a bot to curl the local
API and rewrite settings, keys, MCP servers or webhooks as the owner. The
setting is baked into the systemd unit with that reason written beside it.

### Step 4b — prepared, nothing executed on the host

- `docs/deploy-colonie-vps.md` (190 lines): the runbook. Listener stays on
  `127.0.0.1`; Tailscale `serve` reaches it over the tailnet, so no public port
  and no certificate. Windows teammates use a browser, which is why the missing
  Windows build is not a gap. Engine sign-in is a one-time SSH step for the
  owner only.
- `scripts/colonie/provision-vps.sh` (83 lines, `bash -n` clean): idempotent
  host setup; refuses non-x86_64 and under ~4 GB; installs Tailscale without
  joining; does not start the service or touch the firewall.
- `scripts/colonie/colonie.service` (56 lines): Colonie profile, isolated data
  dir, restart-on-failure with a start limit, systemd hardening with only
  `/opt/colonie/data` writable.

### Blocker — the fork has no remote of its own

`git remote -v` shows only upstream `milind-soni/OpenMausBot`. Every commit in
this session, including the ~45k-line retirement, exists **only on the
development laptop**. That is both a single point of failure and the reason the
deployment has no clean way to move the code. The runbook's first step is
`gh repo create <org>/colonie --private --source=. --remote=colonie`, keeping
`origin` on upstream so future upstream changes can still be fetched.

### Needed from the owner before step 4b runs

1. The private repository (or an explicit decision to use `rsync` instead and
   accept the laptop as the only copy of the history).
2. The Linode IPv4 and an `~/.ssh/config` entry so `ssh colonie-vps` resolves.
3. The engine sign-in, run by the owner on the server. No credential is read or
   handled here.

### Next concrete action

Run the runbook against the host, in order, recording each step's output. The
first real turn on Linux is the real-provider check and must be recorded
separately; the adapters' Linux behaviour has never been exercised.

## 2026-10-14 — M11 step 7: installable macOS build (implemented, artifact-verified)

Commit `2317d4cd`. `release/colonie/Colonie-0.1.101-arm64.dmg` (345 MB) and
`.zip` (346 MB) now exist. Also commit `cd6cd260`: two stale onboarding
expectations corrected, so the ACP suite is fully green (333 passed, 0 failed).

### What was actually wrong

- `colonie:package` passed `--dir`, overriding the config, so the build had
  never produced an installer at all. New `colonie:dist` script; the old one
  keeps its fast `--dir` build for development.
- `identity: null` **skips** signing. The bundle carried only Electron's linker
  signature with `Identifier=Electron`, and `codesign --verify` failed with
  "code has no resources but signature indicates they must be present" — which a
  downloader sees as *"Colonie is damaged"*, not as an unidentified developer.
  `identity: "-"` ad-hoc signs the bundle: `Identifier=com.colonie.desktop`,
  verify passes.
- Hardened runtime plus an ad-hoc signature kills the app on launch: library
  validation refuses the bundle's own helpers, with **no output and no crash
  report**. Confirmed both ways on a copy before changing the config. It is only
  required for notarization, so it is off until there is a Developer ID.

### Driver-retirement fallout that typecheck could not see

`scripts/bundle-server.mjs` listed `drivers/{agents,dweb,phone}-proxy.ts` as
esbuild entry points, and `server/index.ts` and `server/drivers/claude.ts` reach
them through `SPAWNED_PROXIES`. These are resolved **by path string, not by
import**, so the M11 step 3 dependency audit missed them and `pnpm typecheck`
stayed green while `pnpm build:server` failed. The three proxies plus their
closure (6 files, 2042 lines) are restored and classified retain-shared until
the features that spawn them are retired. `piMcpExtension` had no consumer and
is removed from `SPAWNED_PROXIES`, the bundler and both tsconfigs.

Lesson for the remaining retirement slices: an import graph is not the whole
dependency graph here. Check `SPAWNED_PROXIES`, `scripts/bundle-server.mjs`
entry points and any path-string resolution before deleting a server file, and
run `pnpm build:server` — not only `pnpm typecheck`.

### Evidence (Node 24, macOS 26.2)

- `pnpm typecheck` exit 0; `vitest server/proxy-paths.test.ts` 4 passed.
- `pnpm colonie:dist` exit 0, both artifacts written.
- `codesign -dv` reports `Identifier=com.colonie.desktop`, `Signature=adhoc`;
  `codesign --verify --deep --strict` passes.
- Download simulated end to end: the dmg was marked with Safari's
  `com.apple.quarantine` attribute, mounted, the app copied out still carrying
  quarantine (`0283;00000000;;`), and **that quarantined copy launched**.

### Not verified

- A real double-click through LaunchServices. The launch test ran the binary
  directly, which does not raise the Gatekeeper dialog. On macOS 15+ that dialog
  is no longer bypassed by Control-click → Open; the receiver must use System
  Settings → Privacy & Security → **Open Anyway**. The download page was
  corrected to those steps; its earlier Control-click wording was wrong for this
  macOS version.
- Nothing is uploaded yet. The download page still points at a placeholder URL
  pending the owner's Cloudflare R2 bucket.

## 2026-10-14 — M11 step 4a: headless operation proven (verification only, no code change)

Colonie was booted with no Electron, no display and no inherited environment
(`env -i`), from an isolated `HOME` and `OMB_DATA_DIR` under the session
scratchpad, on port 18891, with `COLONIE_PROFILE=1` and `OMB_STATIC_DIR` pointed
at a freshly built `dist/`. This is the first evidence for the claim; it was
previously carried only by inherited `docs/self-hosting.md`, which describes
OpenMausBot and not this fork.

### Proven

- `pnpm build` succeeds after the driver retirement (exit 0, `vite build` ok).
- `GET /api/health` answers `{"app":"openmausbot","static":true,...}`. The
  server serves the renderer itself; no separate web server is involved.
- `GET /` returns the built React document, and its 3.8 MB entry bundle
  (`/assets/index-DRHPKXNx.js`) answers `200` with the full body.
- `GET /api/instances` lists exactly `codex-acp` and `claude-acp`, both
  `state: "available"`, `codex-acp 2.1.1`. No retired engine appears.
- No Electron process exists while the server runs (`pgrep` empty).
- The listener binds `127.0.0.1` only. Nothing is published to a public
  interface by default, which is the behaviour a VPS deployment must preserve:
  reach it through SSH, a private network or an authenticated proxy.

### Engine sign-in on a server — works, with a condition

Colonie's ACP sign-in is a **terminal** route by design (`server/contracts.ts`,
`AcpRuntime.signInCommand()` in `server/devone/acp-runtime.ts`, surfaced by
`POST` handling at `server/index.ts:24447`, which returns
`{ terminal: { command } }`). The command carries the isolated config dir, e.g.
`CLAUDE_CONFIG_DIR="<data>/native/claude" claude /login`.

On a VPS this still works, but it means the owner signs the engines in **over
SSH on the server**, once, not from the desktop window. Team members never do
this; they use the workspace's already signed-in engines. Record this as a setup
step in the deployment runbook rather than discovering it on the day.

### Not proven

- An actual agent turn headless against a real engine. The isolated fixture has
  no engine login (`authenticated: false` for both), and signing one in would
  need the owner's credentials. The `server/devone/*.e2e.test.ts` suites do
  exercise the full conversation path in Node without Electron against the fake
  engine, and they pass, but that is not a real-provider claim.
- Reaching the server from another machine. The loopback binding is deliberate;
  a tunnel, Tailscale or an authenticated reverse proxy is still undesigned.
- **Linux.** Everything above ran on macOS. The VPS is Linux, and the adapters
  and their native dependencies have not been exercised there.

## 2026-10-14 — M11 step 3: non-ACP engine drivers retired (implemented, fixture-verified)

Branch `chore/retire-legacy-drivers`, commit `2ddc2898`. 101 files, 43663 deletions.

- Audit first, and it is what made the slice safe: the two surviving ACP drivers
  (`server/devone/codex-acp.ts`, `claude-acp.ts`) import **nothing** from
  `server/drivers/`. `server/devone/profile.ts` already filtered every configured
  instance through `isColonieAcpDriver`, so the inherited drivers have been
  unreachable at runtime since M8-C. 93 files and ~42k lines removed.
- `server/drivers/builtIn.ts` is now the two ACP drivers and nothing else.
- The OpenCode provider-key policy in `server/index.ts` served only the retired
  `opencodeGo` driver; removed with it, which also freed `acp/opencode-go.ts`.
- Retained under `server/drivers/` because core still imports them: `claude.ts`,
  `codex-identity.ts`, `retry.ts`, `agents-catalog.ts`, `antigravity-temp.ts` and
  the `acp/core.ts` chain. Each is reached from `claude-accounts.ts`,
  `plan-usage.ts`, `harness-capabilities.ts`, `tts/speech-text.ts`,
  `shared/tool-name.ts` or `server/index.ts`. Retiring them changes core modules
  and the surfaces above them, so they are a later slice.
- Test rule applied: a test whose subject is a retired driver is retired with it;
  a file mixing subjects keeps the surviving blocks. `local-inject.test.ts` and
  `hosted-models.test.ts` removed whole; retired blocks removed from
  `cli-setup.test.ts` (the whole `API onboarding` describe, 275 lines, which
  drives API-key engines), `managed-desktop.test.ts`, `model-providers-docs.test.ts`
  and `acp/quiet-status.test.ts`. No assertion weakened, nothing skipped.

### Evidence (Node 24 via /opt/homebrew/opt/node@24)

- `pnpm typecheck` — exit 0.
- `pnpm exec vitest run server/devone server/drivers server/cli-setup.test.ts
  server/managed-desktop.test.ts server/model-providers-docs.test.ts
  server/config.test.ts server/enterprise.test.ts server/brand.test.ts`
  — 29 files: **588 passed, 1 skipped, 2 failed**.

### The 2 failures are pre-existing, not caused by this slice

`server/devone/profile.test.ts` (expects `config.onboarding?.version` to be 1,
gets 0) and `server/devone/start.e2e.test.ts` (expects `tour.done`, gets `[]`)
fail **identically on `main`**, confirmed by running them in a detached
`git worktree` at `main`. They belong to the onboarding work in `e6576d55` and
are an open bug independent of driver retirement.

### Not verified

- The full `pnpm test` suite, the renderer, and any packaged or desktop path.
- No real-provider check was run for this slice.

### Delegation attempt — failed, no damage

A Codex worker was launched with a 76-line brief to run the suites and fix only
mechanical fallout. It changed no files and produced no report: the repository's
own `AGENTS.md` directs every agent to read `SPEC.md`, `PLAN.md` and
`PROGRESS.md` before changing the fork, and the worker spent its run doing that.
Lesson for the next delegation: a worker in this repo inherits `AGENTS.md`, which
outranks a narrow brief, so the brief must state that the lead has already done
the required reading. Running the suites directly with the output piped through
`grep`/`tail` turned out to be cheap, so the test run itself is not worth
delegating; fixing a large failure set still would be.

## 2026-10-14 — M11 step 2: enterprise layer retired (implemented, fixture-verified)

Branch `chore/retire-enterprise`, commit `578730f2`. 28 files, 1974 deletions.

- Removed `enterprise/` (10 files) and everything that existed only for it:
  `server/hosted-access.test.ts`, `server/hosted-models-api.test.ts`, `CLA.md`,
  `.github/workflows/contributors.yml`, the bundler and npm-package branches
  that shipped the layer, the electron-builder filters that excluded it, and its
  `tsconfig.server.json` / `vite.config.ts` / shard-weight entries.
- `server/enterprise.ts` and `server/enterprise.test.ts` stay. The six core
  callers (`brand.ts`, `spend.ts`, `cloud-home.ts`, `cli.ts`, `hosted-models.ts`,
  `index.ts`) were not touched and did not need to be.
- `LICENSING.md` rewritten, `README.md` / `CONTRIBUTING.md` / `CODEOWNERS`
  updated: the repository is now a single Apache 2.0 tree with no carve-out.
- The CI job that proved the deletion works was kept and repurposed as a
  standing proof that the open-source edition boots; only its own `rm -rf
  enterprise` step was dropped.

### Evidence (Node 24 via /opt/homebrew/opt/node@24, isolated fixture)

- `pnpm typecheck` — exit 0.
- `pnpm exec vitest run server/enterprise.test.ts server/brand.test.ts` —
  2 files, 19 tests passed.
- `pnpm exec vitest run server/spend-cap-api.test.ts server/license-expiry-api.test.ts`
  — 2 files, 11 tests passed. Both drive a stand-in layer through the surviving
  hook, so they prove the hook still grants and expires entitlements correctly.
- Isolated boot (`OMB_DATA_DIR` and `HOME` under the session scratchpad, port
  18797) with `OMB_LICENSE_KEY=omb1.not.real`, then `GET /api/edition`:
  `{"edition":"oss","features":[],"notice":"OMB_LICENSE_KEY is set but no
  enterprise layer exists at .../enterprise or .../server/enterprise"}`.
  Both CI assertions reproduced: `"edition":"oss"` and the missing-layer notice.

### Not verified

- `.github/workflows/docker.yml` and `.github/workflows/npm-package.yml` were
  edited but not executed locally. They need a CI run or a local container build.
- The full `pnpm test` suite was not run; only the four suites above plus the
  whole-repo typecheck.

### Follow-up noted, not scheduled

`server/enterprise.ts` (247 lines) is now a hook with nothing to load: `entitled()`
always returns false and `editionStatus()` always reports oss. Retiring it would
touch its six core callers including `server/index.ts`, so it belongs to D1 rather
than to this slice.

## 2026-10-14 — product direction change recorded (documentation only, no code change)

- Owner decision this session: Colonie becomes a shared always-on workspace for
  one internal team, not a single person's desktop app. Long-term intent is people
  and agents working together; replacing a team chat tool is an ambition, not a
  milestone. Written to `SPEC.md` (*Product direction change*) and `PLAN.md` (M11).
- Pi Durable (Earendil, published 2026-10-01) evaluated and rejected: a framework
  rather than a hosted service, published examples target OpenAI not Claude,
  self-described as experimental with a changing API, and adopting it would replace
  the ACP boundary M1-M10 are built on. Execution stays on ACP.
- Owner also rejected a broad rewrite of inherited infrastructure in favour of
  retire-what-is-unused plus rewrite-on-contact. Recorded in `SPEC.md`.

### Findings read from this fork's own source (not from inherited docs)

- `enterprise/` is reachable only through `server/enterprise.ts` (247 lines); core
  callers are `brand.ts`, `spend.ts`, `cloud-home.ts`, `cli.ts`, `hosted-models.ts`
  and `index.ts`. Its `LICENSE` forbids hosting for third parties, reselling and
  white-labelling without a written agreement. `FEATURES` places multiple
  workspaces (`admin`), the workspace spend cap (`budgets`) and SSO inside it.
- `OMB_LOOPBACK_TRUST` is honoured in `server/request-auth.ts:116`, independent of
  `enterprise/`. The self-hosted default is `owner` trust, under which every bot
  shell is an owner-trusted loopback caller.
- `WireMessage` (`shared/wire.ts:399`) carries `role: "bot" | "user"` and no author
  field; no `workspaceId` exists in `shared/wire.ts` or `server/store.ts`.
- `server/index.ts:16481` serves non-`/api/` GETs from `OMB_STATIC_DIR`
  (`server/index.ts:672`), so the server can deliver the built UI itself.
- `electron-builder.colonie.yml` sets `mac: target: dir`, `identity: null`,
  `notarize: false`, and has no `win` section. It therefore produces no installer,
  is refused by Gatekeeper on another machine, and offers no Windows build.
- Non-test line counts: `server/drivers` excluding `acp/` 17143, `server/drivers/acp`
  6205, `server/devone` + `server/colonie` 4690, `server` total 135570, `src` 89776,
  `server/index.ts` 26100.

### Unverified — must be proven before they enter a plan

- Headless operation of this fork on a server, and the built UI delivered from a
  remote server to a browser. The code path exists; the behaviour is not tested.
  Inherited `docs/self-hosting.md` claims it for OpenMausBot, not for Colonie.
- Whether retiring the non-ACP drivers is dependency-complete; no audit has run.

### Blockers

- No distributable macOS artifact exists (see build config above). The team cannot
  install Colonie until M11 step 7 lands.
- Cloudflare R2 credentials for publishing artifacts are not yet shared by the owner.

### Artifacts produced this session

- A one-page download page for the team, published privately as a Claude Artifact.
  Its download target is still a placeholder pending the R2 URL.

## Markdown file preview in chat (implemented, isolated fixture-verified)

- Owner request: bot-authored text files arrive as plain prose or save-only
  chips — no clickable handoff and no in-app reading. Markdown attachments
  (`.md`/`.markdown`) now get a Preview button beside Save, opening a 400px
  right-side reading panel (same slot as Activity/Inspector) that renders the
  document with the chat's Markdown through the existing message-scoped grant.
  PDF and other documents stay save-only; CSV/TSV keep their table dialog.
- Model handoff: the ACP capabilities line now asks the agent to write created
  files as full-path Markdown links (`colonie.capabilities.v6`), so links
  become clickable file cards instead of inert prose. No `attach_file` tool
  exists on the ACP path; authorization reuses the message-link grant.
- Files: `server/devone/context.ts` (v5→v6), `src/state/store.tsx`
  (`filePreview` + `openFilePreview`/`closeFilePreview`, exclusive with the
  other side panels, cleared on select/switchTask/view change),
  `src/components/AttachmentPreview.tsx` (`FilePreviewScope`,
  `MarkdownPreviewButton`, `isMarkdownPreviewPath`, 1 MB
  `readMarkdownResponse`), `src/components/FilePreviewPanel.tsx` (new),
  `ChatMarkdown.tsx` (button on `.md` links), `AttachmentPreview.tsx` chip,
  `ChatView.tsx` + `GroupView.tsx` (scope), `App.tsx` + `lazy-screens.tsx`
  (panel mount), 7 `attach.preview*` English keys (other locales fall back).
- Actual checks under Node 24:
  - `pnpm exec vitest run` on FilePreviewPanel/AttachmentPreview/ChatMarkdown/
    store/lazy-screens/locales/context-e2e/context-integrity — **all passed**
    (307 unit + 3 context + 9 locale).
  - `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm i18n:check` (3714 strings) —
    **passed**.
  - `node --experimental-strip-types scripts/colonie/file-preview-check.ts` —
    **passed** against the disposable fake-engine fixture with real renderer:
    scripted reply links one `.md` + one `.pdf`; only the `.md` gains Preview
    buttons (gallery card + inline link); the panel renders the Markdown body
    through the message grant; Close removes the panel; zero renderer errors.
- Not covered: real-provider model behavior (the handoff line is prompt text,
  not a tool), packaged desktop/Electron, PDF/Office inline viewing, panel on
  mobile widths beyond the existing overlay pattern.

## M9-B + M10 — singleton default Chief and ACP skills (in progress)

- Owner clarified Chief as the first bot by default, exactly one per workspace,
  able to create/change/delete/ask other bots. Owner approved implementation of
  Chief and skills together; group chat is deferred for a separate discussion.
  Updated SPEC/PLAN; detailed file/API/lifecycle/verification plan:
  `plans/2026-10-12-chief-and-skills.md`.
- Parallel color lead (`w2M:p1`) confirmed no source edits/ownership overlap. The
  tree was clean at start (M9-A commit `cd246c4d`). Lead owns shared files/runtime/
  server integration and final verification. New Herdr workers `chief-worker`
  (`w2M:pB`) and `skills-worker` (`w2M:pC`) use
  `9router/alitp-intl/deepseek-v4.1-flash`; availability reconfirmed with
  `opencode models 9router`. Worker new-file allowlists are disjoint.
- Audit: upstream Chiefs are section-scoped, while the approved product requires
  a workspace singleton. Legacy delegation is blocked on ACP and cannot simply
  be re-enabled. Upstream skill store/import/review/integrity is reusable, but ACP
  conversation cwd differs from skill workspace: scoped MCP body retrieval plus
  dynamic indexes are required to preserve bot/project isolation.
- Worker slices completed one bounded pass each. Chief worker: new
  `shared/colonie-chief.ts`, `server/colonie/chief/{store,manager,routes}.ts` + tests,
  `src/components/{ChiefControls,ChiefActivity}.tsx` + tests. Skills worker: new
  `shared/colonie-skills.ts`, `server/colonie/skills/{service,routes}.ts` + tests,
  `src/components/bot-settings/ColonieSkillsSection.tsx` + test. Lead held all
  existing shared files and integration. Combined worker suites: **49 passed / 8 files**.
- Lead integration (existing shared files): `shared/connected-apps.ts` gains the
  `colonie` server source; `server/contracts.ts` adds `acpSkills`, `acpAssignment`,
  `acpChief`; `server/index.ts` instantiates `ColonieSkills` + `ColonieChief`,
  merges the connected-tools and Colonie workspace tool mounts into one ACP mount,
  passes a dynamic skills index plus the assignment/chief flags into each dispatch,
  registers the owner/admin Chief and per-bot skills routes, serves the internal
  `/api/internal/colonie-workspace-mcp` loopback relay, runs child assignments under
  their own ACP conversation (`runColonieAssignment`), and cancels exact work on Stop,
  bot deletion and shutdown. `server/devone/context.ts` composes the skills index and
  Chief/assignment sections dynamically, never on stable pins. `server/store.ts`
  elects one workspace Chief: the first seeded bot, or the oldest bot on an upgraded
  workspace without one.
- Memory boot hardening: an unreadable ledger no longer aborts startup. The store is
  constructed in a guarded block; on failure memory is explicitly unavailable (recall
  off, panel reports unavailable, mutations refused) and the existing data is left
  untouched. The known M9-A startup gap is closed.
- Real React mounts: `ChiefControls` + `ColonieSkillsSection` + `ColonieMemorySection`
  in the normal Simple bot profile and the full ACP sections; `ChiefActivity` above the
  Chief's own conversation. Fixed invalid theme tokens (`border-line`/`bg-surface`)
  the worker used, to the app's real `border-hairline`/`bg-card` tokens.
- Actual checks under Node 25.8.1:
  - `pnpm typecheck` — **passed**; `pnpm lint` (oxlint --deny-warnings) — **passed**;
    `pnpm build` (production renderer + server) — **passed**.
  - `pnpm exec vitest run server/store.test.ts server/colonie/
    server/devone/memory.e2e.test.ts server/devone/context.e2e.test.ts
    server/devone/context-integrity.test.ts server/devone/conversations.e2e.test.ts
    src/components/BotSettingsDialog.simple.test.ts src/components/ChatView.controls.test.ts`
    — **289 passed across 22 files**.
  - `server/colonie/chief/chief.e2e.test.ts` — **2 passed**, both providers, canonical
    disposable SDK/HTTP fixtures: the seeded first bot is the workspace Chief; a
    second bot is created and the role transfers (still exactly one Chief, stale
    revision 409); an owner-authored guide reaches a real ACP turn's receipt as a
    bounded, named `skills.index` section with `colonie_workspace` mounted in the
    connected-tools receipt; a disabled guide is excluded from the next dispatch.
  - The same e2e now drives a **real delegated task through the model**: the Chief
    sends `mcp call colonie_workspace ask_bot {...}` in an actual ACP turn, the fixture
    raises the tool permission which the test allows over HTTP, the child bot runs in
    its own freshly created conversation, and the child's reply flows back as the
    assignment result. Inspected evidence: worker task count 1→2, assignment status
    `completed` with result `1: Reply with the exact word PONG.`, and a recorded
    `colonie_workspace` `ask_bot` completed tool call. Re-sending the same `requestId`
    replays the recorded result idempotently and creates no second child conversation.
- Real renderer check — `node scripts/colonie/chief-skills-ui-check.ts` and
  `--claude` — **both passed** against the canonical SDK fixture and the actual React
  app: the seeded bot's profile shows the Chief card, a guide is created and listed
  through the normal profile, an enabled guide reaches a real dispatch receipt as a
  `skills.index` section, turning the guide off from the profile excludes it from the
  next dispatch, and the user's own message bytes are preserved. Evidence:
  `.devone/evidence/{claude-,}chief-skills-renderer-check.json`.
- Verification caught and fixed a real integration bug: two tool mounts (connected
  apps + Colonie workspace) were merged into one wrapper whose `release` released
  shared sub-leases, so the second message in a conversation failed with
  `Connected app access changed`. The ACP runtime now carries independent mounts
  (`acpTools` + `acpExtraTools`), activates/releases each, and on session rebuild
  releases only the mounts the next turn does not reuse. Both-provider renderer and
  HTTP/SDK checks pass again after the fix.
- Actual boundaries now: the child ran on the SDK fixture (simulated provider), not a
  real model; permission-waiting/Stop propagation for a child is covered by manager
  unit tests with injected deps. The production packaged desktop workflow and a
  bounded real-provider Chief/skills check remain unverified (packaging writes the
  shared `release/` artifact and is deferred until parallel work confirms it is free).
  Group chat is explicitly deferred.

## M9-A — complete controlled memory (implemented; isolated workflows verified)

- Owner approved full automatic memory before Chief delegation, with detailed
  lead planning and Herdr/OpenCode delegation using
  `9router/alitp-intl/deepseek-v4.1-flash`. Plan:
  `docs/plans/2026-10-11-colonie-memory.md`. Model availability confirmed with
  `opencode models 9router`; worker `memory-worker` in `w2M:pA`. No provider
  configuration or credential contents were changed/read.
- Ownership confirmed with the onboarding/branding lead (`w2M:p1`). Worker writes
  only new memory modules, shared types and a new UI component; lead owns narrow
  ACP/contracts/index/bot-panel wiring and final review. Onboarding, App,
  SettingsModal and locales are outside this slice. No shared-tree git restoration
  was performed. The owner subsequently requested committing all memory changes.
- Lead has added dynamic memory composition separate from stable context pins,
  independent bounded ACP background analysis, normal profile integration and
  source-correlated capture wiring. Worker handoff and lead integration/review are
  complete. Product guide: `COLONIE-MEMORY.md`; recipe:
  `verification/colonie-memory.md`.
- Actual check under Node 25.8.1:
  `PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm exec vitest run
  server/devone/codex-acp.test.ts` — **22 passed**. Real-SDK simulated-provider
  tests additionally prove separate analysis sessions/events, cleanup, tool-output
  refusal, cancellation and preservation of the normal user's native session.
  This is runtime-boundary evidence only, not automatic-memory/renderer/desktop or
  real-model evidence on its own.
- Review found and fixed an actual revision bug: automatic changes initially did
  not advance the public revision, so the stale-edit HTTP check returned 200 rather
  than 409. Public content revision plus owner-edit generation now invalidates
  stale editors without discarding valid queued sibling captures. The final store
  has atomic rollback/one-commit capture, source updates, key/text suppression,
  cloned views, bounded source/context/ledger sizes and late-result cancellation.
  Lead fixes additionally cover renderer draft/request guards, saved automatic-off
  compatibility, accurate workspace-control labels, scope/expiry-preserving edits,
  malformed-response status, bounded analyzer cancellation and thread-scoped Stop.
- Actual focused checks (all with the Node path above):
  - `pnpm exec vitest run server/colonie/memory/
    src/components/bot-settings/ColonieMemorySection.test.ts
    server/devone/context.e2e.test.ts server/devone/context-integrity.test.ts
    server/devone/application.e2e.test.ts server/devone/codex-acp.test.ts
    src/components/BotSettingsDialog.simple.test.ts` — **91 passed / 11 files**.
  - Final durable-job/storage/Stop follow-up:
    `pnpm exec vitest run server/colonie/memory/
    src/components/bot-settings/ColonieMemorySection.test.ts
    server/devone/conversations.e2e.test.ts` — **48 passed / 7 files**. Runs
    overlap; their test counts are not added together.
  - `pnpm exec vitest run server/devone/memory.e2e.test.ts` — **2 passed**, one
    per provider. Canonical disposable SDK/HTTP fixtures prove capture, scoped
    recall, source quotes, fresh native sessions, immediate correction/provenance,
    stale edit 409, natural-language forget/suppression, off and full server restart
    with stable profile pins. Log/action-result paths are printed by the tests.
  - Final `pnpm lint`, `pnpm typecheck`, `pnpm i18n:check` (3708 English strings)
    and `git diff --check` — **passed**. An earlier typecheck command timed out
    with a package-manager network notice; direct TypeScript and the later normal
    command passed. Failed attempts are not counted as passes.
- `node scripts/colonie/memory-ui-check.ts` — **passed**, actual React UI with SDK
  simulation: automatic capture, profile, competing edit/draft retention,
  refresh/save, Forget, Add, off/re-enable, retained review and new-conversation
  recall. `node scripts/colonie/memory-ui-check.ts --desktop --claude` — **passed**
  with isolated development Electron/preload. Earlier recipe failures were ambiguous
  Refresh/New conversation locators, alertdialog versus dialog, and premature send
  during a new-thread transition; locators and transition waits were corrected.
  One concurrent source fixture startup timed out with an empty log; a later run
  passed without relaxing its timeout. Evidence:
  `.devone/evidence/{memory-renderer,claude-memory-desktop}-check.json` and screenshots.
- `node scripts/colonie/memory-provider-check.ts --real --claude` — **passed**:
  two analysis/five foreground requests, inherited CLI auth, disposable data/workspace,
  and no accepted tool activity. Claude captured a synthetic preference, recalled
  it in another native session, corrected the same entry/source, recalled the new
  value, then answered UNKNOWN in a fresh session after owner deletion. The first
  recipe rejected an old codename appearing as a historical qualifier; the corrected
  contract checks one active preference and the actual current-value answer.
  Receipts show `Silverwren, replacing Amberfinch`, not two active conflicting facts.
  Evidence: `.devone/evidence/claude-acp-memory-real-check.json`. This is bounded
  real-provider ACP evidence, not a real-provider packaged sign-in check.
- Final `pnpm colonie:package` — **passed**, rebuilding
  `release/colonie/mac-arm64/Colonie.app` after storage and Stop changes.
  `node scripts/colonie/memory-package-check.ts` and `--claude` both **passed**
  against that exact production artifact: actual Electron/bundled renderer/server,
  capture/profile, distinct-session recall, full app restart with the same session/
  pin, then UI memory-off and another restart with retained review/no recall block.
  Renderer errors are empty. Evidence:
  `.devone/evidence/{claude-,}memory-packaged-fixture-check.json`. Screenshots and
  synthetic real-provider receipts were inspected. Artifact ownership was
  coordinated with the onboarding lead; its source changes are preserved.
- Remaining boundaries: real Codex memory is unverified while its latest quota
  blocker remains; no real-provider packaged sign-in was exercised. Retrieval is
  bounded preference/word-overlap recall, not universal semantic search. Manual
  edits outrank automatic correction; old native prompts cannot be erased by
  Forget. Legacy Markdown memory is retained separately. No full upstream suite or
  live-app mutation was performed. M9-A's recorded
  acceptance scope is complete. Next: M9-B detailed Chief-delegation contract,
  scoped task context, result routing, Stop and duplicate-work guards.

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
synthetic checks on this machine. Memory is now implemented as M9-A with its
evidence above; Chief delegation and automation remain subsequent milestones.
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


## 2026-10-14 — VPS commissioning completed; owner engine sign-in is next

Scope: finish HANDOVER step 1 only. No provider sign-in, credentials request,
real-provider turn, onboarding changes, or publication. Followed the owner's
explicit instruction to consult HANDOVER rather than the other product docs.

### Build observation

- `ssh colonie-vps 'pgrep -f "colonie:build:server|vite build|tsc |stage-runtime" >/dev/null && echo building || tail -5 /opt/colonie/build.log'`
  printed `building`. This pattern can match the remote shell running the probe.
- Follow-up: `ssh colonie-vps 'ps -eo pid,ppid,user,etimes,args | grep -E "[c]olonie:build:server|[v]ite build|[t]sc |[s]tage-runtime"; tail -15 /opt/colonie/build.log; du -sh /opt/colonie/app/dist /opt/colonie/app/dist-server'`.
  No matching build process remained. The final log entries were both successful
  staging manifests: Linux/x64, codex-acp 2.1.1 / Codex 0.159.3 and claude-acp
  0.88.0 / SDK 0.3.293. `dist` was 15M; `dist-server` was 20M.
  The original build process exit status was not available; this observation
  alone is not claimed as proof of a complete agent workflow.
- VPS Node: v24.21.0. VPS source revision, read as user `colonie`:
  `e86662b281cbf9d0e9e4042a2e7962ddde71e8c8`. Local starting revision:
  `744da8df48f27fd062e2595234d363bba6af0713`. No source pull or push performed.

### Isolated Linux HTTP pairing evidence (no agent turn)

Added `scripts/colonie/verify-headless-pairing.mjs`, then ran its contents on
VPS as the service user:

```bash
ssh colonie-vps 'cd /opt/colonie/app && runuser -u colonie -- /usr/bin/node --input-type=module' < scripts/colonie/verify-headless-pairing.mjs
```

Exit 0. Fixture: `/tmp/colonie-headless-pairing-SQXm1e`, app port 44043,
webhook port 46827. HOME, XDG directories, temporary files, and both server
and provider data directories belonged to the disposable fixture. The child
received an explicit environment, not the operator's authentication or keys.
No login or message endpoint was called. All fixture processes stopped and
its temporary directory was removed.

Observed results:

| Check | Result |
| --- | --- |
| Raw `server/index.ts`, `service`, no session: config, instances, sessions, usage | All HTTP 403 |
| Same server: create initial pairing code | HTTP 403; cannot bootstrap itself |
| `owner`: create and redeem admin pairing into a browser cookie | HTTP 200 / 200; admin + client scopes |
| `owner`: create and redeem client pairing into a browser cookie | HTTP 200 / 200; client scope |
| Restart same fixture data in `service`: paired admin reads config | HTTP 200 |
| Same restart: paired client reads bots | HTTP 200 |
| Paired client tries creating another pairing | HTTP 403 |
| Paired admin creates another pairing | HTTP 200 |
| Separate clean fixture, `openmausbot serve`, `service`: CLI bootstrap code redeemed | HTTP 200; admin + client scopes |
| CLI fixture: paired cookie reads config; sessionless pairing creation | HTTP 200 / 403 |

Decision: keep the repository unit's default `service` setting for shared use.
For this single-owner commissioning, the installed unit deliberately has
`/etc/systemd/system/colonie.service.d/10-single-owner.conf` overriding it to
`OMB_LOOPBACK_TRUST=owner`. The existing raw-index unit has no startup pairing
capability; choosing `service` without preparing an admin session would leave
the owner unable to bootstrap access. Headless pairing itself works: the
supported CLI `serve` path supplies its own limited pairing capability, or an
admin can pair in `owner` and that session survives transition to `service`.

**Before a second person gets access:** prepare and confirm an admin paired
session, remove the single-owner override, restart, and confirm paired access
plus rejection of sessionless administrative requests. That transition has
only been tested in disposable data, not performed on the owner's workspace.

### Installed server evidence

Installed `/opt/colonie/app/scripts/colonie/colonie.service` as
`/etc/systemd/system/colonie.service`. `systemd-analyze verify` found the original
`StartLimitIntervalSec` in the wrong section and ignored it. Moved both start
limit settings to `[Unit]` in the installed file and the local source template.
Verification of the installed unit then exited 0 without warnings.

Commands:

```bash
ssh colonie-vps 'systemd-analyze verify /etc/systemd/system/colonie.service && systemctl daemon-reload && systemctl enable --now colonie'
ssh colonie-vps 'curl -sf http://127.0.0.1:18891/api/health; systemctl show colonie -p ActiveState -p SubState -p UnitFileState -p MainPID -p NRestarts -p StartLimitBurst -p StartLimitIntervalUSec; ss -ltnp "( sport = :18891 or sport = :18892 )"'
ssh colonie-vps 'systemctl restart colonie'
ssh colonie-vps 'curl -sf http://127.0.0.1:18891/api/health; systemctl show colonie -p ActiveState -p SubState -p MainPID -p NRestarts; ss -ltnp "( sport = :18891 or sport = :18892 )"'
```

Readiness was polled up to 20 times with a one-second interval after startup
and restart. Before restart: PID 10597, `active/running`, `enabled`,
`NRestarts=0`, `StartLimitBurst=5`, `StartLimitIntervalUSec=2min`; health reported
`static:true`. After explicit restart: PID 10878, `active/running`,
`NRestarts=0`, health again reported `static:true`. Both ports listened only on
127.0.0.1. GET `/` and `/pair` returned HTTP 200 initially; GET `/` returned
HTTP 200 after restart. Effective trust was confirmed as `owner`.

No application mutation was tested against `/opt/colonie/data`. Production
checks were health/static responses, listening sockets, and service state.
Automatic startup is configured (`enabled`); an actual VPS reboot was not tested.

### Validation and next action

- Ran bundled Codex `login --help` and bundled Claude `auth login --help` as
  user `colonie`, exit 0. Codex supports `--device-auth`; Claude supports
  `auth login`. Help commands do not sign either engine in. The owner commands
  below use the already staged binaries and isolated provider directories;
  Codex device sign-in avoids requiring a browser callback tunnel to the VPS.
- VPS oxlint on the verification script: **0 warnings, 0 errors, 1 file**, exit 0.
  Local `git diff --check`: exit 0. The local `pnpm exec oxlint` attempt stalled
  and was interrupted (exit 130); its newly created scratch store was removed.
- Not verified: provider login success, a real Linux agent turn, renderer
  interaction or pairing UI, desktop cloud mode, teammate access, a VPS reboot,
  and download publication. HTTP 200 and successful pairing are not evidence
  that an agent can reply.

Next action belongs to the owner (HANDOVER step 2). Run these personally:

```bash
ssh colonie-vps
sudo -iu colonie
export OMB_DATA_DIR=/opt/colonie/data
CODEX_HOME="$OMB_DATA_DIR/native/codex" node /opt/colonie/app/dist-devone/codex-acp/node_modules/@openai/codex/bin/codex.js login --device-auth
CLAUDE_CONFIG_DIR="$OMB_DATA_DIR/native/claude" /opt/colonie/app/dist-devone/claude-acp/claude-native auth login
```

Stop here until owner sign-in is complete. Then HANDOVER step 3 must prove one
bounded real turn in a disposable working folder through the server, separately
from the HTTP evidence above. No commit or push was made in this session.


## 2026-10-14 — Owner sign-in confirmed; real Linux Codex turn passed, Claude quota blocked

The owner personally completed Codex device sign-in and Claude `auth login`,
then reported success for each. The agent did not initiate any login or request,
read, copy, or display credential contents. File-existence checks confirmed the
expected authentication paths existed; file existence alone was not treated as
proof of sign-in. The isolated server's ACP snapshots subsequently reported
both providers `available` and `authenticated:true`.

Added `scripts/colonie/verify-real-turn.mjs`. This verifies the actual deployed
HTTP message route -> maintained ACP adapter -> real provider -> persisted
conversation and application-authored prompt receipt. It is not the simulated
fixture suite and does not merely call the CLI directly. Each provider request
is bounded to 90 seconds, asks for one exact marker, and forbids tool/file/network
actions. Tool permission requests are denied. New temporary app state and bot
workspaces are created for every run. App awareness and bot persona remain at
their defaults; no production configuration or conversation is changed.

Existing native authentication is inherited through file-only symlinks into the
fixture's provider homes. The script does not read or copy the files. The
transient systemd unit makes `/opt/colonie/data` read-only and the whole system
read-only, with private writable temporary directories, so fixture engines
cannot rewrite the owner's login files or application data. Both engines and
the fixture run as `colonie`; native sessions and transcripts are temporary.

Actual upload and first execution:

```bash
ssh colonie-vps 'cat > /run/colonie-real-turn-check.mjs && chmod 644 /run/colonie-real-turn-check.mjs && systemd-run --unit=colonie-real-turn-check --wait --pipe --collect -p User=colonie -p Group=colonie -p WorkingDirectory=/opt/colonie/app -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=true -p NoNewPrivileges=true -p ReadOnlyPaths=/opt/colonie/data -p RuntimeMaxSec=240 /usr/bin/node /run/colonie-real-turn-check.mjs --real --auth-root /opt/colonie/data/native' < scripts/colonie/verify-real-turn.mjs
```

Three attempts were made, at approximately 03:46–03:47 WIB on October 14
(20:46–20:47 UTC on October 13):

1. Initial fixture `/tmp/colonie-real-turn-8bzIsn`, ports 40321/33943.
   Codex produced `COLONIE_CODEX_LINUX_OK` and its receipt was `completed`
   after 4,286 ms. The checker incorrectly concatenated the app's pre-existing
   greeting, `Hi! What would you like help with?`, with the new answer and exited
   1 before attempting Claude. This was a checker bug, not a provider failure.
   Corrected it to exclude message IDs that already existed before dispatch.
   Added `--provider` so one provider can be checked without repeating the other.
2. Reuploaded the corrected script and ran the same unit command with
   `--provider claude-acp`. Fixture `/tmp/colonie-real-turn-kBn6sU`, ports
   44039/39151. Claude failed after 4,297 ms with:
   `You've hit your session limit · resets 10:10pm (UTC)`.
   Receipt status `failed`, native model/mode `default/default`; thread and
   prompt were recorded. Exit 1. This is quota evidence, not a successful turn.
   The provider's reported reset corresponds to 05:10 WIB on October 14.
   No additional Claude requests were made after that response.
3. Ran the corrected unit with `--provider codex-acp`. Fixture
   `/tmp/colonie-real-turn-Y2s8Hx`, ports 36601/37559. **Exit 0**; answer exactly
   `COLONIE_CODEX_LINUX_OK`, receipt `completed`, elapsed 4,598 ms. Native model
   `gpt-6.1-sol`, mode `read-only`, effort `low`, fast mode `off`.
   Thread `62b7d2f5-aa4f-4d52-8151-b6ced9eb0228`; turn
   `45d86295-0408-4bc5-ac3e-b2b88e0dac89`; native session
   `01a13704-c924-7273-9e51-c5edca312289`.

Exact user request (the final prompt block was checked for byte equality):

```text
Reply with exactly COLONIE_CODEX_LINUX_OK. Do not use tools, read files, write files, or make network requests. This is a bounded connectivity test.
```

The successful receipt also preserves the full app identity, effective
capabilities, bot name, and enabled-guides blocks before the literal user
request. No app-managed tools were mounted and `connectedToolCalls` was empty.
All returned observations and full application-authored prompt receipts,
including both failed checks, are saved locally in
`.devone/evidence/vps-real-turn-2026-10-14.json` (ignored by Git, mode 0600).
No credential contents are included.

Validation/cleanup:

- VPS source remained `e86662b281cbf9d0e9e4042a2e7962ddde71e8c8`;
  Node v24.21.0, Linux/x64, same staged adapters as commissioning.
- VPS oxlint: `node node_modules/oxlint/bin/oxlint --deny-warnings /run/colonie-real-turn-check.mjs`:
  0 warnings, 0 errors, 1 file, exit 0.
- All three temporary roots removed; the transient systemd unit became inactive
  and its cgroup was stopped. Removed the uploaded `/run` script after testing.
- Main `colonie` service remained `active/running`, PID 10878, `NRestarts=0`;
  its health response still reported `static:true`. No service restart needed.
- Local `git diff --check`: exit 0. No commit or push performed.

For the owner's next manual interaction, started a loopback-only SSH tunnel on
the Mac, in exec session 11990:

```bash
ssh -N -L 127.0.0.1:18991:127.0.0.1:18891 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 colonie-vps
```

Port 18991 was checked unused first, avoiding any installed local app on 18891.
`curl -sf --max-time 5 http://127.0.0.1:18991/api/health` reached the VPS service;
`lsof` confirmed SSH listened only on 127.0.0.1:18991. The owner can open
`http://127.0.0.1:18991` while this tunnel remains alive. This manual production
access is offered for intended owner use, not used for automated mutation tests.

Not verified: a successful Claude response (quota blocked), a real turn in the
production conversation store, renderer/desktop interaction, tools or file
operations, real-provider continuation after restart, teammate access, and
publication. No claim of a complete shared desktop workflow is made.

Next concrete action: owner opens the forwarded browser UI and uses Codex;
repeat only the bounded Claude fixture after its provider quota resets. Then
continue HANDOVER step 4 (local/cloud onboarding and desktop connection), and
prepare paired admin access + service trust before giving anyone else access.


## 2026-10-14 — Public IP HTTPS and owner phone pairing prepared

Owner request: access Colonie from a phone, using the existing VPS IP because
there is no owned domain. No domain purchase, DNS changes, provider sign-in,
or additional provider turns were performed.

Current official documentation confirms public IP certificates are available:
[Let's Encrypt IP certificate availability](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)
and [Caddy ACME profile configuration](https://caddyserver.com/docs/caddyfile/directives/tls).
IP certificates require the `shortlived` profile. This deployment uses Caddy's
native issuance and renewal; it does not install a private CA on the phone.

### Installed gateway and access mode

- Downloaded the existing source-pinned Caddy 2.11.4 via `ensureCaddy` from
  `server/caddy.ts`, with its pinned SHA-512 check. Installed the binary as
  `/usr/local/bin/colonie-caddy`, root-owned, mode 0755.
- New dedicated system user/group `colonie-https`. Gateway state and certificate
  keys live under `/var/lib/colonie-https`, mode 0700, owned by that user.
  The gateway does not share the engine user's authentication directories.
- Installed `scripts/colonie/colonie-https.service` to systemd and
  `scripts/colonie/Caddyfile.ip` as `/etc/colonie/Caddyfile`.
  `/etc/colonie/https.env` supplies `COLONIE_PUBLIC_IP=172.104.33.55`.
  The gateway is enabled, uses only CAP_NET_BIND_SERVICE, and has a read-only
  system with writable dedicated TLS state. Its administrative API is disabled.
- HTTPS binds the public IPv4 address on 443 and proxies to the existing
  127.0.0.1:18891 app listener with immediate SSE flushing. Port 80 redirects to
  HTTPS and supports ACME validation. The app and webhook listeners remain
  loopback-only. No webhook ingress was added.
- Updated the app unit's launcher to the maintained `openmausbot serve` CLI,
  which supplies its child the existing private stdin capability and can mint
  the initial owner pairing code under `service` trust. This bootstrap was
  proven in isolated fixtures; no reusable admin token is added to the unit.
  The local source unit and installed unit both use this launcher.
- Removed `/etc/systemd/system/colonie.service.d/10-single-owner.conf` and set
  `OMB_PUBLIC_URL=https://172.104.33.55` in `20-public-access.conf`. Effective
  `OMB_LOOPBACK_TRUST` is now `service`, including all sessionless bot loopback
  calls. New owner bootstrap invitations appear in the service journal; a
  successfully paired admin can create later device invitations through UI.

Initial gateway attempts failed with systemd `203/EXEC` / Permission denied:
Caddy's source download directories were root-only, and the later dedicated
user could not traverse `/opt/colonie` (0750). Corrected by installing the
root-owned executable under `/usr/local/bin` and moving TLS state to
`/var/lib/colonie-https`; the owner's parent-directory permissions were not
relaxed. Reset the failed unit and verified the corrected service. The first
external probe timed out during those failed starts; this is not omitted from
the evidence. Later probes succeeded.

### Isolated HTTPS pairing verification

The public gateway initially served a maintenance response on 443 and a
separate, temporary TLS fixture route on 19443 -> 127.0.0.1:19491. This allowed
real TLS/proxy/session testing without mutating the owner's app state.

Extended `scripts/colonie/verify-headless-pairing.mjs` with `--port` and
`--public-origin`. Actual command after uploading it to `/run`:

```bash
ssh colonie-vps 'systemd-run --unit=colonie-public-pairing-check --wait --pipe --collect -p User=colonie -p Group=colonie -p WorkingDirectory=/opt/colonie/app -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=true -p NoNewPrivileges=true -p ReadOnlyPaths=/opt/colonie/data -p RuntimeMaxSec=240 /usr/bin/node /run/colonie-public-pairing-check.mjs --port 19491 --public-origin https://172.104.33.55:19443'
```

Exit 0. Fixture root `/tmp/colonie-headless-pairing-JAMJEy`, ports 19491/42003,
Linux/x64, Node v24.21.0. The existing raw-service, owner-pairing, paired-session
restart, client/admin scope, and CLI-service bootstrap checks all passed again.
Additional checks through the actual HTTPS Caddy proxy:

| Check | Observed |
| --- | --- |
| Redeem disposable pairing code into browser cookie | HTTP 200 |
| Session cookie attributes | Secure and HttpOnly |
| Paired admin reads fixture config over HTTPS | HTTP 200 |
| Sessionless config / pairing creation | HTTP 403 / 403 |
| Spoofed localhost Host and forwarded protocol | HTTP 403; no config exposed |
| Paired cookie with a foreign Origin attempts pairing mutation | HTTP 403 |

Only fixture pairings were redeemed by the agent. No user-provider credentials
were inherited by this fixture, and no real provider requests were made.
The fixture and its transient service were stopped, its temporary root removed,
and the uploaded `/run` script removed. The temporary public 19443 listener and
loopback 19491 route were removed before switching to the owner's main app.
VPS oxlint: 0 warnings, 0 errors, 1 file, exit 0. `git diff --check`: exit 0.

### Production read-only evidence

Both installed units passed `systemd-analyze verify`; Caddy validated the final
configuration. After restarting the app into service mode and restarting the
gateway with its final config:

- App: active/running, CLI PID 15302, actual server PID 15310, NRestarts=0.
  Its journal confirmed an initial pairing code was generated (value redacted).
  Sessionless direct-loopback GET `/api/config` returned HTTP 403.
- Gateway: active/running, enabled, PID 15636, NRestarts=0.
- Listening sockets: public IP 80/443; 127.0.0.1 app 18891 and webhook 18892;
  no 19443 or 19491 listener remains.
- From the owner's Mac, using the public IP rather than the SSH tunnel:

```bash
curl -sS --max-time 10 -o /tmp/colonie-ip-page.html -w 'Public app HTTP %{http_code}; TLS verify %{ssl_verify_result}\n' https://172.104.33.55/
curl -sS --max-time 10 -o /dev/null -w 'Public config without session HTTP %{http_code}\n' https://172.104.33.55/api/config
curl -sS --max-time 10 -o /dev/null -w 'Public pairing page HTTP %{http_code}\n' https://172.104.33.55/pair
curl -sS --max-time 10 -o /dev/null -w 'HTTP redirect %{http_code}; next %{redirect_url}\n' http://172.104.33.55/
openssl s_client -connect 172.104.33.55:443 < /dev/null 2>/dev/null | openssl x509 -noout -issuer -dates -ext subjectAltName
```

Results: app HTTP 200, TLS verify 0; config HTTP 403; pairing page HTTP 200;
HTTP 308 to the same IP over HTTPS. Public certificate issuer Let's Encrypt
YE2, IP SAN 172.104.33.55, valid October 13 20:00:22 UTC through October 20
12:00:21 UTC. Caddy renewal is configured; an actual future renewal and VPS
reboot have not been observed.

Detailed non-secret evidence is retained in
`.devone/evidence/public-ip-pairing-2026-10-14.json` (Git-ignored, mode 0600).
Production writes were deployment configuration and the application's own
startup invitation, not automated test conversations or session redemption.
No owner invitation is included in docs or evidence artifacts.

Browser QA attempt: the computer-use tool reported that IAB was unavailable;
its browser inventory was empty. Therefore rendering is not claimed. Neither
physical phone pairing nor an actual phone conversation has yet been verified.
Codex's earlier isolated real-provider success still stands; Claude's earlier
session-quota blocker was not retried. Desktop cloud onboarding and publication
remain unfinished. No commit or push was made.

Historical next action: owner opens the current, single-use pairing link on the phone and
presses Connect, then uses a Codex-backed bot. The link expires five minutes
after app startup and works for one browser. Retain only a redacted invitation
record. If it expires before the first admin browser pairs, the CLI startup
bootstrap can be reissued by a controlled app restart; once paired, the admin
UI can generate future invitations without restarting the workspace.

Owner invitation refresh: the first startup invite had only 92 seconds left after deployment verification. Performed one controlled `systemctl restart colonie` to issue a fresh five-minute invitation for the owner; health returned and the pairing page remained available over verified HTTPS. Read the invitation only from the current systemd invocation, preventing selection of an older code. No invitation value is retained in docs or evidence, and no production invitation was redeemed by the agent.

## 2026-10-14 — Multi-workspace implementation authorized

The owner approved the product direction in `WORKSPACE-PLAN.md`, supplied
infrastructure credentials, and explicitly asked to proceed with all work.
They also requested delegating suitable work to DeepSeek through Herdr to
reduce OpenAI token use. Three DeepSeek workers were started in a balanced
four-pane layout in the existing workspace: Cloud API, responsive account/chat
UI, and Local workspace registry/supervision. No separate checkout was created.
They received code tasks and synthetic test requirements, not infrastructure
credentials, native authentication files, or customer data.

Credentials are saved outside the repository in an owner-readable private
configuration directory (directory 0700; file 0600). They are consumed by
scripts without printing their contents. `pnpm add -w better-auth pg
@neondatabase/serverless` and `pnpm add -Dw @types/pg` completed successfully;
the earlier root-workspace guard rejected the first install attempt and no
success was claimed from it.

An isolated read-only Node/pg connectivity probe consumed the private Neon
configuration and executed `select current_database(), current_user(),
version()`. Actual result: connected=true, database=neondb, PostgreSQL 17.11.
No schema migration or application write was performed by this probe. This
proves database connectivity only, not signup, invitations, persistence,
chat, tenant isolation, or a real provider turn.

The current Cloud runtime implementation uses the maintained ACP SDK and
Claude adapter with `tools: []`, `settingSources: []`, no filesystem/terminal
capabilities, a minimal child environment, and separate conversation roots.
This policy is supported by the installed maintained adapter's implementation;
it is not yet evidence from a running provider. Local execution keeps the
existing maintained ACP boundary. Exact application input is saved before
dispatch. Provider success, renderer flows, Mac app integration, R2 operations,
Composio provisioning, and the new production deployment are not yet verified.

Next: finish and review the delegated API/UI/Local changes; run isolated
fixture and PostgreSQL account/conversation checks; connect the Cloud runtime
and native desktop bridge; then evaluate deployment from those results.

### Isolated implementation verification and delegation interruption

Executed from the repository with `/opt/homebrew/opt/node@24/bin` prefixed to
PATH (the resolved Node executable reports v25.8.1):

```bash
pnpm exec vitest run server/colonie/platform/platform.test.ts server/colonie/platform/runtime.test.ts
pnpm exec vitest run src/lib/colonie-platform.test.ts src/components/colonie-platform/platform-flow.test.ts
node --test electron/colonie-workspaces.node-test.mjs electron/colonie-workspaces-credentials.node-test.mjs electron/colonie-platform.node-test.mjs
```

Actual results: backend/runtime 27/27 passed; renderer/client 25/25 passed;
Local registry, process supervision, vault and account-controller 26/26 passed.
These use synthetic accounts, isolated directories and deterministic providers.
Renderer tests prove simulated interactions, not production browser/phone or
packaged Mac behavior. ACP fixture tests prove exact per-DM input receipts,
separate context, disabled built-in tools, denied permissions, secret-free child
environment, cancellation and rejection of results after revocation.

Review found and corrected initial live-event routing and replay authorization
problems: workspace routing is now explicit, every replay record is audience
checked, and an owner's workspace role does not expose private DMs or another
member's personal connection metadata. The fixture tests cover these rules;
their PostgreSQL/live-provider equivalents are still pending.

The real Neon workflow command is:

```bash
node --experimental-transform-types scripts/colonie/verify-platform-neon.ts --infra-file /Users/riaenriala/.config/colonie-development/infra.json
```

It creates a random `colonie_fixture_*` schema, temporary files, and synthetic
accounts; it drops that schema and removes its files in cleanup. Both first
runs proved four independent Better Auth signups without email verification
and working cookie sessions. Run 1 then failed because the verification script
incorrectly expected HTTP 201 while the published API returns HTTP 200; the
checker was corrected. Run 2 failed on invitation acceptance with HTTP 500
while the delegated source files were being changed. It is not reported as a
successful invitation or full database workflow. A stable-source rerun with
sanitized fixture-only diagnostic output is the next check.

The DeepSeek backend CLI exited with `ClientError: Transport: The operation
timed out`; its files and session were preserved. Verified its pane had returned
to zsh, then restarted the same `ses_ec8c99f8effej2sN5HU7lLK92O` session via
Herdr. UI and Local agent processes were separately verified still running.
No unrelated user's panes or workspaces were modified. A restarted agent or a
worker's completion report is not workflow evidence.

Cloud/native integration code is present but is not yet claimed as a completed
Mac journey. Ordinary signup replaces pairing in the new platform shell;
the existing production service remains running and has not been replaced.
No new production account/conversation was created by these tests. Actual Cloud
AI, Composio OAuth/provisioning, Group proactivity, packaged desktop, physical
phone use, and the complete release remain unverified or unfinished.

### Neon, real Cloud provider and renderer milestones

The stable-source isolated Neon workflow passed. The later recovery-enabled
run used this command with a private configuration file (contents never printed):

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH node --experimental-transform-types scripts/colonie/verify-platform-neon.ts --infra-file /Users/riaenriala/.config/colonie-development/infra.json
```

Actual results in `/tmp/colonie-neon-workflow-recovery.log`: four independent
Better Auth accounts, signup without email verification, Cloud invitation
acceptance into the intended workspace, cross-workspace denial, human DM
reads limited to participants (including owner-denied replay), private Group
audiences, masked personal connection metadata hidden from the workspace
owner, persistence after host restart, removed-member denial, and one-time
account recovery with old-password/session rejection. This is real PostgreSQL
and auth evidence; the ordinary bot runtime in this run is simulated. The
random fixture schema and files were removed in cleanup.

Copied source to a separate `/opt/colonie/platform-app` on the VPS, installed
dependencies there, and executed one bounded real Cloud turn with the owner's
existing native Claude authentication mounted read-only:

```bash
ssh colonie-vps 'systemd-run --unit=colonie-platform-real-check --collect --wait --pipe --property=User=colonie --property=Group=colonie --property=WorkingDirectory=/opt/colonie/platform-app --property=ProtectSystem=strict --property=PrivateTmp=yes --property=ReadOnlyPaths=/opt/colonie/data /usr/bin/node --experimental-transform-types scripts/colonie/verify-platform-neon.ts --infra-file /opt/colonie/platform-verification/infra.json --real --auth-root /opt/colonie/data/native/claude --adapter /opt/colonie/app/dist-devone/claude-acp/index.js --native-cli /opt/colonie/app/dist-devone/claude-acp/claude-native'
```

Actual result: maintained `claude-acp` returned exactly
`COLONIE_PLATFORM_CLAUDE_OK`; the reply persisted in the disposable Cloud
conversation. One paid request, no engine login performed, service exit 0,
8.698 seconds, disposable schema removed. Log:
`/tmp/colonie-platform-real-provider.log`. This proves a bounded text turn,
not real external-app tools or universal runtime isolation.

```bash
pnpm exec vitest run server/colonie/platform/ src/components/colonie-platform/ src/lib/colonie-platform.test.ts server/composio.test.ts server/composio-availability.test.ts
node --experimental-transform-types scripts/colonie/verify-platform-ui.ts
node --experimental-transform-types scripts/colonie/verify-platform-ui.ts --desktop
```

Combined fixture suite: 156 tests in 8 files passed at that source milestone.
Real Chromium with synthetic identities/provider replies passed Cloud signup,
recovery-key display, workspace and first bot creation, message/reply and
reload persistence, and an invited signup that skipped workspace/engine setup
at a 390×844 viewport. Evidence: `.devone/evidence/platform-browser-ui.json`
and screenshots. This is browser rendering evidence, not a physical phone.

The initial Electron check failed on a checker selector, then another run
timed out waiting for signup. Neither was counted as success. A fresh isolated
rerun explicitly selected account mode and passed Cloud signup/chat/reload,
Local creation, opening its separate loopback server, and the main process's
account-ownership check. Evidence: `.devone/evidence/platform-native-ui.json`.
This milestone did not yet test a Local bot turn or a packaged app; the
checker is now being extended for both. All profiles and accounts are fixtures.

The UI DeepSeek mini process also exited with a transport timeout. Its pane
foreground process was verified to be zsh, then the same session was resumed.
Source changes were preserved. The API and Local workers are running scoped
follow-up reviews and the connected-tool broker. No unrelated panes were used.

Still unverified: real Composio project provisioning/OAuth/tool use (no usable
project or organization key supplied), the complete packaged Mac journey,
physical phone use, R2 delivery (endpoint/account ID unavailable), and the new
production platform deployment. The existing production app has not been
replaced. Current next action: complete Local chat/switching and connected-app
integration fixtures, then package and deploy from the verified result.

## Composio resolver + callback hardening (fixtures)

Scoped audit of `server/colonie/platform/composio.ts` plus the invitation and
replay paths. Changes:

- `completeLink` now rejects expired/failed/disconnected links (never revived
  by replay), requires a nonempty `sessionUri`, expires a pending link older
  than 10 minutes, re-checks actor membership after the awaited provider call,
  fails the link when Composio verifies a different toolkit, and re-checks the
  workspace key reference/version after the call so a swap or removal cannot
  activate. Failed validation still preserves the prior key.
- Per-workspace key mutex serializes provision/set/remove so references cannot
  cross or leak. Removed the unenforced "idempotent provisioning" claim. No
  header or state logging added.
- Server-only `resolveToolAccess(accountId, workspaceId, scope)` returns the raw
  key + `keyRef` + `keyVersion` and only active linked descriptors; personal
  scope is the caller's own identity only, shared scope resolves the service
  identity for any member (configuring a shared link stays admin-only).
  `checkToolAccess(snapshot, connection)` re-checks key ref + active link +
  membership. Neither is exposed by a route (fixture asserts 404). Root's
  `tool-provider.ts` calls both.
- Repository `acceptInvitation` re-checks revoked/expired/already-used under the
  row lock (PG and the memory fixture) and raises `InvitationConflictError`,
  which the service maps to the same 410/409 errors.
- `replay` reads one past the page and appends a `resync` frame when the page is
  truncated, so a workspace replay cannot silently skip events; private records
  are still dropped per-record.

Verification (fixtures only, no credentials, no live data):

```bash
npx tsc -p tsconfig.server.json --noEmit   # clean for platform files
npx vitest run server/colonie/platform/    # 6 files, 130 tests passed
npx oxlint --deny-warnings server/colonie/platform/composio.ts \
  server/colonie/platform/composio.test.ts server/colonie/platform/service.ts \
  server/colonie/platform/contracts.ts server/colonie/platform/pg-repository.ts \
  server/colonie/platform/memory-repository.ts \
  server/colonie/platform/platform.test.ts server/colonie/platform/index.ts   # exit 0
```

`composio.test.ts` is 51 tests and `platform.test.ts` is 32 tests; the new
fixtures cover callback hardening, key serialization, server-only tool access
(a member may use a deliberately shared grant; a revoked actor is denied),
the locked invitation re-check, and replay resync/private-event handling. The
only remaining `tsc` error is in root-owned `tools.test.ts` (`McpServer.headers`),
not touched here. Still unverified: `PgComposioStore`/`PgPlatformRepository`
against a real Postgres, the Composio callback verifier configuration, and any
real provider tool call.

## 2026-10-15 — Release checks and deployment preparation

Local onboarding now starts at the engine step after global signup. An
isolated native Mac run completed Cloud signup/first-bot chat, Local workspace
creation, maintained-SDK deterministic ACP reply `1: LOCAL_WORKSPACE_UI_OK`,
and switching back to Cloud with the Local conversation absent there. No
native engine sign-in or real Local provider request was performed.

The first packaged-app check exposed an actual lifecycle bug: a `closed`
handler accessed a destroyed BrowserWindow's webContents during switching.
The handler now captures the original contents while the window is alive.
An earlier fixture also exposed the missing `cloudHomeOrigin` clipboard
permission callback; it was fixed before packaging. Neither failure is
reported as a passing journey.

Actual commands/results:

```bash
pnpm exec vitest run server/colonie/platform/ src/components/colonie-platform/ src/lib/colonie-platform.test.ts server/composio.test.ts server/composio-availability.test.ts
node --test electron/colonie-workspaces.node-test.mjs electron/colonie-workspaces-credentials.node-test.mjs electron/colonie-platform.node-test.mjs electron/app-permissions.node-test.mjs
PLAYWRIGHT_BROWSERS_PATH=.devone/browsers pnpm colonie:build
pnpm exec electron-builder --config electron-builder.colonie.yml --mac --arm64 --publish never
node --experimental-transform-types scripts/colonie/verify-platform-ui.ts --desktop --executable release/colonie/mac-arm64/Colonie.app/Contents/MacOS/Colonie
```

At this milestone: 239 fixture tests passed in 11 files; 61 native unit checks
passed. Typecheck, complete UI/server/native-adapter build and ad-hoc signing
completed. The final isolated packaged Mac check passed Cloud signup/chat/reload,
Local creation/onboarding/ACP chat, and switching with separate histories.
Evidence: `/tmp/colonie-platform-packaged-check-final.log` and
`.devone/evidence/platform-native-ui.json`. The DM and Local provider replies
in this renderer check are simulated; it does not prove real Local login,
quarantined installation, or a physical phone.

Connected-app implementation now has a parent-held, per-turn MCP lease broker,
fixed account/identity execution, revocation checks before and after calls,
and an explicit read-action catalog for Gmail, Google Calendar and Google Drive.
Native filesystem/terminal tools remain disabled in Cloud. A maintained SDK
fixture successfully requested an approved read tool over real loopback HTTP,
returned its result through the ACP turn, and rejected the released lease.
Write/send/delete actions and arbitrary toolkit/meta execution are unavailable.
Provider key material is absent from the native child environment and MCP
schemas. Composio vendor calls in these checks are simulated.

The expanded isolated Neon check passed actual encrypted project-key storage,
failed key replacement preserving the previous key, personal callback ownership,
deliberately shared read identity accessible to ordinary members, persistence
across restart, and refusal to revive a disconnected link (HTTP 410).
`/tmp/colonie-platform-neon-app-storage-3.log` records the complete result and
disposable-schema cleanup. One earlier run timed out and is not counted as
success. This uses synthetic project keys and verifier responses, not live OAuth.

Built both Cloud host and verifier as Node 24 bundles, installed the locked
dependencies on the VPS, and ran the compiled Linux verifier under an isolated
systemd unit:

```bash
node scripts/colonie/build-platform.mjs
ssh colonie-vps 'systemd-run --unit=colonie-platform-release-check --collect --wait --pipe --property=User=colonie --property=Group=colonie --property=WorkingDirectory=/opt/colonie/platform-app --property=ProtectSystem=strict --property=PrivateTmp=yes --property=ReadOnlyPaths=/opt/colonie/data /usr/bin/node dist-platform/verify-neon.mjs --infra-file /opt/colonie/platform-verification/infra.json --real --auth-root /opt/colonie/data/native/claude --adapter /opt/colonie/app/dist-devone/claude-acp/index.js --native-cli /opt/colonie/app/dist-devone/claude-acp/claude-native'
```

Actual result: full PostgreSQL workflow passed and real Claude returned exactly
`COLONIE_PLATFORM_CLAUDE_OK`, persisted; one paid request, no engine login,
service exit 0, 10.534 seconds, disposable schema removed. The auth donor was
read-only. No real app tool was exercised by this bounded text-only check.

The separate `colonie-platform` service is now enabled and listening only at
127.0.0.1:19091. Its private production config is mode 0600 outside the repo,
uses a new `colonie_cloud_v1` schema, and has independent signing/encryption
keys. Its native auth directory contains a read-only donor link, not copied
credential bytes. Initial read-only bootstrap returned the expected platform
origin. This service startup alone is not conversation evidence; that evidence
is the isolated compiled-provider check above.

`Colonie-0.2.0-arm64.dmg` (343 MB) was uploaded to the VPS's public download
directory. The HTTPS gateway configuration validates, but the public switch
and download verification are still pending at this milestone. R2 was not used
because its endpoint/account ID is unavailable. No existing VPS conversations
were reassigned to public accounts. Live production checks remain read-only.

Next: finish the final Cloud view concurrency/provisioning checks, publish the
account shell and download over HTTPS, verify them read-only, and record the
final artifact hash. Still not verified: actual Composio OAuth/provisioning/tool
use, physical-phone use, real Local engine login/turn on a recipient's Mac,
and notarized/Gatekeeper installation. No claim of universal privacy or product
correctness is made by these bounded checks.

## Cloud workspace provisioning hook (fixtures)

Added optional `PlatformServiceConfig.workspaceCreated(workspace, actorId)`.
`createWorkspace` awaits it only for a Cloud workspace, after the membership and
principal rows exist, and swallows any rejection: a provisioning failure never
fails or blocks the workspace's first chat, and no key status is set. Root wires
it to `WorkspaceComposioService.provisionProjectKey` in `host.ts` (not touched
here). Fixtures: each Cloud workspace invokes the hook separately with its owner
account; a Local workspace never does; a throwing hook still leaves the
workspace usable (bot DM turn succeeds); no hook configured is fine; a failed
`provisionProjectKey` leaves `status.configured === false` and no key record.

Verification: `npx vitest run server/colonie/platform/` → 7 files, 139 tests
passed (`composio.test.ts` 52, `platform.test.ts` 36). `tsc` and `oxlint` clean
for platform files; the only remaining `tsc` error is root-owned `tools.test.ts`.

### Final beta publication and evidence reconciliation

The older worker notes about `tools.test.ts` and unverified PostgreSQL are
historical. The ACP server-union test was narrowed correctly; full typecheck
and build passed. The final combined suite passed **255 tests in 11 files**;
the native registry/controller/vault/permission suite passed **61 tests**.
Oxlint and the locale catalog check passed. The scope remains a beta, with the
real-provider and device limitations below.

Final refinements include guarded conversation opening/sending across fast
conversation or workspace switches, active-message reload after replay resync,
the most recent page on reopening long conversations, and **Load earlier
messages**. Deferred-response fixtures cover stale open/send completions and
earlier-page merging/failure. Cloud provider prompts now request the latest 60
authorized messages explicitly, so a message after the first 100 cannot vanish
from the native input. A chunked, oversized account-body fixture returned 413
without destroying the response socket. Vendor map-format tool schemas are
converted to valid JSON Schema and checked with Ajv.

Composio auto-provisioning is a best-effort background hook after Cloud workspace
creation when an org key exists. A deferred-hook fixture proved workspace
creation does not wait for that provider. The deployment has no org key, and
this is not a claim of real project provisioning. An admin can use project-key
setup; ordinary members see a plain explanation instead of server details.

Actual final commands:

```bash
pnpm exec vitest run server/colonie/platform/ src/components/colonie-platform/ src/lib/colonie-platform.test.ts server/composio.test.ts server/composio-availability.test.ts
pnpm build
pnpm exec oxlint --deny-warnings .
pnpm i18n:check
node scripts/colonie/build-platform.mjs
node --experimental-transform-types scripts/colonie/verify-platform-ui.ts
node --experimental-transform-types scripts/colonie/verify-platform-ui.ts --desktop --executable release/colonie/mac-arm64/Colonie.app/Contents/MacOS/Colonie
NODE_ENV=production node --experimental-transform-types scripts/colonie/verify-platform-neon.ts --infra-file /Users/riaenriala/.config/colonie-development/infra.json --public-origin https://172.104.33.55
```

The final browser run passed Cloud signup/first bot/chat/reload, invited signup
at 390×844, and messages/replies between independent human browser contexts.
The final packaged Mac run passed Cloud and Local chats and switching; the
Local reply was deterministic ACP, without real engine sign-in. Logs:
`/tmp/colonie-platform-ship-renderer.log` and
`/tmp/colonie-platform-shipped-mac-check.log`. The production-origin Neon
fixture passed actual auth/tenant/conversation/recovery/app-storage workflows
with Secure HttpOnly session cookies. Its first run deliberately burst four
signups from one address and hit the production signup limit (429); separate
synthetic client IPs then reproduced the trusted proxy headers and passed.
That was an isolated fixture, not a write against production accounts.

The HTTPS gateway was switched to the new platform at 127.0.0.1:19091 after
configuration validation. Read-only public checks returned platform bootstrap,
401 for unauthenticated workspaces, 403 for a foreign Origin, and TLS verify 0.
Public Chromium rendered the signup screen without pairing; no account was
created. The Mac download initially returned 403 because the HTTPS service
could not traverse the private app parent directory. Public artifacts were
moved to `/var/www/colonie/downloads`, preserving that private boundary; the
download then returned HTTP 200, `application/x-apple-diskimage`.

The final installer was rebuilt, retested, and uploaded. A complete HTTPS GET
was streamed through SHA-256 and matched the local file:

```text
f54448b4ce79946ded8244aa657ccfe4ed1d74920c2ea85a536c958dd1c4f0ee
```

URL: `https://172.104.33.55/downloads/Colonie-0.2.0-arm64.dmg`.
The earlier `626a47…` digest belongs to the superseded artifact. The app is
ad-hoc signed, not notarized. The source is on `colonie/multi-workspace-beta`;
provided infrastructure secrets were checked against the 80 changed/new files:
zero matches, without printing credential values or inspecting native auth.

Unverified or outstanding: real Composio provisioning/OAuth/tool execution,
physical-phone use, a recipient's real Local engine login/turn, quarantined
Mac installation, and migration of existing VPS conversations into global
accounts. R2 is unused because no endpoint/account ID was supplied; download
delivery uses the VPS. Jev, write actions, billing, workspace mode conversion
and cross-workspace forwarding are not included. The beta can now be tried via
ordinary signup; broad production correctness is not inferred from these tests.

Source publication: `git commit -m 'Add account-based Cloud and Local workspace
beta'` created `a42556f5`; `git push -u colonie colonie/multi-workspace-beta`
completed, including the required lint/locale pre-push checks. The upstream
`origin` remote was not pushed. `gh pr create --repo hanifstudio/colonie --base
main --head colonie/multi-workspace-beta --draft --title 'Add account-based
Cloud and Local workspaces' --body-file /tmp/colonie-workspace-pr.md` created
draft PR https://github.com/hanifstudio/colonie/pull/1. It is not merged.
The final full typecheck and the Ajv schema fixture passed after correcting the
test's constructor import. The working tree was clean after the implementation
commit; this closing evidence note is the only subsequent documentation change.

## October 15 — owner rejected the Cloud UI; recovery in progress

The owner installed 0.2.0 and reported a wholesale UI change, AI errors and
inability to chat in a joined workspace. They explicitly require the existing
Colonie UI as the base. No git reset/revert, production data rollback or
conversation migration has been performed. Initial `git status --short --branch`
was clean on `colonie/multi-workspace-beta`; source UI from before `a42556f5`
remains in Sidebar.tsx, ChatView.tsx, Composer.tsx and App.tsx. The new Cloud
entry selects a different shell. This was a product regression despite the
previous fixture passes.

Read-only diagnostic commands:

```sh
ssh colonie-vps 'systemctl is-active colonie colonie-platform colonie-https; journalctl -u colonie-platform --since "12 hours ago" --no-pager -o cat | tail -60'
ssh colonie-vps 'stat -c "%F %a %U %s %n" /opt/colonie/platform-data/native-claude/.credentials.json /opt/colonie/data/native/claude/.credentials.json; test -r /opt/colonie/platform-data/native-claude/.credentials.json && echo production-auth-file-present'
```

All services were active. The journal contained lifecycle/startup messages,
not the reason for failed turns: runtime errors were swallowed. Both native
auth paths existed; metadata only was inspected, never credential contents.
The production auth entry is now a regular file, not the original symlink.

Added a fixed-category diagnostic boundary (phase, reason, exit code only;
no provider stderr/error text, messages, account data or credentials logged) and
an explicit `verify-cloud-chat.ts` fixture. It uses real Better Auth/Neon with
a random disposable schema, two synthetic accounts, the default app-tool
resolver, and one bounded AI prompt from an invited member. The native CLI
alone follows a read-only auth donor link in an isolated temporary directory.

```sh
node scripts/colonie/build-platform.mjs
scp dist-platform/verify-cloud-chat.mjs colonie-vps:/opt/colonie/platform-app/dist-platform/verify-cloud-chat.mjs
ssh colonie-vps 'systemd-run --unit=colonie-invited-chat-check --collect --wait --pipe --property=User=colonie --property=Group=colonie --property=WorkingDirectory=/opt/colonie/platform-app --property=ProtectSystem=strict --property=ProtectHome=yes --property=PrivateTmp=yes --property=ReadOnlyPaths=/opt/colonie/platform-data /usr/bin/node dist-platform/verify-cloud-chat.mjs --infra-file /opt/colonie/platform-verification/infra.json --real --auth-root /opt/colonie/platform-data/native-claude --adapter /opt/colonie/app/dist-devone/claude-acp/index.js --native-cli /opt/colonie/app/dist-devone/claude-acp/claude-native'
ssh colonie-vps 'systemd-run --unit=colonie-inherited-chat-check --collect --wait --pipe --property=User=colonie --property=Group=colonie --property=WorkingDirectory=/opt/colonie/platform-app --property=ProtectSystem=strict --property=ProtectHome=yes --property=PrivateTmp=yes --property=ReadOnlyPaths=/opt/colonie/data /usr/bin/node dist-platform/verify-cloud-chat.mjs --infra-file /opt/colonie/platform-verification/infra.json --real --auth-root /opt/colonie/data/native/claude --adapter /opt/colonie/app/dist-devone/claude-acp/index.js --native-cli /opt/colonie/app/dist-devone/claude-acp/claude-native'
```

Both fixtures proved the invited-member human DM and reply through real HTTP
and PostgreSQL. Both AI requests **failed** at `prompt`, categorized
`authentication`; unit exit 1, 6.442 seconds / 5.241 seconds respectively.
Both disposable schemas and runtime directories were removed. This supersedes
the earlier successful provider check as evidence of current availability.
No login/sign-in was performed and no production conversation was read/written.
The added verifier is installed; the production host/UI has not been replaced
at this milestone. Do not describe the AI outage as repaired.

UI recovery is being implemented by adapting account data to the existing
Sidebar and ChatView, without mounting the old global store/transport. New
members will be able to select teammates directly from People; the old empty
state offered the new-DM action only to bot managers. Initial updated tests
exposed an absent ResizeObserver in the DOM fixture, and typecheck found an
unused import; these are not passes. Next: complete the adapter, verify actual
renderer invitation/DM/bot-error paths and Local compatibility, then build a
reviewable recovery installer. A recipient's real UI/chat remains unverified.

### UI recovery published; AI reconnection remains owner-only

Recovery uses the original `Sidebar`, `BotListItem`, `GroupListItem`,
`ChatView`, message Markdown/bubbles, glass surfaces and composer styling.
The account controller adapts authorized Cloud data into that view without
mounting the legacy global transport. Cloud's added controls are workspace
switching, account/membership settings, Groups and People. All workspace bots
are visible in the roster before a person has a bot DM; teammates can be
selected directly from People. Ordinary members now have the new-DM action
on an empty workspace too. No account/session/secret schema was changed.

Fixed a real renderer race: `openConversation` previously updated its current
conversation ref only on React's next render. An immediately resolved request
following an async DM lookup could be discarded as stale and leave the view
loading. The ref now owns the view before the first await, and existing DMs
are opened directly. The existing stale-open/send/resync tests pass. Account
messages also receive presentation-only parent links so separate messages are
not displayed as edited versions of one another in the old renderer.

Actual checks:

```sh
pnpm exec vitest run server/colonie/platform/ src/components/colonie-platform/ src/lib/colonie-platform.test.ts src/lib/cloud-guest.test.ts src/components/Sidebar.rows.test.ts src/components/Sidebar.header.test.ts src/components/SidebarBotListItem.test.ts src/components/ChatView.rows.test.ts src/components/ChatView.controls.test.ts src/components/ChatView.follow.test.ts src/components/Avatar.test.ts
pnpm exec vitest run src/components/colonie-platform/platform-flow.test.ts src/components/ChatView.rows.test.ts
pnpm build
pnpm exec oxlint --deny-warnings .
pnpm i18n:check
node scripts/colonie/build-platform.mjs
node --experimental-transform-types scripts/colonie/verify-platform-ui.ts
node --experimental-transform-types scripts/colonie/verify-platform-ui.ts --desktop --executable release/colonie/mac-arm64/Colonie.app/Contents/MacOS/Colonie
```

The broad suite passed **317 tests in 17 files**. After the final adapter and
mobile-header refinements, the focused suite passed **32 tests in two files**;
these overlap the broad suite and are not additional distinct tests. Full
typecheck/Vite build, lint, locale check and Cloud host bundle passed. Initial
DOM-fixture failures were repaired by supplying browser observer globals,
keeping avatar animation in real-browser QA, and finding accessible button
roles/log-scoped content. The restored sidebar displays message previews, so
unscoped text locators could match a preview as well as the transcript; those
checks now target the real conversation log. No failed run is counted as a pass.

Final Chromium report (`/tmp/colonie-ui-recovery-browser-shipped.log`, exit 0):
signup/first Cloud bot/chat/reload, streamed AI error displayed while the sent
message remains, invitation skips workspace/engine setup, newly invited
ordinary member opens the existing workspace bot and receives a simulated
reply, and human DM/reply between independent browser contexts at 390×844.
Final Mac report (`/tmp/colonie-ui-recovery-desktop-shipped.log`, exit 0): the
same shipped 0.2.0 executable loaded the recovered Cloud UI, displayed chat
and the simulated error, created/opened Local, completed deterministic ACP
Local chat and returned to the separate Cloud history. No real native login.
Screenshots in `.devone/evidence/platform-native-cloud.png` and
`platform-mobile-human-dm.png` were visually inspected. The mobile screenshot
waits for the drawer's closing animation to finish. The OS emitted a nonfatal
task-policy warning; the renderer reported no JavaScript errors.

Deployment kept the installed DMG unchanged. The final `dist/` was staged with
`rsync -az dist/ colonie-vps:/opt/colonie/platform-app/ui-recovery-dist/`; the
Cloud bundle was staged separately as `dist-platform/host-ui-recovery.mjs`.
The following was run over `ssh colonie-vps 'bash -s'` with `set -eu`:

```sh
colonie_recovery_dir=/opt/colonie/platform-app/recovery-20261015-ui
test ! -e "$colonie_recovery_dir"
install -d -m 700 "$colonie_recovery_dir"
cp -p /opt/colonie/platform-app/dist/index.html "$colonie_recovery_dir/index.html"
cp -p /opt/colonie/platform-app/dist-platform/host.mjs "$colonie_recovery_dir/host.mjs"
# The existing host source map was also backed up when present.
# Staged backend map/verifier were moved out before syncing the static tree.
rsync -a --exclude=index.html /opt/colonie/platform-app/ui-recovery-dist/ /opt/colonie/platform-app/dist/
install -o colonie -g colonie -m 644 /opt/colonie/platform-app/ui-recovery-dist/index.html /opt/colonie/platform-app/dist/.index-ui-recovery-next
mv /opt/colonie/platform-app/dist/.index-ui-recovery-next /opt/colonie/platform-app/dist/index.html
mv /opt/colonie/platform-app/dist-platform/host-ui-recovery.mjs /opt/colonie/platform-app/dist-platform/host.mjs
# Installed the matching host map and updated isolated verifier; restored code ownership.
systemctl restart colonie-platform
systemctl is-active colonie-platform colonie colonie-https
```

All three services returned `active`. Old hashed browser assets remain, and
the previous HTML/host/map are backed up outside the static root. Backend
source maps/verifier were not published as frontend assets. No production
account, message or credential file was changed by this recovery deployment.
The deployed HTML and host SHA-256 match the verified local build:

```text
b5b82b3e59c3fdb8563a7628bf7451d7f275437952d90ec00e608529c793f820  dist/index.html
3a6aa1ffd0b4d0121c070799a2afaf222e90021f9953169d774ef0d9dc52baa0  dist-platform/host.mjs
```

Public checks were read-only:

```sh
curl --fail --silent --show-error https://172.104.33.55/ --output /tmp/colonie-ui-recovery-public-index.html
shasum -a 256 /tmp/colonie-ui-recovery-public-index.html
curl --silent --show-error --output /tmp/colonie-ui-recovery-public-bootstrap.json --write-out 'bootstrap HTTP %{http_code}; TLS verify %{ssl_verify_result}\n' https://172.104.33.55/api/colonie/bootstrap
curl --silent --show-error --output /dev/null --write-out 'workspaces without sign-in HTTP %{http_code}\n' https://172.104.33.55/api/colonie/platform/workspaces
curl --silent --show-error --output /dev/null --header 'Origin: https://foreign.example' --write-out 'foreign Origin HTTP %{http_code}\n' https://172.104.33.55/api/colonie/platform/workspaces
```

The complete public HTML matched `b5b82b…f820`; bootstrap was 200 with platform
mode and the expected HTTPS origin, TLS verify 0; unsigned workspace read 401;
foreign Origin 403. These are publication/auth boundary checks, not AI evidence.

**Still blocked/unverified:** real Cloud AI replies currently fail native
Claude authentication. No owner reconnect has been performed or requested as
a credential disclosure. Recipient's actual joined-workspace UI/chat, physical
phone use, real Local engine login/turn and the previously listed Composio and
offline-startup limitations remain unverified. The preceding successful real
Claude release check is historical, not a current availability claim.

Next action, performed by the owner (not the agent):

```sh
ssh -t colonie-vps 'sudo -u colonie env CLAUDE_CONFIG_DIR=/opt/colonie/platform-data/native-claude /opt/colonie/app/dist-devone/claude-acp/claude-native auth login'
```

Then the agent may run one bounded isolated invited-member real-provider check
against that read-only native auth root using `dist-platform/verify-cloud-chat.mjs`.
Do not sign in on the owner's behalf or request credential contents. The next
provider success must be recorded before saying the AI outage is resolved.

Source checkpoint: `git commit -m 'Restore the existing Colonie UI for Cloud
workspaces'` created `b1afbd2d`. `git push -u colonie
colonie/restore-existing-ui` completed; the pre-push lint, full typecheck and
locale checks passed (the hook's default Node 22 emitted the engine-version
warning; the application builds/checks above used the explicit Node 24 path).
Only the owner's `colonie` remote was pushed; upstream `origin` was untouched.
The code change is separate from the earlier beta commit and remains unmerged.
Aggregate recovery evidence is `.devone/evidence/ui-recovery-2026-10-15.json`,
including explicit `realAiAvailable: false` and the pending owner reconnect.

### Owner rejected the partial recovery — full UI remains unrestored

The owner states that only a small part of the original UI was recovered.
They are correct. The preceding publication proved selected fixture journeys
and deployment of reused components; it did not prove restoration of the full
pre-change Colonie product or its feature set. Application code changes and
deployments are paused for discussion/source comparison in this response.
No new runtime/provider or live-user verification was performed.

Read-only comparison commands included:

```sh
git status --short --branch
git log -5 --oneline
git diff --stat 744da8df..HEAD -- src/App.tsx src/main.tsx src/components/onboarding electron/main.mjs
git diff --quiet 744da8df HEAD -- src/App.tsx
git diff 744da8df HEAD -- src/main.tsx
rg -n 'classicDispatch|toggleSettings|toggleAppSettings|togglePlugins|accountConversation|New direct message|<.*Dialog|<.*Panel' src/components/colonie-platform/WorkspaceShell.tsx src/components/colonie-platform/ConversationView.tsx
rg -n 'accountConversation \?|!accountWorkspace|!accountConversation|workspace \?' src/components/ChatView.tsx src/components/Sidebar.tsx
```

Findings from source, not new functional verification:

- App.tsx is unchanged relative to the pre-workspace snapshot `744da8df`.
  Cloud routing bypasses that application and still selects PlatformApp.
- The original App mounts BotSettingsDialog, SettingsModal, PluginsPanel,
  the original NewBotDialog, GroupView and the rest of its application shell.
  The Cloud shell does not mount that complete application.
- The original fork's bot settings include Identity/SOUL and ACP-specific
  Skills/Memory/Access/Model/Permissions sections. The Cloud wire bot currently
  exposes a name and purpose; the recovery's toggleSettings action opens
  Members rather than those bot settings.
- Original app settings include General, Appearance, Engines, Connections
  and Backups for the ACP fork. The Cloud replacement settings offer workspace
  naming and connected apps, not the complete original settings UI.
- Account-conversation overrides suppress original conversation navigation,
  native/model controls and several message actions. The original Composer is
  replaced with a plain-text account composer. Reusing its styling does not
  restore attachments or the original interaction set.
- The owner's requirement is to retain the existing Colonie application as
  the foundation. Restoring isolated visual fragments is insufficient; the
  account/workspace integration and feature data contracts need to support
  that application. Previously retired upstream engines/enterprise behavior
  must not be revived as an accidental side effect.

No further application code, server configuration, credential or production
conversation was changed for this audit. Only these correction notes were
updated locally; no new commit/push/deployment was performed. Next: agree on
the full recovery approach using the pre-change application as the baseline,
before another implementation or deployment. Real Cloud AI authentication
also remains unresolved; its earlier status has not changed.

## 2026-10-15 — Incremental UI recovery: original bot profile (verification)

The owner authorized restoring the remaining original UI one part at a time.
This slice reconnects the existing BotSettingsDialog, SimpleBotPanel,
IdentitySection, SoulSection and BotProfileAvatarCard to Cloud workspace data.
It is not a full application UI restoration. Cloud still enters PlatformApp /
WorkspaceShell; App.tsx remains the pre-change source for the other surfaces.

Implemented scope:

- Name, role/title, description, standing instructions, mascot color/body/
  expression, custom image upload/removal, crop and framing use the original
  controls. The bot header and sidebar menu open the actual settings panel.
- Workspace owners/admins can edit; ordinary members can view a disabled
  profile. The service independently checks the role and exact workspace/bot.
  Avatar reads check current membership and use private, no-store responses.
- PostgreSQL adds a default-empty profile JSON column and a scoped binary
  avatar table. Existing bot records and their purpose remain valid. Partial
  updates merge submitted fields, including explicit clears, rather than
  overwriting unrelated concurrent edits. No R2 credentials are involved.
- Serialized saves retain failed drafts, show a retry, and preserve edits
  made while an older save is in flight. Closing waits for successful saving.
- Cloud dispatch reads the saved name, role, description and SOUL for each
  turn and records the exact application-authored prompt. No inspector setup
  is required. Native provider/project instructions remain provider-owned.

Commands/results (all local commands used
`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`):

```sh
pnpm exec vitest run server/colonie/platform/platform.test.ts server/colonie/platform/runtime.test.ts src/components/colonie-platform/platform-flow.test.ts src/components/BotSettingsDialog.simple.test.ts
# 4 files / 96 tests passed (initial focused run).
pnpm exec vitest run src/components/colonie-platform/platform-flow.test.ts
# 27 passed after adding in-flight-save and failed-save/retry journeys.
pnpm exec vitest run server/colonie/platform/ src/components/colonie-platform/ src/lib/colonie-platform.test.ts src/lib/cloud-guest.test.ts src/components/Sidebar.rows.test.ts src/components/Sidebar.header.test.ts src/components/SidebarBotListItem.test.ts src/components/ChatView.rows.test.ts src/components/ChatView.controls.test.ts src/components/ChatView.follow.test.ts src/components/Avatar.test.ts src/components/BotSettingsDialog.simple.test.ts
# Final run: 18 files / 343 tests passed, including the pending-close regression.
pnpm exec vitest run src/components/BotProfileAvatarCard.test.ts src/components/BotSettingsDialog.caption.test.ts server/bot-avatar.test.ts
# 3 additional files / 15 tests passed (358 distinct tests across these suites).
pnpm build
# Final run passed TypeScript and Vite; existing CSS/chunk warnings remain.
# The first run found one NodeNext import missing its .ts extension; corrected.
pnpm exec tsc -b && pnpm exec vite build
# Exited 0; final frozen renderer includes saved mascot state in bot headers.
pnpm exec oxlint --deny-warnings .
pnpm i18n:check
# Both exited 0; 10 locale catalogs valid, 3,714 English strings.
node scripts/colonie/build-platform.mjs
# Host and verification bundles built successfully.
node --experimental-transform-types scripts/colonie/verify-platform-neon.ts --infra-file /Users/riaenriala/.config/colonie-development/infra.json --public-origin https://172.104.33.55
# Exited 0: real Better Auth + PostgreSQL, original profile fields saved,
# concurrent partial edits retained, member edit and wrong-workspace access
# denied, profile and uploaded PNG bytes survived host restart, outsider image
# read denied, existing private-DM/recovery/revocation checks passed.
# Disposable schema removed. Provider and app integrations were simulated.
```

A final host inspection found the ordinary 128 KB JSON-body guard would also
reject larger avatar uploads. The larger bounded envelope is now allowed only
on the exact authenticated avatar-upload route; all other routes keep their
existing cap. The repeated Neon fixture uploaded a 150,068-byte synthetic PNG
payload above that ordinary cap and read the exact bytes after restart. PNG
decoding itself is covered by the separate small-image renderer fixture.
`pnpm exec tsc -p tsconfig.server.json && node scripts/colonie/build-platform.mjs`
checks the updated host before publication; its completion is recorded below.

The maintained ACP SDK fixture completed two turns with different saved SOUL
values. Each dispatched prompt matched its input receipt exactly and contained
the current role/description/SOUL; the previous SOUL and legacy purpose did not
bleed into the later input. This proves dispatch wiring with a simulated ACP
provider, not successful reasoning or replies from a real Cloud provider.

An additional renderer regression check covers leaving a bot profile while
its close is waiting for a save: that old response cannot dismiss the profile
of another bot opened in the meantime. The new test passed in the 343-test run.

Initial Chromium HTTP/SSE renderer check exited 0, including profile/PNG upload,
crop/zoom, save/reload/removal, failed-save draft retention/retry, invited-member
read-only profile, bot chat, human DM, and visible provider-failure handling.
Final browser and packaged desktop checks also passed against the final build:

```sh
node --experimental-transform-types scripts/colonie/verify-platform-ui.ts
node --experimental-transform-types scripts/colonie/verify-platform-ui.ts --desktop --executable release/colonie/mac-arm64/Colonie.app/Contents/MacOS/Colonie
# Both exited 0, completed=true, errors=[].
```

Chromium covered the complete original-profile edit/upload/reload/remove/retry
journey, plus an ordinary invited member's read-only profile at 390 × 844.
The unchanged 0.2.0 packaged Mac executable loaded the final Cloud fixture UI
and completed the same profile journey. Its separate disposable Local server
also completed deterministic ACP onboarding/chat and switched back to Cloud
without crossing message histories. No native engine login was performed.
The checks used isolated accounts/data; no production conversation was touched.

JSON evidence is `.devone/evidence/platform-browser-ui.json` and
`platform-native-ui.json`. Profile, identity and SOUL screenshots are the
`platform-browser-bot-*.png` / `platform-native-bot-*.png` files, with the
read-only mobile view in `platform-mobile-bot-profile.png`. The final browser
capture waits for the original panel's entrance animation before taking a
screenshot. PNG decode/crop and zoom to 101% were exercised; arbitrary uploaded
images, every accepted file format and pointer-drag framing were not verified.
Publication has not happened at this verification milestone.

Explicitly not restored in this slice: Skills, Memory, bot model/permissions,
connected-tool settings inside the original panel, generated avatars, Library,
full app settings, attachments/search and the remaining conversation controls.
Real Cloud Claude replies remain authentication-blocked. No engine sign-in,
credential-content read, production conversation test or real OAuth flow was
performed. A physical phone, quarantined install and Apple notarization remain
unverified. Next: publish this tested profile slice with rollback artifacts
retained, then restore the remaining original surfaces incrementally.
