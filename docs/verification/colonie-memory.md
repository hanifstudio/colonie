# Colonie ACP memory verification

Follow [README.md](README.md) and [devone-acp.md](devone-acp.md). All commands use
isolated data/workspaces, without live app mutations or credential-content reads.
Use Node 24 or newer. In the recorded environment,
`PATH="/opt/homebrew/opt/node@24/bin:$PATH"` selects Node 25.8.1.

## SDK/HTTP and unit contracts

```sh
pnpm exec vitest run server/colonie/memory/ src/components/bot-settings/ColonieMemorySection.test.ts
pnpm exec vitest run server/devone/memory.e2e.test.ts
pnpm exec vitest run server/devone/conversations.e2e.test.ts server/devone/codex-acp.test.ts server/devone/context.e2e.test.ts server/devone/context-integrity.test.ts server/devone/application.e2e.test.ts
```

The HTTP test uses canonical `launchVerificationServer(...,["devone"])` for both
maintained providers' SDK fixtures. It proves capture, source quotes, shared/private
separation, fresh native-session recall, correction with stable entry identity,
stale-edit rejection, natural-language forget/suppression, off/re-enable, exact
user-message blocks, stable profile pins and full server restart. Log and synthetic
action/result JSON paths are printed by the fixture.

Store/service tests cover atomic rollback, unreadable/symlink refusal, scope/evidence
validation, expiry/budgets, interrupted durable job recovery, duplicate-source
idempotency, owner-generation/public-revision guards, late-result cancellation and
old saved automatic-memory off choices.

## Real renderer and desktop shell

```sh
node scripts/colonie/memory-ui-check.ts
node scripts/colonie/memory-ui-check.ts --desktop --claude
```

The actual React UI uses the canonical SDK fixture: capture, normal profile access,
edit, competing edit/draft preservation, Forget confirmation, Add, off with retained
review, re-enable and new-conversation recall. Desktop uses a temporary Electron
profile and real preload shell with the source renderer/server. Providers are simulated.
Evidence: `.devone/evidence/{memory-renderer,claude-memory-desktop}-check.json` and
screenshots. Locators are scoped to the memory region, alertdialog and conversation
navigation. New-thread sending waits for server selection and the rendered empty chat.

## Production package

Coordinate shared artifact ownership before rebuilding.

```sh
pnpm colonie:package
node scripts/colonie/memory-package-check.ts
node scripts/colonie/memory-package-check.ts --claude
```

The actual production `.app`, bundled renderer/server and Electron shell run with
synthetic SDK agents. Capture/profile and a distinct new native session receiving
recall precede full app restart with the same session/pin. Memory is then disabled
through UI and another restart proves retained review and absent future recall.
Only owned processes and temporary data are cleaned up. Evidence:
`.devone/evidence/{claude-,}memory-packaged-fixture-check.json` and screenshots.

## Bounded real provider

```sh
node scripts/colonie/memory-provider-check.ts --real --claude
```

Disposable app data/workspace, inherited CLI auth, no credential reads. Maximum
five foreground and two analysis requests: capture a synthetic codename preference,
recall in a fresh session, correct it, recall its new value in another fresh session,
forget through the owner store API, and prove a final fresh session answers UNKNOWN.
Permissions are denied and observed tool use fails the check. Exact synthetic
receipts/provenance: `.devone/evidence/claude-acp-memory-real-check.json`.

This is bounded real-Claude ACP behavior, not real-provider packaged sign-in or a
universal semantic-retrieval evaluation. Real Codex remains a separate quota follow-up.
