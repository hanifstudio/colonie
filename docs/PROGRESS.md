# Colonie recent progress

This is the short active evidence log. Product direction belongs in the
[blueprint](COLONIE-BLUEPRINT.md); current implementation and next action belong in
[HANDOVER](HANDOVER.md). Earlier evidence is preserved in the
[pre-cleanup history](archive/2026-10-17/docs/PROGRESS.md). Read historical entries
only for a specific investigation.

## 2026-10-17 — ACP fixture engine restored; per-turn usage crosses the ACP boundary

The verification fixture still configured its `claude` engine with the retired
`claudeAgent` driver, so every fixture test died before reaching its subject
(`unknown driver "claudeAgent"`, inherited from the 2026-10-14 driver
retirement). The fixture now runs the scripted ACP fake
(`server/testing/fake-acp-cli.ts`) behind `claude-acp`, and that fake now also
answers the legacy `modes` block the runtime validates `set_mode` against.

Migrating the ledger test surfaced a real gap: the new ACP runtime never carried
per-turn token usage, so every ACP turn booked `input: 0, output: 0,
costUsd: null` — the usage ledger, spend cap and attribution were bookkeeping on
nothing. The runtime now reads `usage`/`_meta` from the prompt result
(`inputTokens`, `outputTokens`, `cachedReadTokens`, `totalTokens`, the same wire
shapes the retired ACP client read) and emits it on `turn.completed`; the
harness already books that figure.

Commands/results (isolated fixtures only):

- `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm exec vitest run server/acp/ server/routes/bot-memory.test.ts server/email-signin.test.ts server/usage-ledger-api.test.ts`: 17 files, 65 passed / 2 failed — both were `server/acp/application.e2e.test.ts` asserting the exact instance list now that the fixture adds its own `claude` instance; narrowed to the registered driver kinds and re-run green (2 passed).
- `server/usage-ledger-api.test.ts`: green, booking the ACP turn's 10/5 tokens unpriced, because the OSS edition is not entitled to operator prices.

Remaining: about 50 test files still declare a retired driver in their own
fixture config (95 × `claudeAgent`, 43 × `grokAgent`, 19 × `codex`). Owner
decision: migrate the files whose subject is live behaviour, delete the ones
whose subject is the retired driver or protocol. Next concrete action: migrate
the feature e2e files in batches, starting with usage attribution, spend cap,
tool scope and MCP selection.

Blocker unchanged: the Linode instance `172.104.33.55` still needs deleting in
the console (no CLI or token here).

## 2026-10-17 — documentation consolidation

Owner requested removing old project context so agents can work from a consistent
set of instructions. The lead owns the plan and review. Scoped documentation
implementation was delegated through Herdr/OpenCode; the initial three root
guides finished on `9router/alitp-intl/deepseek-v4.1-flash` before the owner requested
the free model. Subsequent worker work uses
`opencode/deepseek-v4.1-flash-free`. Workers were not assigned product planning.

### Scope

- Preserved pre-cleanup Markdown originals and their hashes in `archive/2026-10-17/`.
- Shortened AGENTS, HANDOVER, docs index, and this log. SPEC/PLAN are redirects to the single provisional blueprint.
- Removed old verification/feature recipes from the active reading path. History is opt-in and excluded from default ripgrep discovery.
- Kept active ACP/memory verification methods and the current memory/connected-tools guides, without declaring runtime success.
- Updated root development/security/conduct documentation and the PR template to remove unsupported engine/release instructions and automatic full-test requirements.
- Preserved the owner's single-J01 clarification and other existing blueprint edits.

### Verification

Commands/results:

- `python3 /tmp/colonie-check-active-docs.py` — passed: 21 documents, 123 relative links, 23 verification source paths, and 96 verbatim snapshot hashes. Blueprint decision/feature IDs and the single-J01 clarification are preserved.
- The same check confirmed default `rg --files docs` discovery exposes 12 active Markdown files and excludes archive/evidence assets. Include globs can override ignore files; AGENTS names the required explicit exclusions for broad glob searches.
- `git diff --check -- AGENTS.md README.md CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md .github/pull_request_template.md docs` — passed.
- Reviewed both workers' diffs and results; corrected README engine/authentication wording, normalized trailing newlines, and removed session-specific check claims from contributor instructions.
- Active HANDOVER is 71 lines, SPEC/PLAN redirects are 11/10 lines, and the active verification policy is 72 lines. The old multi-thousand-line progress record is a hash-checked historical snapshot.

No build, Electron/browser, E2E, deployment, real-provider request, external message,
or live data mutation was run by this cleanup. No credential contents were inspected.
Licensing content remains unchanged. Concurrent source/test changes, including
`scripts/control-colonie.ts`, `server/testing/fake-acp-cli.ts`, and the existing
usage-ledger test work, are outside this documentation change and were preserved.

The legacy verification-docs test reads a deleted enterprise source and is not a
valid current check. Its code was not changed or executed. The documentation-only
checks do not replace runtime evidence for later implementation work.

### Next

Documentation cleanup and static review are complete. Perform the agreed read-only architecture audit.
Bring a compact responsibility diagram, retain/adapt/remove map, and one bounded
first implementation proposal. Do not restore retired infrastructure from history.
