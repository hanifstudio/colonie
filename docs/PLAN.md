# Colonie milestone plan

Phase 1 M0–M4 completed under the DevOne name. Actual commands/evidence and
positive user feedback on Codex are in `PROGRESS.md`. **M5: Colonie branding**
and **M6: Claude core-workflow integration** are implemented and verified.
M7-A native controls are implemented and verified with both provider fixtures
and real Claude; the real Codex request for this slice hit the account usage limit.
M7-B scoped app awareness/persona/SOUL is implemented, with both-provider fixtures
and real Claude evidence. Subsequent milestones remain
proposed and need their own evidence. Current run guide: `COLONIE.md`.

UX correction completed: awareness/persona/SOUL enabled by default, normal
bot-profile editing, and a separately opt-in developer inspector. Both-provider
desktop/package profile fixtures and bounded real Claude passed without visiting
ACP context before the first dispatch. Bot-level multi-conversation navigation is
implemented in the default UI; both-provider same-bot HTTP/package fixtures cover
independent parallel sessions, approval/Stop routing and restart. Evidence is
simulated-provider with real renderer/desktop; native parallel throughput is not
claimed. M8 connected tools are now implemented; the separate unsigned macOS
credential UI/storage follow-up is now verified with targeted synthetic tests.
User-specific unreadable/locked-store recovery remains a bounded diagnostic task.
The immediate next slice is M8-C: connected-tools marketplace and ACP-only UX
consolidation. Full frontend/backend legacy retirement is reserved as deferred
architecture milestone D1; it is not part of the delegated UX cleanup. M9 remains
the next feature-expansion milestone after consolidation.

## Next phase

### M5 — Colonie branding: rename and Bloub-based art (completed)

1. Inventory product-name references across package metadata, Electron entry,
   app/window/menu labels, bundle id, runtime profile, command/env names, artifact
   names, verification scripts and documentation. Separate product identity from
   historical evidence, native provider ids, upstream names and legal attribution.
2. Choose the persisted-data strategy explicitly. Preserve access to existing
   DevOne chats/settings/receipts and Codex session ids, either with a documented
   legacy path or an idempotent migration. Renaming must not reset conversations.
3. Apply the rename coherently. Document compatibility aliases if old commands
   or environment variables remain. Leave the workspace folder location unchanged
   unless the user separately requests moving it.
4. Adopt the pinned Bloub engine/geometry with a React-compatible wrapper. Choose
   Colonie shape/palette/expression defaults, map current application status and
   saved appearance settings, and preserve user-uploaded avatars. Inventory the
   shared avatar boundary (`src/components/Avatar.tsx`), current animation engine
   (`CursorAvatar.tsx`), state selection (`src/lib/mascot.ts`), generated appearance
   catalog (`shared/mascot-bodies.ts`) and static desktop/build resources before
   replacing them. Do not assume this is a PNG-only swap.
5. Replace app-owned mascot surfaces consistently: avatars, chat/sidebar presence,
   appearance previews and loading/empty surfaces; generate matching static
   desktop icons. Record source revision and carry MIT/copyright attribution for
   adopted Bloub code/assets in source and packaged notices.
6. Verify visual state mapping, static/reduced-motion behavior, light/dark themes,
   small avatars and concurrent SVG instances without mask/id collisions. Keep
   idle/hidden animation work bounded and clean up on unmount. Capture visual
   evidence of the real renderer and packaged app in isolated fixtures.
7. Build and launch the new Colonie artifact. Verify fresh startup, existing
   DevOne-data upgrade, repeat startup and session continuation in isolated
   fixtures. Record paths and commands in the run guide and progress log.

Done when the visible product/build identity and default mascot/art are Colonie,
the documented commands work, old fork data remains accessible and the ACP/Codex
workflow still passes. Complete naming/data continuity and visual replacement as
separate verified slices within M5. Implementation and isolated visual/desktop
upgrade evidence are recorded in `PROGRESS.md`.

### M6 — full Claude core-workflow integration (completed)

Use the maintained `claude-agent-acp` adapter and the official ACP SDK, with
supported existing native authentication. This milestone is a complete desktop
integration at the level of the current Codex implementation, not only a
compatibility probe or a successful single prompt.

1. Extract shared runner/session/input-receipt/UI-event responsibilities where
   useful; leave native provider behavior behind explicit capability boundaries.
   Preserve the verified Codex execution path during the refactor.
2. Add Claude selection and actionable setup/authentication status to the actual
   desktop application. Keep Claude and Codex credentials and sessions distinct.
3. Support chat, incremental output/reconnect, tools/results, Allow/Deny, Stop,
   queued follow-ups, multi-turn continuation, exact input inspection and session
   continuation after a full application restart.
4. Discover and enforce the adapter's supported model/mode/attachment features.
   Similar UX must not imply identical permission semantics or optional features.
5. Run isolated SDK/application/renderer fixtures, build the desktop artifact and
   perform bounded real-Claude checks with inherited authentication when available.
   Record any unavailable capability or login blocker explicitly; a fixture alone
   does not establish full real-provider completion.

Done when both Claude and Codex meet the core workflow acceptance matrix through
the packaged app, with provider-specific differences documented. No new implicit
persona, SOUL, memory or orchestration context is added in this milestone. This
multi-provider foundation precedes personalization and feature restoration.
Recorded evidence includes both-provider SDK/HTTP/UI fixtures and real native
session-restart and Allow/Deny checks through the actual packaged app.

### M7 — useful coding controls and explicit personalization (implemented)

#### M7-A — native controls (implemented; real Codex blocker recorded)

Explicit discovery without prompts, a dynamic model/effort/mode panel, native
boolean options, revision/session guards, per-thread/provider overrides,
revalidation after model changes, and effective options in input receipts. The
API follows route modules and application gates. Identical discovery is coalesced;
competing changes are rejected. Another provider's prepared cursor does not
establish history ownership.

Evidence: SDK/HTTP tests, desktop UI for both providers, packaged fixtures for
both providers, and packaged real Claude retaining effort after restart and still
passing native Allow/Deny. Real Codex hit its usage limit; fixture success alone
is not reported as real-provider success. See `PROGRESS.md` for commands/evidence.

#### M7-B — explicit persona/SOUL (implemented)

Implement the scoped contract in `SPEC.md`: separate app-wide preferences and
per-bot persona/SOUL switches; pin at first prompt dispatch (not discovery);
retain old/plain conversations; show preview, pinned version and source manifest.
Verify shared app scope and bot isolation through both SDK/HTTP fixtures before
renderer/package and bounded real-Claude checks.

Define named/source-versioned context composition and update semantics for
running sessions before enabling persona. A plain/native configuration must
remain available, and added application instructions must be inspectable.
Product-authored context, built-in templates and UI copy use English (US);
user-authored persona/SOUL content retains its chosen language.

- Address model/effort controls, mode presentation, working-folder/attachment UX,
  and provider usage/limit signals only where the adapter supplies them.
- Restore editable persona and SOUL as deliberate agent configuration, separating
  visual metadata from actual behavioral instructions.
- Add a configured Chief role/personality without implying delegation works
  before its tools and lifecycle are implemented in M9.
- Design an inspectable context composer: named/source-versioned sections,
  preview, exact dispatch receipts, and defined behavior when settings change
  during an existing native session. Preserve a plain/native configuration.
- Reuse upstream UI and storage where useful; keep context composition independent
  of the provider transport. Do not reconnect the old hidden-context pipeline.

Evidence: changes to persona/SOUL affect only the intended agent; the user can
inspect every added section; unrelated memory/team context does not appear;
continuation and restart remain consistent with the chosen update semantics.
Both-provider HTTP/SDK/desktop/package fixtures passed, including plain baselines,
shared app versus bot isolation and native discovery before profile edits. Bounded
packaged real Claude identified app/role/SOUL and retained native memory after
restart with the same pinned context. Real Codex quota remains an explicit blocker.

### M8 — custom MCP and connected tools (implemented; credential follow-up verified)

Explicit server/tool selection, lifecycle and permission integration over the
shared ACP boundary. Start with one useful office/development integration and
verify it end-to-end. Existing UI controls become available only when their
execution path works. Browser integration is outside this milestone.

The owner selected Composio and supplied a project credential for runtime use.
Start with workspace connection setup, per-bot toolkit access, shared ACP HTTP
mounting and an authenticated active-conversation relay. Reuse useful account/UI
infrastructure without restoring implicit legacy context. Include the small Simple
sidebar +/actions spacing correction reported during the previous milestone.

Implemented: common ACP mount contract, Composio toolkit-scoped loopback relay,
per-bot selection and shared registry-backed Custom MCP (stdio/HTTP; Claude SSE).
HTTP and packaged SDK fixtures, web key/profile workflow and real packaged Claude
public Composio search/read passed. Unsigned macOS secure-store writes failed in
the isolated profile and remain a separate blocker; credentials were supplied by
explicit runtime environment for package checks. No other built-in presets were added.

Final lifecycle/outcome checks and package fixtures passed; real packaged Claude
search/read and native restart passed after the runtime changes. The final UI-only
adjustment was rebuilt and package-smoked separately. Address encrypted credential
persistence before claiming the packaged key-entry workflow fully verified; see
`PROGRESS.md` and `.devone/evidence/composio-secure-store-blocker.json` evidence.

Credential follow-up: explicit source/origin/masked key, key versus account state,
operation-specific failures, no catalog without a key, immutable environment-source
removal, transactional migration, and encrypted-byte rollback are implemented.
Targeted browser and packaged synthetic tests passed Save/restart/Remove/restart,
including workspace import origin. The original failure depended on inaccessible
Keychain context in temporary HOME; unsigned status alone was not established as
the cause. Historical records remain, and current evidence is recorded in PROGRESS.

### M8-C — one connected-tools marketplace and ACP-only UX (implemented)

1. Make the puzzle entry open one Connected apps/tools surface consistently,
   including before provider discovery completes. Product identity comes from a
   stable application contract, not an empty/mixed driver-list heuristic.
2. Adapt the useful upstream Apps marketplace/catalog/account UI to Colonie's ACP
   tools boundary, credential source/origin display and per-bot access policies.
   Preserve Composio as the only ready-to-use integration and generic Custom MCP.
   Remove the duplicate setup/catalog surface only after intended behavior is
   covered. Reuse persistence, OAuth and registry infrastructure.
3. Consolidate frontend legacy-versus-ACP presentation into one Colonie UX. Simple
   and Advanced may vary control density, but must not change the destination or
   execution system. Limit supporting backend changes to explicit UI contracts;
   transport, credential storage and session lifecycle are separate responsibilities.
4. Verify entry/loading, marketplace, setup/status, custom connections and bot
   selection in isolated renderer/desktop fixtures. Expand backend/provider checks
   only when changed execution boundaries or unresolved failures justify them.

Coordination approved by the owner: the lead handles 1, 2, integration and 4. Slice
3 may be delegated through a new Herdr pane to OpenCode with Muse 1.3 Free, subject
to actual session/model availability. Before starting, provide a complete bounded
plan, explicit file allowlist, shared-contract prerequisites, non-overlapping
ownership and acceptance criteria. One implementation pass, targeted checks,
change/blocker report, then stop; no self-directed refactor loops, commits or bulk
deletion. The lead reviews the full diff and checks before integrating.

Done when puzzle/navigation is stable during loading and reload, one marketplace
serves Composio/Custom MCP, credential and bot-policy behavior remains explicit,
and normal Colonie UI does not fall back to an upstream execution experience.

### M8-D — Colonie CLI state isolation (implemented)

Colonie runs the ACP engines with their own config directory under the app data
dir, so its sessions, sign-in and history never touch the user's own CLI state
(`~/.codex`, `~/.claude`). This is how Colonie always runs — not a mode and not a
toggle:
- `server/devone/profile.ts` injects `CODEX_HOME` (codex-acp) and
  `CLAUDE_CONFIG_DIR` (claude-acp) into every ACP instance's environment, pointing
  at `~/.colonie/native/<codex|claude>` (`nativeBase` = `NATIVE_DIR`).
- `server/config.ts` passes `NATIVE_DIR` and creates those directories at boot.
- The user signs in once inside Colonie (or the engine's own login runs with the
  isolated env during a session); the token lands in the app data dir, not the
  global CLI config.
- Account/service-level facts (e.g. usage counting) cannot be separated; that is
  stated, not hidden.
- Reuses the mechanism already present for hosted/managed Claude/Codex accounts
  (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`).

Done when both engines spawn with the isolated dir (verified end-to-end) and the
user's global CLI keeps only its own state.

### D1 — frontend/backend legacy retirement (deferred architecture milestone)

Prerequisite: complete M8-C and audit dependencies. Scheduling relative to M9 is
decided from that audit; reserving this milestone does not approve immediate
deletion or change the current delegation scope.

1. Inventory legacy frontend components/state/preferences, backend drivers and
   registration, alternate execution branches, routes, prompt/automation/team
   assembly, startup/build/package imports, fixtures and documentation.
2. Classify each dependency as **retain shared**, **extract**, **reimplement for
   ACP**, or **retire**. Preserve useful UI, HTTP/SSE, persistence and Electron
   infrastructure and source needed by approved future features.
3. Extract shared responsibilities from the large server entry point where needed,
   then retire obsolete drivers, dispatch branches, dead UI logic and their imports
   in small dependency-complete slices. Keep optional capability checks; remove
   dual-product/execution-mode selection from Colonie's supported entry points.
4. Define data/contract compatibility before removing schemas or old paths. Preserve
   existing bots, conversations, working folders, native resume cursors, context
   pins, tool access, credentials and receipts. Keep legacy naming/path aliases
   intentionally when required for continuity; document any owned migration.
5. Verify affected behavior per slice. Execution/persistence changes require
   isolated ACP/HTTP and renderer/restart evidence for the affected providers;
   packaging/startup changes additionally require artifact smoke. Compilation alone
   is not workflow proof. Record remaining references and justified retention.

Done when supported Colonie startup/execution is ACP-only, retired modules are
unreachable and removable without dangling dependencies, retained shared modules
have clear ownership, and the named continuity matrix passes. This is broader than
M8-C UX cleanup and should have its own implementation/review/verification plan.

### M9 — memory, Chief coordination and routines (proposed)

Split into independently verifiable slices: controlled cross-session memory;
Chief delegation and group context/ownership; then manual/scheduled routines and
webhooks as needed. Define who responds, what context crosses agent boundaries,
how Stop propagates and how retries avoid duplicate work. Chief profile alone
does not satisfy this milestone.

### M10 — skills on the ACP boundary (proposed)

Colonie already ships the upstream Agent Skills store (`server/skills.ts`,
`shared/skill-md.ts`) and per-bot Skills UI: `SKILL.md` imports (agentskills.io
format) land disabled with provenance, a content hash and a static scan; enabled
skills reach an engine through native discovery links (`.claude/skills`,
`.agents/skills`, `.grok/skills`) and a bounded index line in the system prompt.
Adopt it for ACP: reuse the store, links and UI, expose a Skills section in the ACP
bot profile (currently filtered out), and deliver the skills index through the
app-owned ACP context (M7-B) instead of the legacy prompt pipeline. Claude reads
`.claude/skills` natively through its adapter; Codex relies on the context index.
Verify with an isolated fixture and one bounded native-discovery check per provider.

### Later — computer/VM, voice and office deployment

Computer/VM and voice are potential follow-ups. Office multiuser access requires
its own identity, project access and execution-account design. Restore useful
upstream pieces after checking their dependencies; source presence is not proof
of runtime support. Previous-message editing and browser are not priorities.

## Completed phase 1

### M0 — baseline and map

Clone the source, read verification instructions, install dependencies, inspect
provider contracts, dispatch-time input assembly, renderer streaming, and
desktop launch. Record upstream commit and environment requirements.

Evidence: clean source snapshot, dependency installation, architecture map.

### M1 — independently implemented ACP runner

Use the official SDK for transport. Add Codex adapter launch and process cleanup,
native session create/load, model/mode negotiation, normalized events, permission
responses, cancellation, and an exact input receipt. Keep the runner independent
of the old ACP implementation. Add meaningful isolated protocol tests.

Evidence: deterministic agent fixture uses the real SDK; tests cover continuity,
approval/denial, cancellation, exit, and context fidelity.

### M2 — desktop UI integration

Select the new path by default in the fork's launch profile. Retain useful
upstream HTTP/SSE and transcript handling. Bypass implicit application context,
provide an inspectable input view, and render incremental output without
duplicating final messages. Ensure unsupported controls do not promise actions
the runner does not implement.

Evidence: typecheck and focused UI/server tests; an isolated end-to-end turn
through the real renderer, including approval and session continuation.

### M3 — native-provider and desktop verification

Launch an isolated workspace and exercise the installed Codex using existing
login, if available. Use only bounded synthetic prompts and disposable files.
Build the renderer/server and launch the Electron app with isolated data/profile.
Provide a reproducible launch command and suitable local desktop build.

Evidence: recorded fixture logs, input receipts, real-provider outcome, Electron
smoke result, and build artifact paths. Report any provider/login limitation
separately from deterministic fixture verification.

### M4 — cleanup and handoff

Remove inactive legacy integration from the fork's runtime, finalize run/update
instructions, and record passed checks, limitations, and next actions. Keep
documentation aligned with actual implementation.

## Working rhythm

- Finish one observable slice before expanding scope.
- Update `PROGRESS.md` after a milestone or discovered blocker.
- Separate implemented, simulated-test-passed, real-provider-passed, and
  desktop-passed status.
- Changes to scope or decisions belong in `SPEC.md`; next steps belong here.
- Keep product priorities separate from feature implementation status. A rename
  or roadmap update does not make unconnected upstream features supported.
