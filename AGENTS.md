# Colonie agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

More specific `AGENTS.md` files override this note within their directories.

## Start here

`docs/HANDOVER.md` is the current state of the work, the goal in the owner's own
words, what is verified, what is next, and the traps already hit. Read it before
`docs/SPEC.md` and `docs/PLAN.md`, and prefer it over the rest of `docs/`: most
of those pages describe the upstream project's product and runtime rather than
this fork, and following them steers work in the wrong direction.

## Colonie fork

Read `docs/SPEC.md`, `docs/PLAN.md`, and `docs/PROGRESS.md` before changing
the fork. The target is macOS desktop and Codex/Claude through the upstream ACP
SDK and their maintained `@agentclientprotocol/*-acp` adapters. Do not build on the legacy
`server/drivers/acp/` client or the native Codex driver.

Preserve useful upstream UI, persistence, HTTP/SSE, and Electron infrastructure.
Keep our ACP execution boundary independently understandable. User messages
must not acquire Colonie personas, memory, recall, team, or automation
instructions. Native Codex/project instructions remain agent-owned. Record the
exact application-authored prompt before dispatch so it can be inspected.

Use isolated data directories and fixtures for all verification. Never read
credential contents or mutate the user's installed Colonie. A real-provider
check must use a disposable workspace, inherited CLI authentication, and a
clearly bounded request. Distinguish simulated, real-provider, renderer, and
desktop evidence in `docs/PROGRESS.md`.

Update progress after each milestone and before ending a work session. Record
actual commands/results, unresolved blockers, and the next concrete action.
Do not claim a workflow passed on the strength of compilation alone.

## Communication

Respond to the user in Bahasa Indonesia. Keep implementation status, remaining
scope, and verification evidence explicit; do not promise universal correctness.

Product-authored UI copy, factory/application context, built-in persona/SOUL
templates, help text and product/project documentation must be in English (US).
The primary audience is US users. This is separate from the working conversation
language. Keep user-authored content and native provider output under their owners.

Colonie's primary users are nontechnical people. App awareness and saved bot
persona/SOUL are enabled by default; configuring a bot profile must be enough to
use them. ACP context is an opt-in developer inspector, never a required setup
step. Keep technical transport, receipt and hash details out of the default UX.
