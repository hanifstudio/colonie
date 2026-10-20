# Server module map

What each folder under `server/` owns, so a reader — or an agent picking up a task — can
find the right home before searching. The blueprint's
[code structure](../COLONIE-BLUEPRINT.md#code-structure)
describe the target shape; this file describes the current one.

The list is checked, not just written. `pnpm structure:check` (and the test suite) fails
when a folder holding source files is missing from this map, and when this map names a
folder that no longer exists — so it cannot rot quietly, and adding a feature folder is a
one-line change here.

## Composition and shared plumbing

- `server/` root — Process-wide services that `index.ts` assembles: `config.ts`,
  `commands.ts`, `activity.ts`, `request-auth.ts`, `spend.ts`, `sse-fanout.ts`, the
  admittance/approval gates, the proxy helpers and the background workers.
- `server/harness/` — Startup and shared plumbing: server assembly, the HTTP request
  pipeline, SSE client streams, the provider registry, the bus, config status, permission
  and approval resolution, the desktop channel, screen polling, process lifecycle, and the
  memory-upkeep wiring that `index.ts` supplies collaborators to.
- `server/runtime/` — Process environment: the workspace scope that owns a workspace's
  paths (data, native, events, settings, conversations, registry files), the data-dir lease,
  graceful shutdown and restart, child-process bookkeeping, exit.
- `server/routes/` — HTTP adapters, one module per resource (`bots`, `thread-respond`,
  `teams-export`, `desktop-viewer`, …), plus the shared route contract `table.ts`. Route
  modules depend on features, never the reverse.
- `server/persistence/` — Storage: the store, the message database, the search worker's
  query side, atomic file writes.
- `server/hooks/` — Hook entry point (`colonie-hook.ts`).
- `server/testing/` — Shared test infrastructure and fakes: ports and TLS, SSE helpers,
  fake ACP/provider CLIs, control-plane and MCP stubs, environment scrubbing.

## Features (`server/colonie/<feature>/`)

- `server/colonie/bots/` — Bot lifecycle and configuration: creation and defaults, profile,
  avatar and directory, visibility, packages, proposals, presets, system prompt.
- `server/colonie/chat/` — Conversations: turn dispatch and thread admission, streaming,
  context rebuild and budget, compaction, checkpoints, queuing and steering, thread logs
  and retention, attachments, tool cards, resume.
- `server/colonie/chief/` — Chief-of-staff: the manager, its store, and the routes that
  expose it.
- `server/colonie/computer/` — Computers and browsers: local VM lifecycle (lease, seat
  pool, inventory, state, idle, stop reason), container and desktop-viewer targets with
  their contract, browser engine/runtime and sessions, screen frames, observation and
  control.
- `server/colonie/connections/` — Third-party connections: credentials and their routes,
  key permissions, policy, outcome, manager, the Composio-compatible client.
  `server/colonie/connections/testing/` holds the fake Composio and stdio tool.
- `server/colonie/mcp/` — MCP servers: registry and directory, HTTP and OAuth transports,
  probes, schema validation and trimming, connector advertisement/cards/verdicts, tool
  images, the bridge and the gate config.
- `server/colonie/memory/` — Bot memory: capture, entries, topics, organization, journal,
  tidy, the recall prompt and recall. `server/colonie/memory/ledger/` holds the
  capture-to-recall ledger service, its store and routes.
- `server/colonie/peers/` — Peer agents: roster, delivery, delegation lifecycle and watch,
  approvals and keys, provenance, comms visibility.
- `server/colonie/providers/` — Model providers: CLI sign-in and named accounts, key checks
  and rejections, model selection, catalog, prices and context windows, usage booking and
  the usage ledger, engine install, auth sessions, provider icons.
- `server/colonie/routines/` — Scheduled and webhook work: routines and their runs,
  calendar calls, run cards, webhook ingress and wiring.
- `server/colonie/runtime/` — Feature-side event subscriber wiring for the bus.
- `server/colonie/skills/` — Bot skills: the library and resolution, learning, fetching,
  staged cleanup, the skills-library migration, routes.
- `server/colonie/teams/` — Teams as packages: manifest, export/import and parts, package
  wiring, team library, memory and computers, project scout, chief of staff, sections,
  setup requests, published teams.
- `server/colonie/workspace/` — The workspace service and backups: team backup, backup
  policy, maintenance, HTTP surface.

## Other server boundaries

- `server/acp/` — Provider execution boundary: the ACP runtime, the maintained Claude and
  Codex adapters, session/settings/context/profile routes, elicitation, native history,
  receipts. `server/acp/testing/` holds the fake agent and MCP client.
- `server/decider/` — Decision log: the decision types, the log and its index (`index`,
  `jev`, `log`, `types`).
- `server/drivers/` — External agent drivers: the built-in driver, agents
  call/catalog/client/proxy/result, Codex identity, retry, the dweb proxy.
- `server/model-catalog/` — Model catalog defaults: catalog, presets, trimming.
- `server/tts/` — Text-to-speech: the chatterbox, elevenlabs, fish and grok engines,
  speech-text segmentation, system voices, the entry point.

## Outside the server tree

- `src/` — Renderer: `components/` presentation, `lib/` UI helpers and the API/event
  client, `state/` cross-feature composition, `features/` extracted feature UI.
- `shared/` — Portable contracts and pure rules compiled into both the server and the
  renderer.
- `electron/` — Native shell and platform adapters.
- `scripts/` — Build, release, diagnostics and verification tools; `scripts/structure/`
  holds these checks.
- `docs/` — Product reference, current work and recent evidence. `docs/structure/` holds
  the measured baseline and this map.
