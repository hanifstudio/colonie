# Colonie agent notes

## Read for the task

The owner's latest instruction takes priority. For project continuation, start
with [HANDOVER](docs/HANDOVER.md): current state, active task, and next action.
For a focused question, inspect its relevant source directly. Read other context
only when needed:

- [Blueprint](docs/COLONIE-BLUEPRINT.md): relevant product/architecture sections when scope or intended behavior matters. It is provisional, not implementation evidence.
- [Verification](docs/verification/README.md): before choosing or running checks.
- [Progress](docs/PROGRESS.md): the relevant recent entry when previous evidence matters.
- [Docs index](docs/README.md): to locate a specific guide, not to load every document.

More specific directory AGENTS.md files apply within their directories.

## Development loop

1. Keep one milestone and one task active. For planned implementation, record the outcome, scope, acceptance, and bounded checks in HANDOVER before editing.
2. Inspect current source and WIP. Preserve unrelated changes and third-party attribution; never sweep them into a commit, revert, or cleanup.
3. Decide reversible technical details within authorized scope. Investigate technical questions before asking the owner. Existing permission persists; escalate unresolved product choices or actions beyond it.
4. Implement a small unit, verify it, and review its diff against behavior and [structural/consistency acceptance](docs/COLONIE-BLUEPRINT.md#code-and-design-consistency-acceptance). Diagnose failures before retrying; do not weaken checks or requirements to claim success. Choose a bounded repair budget for the task and checkpoint if exhausted.
5. Update HANDOVER and recent PROGRESS at milestones and before ending work: actual commands/results, material decisions, missing evidence, blockers, and next action. Keep both short; resume unfinished work rather than repeating completed tasks.
6. Continue the next ready task within the authorized milestone without routine approval prompts. Capture new ideas separately; explicit reprioritization overrides the queue and requires a recoverable checkpoint. A question or new topic alone is not cancellation.

## Product boundaries

- Today's foundation is a local macOS app. Server workspaces, invitations, and companion capabilities are future targets. Do not reactivate retired hosting or integrations from historical instructions.
- Use the upstream ACP SDK and maintained `@agentclientprotocol/*-acp` Claude/Codex adapters. Keep that boundary clear; do not restore the retired legacy ACP client or native Codex driver.
- Preserve useful native UI, persistence, HTTP/SSE, and Electron infrastructure.
- Preserve user message text. Default app awareness and bot persona/SOUL follow the scoped Colonie profile/context contract; do not restore unrelated inherited persona, memory, team, recall, or automation prompt pipelines.
- Provider/project instructions remain agent-owned. Record exact application-authored input before dispatch with protected values redacted; do not claim access to provider-internal prompts.
- Normal bot profile configuration must suffice. ACP context is an opt-in developer inspector; transport, receipt, and hash details stay out of default UX.

## Verification boundaries

Use isolated fixtures for server/conversation checks, never the live app, installed
data, or normal development instance. Never read credential contents. Real-provider
checks require disposable workspaces, supported inherited CLI authentication, and
a bounded task. Follow the verification guide for methods and evidence categories.

Structural edits also run `pnpm structure:check` — the import boundaries and the
`server/` module map — and add a line to that map when a folder appears; method,
exit codes and limits are in [structure](docs/structure/README.md).

Run one heavy local job at a time, including child processes; set duration/process
limits and clean up owned fixtures. Documentation edits need document checks, not
builds or E2E. Report inherited failures and missing evidence; compilation or a
simulated provider is not proof of a complete real-provider/desktop workflow.

## Documentation and communication

Keep product planning in the blueprint, current work in HANDOVER, and evidence in
PROGRESS. Avoid duplicate rules/specifications, archives, and redirect-only files;
use Git history only for a specific historical question. Preserve external names
and URLs. The docs guide execution; they do not schedule or wake agents.

Respond to the owner in natural Bahasa Indonesia and explain status/evidence for
a nontechnical reader. Product UI, app-authored context, built-in personas/SOUL,
help, and project docs use English (US); preserve user language and provider output.

Explain a feature as the person using it experiences it: what they see, what they
can now do, what changes for them — a few plain sentences, before any
implementation detail. The owner is an engineer, but a feature explanation is not a
code tour: leave file, module and function names out unless a name is the point.
