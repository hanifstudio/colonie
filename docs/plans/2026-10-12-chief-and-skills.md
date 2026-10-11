# M9-B + M10: one default Chief and usable ACP skills

## Approved product contract

The owner approved implementation, not only planning. Groups remain deferred.
The first bot is Chief by default. Exactly one Chief exists per Colonie workspace.
Chief is a normal named/personality/provider-configured bot with authority to
create, inspect, change, delete and ask other bots, and manage their skills. Users
talk to Chief in ordinary chat. Switching Chief transfers the role; it does not
create a second Chief. The current Chief cannot be deleted/archived until the role
has been transferred. Other bots execute with their own permissions, model, tools,
memory, skills and fresh assignment conversations.

Skills are reusable instructions managed through normal bot profiles and Chief
chat. Users can create/read/edit enabled/disabled guides, import external SKILL.md
or a supported source URL, and assign existing library guides to a bot. Keep
existing import review/integrity behavior. No developer/ACP setup step is needed.
App-managed skill indexes and bodies remain separate from native project guidance.

Also close the known M9-A startup gap: an unreadable memory ledger must leave the
app usable with memory explicitly unavailable, without overwriting its data.

## Ownership and working rules

Lead `w2M:p8`: shared-file changes, store Chief invariant/migration, ACP contracts/
runtime/context, server wiring and assignment dispatch, profile/chat mounts,
fixture agent changes, verification recipes, docs, integration review and fixes.

Chief worker `w2M:pB`, skills worker `w2M:pC`: OpenCode,
`9router/alitp-intl/deepseek-v4.1-flash`, verified through `opencode models 9router`.
Pane `w2M:p1` confirmed its color investigation made no edits and does not own the
lead's files. Preserve any subsequent changes and coordinate package output.

Worker allowlists are **new files only**:

- Chief: `server/colonie/chief/**`, `shared/colonie-chief.ts`,
  `src/components/ChiefControls.tsx`, `src/components/ChiefActivity.tsx`, co-located
  `.test.ts` files for those two components.
- Skills: `server/colonie/skills/**`, `shared/colonie-skills.ts`,
  `src/components/bot-settings/ColonieSkillsSection.tsx` and its `.test.ts`.

No worker edits index/store/runtime/context, existing skills modules, profile
shells, locales, App/SettingsModal, docs or another worker's files. No commits,
pushes, resets, stashes, restores, subagents, real-provider calls or package builds.
Use apply_patch. Implement one bounded pass, targeted checks, then report and stop.
Send interface decisions early to lead via `herdr agent prompt w2M:p8 '...'`.

Read AGENTS.md, SPEC/PLAN/PROGRESS and verification/README.md first. Product copy
and docs use English (US); working reports to the owner use natural Indonesian.
Node >=24, currently available through `/opt/homebrew/opt/node@24/bin`.

## Exact audited integration map (avoid broad searching)

- `server/devone/acp-runtime.ts`: shared upstream ACP SDK runner. `sendTurn` saves
  exact receipts before prompt, activates `AcpToolMount`, records tool calls at
  finish, deactivates on completion/Stop, releases on close. Session mount revision
  changes reopen/load the same native session. Both adapters support HTTP MCP.
- `server/colonie/connections/contracts.ts`: `AcpToolMount` has servers, revision,
  public receipt, activate/deactivate/release/calls. Existing manager.ts is the
  example of a loopback bearer MCP relay. Do not modify/import the legacy ACP client.
- `shared/connected-apps.ts`: public server source currently composio/custom; lead
  adds `colonie` for internal management/skill tools and merges mounts.
- `server/index.ts`: `acpToolMount` near 3770; independent direct ACP dispatch near
  9980; pre-dispatch refusals near 9854; `startTurn` options near 9655;
  owner route registration near 16070; internal relay handling near 16780;
  `interruptDirectThread` near 2884; store/bus lifecycle hooks are reusable.
  StartTurn returns after admission; actual ACP setup/dispatch is asynchronous.
- StartTurn supports `peerAsk`, `commsDepth`, `onDispatchError`, `onTurnSettled`.
  Existing ACP refuses peerAsk/coordination; lead adds a separately validated
  `colonieAssignment` option rather than reopening legacy coordination.
- `server/store.ts`: createBot near 1774 persists before publish; deleteBot near
  1958 owns transcript/workspace/skill-state cleanup; patchBotProfile near 2089;
  setChiefOfStaff near 2238 currently enforces one **per section**, not workspace;
  createTask near 2828 has activate=false and openedBy, returns fresh threadId;
  seedIfEmpty near 2953; constructor normalizes old section Chiefs near 777.
  Lead changes the Colonie path to a global transactional singleton while
  preserving non-Colonie upstream behavior.
- `deleteBotWithLifecycle` in index near 11744 handles owned provider/computer
  cleanup and accepts a revalidate callback. Reuse it; no raw rm from Chief tools.
- `server/routes/table.ts`: authenticated route factories, explicit deps, PASS.
  Owner means loopback trust != service or admin session; existing HTTP auth and
  desktop mutation gates remain in force. Internal MCP has its own private bearer.
- `server/skills.ts` existing imports/install/manifest/native-link/integrity store:
  listSkills (590), readSkillFile (597), installSkill (633, disabled),
  setSkillEnabled (667), removeSkill (738), stageSkillWrite (1180),
  applyStagedSkillWrite (1309), resolveBotSkills (1465). Stage/apply gives editable
  learned revisions and conflict-safe updates; use `learned:colonie` provenance.
  stage update requires a learned source and appliedStageId: imported bytes are
  immutable. Offer copy-as-editable for imports, not remove/reinstall overwrites.
- `server/skill-library.ts`: listLibrarySkills (304), installLibrarySkill (314),
  readLibrarySkillFile (371), setLibrarySkillReviewState (383). Library entries
  are immutable by name, assignments live in BotRecord.assignedSkills. Reuse
  existing entries without globally enabling the old skills/context pipeline.
- `shared/skill-md.ts`: isSkillName, parser, scan, max bytes. Skill bodies are
  SKILL.md only; supporting scripts/references are still outside current import
  boundary. `server/skill-fetch.ts` source fetch helper is to be located narrowly
  by import `fetchSkillFromSource` in index; reuse it for source import.
- `server/workspace.ts`: skill files live under per-bot DATA_DIR/workspaces; ACP
  conversations use DATA_DIR/task-workspaces or a user's pinned cwd. Do not create
  links/files in a user's chosen project or global CLI home. Skill bodies are read
  through the scoped MCP tool, so a chosen cwd does not bypass bot isolation.
- `src/components/BotSettingsDialog.tsx`: ACP section allowlist near 93, skills
  body near 318, permissions body later. Lead adds Skills and new Chief controls,
  avoiding old team-scoped permissions/proposals for ACP.
- `src/components/bot-settings/SimpleBotPanel.tsx`: normal ACP profile cards near
  205; lead mounts ChiefControls and ColonieSkillsSection there.
- `src/components/ChatView.tsx`: lead mounts ChiefActivity near conversation header.
  Existing task navigation exposes private assignment threads as normal bot work.
- `src/state/store.tsx`: api/ApiError/useStore; source UI patterns in
  ColonieMemorySection.tsx and BotConnectedTools.tsx. Guard request sequencing,
  drafts and captured revisions across bot changes; no optimistic success.
- `server/devone/testing/fake-agent.ts`: maintained real-SDK fixture. Lead extends
  scripted management/skill calls. HTTP fixtures use canonical
  `launchVerificationServer(...,["devone"])`; package fixtures have disposable
  app/profile and use actual production Electron/renderer/server.

## Chief worker: shared contract and implementation

Create `shared/colonie-chief.ts` with renderer-safe types:

```ts
interface ChiefBot { id: string; name: string; title: string; description: string;
  chiefOfStaff?: boolean; hidden?: boolean; modelSelection: {instanceId:string;model:string}; }
interface ChiefActor { botId: string; threadId: string; turnId: string }
interface ChiefAssignment {
  id: string; chiefBotId: string; sourceThreadId: string; sourceTurnId: string;
  targetBotId: string; targetThreadId?: string; message: string; context?: string;
  status: "queued"|"running"|"waiting"|"completed"|"failed"|"cancelled"|"interrupted";
  createdAt: string; updatedAt: string; result?: string; error?: string;
}
interface ChiefView { chief: ChiefBot|null; revision: string; assignments: ChiefAssignment[] }
interface AcpAssignmentContext { id:string; chiefBotId:string; chiefName:string;
  sourceThreadId:string; context?:string }
```

Export `ColonieChief` from `server/colonie/chief/manager.ts` (no Node parameter
properties). Constructor `(deps)` and optional dataDir constructor/deps override
for isolated tests; use DATA_DIR by default. Exact dependency methods:

```ts
interface ChiefDeps {
  origin: string; dataDir?: string;
  bots(): ChiefBot[]; bot(id:string): ChiefBot|undefined;
  chiefId(): string|null;
  owns(botId:string,threadId:string): boolean;
  currentTurn(botId:string,threadId:string): string|null;
  busy(botId:string): boolean;
  setChief(botId:string,expectedRevision:string): void;
  createBot(input: {name:string;title?:string;description?:string;soul?:string;
    modelSelection?:{instanceId:string;model:string}}, signal:AbortSignal): Promise<ChiefBot>;
  updateBot(botId:string, patch:{name?:string;title?:string;description?:string;
    soul?:string;modelSelection?:{instanceId:string;model:string}}, signal:AbortSignal): Promise<ChiefBot>;
  deleteBot(botId:string,signal:AbortSignal): Promise<void>;
  createAssignmentThread(job:ChiefAssignment): string;
  runAssignment(job:ChiefAssignment,signal:AbortSignal): Promise<string>;
  skills: {
    list(botId:string): unknown;
    readEnabled(botId:string,name:string): {text:string;sha256:string}|null;
    save(botId:string,input:unknown,actor:ChiefActor): unknown;
    setEnabled(botId:string,name:string,enabled:boolean,expectedRevision:string): unknown;
    remove(botId:string,name:string,expectedRevision:string): unknown;
  };
}
```

Public methods: `mount(botId,threadId,instanceId,skillRevision?,skillHashes?)` ->
`AcpToolMount|null`; `handle(req,res,body)` internal loopback MCP route;
`view(sourceThreadId?)`; `revision()` for role-transfer optimistic concurrency;
`cancelSource(threadId)`; `cancelBot(botId)`; `invalidate()` for role changes;
`assignment(id)`; `isAssignmentCurrent(id,targetBotId,targetThreadId)`;
`setAssignmentStatus(targetThreadId,status)`; `dispose()` aborts all live jobs.
No constructor callback starts model work before server readiness.

### Internal MCP contract

URL `/api/internal/colonie-workspace-mcp`, server name `colonie_workspace`, source
`colonie`, HTTP. Random 32-byte ephemeral bearer per lease, loopback peers only,
reject Origin. Token never enters prompts/receipts or persisted jobs. Owns check
on every request; tools/call needs lease.active and currentTurn. Idle initialize/
tools/list allowed. Revoke on close, role transfer, bot deletion, Stop/shutdown.

Chief tools: `list_bots`, `read_bot`, `create_bot`, `update_bot`, `delete_bot`,
`ask_bot`, `list_skills`, `save_skill`, `set_skill_enabled`, `delete_skill`.
All bots with enabled skills get only `read_skill` (and optional `list_my_skills`),
scoped to self and the dispatched skill hashes. Normal bots get no management or
delegation authority. Reject arbitrary botId on read_skill and disabled/changed
content; a lease's selected hashes bound exactly what it can read.

Arguments use camelCase. Every mutating/delegating tool requires `requestId`
(1–128 chars); source bot/thread + requestId is the durable idempotency key.
Store normalized argument hash: repeated same operation returns the cached result;
same key/different args is refused. Persist claimed operation BEFORE mutation.
Unsettled mutations on restart become interrupted/indeterminate, never replayed
automatically. This prevents duplicate create/delete/tasks after lost responses.
Bound operations/assignments to 1000; prune settled old rows only, never pending
ownership. One atomic ledger, strict validation, 0600, rollback on write failure,
no secrets or raw host config. Long results cap at 8000 chars; operation bodies
and evidence must be redacted before persistence/logging/return.

Ask requires another existing visible bot, a message <=8000 chars and optional
explicit context <=8000. Create a NEW inactive target task, store its threadId,
run with its own provider/tools/permissions, wait for completion, return actual
result. Max 120 seconds for one assignment; timeout/Stop aborts the exact child.
Reject asking self, nested delegation, role loss and stale source calls. Parallel
Chief source conversations own separate jobs/Stop trees. No group/automation code.
Source completion/deactivation aborts any unfinished child. Completed jobs remain
inspectable; interrupted jobs after restart show interrupted and require a new
explicit requestId to run again. Do not silently execute uncertain work twice.

MCP tool failures use JSON-RPC success envelope with tools result isError=true
where appropriate. Append non-secret ConnectedToolCall metadata with server,
tool, targets, started/completed/failed/cancelled. calls() returns copies.

### Public UI/API

`server/colonie/chief/routes.ts`: owner/admin GET `/api/colonie/chief?threadId=`
and PUT `/api/colonie/chief` `{botId,expectedRevision}`. Validate source thread
ownership if supplied. Role transfer rejects while Chief jobs/turns are active;
recheck after readBody. Return fresh ChiefView. Other bots cannot get this control
surface through a model-facing bearer.

`ChiefControls({bot})`: normal profile card: Chief explains create/change/delete/
ask capability; another bot has "Make Chief" action (transfer) with source name.
No per-team switch, hashes or transport copy. Preserve errors and stale-response
guards. `ChiefActivity({botId,threadId})`: normal chat card listing bot name, task,
Working/Needs your approval/Done/Failed/Stopped, result preview and a button to
open the target bot/task using existing store actions. Read names through bot
state if needed. Poll while visible; clean up on unmount; source switching must
never display a sibling conversation's jobs. No developer opt-in.

Tests: bearer/loopback/inactive/role/self/scope rejection, create/edit/delete calls,
idempotency and mismatched reuse, cancellation with sibling unaffected, failed
child never represented as successful, restart-interrupted ownership, UI guards.

## Skills worker: service, context and normal editor

Create `shared/colonie-skills.ts` with:

```ts
interface ColonieSkill { name:string;description:string;enabled:boolean;
  source:string;sha256:string;editable:boolean;origin:"private"|"library";
  warnings:string[] }
interface ColonieSkillsView {revision:string;skills:ColonieSkill[];
  library:ColonieSkill[];assignedSkills:string[]}
interface AcpSkillsContext {revision:string;entries:ColonieSkill[];text:string}
```

`server/colonie/skills/service.ts` exports `ColonieSkills`:
constructor `({bot:(id)=>{id,assignedSkills?}|undefined,
setAssigned:(id,names)=>void,busy:(id)=>boolean})`. Public `view(botId)`,
`read(botId,name)` (review editor includes disabled intact content),
`readEnabled(botId,name)` -> `{text,sha256}|null`, `context(botId)` ->
AcpSkillsContext, `save(botId,input,expectedRevision?,actor?)`,
`setEnabled(botId,name,enabled,expectedRevision)`,
`remove(botId,name,expectedRevision)`, `assign(botId,names,expectedRevision)`,
`importSource(botId,source,expectedRevision)` (bounded async source fetch).

Save input: `{name,description,instructions,enabled,expectedSha256?}`. Users type
normal guide text; service authors valid YAML frontmatter via safe JSON-quoted
strings and owns the SKILL.md envelope. Validate limits/parser, secret scrub,
matching name, latest expectedRevision/content hash. Use stageSkillWrite plus
applyStagedSkillWrite for editable user/Chief-created skills, preserving latest
enabled choice on update. External imports stay disabled until explicitly enabled
and reviewed through UI. Imported/library originals are immutable; offer an
editable private copy with a new name. No remove/reinstall overwrite of old bytes.

Reuse upstream private/library stores and assignedSkills. Private names shadow
library entries consistently. New APIs are independent of old feature flags.
Existing shared library can be assigned/unassigned per bot; changing a shared
library entry's enabled state must not be disguised as a bot-only preference.
Prefer copying a library guide into a private editable guide for bot-only edits.

Reject mutation while the target bot is busy/configuring. Exception: trusted
Chief creating a NEW self skill can be stored for its next request; do not mutate
an existing self guide in flight. actor is a trusted backend argument, never an
HTTP body field. Async imports recheck bot/current revision/busy after await.

Context is a dynamic named index, max 30 guides/4000 bytes, not full bodies. Names,
descriptions/hashes are exact; no empty/malformed/tampered/disabled guide selected.
Index tells the model to call `read_skill` for exact contents when needed, keeping
native project/provider instructions authoritative. Empty index explicitly says
no app-managed guides enabled for this request. Do not call legacy prompt assembly
or publish any files/links outside app-owned directories. Body retrieval through
the MCP service ensures both providers work with a user-selected cwd.

`routes.ts`: owner/admin GET `/api/bots/:id/colonie-skills`; GET `/.../:name` full
text and hash; POST root `{skill,expectedRevision}`; PATCH `/:name` edit or enable
with strict payload; DELETE `/:name?expectedRevision=`; PUT `/assign`
`{names,expectedRevision}`; POST `/import` `{source,expectedRevision}`. Declare
specific routes before the name route so assign/import cannot be swallowed.
Responses return fresh view, invalid/stale/foreign/busy choices are explicit errors.

`ColonieSkillsSection({bot,active?})`: normal Skills card, current list and source,
enabled switches, read/edit/remove, create form Name/When to use/Instructions,
import GitHub/skills.sh URL and SKILL.md text/file, existing library assignment.
Read imported full guide before enabling (existing behavior, not a new required
technical setup). Preserve drafts and captured revisions on 409, guard old async
responses after bot switch/unmount. No hash/MCP/path details in default UI.
Tell users guide changes apply to future requests; old native history is retained.

Tests: own/library collision isolation, disabled import, integrity failure, direct
create/edit preserving enabled state, stale edit rejection, busy/import race,
exact bounded index/no legacy context, body read scope, UI draft/request guards.

## Lead integration tasks

1. Implement transactional global Chief normalization/election in Store for
   Colonie only. Existing unique Chief retained; otherwise choose oldest existing
   visible bot deterministically. First fresh bot is Chief. Preserve profile,
   transcripts, sessions, permissions and appearance. Prevent zero/multiple Chiefs
   through existing PATCH, archive/delete, import/team setup and new direct routes.
2. Inject ColonieSkills into Chief deps; compose its MCP mount with connected apps
   without losing either lifecycle/receipt/calls. Mount management only for current
   Chief; ordinary bots only get scoped reads for enabled skills. Keep SDK transport
   negotiation and native session reload; no credentials in prompt/receipt.
3. Add `acpSkills` and `acpAssignment` to SendTurnInput. Compose dynamic skill/
   current-Chief-role/assignment sections without altering stable persona pins or
   user-message bytes. Plain/legacy app-context-disabled baselines stay plain.
4. Run child assignments through existing ACP branch with a validated job ID and
   fresh task. Exempt only this bound request from peerAsk refusal. Mark internal
   to exclude memory capture and old automation/digest prompts; recheck ownership
   before/after native setup. Never reuse the legacy askBotAndWait dispatch/context.
   Subscribe before dispatch; use exact turn IDs, onDispatchError, signal and
   interruptDirectThread for failure/Stop. Children get their own permissions.
5. Persist assignment statuses from scoped runtime requests/completions, expose
   normal ChiefActivity and target approvals/navigation, cancel exact source tree
   on Stop/role loss/delete/shutdown; startup shows interrupted work, no auto replay.
6. Mount profile Chief/Skills controls and chat work status. Leave New group chat,
   teams and templates deferred. Do not mount legacy group/team configuration.
7. Close memory corrupt-startup gap with explicit read-only/unavailable status;
   never overwrite invalid data. Verify full server start and normal chat still work.
8. Both-provider real-SDK/HTTP tests: fresh/upgrade singleton, transfer, source-role
   revocation, create/edit/delete, idempotent retries, child success/failure/approval/
   Stop and siblings/restart, skills import/create/read/edit/off/assignment/scopes,
   exact receipts and unchanged provider sessions. Real renderer/production package
   then bounded real Claude tool/skill workflow in disposable workspace.
9. Update progress after milestones, report actual commands/results and separate
   simulated provider, renderer, desktop and real-provider evidence. Coordinate
   shared package output. No commit unless newly requested by owner.

## Checks and exit criteria

Workers run targeted own tests and oxlint; typecheck may reflect lead in-flight
interfaces, report exact failures rather than editing other files.

```sh
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm exec vitest run server/colonie/chief/ src/components/ChiefControls.test.ts src/components/ChiefActivity.test.ts
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm exec vitest run server/colonie/skills/ src/components/bot-settings/ColonieSkillsSection.test.ts
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm typecheck
pnpm exec oxlint --deny-warnings <owned files>
git diff --check
```

Complete only when ordinary user chat can actually create/change/ask/delete bots
and create/assign/use guides, one default Chief persists across restart/transfer,
Stop/permissions/idempotency/scope are proven, and normal UI works. Groups are
explicitly not part of this approval. Worker final report: changed files, exact
export/API signatures, commands/results, unresolved blockers; then stop.
