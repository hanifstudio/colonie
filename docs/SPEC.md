# Colonie: personal desktop AI agents with transparent ACP execution

## Product name and implementation status

The product name is **Colonie** (latest user decision, 2026-10-09, superseding
the earlier Normie choice). **DevOne** is the existing phase-1 implementation/build
name, not a second product. Colonie branding (rename and Bloub-based mascot/art)
and the full Claude core-workflow integration are implemented and verified.
Current app: `release/colonie/mac-arm64/Colonie.app`. Legacy data/source/protocol
paths and command aliases are retained deliberately; see `COLONIE.md`.

## Goal

Keep the OpenMausBot chat/agent desktop experience while replacing its agent
connection with an independently implemented ACP client. Use existing local
Codex authentication and maintained upstream adapters instead of maintaining
Codex's native protocol. Work in small verified milestones with repository
documentation as project memory.

The desired product is a personal agent experience: user-configured persona,
SOUL/standing instructions, and a Chief role are wanted. Transparent execution
means the user can understand and control the application's added context; the
empty application context in phase 1 is a baseline, not the final product UX.

## Phase 1 — completed baseline (DevOne)

- macOS desktop; Codex first.
- New local runner using `@agentclientprotocol/sdk` and
  `@agentclientprotocol/codex-acp` (pinned versions in the lockfile).
- Existing login/subscription is owned by Codex. No token extraction or copying.
- Chat, incremental output, tool activity, approvals, denial, cancellation,
  multi-turn continuity and native session reload after restart.
- Reuse upstream React UI, HTTP/SSE, transcript storage, event contracts, and
  Electron packaging where practical.
- Application input is transparent: no implicit persona, SOUL, memory, recall,
  team, skill, routine, or MCP additions on the new path.
- Inspect the exact application-authored input, working directory, model/mode,
  session identity, and any explicitly configured extra instructions.
- Own application data is separate from `~/.openmausbot`.

Native Codex system/project instructions, tools, login configuration, and model
behavior are not replaced by ACP. Transparency covers what this application
sends; it does not claim to expose provider-internal system prompts.

## Architecture

```text
React chat UI in Electron
        | HTTP commands / SSE events
Reused application server and transcript storage
        | new adapter boundary (transparent input + recorded receipt)
New ACP client using the upstream TypeScript SDK
        | JSON-RPC over stdio
Maintained codex-acp / claude-agent-acp adapters
        | Codex App Server / Claude Agent SDK
Native agent model, tools, configuration and existing login
```

The old `customAcp` transport is not part of this execution path. ACP Registry
is a discovery/distribution catalog, not an execution service. Phase 1 pins the
Codex adapter directly; a registry picker can follow after the core flow works.

## Phase-1 acceptance criteria

1. A fresh local launch selects the new Codex ACP connection, clearly labeled.
2. Sending a message preserves its text and does not silently append app context.
3. Output appears incrementally and ends as exactly one persisted reply per item.
4. Tool calls/results and provider approval options reach the existing UI.
5. Allow/deny and Stop operate on the correct thread and pending request.
6. Two prompts use the same native session; after application restart it loads
   the persisted native session or reports an actionable failure, never silently
   starts an empty conversation under the old transcript.
7. The owner can inspect what the application sent before/after dispatch.
8. Transport/process failure clears busy state and pending approvals.
9. A reproducible isolated E2E fixture proves the new path through the real UI.
10. Desktop launch/build is verified separately from renderer/API tests. Real
    Codex authentication/provider evidence is separately recorded.

## Decisions

- 2026-10-09: Start from upstream commit
  `974670059884139d5a7c115e4bfae2b5ee778fec` (OpenMausBot 0.1.101).
- Reuse application infrastructure, replace the protocol implementation.
- Preserve native CLI authentication; ACP does not itself supply subscription
  entitlement. Pin/test adapter updates rather than auto-update on each launch.
- The development/runtime machine initially has Node 22.23.1; upstream requires
  Node 24. Use Node 24 for project execution and document bootstrap commands.
- Keep this fork's execution changes narrow and traceable for future upstream
  updates. Remove unused registrations/features from the phase-1 runtime first;
  avoid broad source deletion before understanding dependencies.
- Packaged phase 1 ships the adapter's compatible native Codex dependency
  (`0.159.3`) and inherits existing CLI auth/configuration. Global Codex installs
  are not modified. Native Ask is read-only; Full is agent-full-access.
- Verification includes a real-provider check through the built desktop app,
  not only compilation, protocol mocks, or a standalone runner.
- 2026-10-09: User reports the packaged Codex experience works smoothly. This
  is qualitative acceptance feedback, separate from the recorded fixture checks.
- 2026-10-09: **Colonie** replaces the earlier Normie choice as the approved
  product name. Implement and verify the
  rename before expanding agent integrations or personal features.
- 2026-10-09: Persona, SOUL and Chief are desired future product features. Their
  future integration must be explicitly configured and inspectable, rather than
  automatically restoring the upstream context pipeline. Phase 1 remains empty
  by default until a separately implemented and verified context feature exists.
- 2026-10-09: Previous-message editing is not needed. Browser integration is not
  a priority. Other missing features are candidates for restoration, not blanket
  approval to enable every upstream feature or claim feature parity.
- 2026-10-09: After the Colonie rename, prioritize **full Claude integration at
  the level of the current Codex core workflow**, before personalization and
  feature restoration. A minimal compatibility check is not this milestone's
  completion criterion. Establish shared multi-provider boundaries and verify
  provider differences before building more features on them.
- 2026-10-09: Replace the OpenMausBot mascot/art using
  [jeremy-prt/bloub](https://github.com/jeremy-prt/bloub) as the visual foundation,
  so Colonie has a distinct product appearance. Include this in M5 branding;
  full Claude integration remains the immediate next milestone.

## Completed M5 — Colonie identity

Rename the fork's product-facing identity, desktop bundle identity, build
artifacts, project-owned commands and documentation coherently, and replace the
default mascot/art with a Bloub-based Colonie treatment. Audit persisted
paths before selecting a migration: existing DevOne chats, settings, input
receipts and native session references must remain usable. Do not silently
rename the workspace directory or touch the user's original OpenMausBot install.

Acceptance: a newly built Colonie app opens from its artifact, displays the new
name and visual identity, continues an existing DevOne conversation and uses the
same local ACP execution behavior. Fresh and existing-data startup must be
verified separately with disposable fixtures. Existing upstream notices and
attribution are retained.

Implemented data strategy: fresh installations use `.colonie`/Colonie profile;
existing `.devone`/DevOne profile paths are reused in place, without copying or
rewriting native cwd/session references. Explicit location overrides take
precedence. Fresh desktop and old-artifact upgrade fixtures passed.

### Bloub visual integration

- Source reviewed: `jeremy-prt/bloub`, commit
  `b4bb3c1b5f93c7b87a2e8d620f667c4093d97749`. Pin the adopted revision and record
  which files/assets are reused or modified when implementing.
- Bloub is animated SVG/code, not only a collection of static images. Its
  `src/bot/` engine is framework-free TypeScript; its supplied component is Vue.
  Prefer the reusable engine/geometry plus a small React renderer wrapper, rather
  than adding a Vue application/runtime to the React chat UI.
- Apply the new mascot consistently to default bot avatars, sidebar/chat headers,
  in-flight presence, appearance previews, empty/loading surfaces and app-owned
  mascot illustrations. Produce matching static app/Dock/startup/favicons where
  needed. Preserve user-uploaded avatars.
- Select Colonie defaults for shape, palette and expression. Replacing the
  OpenMausBot visual does not itself establish an original design: Bloub describes
  itself as an x.ai-avatar recreation. Its MIT code notice must accompany reused
  code; retain Jérémy Perret attribution and the repository's stated distinction
  between code licensing and the reference design.
- Map agent status to visual state explicitly: idle, working/thinking, awaiting
  permission, success and failure. Existing CursorAvatar state/body/expression
  identifiers are not interchangeable with Bloub's; define documented fallbacks
  for saved bot appearance settings rather than dropping settings or guessing ids.
- Keep mascot state derived from application events; artwork never inserts model
  instructions. Verify small-size legibility, light/dark backgrounds, multiple
  SVG instances, reduced-motion/static rendering and cleanup of animation loops.

## Completed M6 — Claude core-workflow integration

Both providers use the shared official-SDK ACP runner and separate descriptors,
auth/configuration and native session references. Desktop selection, streaming,
reconnect, tools, Allow/Deny, Stop, queued follow-ups, input receipts, continuity
and full restart are verified. Bounded real-provider checks additionally prove
session memory after restart and actual native file writes/denials through the
packaged UI. Published versions and evidence are recorded in `PROGRESS.md`.

Native mode semantics differ: Codex Ask is `read-only`; Claude Ask is `default`.
Full maps to `agent-full-access`/`bypassPermissions` only if advertised. Form
elicitation, nested subagent rendering and all optional protocol extensions are
outside current core parity. Switching providers after a session starts requires
a new thread instead of silently discarding native history.

## Personalization and feature restoration

After completed branding/provider milestones, feature ordering is proposed in
`PLAN.md`:

- Persona/identity and SOUL: users choose and edit their agent's behavior; display
  metadata is distinguished from fields actually sent to the agent.
- Chief: distinguish the configured role/personality from its later ability to
  coordinate agents. Naming a bot Chief must not imply working delegation tools.
- Context transparency: inspect active app-owned sections and exact dispatched
  input, with version/source information and documented session-change behavior.
- Useful coding controls and custom MCP/connected tools, using native provider
  capabilities instead of implying unsupported modes or metrics.
- Memory, routines/schedules, team coordination, computer/VM and voice as bounded
  later milestones. Browser and previous-message editing are outside the current
  roadmap. Office multiuser access remains a separate deployment milestone.

M7-B implements scoped, explicit persona/SOUL and context transparency as described
below. Coordination, integrations and automation remain future requirements.
Native provider instructions/auth remain agent-owned; adapter maintenance remains upstream.

## M7-A — native controls (current implementation slice)

Before persona/SOUL, provide native controls read directly from the session:
model, thought-level/model-config categories and available modes. Opening the
panel explicitly discovers settings without a model prompt and pins the session's
working directory. Choices are stored per thread/provider and revalidated against
current capabilities before dispatch. Stale values must be rejected and repairable
in the panel. Agent fallback modes must be shown as the effective values.

Configuration uses upstream SDK contracts, revision/session snapshots for
concurrent edits, and an API module behind authentication, visibility and desktop
mutation gates. Changing the app's permission default restores its baseline
mapping; native overrides apply while the baseline used when selecting them stays
the same. Receipts must store effective configuration alongside application input.
This does not add persona context or change the application's system prompt.

## Product language

The primary audience is US users. Product-authored UI copy, factory/application
context, built-in persona/SOUL templates, help text and product/project
documentation must use English (US). User-authored content and native provider
output retain their own language. The coding assistant's working conversation
with the project owner remains in Bahasa Indonesia, with explicit fixture,
real-provider, usage-limit/blocker and remaining-scope status.

## M7-B — scoped, explicit application context

- App-wide context (factory identity/capabilities and owner-authored shared
  instructions) has its own workspace preferences. Bot-specific persona
  (name/title/description/Chief identity) and SOUL have independent per-bot
  switches and reuse the saved bot profile. Appearance never becomes instructions.
- App awareness, persona and SOUL default on. The primary audience is nontechnical:
  editing a bot's profile/instructions is sufficient; no ACP activation step is
  required. Plain/native switches remain opt-in developer controls. Instance-level
  explicit adapter instructions remain a distinct source. No legacy memory,
  recall, skills, team, About Me or automation assembly is restored.
- Pin stable app, bot and explicit instance context at the first attempted prompt
  dispatch, after native setup succeeds. Native discovery sends no prompt and does
  not pin context. Later profile/preference changes affect new conversations;
  the first turn uses the settings/profile captured when that message is admitted,
  so edits made during native setup do not alter an already-admitted request.
  existing conversations use the persisted snapshot, including after restart.
  Pre-M7-B dispatched conversations remain plain for app/bot additions.
- Effective capabilities/model/mode are runtime-derived on each dispatch when app
  awareness is enabled. Permissions are enforced by runtime/native providers.
  A Chief identity does not claim working coordination or delegation.
- The independent shared composer sends named text blocks as ACP user content,
  preserving the user's message bytes in its own block. ACP blocks do not create
  multiple system-prompt levels; native/project instructions remain agent-owned.
- An explicitly enabled Developer tools preference exposes ACP inspection;
  it is off by default, independently of Simple/Advanced interface mode. The
  inspector exposes workspace and bot switches, preview/current snapshot,
  changed-profile state, source/version/hash/status and exact dispatch blocks.
  Settings updates are owner/admin-only, thread-owned, revision-guarded, and behind
  existing application auth/visibility/desktop mutation gates.
- Acceptance: both provider fixtures prove app context shared across bots, bot
  context isolation, plain baseline, discovery-before-profile-edit behavior,
  pinned continuation/restart, and effective capability changes. Renderer evidence
  must prove the actual controls, preview and manifest; real-provider evidence is
  recorded separately, with Codex quota limitations retained.

## Bot-level conversations — default product UX

Multiple conversations per bot are a core feature for nontechnical users, not an
Advanced-only feature. Each conversation owns its transcript, native session,
working folder, effective options, approvals, queue, Stop and pinned profile.
New conversations inherit the bot's saved profile/defaults without replaying
sibling histories. Cross-conversation memory is not implied.

Provide visible Conversations and New conversation controls in normal chat,
including with the sidebar closed or its tree hidden. The sidebar list respects
the saved display preference independently of Simple/Advanced mode. Folder creation
and technical controls remain advanced. Switching conversations never cancels work;
activity/unread/approval indicators identify the relevant conversation. Verify
parallel ACP turns, scoped approvals and Stop, separate receipts/native sessions,
and full-server/app restart using isolated fixtures for both providers.

## M8 — Composio connected apps

First integration: Composio, selected by the owner. Reuse the application's
credential storage and account-connection UI/API where useful. Keep the ACP tools
boundary independent from the legacy agent/context/connector-continuation pipeline.
Both maintained adapters advertise HTTP MCP; negotiate this capability explicitly.

Workspace connections and credentials are app-wide. Bot profiles select which app
toolkits that bot may use. Composio sessions enforce those toolkit scopes, and a
local authenticated relay rechecks the bot's current access and active conversation
before executing calls. Project keys stay server-side, never in native agent env,
MCP headers handed to agents, prompts or receipts. Stop aborts pending relay calls.
Reloading tools must retain the native conversation/history, not silently create
a new native session. Empty selections mount no app tools. Tool receipts expose
only non-secret app/toolkit metadata. Normal UX uses Connected apps and bot profiles;
transport/session diagnostics remain developer-only.

Verification: isolated loopback Composio/MCP and real-SDK agent fixtures for scopes,
disabled access, approvals, Stop and reload/restart; actual renderer/packaged UI;
bounded real Composio discovery/read against a disposable user/session, inherited
native Claude authentication for the provider check. Never execute requests against
the owner's existing connected accounts as a verification shortcut.

Clarified product scope: Composio is the **only built-in ready-to-use integration**.
All other services (including Figma/Pendev) are user-configured Custom MCP servers.
Reuse the app registry for command/args/env or remote URL/headers/OAuth; bot profiles
explicitly select those entries. No vendor-specific presets are added. Session
mounting uses the shared upstream ACP contract and checks transport capabilities.

### Credential status and mutation semantics

Composio project-key availability is distinct from managed-broker availability and
individual app-account connections. Normal settings show an owner-only masked key
and its source (device encrypted store, existing workspace settings, or externally
provided environment). No key means setup only, no app catalog or Connect controls.
Environment keys cannot be removed through the app. Save/Remove report distinct
failures and retain the previous status on failure. Migration publishes memory
only after persistence succeeds. Removing the last known credential removes the
encrypted document without encrypting an empty payload; rejected server commits
restore the original encrypted bytes. An unreadable document is never overwritten
or removed based on an empty/unknown view. Verification uses synthetic credentials
and isolated app data/profile; no real-provider regression is required for this UI/
storage follow-up.

## ACP-only product consolidation and deferred legacy retirement

Colonie has one supported ACP execution experience. Its UI identity must not be
inferred from provider-list loading or a mixture of driver kinds. Simple/Advanced
controls presentation density, never the connected-tools destination or transport.
M8-C consolidates navigation and reuses the useful upstream Apps marketplace over
Colonie's existing credential/policy/ACP boundary; Composio remains the only built-in
ready-to-use integration, with other services configured as Custom MCP.

Colonie isolates its own state from the user's own coding-assistant CLI: the ACP
engines always run with a per-engine config directory under the app data dir
(`CODEX_HOME`, `CLAUDE_CONFIG_DIR` → `~/.colonie/native/...`), so Colonie's
sessions, sign-in and history do not mix into `~/.codex`/`~/.claude`. This is the
app's fixed behaviour, not a mode or a setting. App-authored context (memory,
skills, per-bot workspace) likewise lives under the app data dir and is delivered
per dispatch; MCP servers are passed per ACP session. Account/service-level facts
are the only part that cannot be separated, and that limit is stated rather than
hidden. A user who stops using Colonie and returns to the plain CLI finds their
own state unchanged.

Because the login is isolated, the app must show whether each ACP engine is signed
in and offer a way to sign in: it probes signed-in state over the protocol (never
from stored credentials) and runs the engine's own `authenticate`, so the isolated
login is discoverable and usable from the app.

The owner approved bounded delegation of frontend UX cleanup through Herdr/OpenCode
with a free model when available, with complete planning, separate file ownership,
one-pass reporting and lead review. This does not delegate or authorize broad
backend removal. Full legacy retirement is deferred architecture milestone D1 in
`PLAN.md`: frontend and backend logic, drivers, dispatch/routes, context assembly,
entry points and build dependencies are audited and retired in separate slices.
Shared infrastructure and persisted-data compatibility must be explicitly retained
or extracted. Future memory/Chief/routine features must not be erased merely because
their upstream execution pipeline is currently unsupported.

## M9-A — controlled cross-conversation memory

Owner-approved order: complete memory, then Chief delegation (M9-B). First-run
provider work is proceeding independently. The memory contract covers automatic
capture, immediate correction/consolidation, relevant recall, owner controls,
provenance, scope isolation and restart; CRUD alone is not milestone completion.

- Shared memory holds durable owner facts/preferences; private memory belongs to
  one bot. Other bots' private notes/transcripts are never copied automatically.
- Capture accepts successful owner-driven ACP direct turns only. Initial evidence
  is the person's own text, not assistant guesses, quoted documents or tools.
  Model proposals require validated verbatim source quotes, bounded confidence,
  scope and entry targets. Corrections supersede the intended existing fact.
- Capture runs asynchronously in a separate bounded ACP session with no app MCP,
  project, persona or conversation history. Permissions are denied; observed tool
  activity invalidates the proposal. Native tools remain provider-owned.
- Recall is dynamic reference data per dispatch, separate from stable persona/SOUL
  pins. Exact selected memory is recorded before dispatch; the user's own message
  retains its bytes. Plain/legacy app-context-disabled conversations stay plain.
- Memory and automatic capture have normal shared/per-bot controls, enabled by
  default; stored explicit off choices are honored. Forget/edit/off invalidates
  pending proposals. Tombstones prevent automatic resurrection of forgotten facts.
- Store and durable job queue live under application data, independently of native
  provider session state. Expired facts do not enter recall. Corrupt/unreadable
  storage is not overwritten as an empty memory.
- Editing or forgetting affects future retrieval, not text already delivered to a
  native session. Existing native history is not silently reset or represented as
  erased. A new conversation provides a clean native context.

Preserve legacy Markdown notes/APIs without silently importing their old context
pipeline. Verify both-provider SDK/HTTP lifecycle, renderer controls, restart and
bounded real-provider behavior separately. Implementation ownership and exact
acceptance matrix: `plans/2026-10-11-colonie-memory.md`.

## M9-B and M10 — default Chief and usable skills (owner approved)

The first bot is Chief automatically. Colonie has exactly one Chief per workspace,
regardless of legacy sections. Existing unique Chief/profile choices are preserved;
otherwise an existing first/oldest bot is selected without resetting its history.
Users can transfer the role through an ordinary profile action. The current Chief
must be transferred before deletion/archive; no per-team Chiefs are introduced.

Chief is a normal user-named/personality/provider-configured bot with authority to
create, inspect, update, delete and ask other bots and manage their skills. Normal
chat is sufficient. Model-facing management tools use scoped active-turn ACP MCP
leases, not the legacy agent/team prompt pipeline. Authority is checked against
the current Chief on every operation. Stable request IDs, persisted operation
claims and argument hashes prevent duplicate mutations/assignments after retries;
uncertain operations after restart are not silently re-executed.

Each delegated task has a fresh target conversation and explicit selected task
context, its own provider/model/tools/permissions/memory/skills and status/result.
Chief combines actual results, not success claims. Normal UI shows who is working,
which task needs approval and what completed/failed/stopped. Stop cancels only the
source request's owned children. Group chat, team orchestration and routines remain
deferred pending a separate product discussion.

Skills are reusable guides managed from normal bot profiles or Chief chat. Users
can author/read/edit private guides, import supported SKILL.md/source URLs, enable/
disable/remove and assign existing library guides. Reuse the upstream store,
review/integrity rules and private-over-library name precedence. External imports
arrive disabled; explicit user/Chief-authored guide changes use the exact-content
store path. Imported/library originals can be copied to editable private guides.

ACP receives a bounded dynamic index; scoped read_skill MCP returns exact enabled,
integrity-checked bodies only for the receiving bot. No app-managed guide is copied
into a user's project or global native CLI configuration. Profile pins/native
history remain stable; settings apply to subsequent requests. Native project and
provider instructions remain agent-owned. Skills do not grant new tool permissions.

Implementation plan and disjoint worker ownership:
`plans/2026-10-12-chief-and-skills.md`. The implementation also hardens memory boot
so unreadable stored memory leaves the app usable and explicitly memory-unavailable,
without overwriting unknown data. All workflow claims require isolated evidence.
