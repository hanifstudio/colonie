# ACP verification methods

Follow [the verification policy](README.md). This is a curated list of current
entry points, checked for source presence during documentation cleanup; none
was run by that cleanup. Consult [HANDOVER](../HANDOVER.md) and
[PROGRESS](../PROGRESS.md) for actual evidence and limitations.

## Boundary and fixture

The maintained execution path lives in `server/acp/acp-runtime.ts`, with provider
definitions in `server/acp/codex-acp.ts` and `server/acp/claude-acp.ts`.
`server/acp/testing/fake-agent.ts` is the repository-owned SDK fake agent.
Application fixtures call `launchVerificationServer` in
`scripts/control-colonie.ts` with the `colonie` extra-provider option to select
these fake ACP providers, disposable data, and owned ports.

Start with the smallest test matching the changed contract, one command at a time:

```sh
pnpm exec vitest run server/acp/codex-acp.test.ts
pnpm exec vitest run server/acp/context-integrity.test.ts
pnpm exec vitest run server/colonie/connections/manager.test.ts
```

These are possible starting commands, not a requirement to run all three.
For application/session behavior, inspect the relevant fixture before running it:

- `server/acp/application.e2e.test.ts`: application dispatch/session boundary.
- `server/acp/conversations.e2e.test.ts`: independent conversations and control routing.
- `server/acp/context.e2e.test.ts`: scoped application-authored context.
- `server/colonie/connections/connections.e2e.test.ts`: connected/custom MCP boundaries.

Confirm actual request/tool payloads and recorded input, not only an assistant's
claimed result. Resume, transport, permissions, and cancellation need separate
provider-capability handling; a shared UI does not make adapters identical.

## Renderer and desktop

Existing entry points include:

```sh
pnpm colonie:ui-check
pnpm colonie:desktop-check
```

Inspect `scripts/colonie/ui-check.ts` for supported flags, prerequisites, isolation,
and assertions. A test's default simulated provider is not real-provider evidence.
Select the relevant profile/context/connection path and capture visible action
plus resulting state. Do not run both commands automatically for a text-only edit.

## Package evidence

`scripts/colonie/package-check.ts` drives an actual built macOS artifact with an
isolated profile. Check the script's expected artifact and flags before use.
`pnpm colonie:package` builds an unpacked app; `pnpm colonie:dist` makes distribution
artifacts. These are heavy operations, not prerequisites for documentation edits.
Never run a packaged verification against the installed user's profile.

## Real-provider evidence

The optional runner probe is `scripts/colonie/provider-check.ts`. It requires
`--real`, selects Claude with `--claude`, and currently makes three application
requests with a 90-second per-request wait: marker, session reload, and a read of
one disposable file. It uses existing native authentication, denies permission
requests where handled by the script, and records receipts/events.

Inspect its current implementation and cleanup before execution. Its provider
history/evidence can persist outside the disposable app directory. Do not infer
that this runner probe proves in-app sign-in, email delivery, browser/desktop
control, member sharing, or a complete packaged workflow.

Current authentication and quota are not established by this guide. Bound any
real check to the scoped question; report a quota/login block instead of retrying
indefinitely or changing billing. Never read token contents.

## Related current methods

- [Memory](colonie-memory.md).
- [Connected tools guide](../tool-selection.md).
