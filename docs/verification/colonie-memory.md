# Memory verification methods

Follow [the verification policy](README.md) and [ACP methods](colonie-acp.md).
The current application guide is [Memory in Colonie](../COLONIE-MEMORY.md).
This page lists available methods, not newly passed results.

## Select the changed boundary

Start with the specific store/service/UI unit test relevant to the edit. For an
application capture/recall/restart change, inspect and run the isolated ACP memory
fixture when appropriate:

```sh
pnpm exec vitest run server/acp/memory.e2e.test.ts
```

`server/colonie/memory/` contains the store, service, recall, and capture contracts.
`src/components/bot-settings/ColonieMemorySection.test.ts` covers the normal editor.
Verify scope/provenance, correction/forget, stale edits, off/re-enable behavior,
and ownership of delayed work according to the changed behavior. Do not replace a
semantic capture question with CRUD-only evidence.

## UI and package

- `scripts/colonie/memory-ui-check.ts`: isolated real renderer and optional desktop shell with simulated providers.
- `scripts/colonie/memory-package-check.ts`: built macOS artifact with fixture providers and disposable state.

Inspect the script's current flags, expected artifact, assertions, and cleanup
before running it. Coordinate a single heavy job; do not rebuild merely to edit
this guide. Fake-provider UI success is not real semantic-memory evidence.

## Bounded real provider

`scripts/colonie/memory-provider-check.ts` has a separate real-Claude path. Inspect
its current budget and prerequisites before use; it makes additional provider
requests for foreground work and memory analysis. Use synthetic preferences and
disposable workspaces only. Never inspect credential values or use personal
conversation content as a test fixture.

Real-provider memory semantics, application API behavior, renderer controls, and
packaged restart are separate evidence categories. Record actual commands/results,
scope, cleanup, and limitations in [recent progress](../PROGRESS.md).
