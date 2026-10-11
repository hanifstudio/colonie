# M9-A: complete memory on the Colonie ACP boundary

## Outcome and boundaries

Build usable automatic cross-conversation memory before M9-B Chief delegation.
The first-run/provider work is owned by another session. Memory includes capture,
consolidation/correction, relevant recall, shared versus private scopes, editing,
forgetting, disabling, provenance, and restart-safe lifecycle. A CRUD-only panel
does not complete this milestone. Chief/routines remain subsequent milestones.

Use English (US) for product copy and documentation. Working reports to the owner
are in Indonesian. Do not commit, restore, reset, stash, rebase, push, edit agent
configuration, inspect credential contents, or touch installed app data.

## Parallel ownership

Lead: current Herdr agent in `w2M:p8`. Worker: `memory-worker`, `w2M:pA`, running
OpenCode with `9router/alitp-intl/deepseek-v4.1-flash`. The provider/model ID was
confirmed by `opencode models 9router`; no provider settings were changed.

The onboarding/branding lead in `w2M:p1` confirmed no ownership of
`server/index.ts`, `server/devone/acp-runtime.ts`, `server/devone/context.ts`, or
`BotSettingsDialog.tsx`. They own onboarding, App/main, SettingsModal, locale files,
and branding tests. Avoid those files. Re-read shared files before each small patch.
Do not package concurrently without coordination: artifact paths are shared.

### Worker write allowlist

- New `shared/colonie-memory.ts`.
- New files only under `server/colonie/memory/` (store, capture, recall, service,
  routes, tests; file names below).
- New `src/components/bot-settings/ColonieMemorySection.tsx` and its tests.

All existing shared-file integration, runtime changes, SDK fixture changes,
verification scripts, documentation updates, and final evidence belong to the
lead. The worker must not modify `server/index.ts`, existing memory files,
`server/contracts.ts`, `server/devone/*`, bot-panel shells, locales or progress.
If an interface needs changing, report it to the lead rather than broad searching.

## Audit: where the existing pieces live

- `server/devone/context.ts`: stable app/persona/SOUL snapshots pinned at first
  dispatch; `composeContext` creates named text blocks and preserves the user
  message in its own block. Effective capabilities are dynamic. Memory must be
  dynamic, not added to these stable snapshot hashes.
- `server/devone/acp-runtime.ts`: `sendTurn` around lines 510–573; composer at
  approximately 540, receipt saved before SDK prompt at approximately 551.
  `open` mounts ACP MCP, preserves native session IDs, and negotiates transports.
  Do not use legacy `server/drivers/acp/` or the native Codex driver.
- `server/contracts.ts`: `SendTurnInput` around 112. Lead adds `acpMemory`.
- `server/index.ts`: independent ACP direct-dispatch branch around 9916–9947;
  memory upkeep subscription around 6386; route registration around 16012.
  Existing memory-upkeep does not have an ACP `generateText`, so merely enabling
  the old panel would not establish automatic memory.
- `server/memory-capture.ts`: pure capture helpers and bounded JSON proposal
  approach. `memory-entries.ts`: calendar expiry and fact identity.
- `server/memory-store.ts`, `memory-journal.ts`, `workspace.ts`: existing Markdown
  notes and journal. Preserve these files and old APIs. Do not silently import
  legacy notes or old About me into the new ACP context.
- `server/atomic.ts`: reuse `writeFileAtomic` with mode 0600.
- `server/redact.ts`: reuse `redactSecretsInText`; redact user capture input and
  saved text/evidence. Do not save a purported fact whose content becomes only
  redaction markers.
- `server/colonie/connections/routes.ts`: small route factory, explicit deps,
  owner/admin check, strict Zod body validation, recheck at write boundary.
- `server/routes/table.ts`: `RouteHandler`, `PASS`, context includes `readBody`,
  `json`, `auth`, `method`, `path`, `url`.
- `src/components/BotSettingsDialog.tsx`: ACP section allowlist near 92, memory
  body around 319. Lead adds Memory and routes ACP to the new component.
- `src/components/bot-settings/SimpleBotPanel.tsx`: ACP profile/tool cards around
  191–205. Lead mounts the memory component in normal Details, so no Advanced or
  Developer setup is necessary.
- `server/devone/context.e2e.test.ts`: canonical isolated both-provider HTTP
  fixture and full server restart pattern. Plain baselines must remain plain.
- `scripts/colonie/connected-tools-web-check.ts`: real React renderer fixture via
  `launchVerificationServer`, `mountPreview`, headless Playwright, screenshots,
  owned cleanup. New memory recipe will follow this shape.
- `server/devone/testing/fake-agent.ts` is the maintained SDK fixture supplied
  through `launchVerificationServer(...,["devone"])`.
  Do not substitute the legacy `fake-acp-cli.ts` for SDK verification.

## Product and context contract

1. Memory is on by default in the new memory policy. Preserve explicit off choices
   (`bot.memoryEnabled === false` also gates capture/recall). Existing stored facts
   are not deleted when disabled. New bot defaults must support the feature.
2. Global policy: `enabled`, `automatic`. Per-bot policy: `enabled`, `automatic`.
   Effective capture needs both policies enabled/automatic and current bot access.
3. Shared entries hold durable owner preferences/facts explicitly grounded in
   owner-authored text. Project facts/decisions default to bot-private entries.
   Nothing automatically copies other bots' conversations or private memories.
4. Only completed, successful, owner-driven ACP direct turns are capture sources.
   Failed/stopped turns, rooms, peer messages, automation and quoted tool output
   are excluded. Initially extract from the user's own message only: assistant
   assertions are not evidence of user facts or verified outcomes.
5. Capture starts after completion, asynchronous and isolated from the native chat
   session. Capture is immediate (one bounded call per eligible completed turn),
   serialized, with a bounded durable queue. No historic transcript backfill.
6. Recall is a fresh, bounded snapshot on every dispatch. Stable persona/SOUL pins
   and native session IDs do not change. Plain/legacy app-context-disabled turns
   receive no memory and produce no capture. Record exact memory in the dispatch
   receipt, with IDs, scope, revision and provenance in the section source/text.
7. Memory is reference data, not instructions or authorization. Instructions in
   recalled text do not become app/persona/tool policy. Keep the user block exact.
8. Deleting/editing/off invalidates outstanding capture proposals at commit. A
   delayed response may not restore a forgotten fact or overwrite a user edit.
   Past native prompts cannot be erased: UI says changes apply to future memory
   retrieval, and a new conversation is appropriate for a clean native context.

## Shared types: `shared/colonie-memory.ts`

Keep shared types importable from renderer; no Node or server imports.

```ts
type MemoryScope = "shared" | "bot";
type MemoryKind = "preference" | "fact" | "decision";
interface MemoryPreferences { enabled: boolean; automatic: boolean }
interface MemorySource {
  botId: string; threadId: string; messageId: string;
  at: string; quote: string;
}
interface MemoryEntry {
  id: string; scope: MemoryScope; botId?: string;
  key: string; text: string; kind: MemoryKind;
  createdAt: string; updatedAt: string; until?: string;
  origin: "automatic" | "person"; source?: MemorySource;
}
interface MemoryView {
  revision: string;
  app: MemoryPreferences; bot: MemoryPreferences;
  entries: MemoryEntry[];
  status: { pending: number; running: boolean; lastError?: string; lastCaptureAt?: string };
}
interface AcpMemoryContext {
  revision: string; entries: MemoryEntry[]; text: string;
}
```

Additional internal types may be exported if needed, but publish exact interfaces
to the lead early. Prefer ISO date strings and opaque IDs, never expose host paths.

## Store: `server/colonie/memory/store.ts`

Create one validated ledger at `DATA_DIR/colonie-memory/state.json`; the single
atomic document gives all-or-nothing commits across shared/private scopes and
queue bookkeeping. Constructor accepts `dataDir` for meaningful isolated tests.
No parameter properties (Node strip-only execution). Zod schemas are strict.

Ledger: version 1, monotonic revision, app preferences, per-bot preferences,
entries, suppression/tombstones, processed source IDs, pending jobs and status.
Bound text (max 1000 chars), evidence quote (max 1000), key (max 120), entries
(1000), queued jobs (100), source IDs/suppressions with explicit bounded behavior.
Do not silently evict tombstones in a way that resurrects previously forgotten
facts. At capacity reject new facts with a useful status; prune processed jobs,
not active facts or forget protections. Refuse corrupt/unreadable/symlink ledger
rather than quietly treating it as empty and overwriting it. Only ENOENT is new.

Reuse atomic writer, secret scrubber, calendar-date validator and fact identity
where suitable. Runtime store operations are synchronous read-modify-write bursts
without await; never commit a model proposal against an old revision.

Expose a `ColonieMemoryStore` with the following methods (extra private helpers
are fine):

- `view(botId): MemoryView` exposes shared + that bot only, active/unexpired.
- `snapshot(botId): { revision; app; bot; entries }` for recall/capture.
- `updatePreferences(botId, scope, preferences, expectedRevision)`.
- `saveEntry(botId, { scope, text, kind, key?, until?, id? }, expectedRevision)`:
  owner edits/creates, scope cannot move implicitly; existing foreign private ID
  is rejected; correction of an ID preserves createdAt and records updatedAt.
- `forgetEntry(botId, id, expectedRevision)` removes it from active retrieval and
  records a suppression keyed by scope/bot/key and canonical text; model cannot
  re-add it. An explicit owner `saveEntry` may intentionally restore that key.
- `clear(botId, scope, expectedRevision)` removes selected scope and invalidates
  pending proposals, preserving suppression; shared clear is owner-only in routes.
- Queue helpers `enqueue`, `nextJob`, `completeJob`, `failJob`, `cancelBot`,
  `cancelAll`; durable source identity includes bot/thread/message IDs. Capturing
  the same completed message twice is idempotent. No user text in log messages.
- `applyCapture(job, changes, expectedRevision)` atomically validates current
  settings/revision/source ownership/suppression, upserts or forgets exact allowed
  entries, and completes job. Stale response is discarded, not force-applied.
- `removeBot(botId)` clears private facts/jobs/preferences and strips provenance
  references as appropriate; shared facts remain workspace-owned.

Persisted jobs have a queued/running state; interrupted running jobs recover as
queued on startup with a bounded attempt count. Retry at most once for a proven
interruption/stale snapshot; malformed/provider errors are surfaced without an
automatic retry loop. Stop/disable/delete cancels relevant controller and queue.

## Capture: `server/colonie/memory/capture.ts`

Export `capturePrompt(job, snapshot)` and `parseCapture(answer, job, snapshot)`.
No provider imports. Prompt has a versioned marker `COLONIE_MEMORY_CAPTURE_V1`
and JSON input containing source user text, today, and current entries. Existing
memory is data, not a command. No tools, no suggestions, no inference, no secrets,
no one-off requests, no facts quoted from other people/files/web. Keep original
language of user-authored facts. Shared only for durable facts about the owner.

Answer strict JSON array, max 8 changes:
`{ action: "upsert"|"forget", scope, kind, key, text, evidence, confidence,
   replaces?: existingId, until?: YYYY-MM-DD }`.

`evidence` must be a nonempty verbatim substring of the admitted source text;
confidence must be finite and >= 0.8. Model-generated JSON isn't trusted: keys,
dates, scopes, strings and target IDs are validated. `replaces` or `forget`
targets must be from the snapshot's shared/own-bot entries. For correction use
the existing entry's key/ID, not an unrelated supplied key. Core preference
keys should be stable (e.g. `user.reply-style`, `user.location`). Reject expired
proposals, fabricated evidence, unknown IDs, foreign bot entries, and redactions.
Tests must show a correction with two entries works immediately; no five-entry
threshold and no nightly wait. Never learn an assistant claim as a user fact.

## Recall: `server/colonie/memory/recall.ts`

Export `recallMemory(store, botId, userText): AcpMemoryContext | null`.
Check enabled app/bot policies. Include bounded core shared preferences and
relevant bot/shared facts via normalized word overlap (reuse a pure tokenizer if
available, otherwise implement one in this file). Stable ranking: preference,
relevance, recency, ID. At most 12 entries / 6000 characters total; no raw sibling
transcript replay or all-memory dump. Remove expired entries and excluded scopes.
Return IDs/revision and exact formatted text with a reference-data preamble;
no truncation that cuts a fact into a different statement. Tests cover C++/numeric
identity, Unicode, unrelated projects, limits, expiry and deterministic ordering.

## Service: `server/colonie/memory/service.ts`

Export `ColonieMemoryService` with injected store and deps:

```ts
interface MemoryBot { id: string; memoryEnabled?: boolean; memoryUpkeep?: boolean }
interface MemoryServiceDeps {
  bot(id: string): MemoryBot | undefined;
  owns(botId: string, threadId: string): boolean;
  analyze(botId: string, prompt: string, signal: AbortSignal): Promise<string>;
  log?(message: string): void;
}
interface CompletedMemoryTurn {
  botId: string; threadId: string; messageId: string;
  text: string; at: string;
}
```

- `noteTurn(input)` validates ownership/effective policy, redacts text, queues
  durably and schedules drain. No model call on the user's critical send path.
- `start()` recovers queued jobs and begins draining; `stop()` aborts the worker
  and leaves interruption recoverable; `idle()` resolves after scheduled work.
- `cancelBot(botId)` aborts its call and drops queued jobs; `cancelAll()` for app
  memory off. A single analyzer call runs at a time, each bounded to 60 seconds.
- `view(botId)`, `recall(botId, text)` combine store/current bot policy and status.
- Before/after analyze recheck bot/thread ownership, current enabled/automatic
  choices, and ledger revision. If model times out/errors, keep chat usable and
  surface status. Never apply after stop/delete/disable/edit/clear.
- Do not connect the old MemoryUpkeep automatically. New ledger is the supported
  ACP memory source. Existing Markdown note editors stay intact for compatibility.

## Routes: `server/colonie/memory/routes.ts`

Export `createColonieMemoryRoutes({ service, exists, changed? }): RouteHandler`.
Owner/admin check on every route, including reads; session-less service callers
cannot access it. Lead wires after the existing auth/desktop mutation gates.

- `GET /api/bots/:botId/colonie-memory` -> `MemoryView`.
- `PATCH .../preferences` -> `{scope, preferences, expectedRevision}`.
- `POST .../entries` -> `{entry: {scope,text,kind,key?,until?}, expectedRevision}`.
- `PATCH .../entries/:id` -> `{text,kind?,until?,expectedRevision}`.
- `DELETE .../entries/:id` -> revision query parameter (or strict JSON body;
  choose one and communicate exact contract early).
- `POST .../clear` -> `{scope,expectedRevision}`.

All mutations return the fresh view. Reject unknown bot IDs, stale revisions,
foreign private IDs, invalid scope/body/date/size. Recheck after body await.
Preferences disabling automatic or memory cancels relevant work. `changed` lets
the lead broadcast/invalidate views without coupling store to the server.

## Normal UI: `ColonieMemorySection.tsx`

Props `{ bot: Bot; active?: boolean }`; uses existing `api`, `HIcon`, `Switch`,
`ConfirmDialog` and application styles. API contract above. Show:

- "Memory" with plain explanation of cross-conversation use.
- "Use memory" and "Remember useful details automatically" per bot.
- Shared workspace memory enabled/automatic controls, clearly labeled as affecting
  all bots; no hashes/transport details in normal UX.
- "About you · Shared with your bots" and "Only this bot" lists. Each entry shows
  its fact, origin, date, source conversation ID only as a human-friendly source
  fallback, Edit and Forget. Do not expose source hashes.
- Add memory with scope, kind and text; edit/save and cancel; Forget and Clear
  confirmation; status for capture working/failure, with no false "remembered".
- Global and per-bot controls remain reachable when off. Keep existing entries
  visible for review while disabled. Explain that old messages in an existing
  conversation are still part of its native history.
- No optimistic success on failed saves. Preserve draft on 409/error and offer
  refresh. Switching bot/unmount invalidates old requests; stale responses may
  never populate another bot's list. Poll boundedly only while active to show
  background capture; clean up timer; no request loops when hidden.

Worker tests: meaningful store/service/capture/recall/routes and component
behavior. Avoid tests which merely mirror markup. Run targeted tests once clean;
no full upstream suite, no package writes, no real-provider calls by worker.

## Lead integration (worker does not edit these files)

1. Add `acpMemory?: AcpMemoryContext` to `SendTurnInput`. Compose as dynamic named
   `memory.recall` reference-data section; never modify stable pins. Effective
   capabilities advertise actual memory availability instead of claiming no recall.
2. Add bounded `AcpRuntime.analyzeMemory(prompt, {model, signal})`: independent
   runtime/session, disposable empty cwd, no context/MCP/profile instructions,
   Ask permissions, deny permission requests, reject outputs with tool activity,
   bounded text and timeout, stop owned child on every exit. Use same maintained
   ACP SDK/provider environment; don't change user conversation. Persist exact
   authored analysis input before dispatch (existing receipt path with synthetic
   memory job thread ID is acceptable). Do not add hidden calls to normal discovery.
3. In index create service with current registry/bot/ownership checks and budget
   policy. ACP direct branch obtains fresh recall, passes it explicitly. Capture
   subscriber correlates successful event to exact dispatched receipt's user block
   and source message, excludes legacy/disabled/foreign/automation turns. Avoid
   capturing background analysis as user conversations (events stay isolated).
4. ACP turns skip old capture/daily memory logs; preserve old non-ACP behavior.
   Hook startup/shutdown, bot deletion and explicit memory off. Remove the
   phase-1 forced memory-off default for new starter bots, preserving saved off.
5. Expose normal memory UI in Simple profile and full ACP Memory section. Existing
   legacy MemorySection remains for non-ACP. No App/SettingsModal/locale edits.
6. Extend the SDK fake agent for capture JSON fixture responses with real
   source/quote matching, keeping default scripted behavior unchanged. Fixture
   proposals simulate model judgments, not real answer quality.
7. Add both-provider HTTP capture/recall/correction/forget/off/restart/isolation
   tests using canonical launcher and real SDK fixture. Keep exact user bytes,
   persona pin and native session continuity assertions.
8. Add real renderer recipe for automatic capture, separate shared/private lists,
   edit, forget, stale-save/off and new conversation. Coordinate packaging; then
   desktop fixture against exact artifact if available.
9. Bounded real-Claude check in disposable workspace with inherited CLI auth:
   user preference capture, fresh native conversation recall, correction and
   forget. Bound total requests and report auth/quota/tool-activity failures.
   Codex real usage-limit evidence stays separate; no retry loop.

## Worker verification and reporting

Use Node >=24. The Homebrew path `/opt/homebrew/opt/node@24/bin` was used in
earlier verification; check actual `node --version` before choosing it.

```sh
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm exec vitest run server/colonie/memory/ src/components/bot-settings/ColonieMemorySection.test.ts
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm typecheck
pnpm exec oxlint --deny-warnings shared/colonie-memory.ts server/colonie/memory/ src/components/bot-settings/ColonieMemorySection.tsx src/components/bot-settings/ColonieMemorySection.test.ts
git diff --check
```

Typecheck may encounter lead work-in-progress; report exact failures without
editing lead files. Send early interfaces, then implement in one bounded pass.
Final report: changed files, API signatures, commands/results, blockers, remaining
lead wiring. Stop after report; no autonomous refactor loops or commits.

## Evidence and exit criteria

Read `docs/verification/README.md` and `devone-acp.md`. Always isolated fixture,
explicit URL, temporary data/home/workspace. Retain action/result JSON and logs.
Compilation is not workflow proof. Distinguish unit, SDK simulated-provider HTTP,
real renderer, desktop, and real-provider evidence in `docs/PROGRESS.md`.

Complete M9-A only after new-conversation recall, correction, forget, settings,
source ownership, shared/private isolation and restart pass. Report unverified
model behavior or desktop gaps explicitly. Next concrete milestone: M9-B design
and implementation for Chief delegation, scoped task context and Stop ownership.
