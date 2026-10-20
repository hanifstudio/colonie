# Colonie agent notes

The owner's latest instruction comes first. Start every session by reading
[HANDOVER](docs/HANDOVER.md). Read other files only when the task needs them.

## Where things live

Each kind of information has exactly one home:

- **[Blueprint](docs/COLONIE-BLUEPRINT.md)**: where the product is going, and the owner's decisions.
- **[HANDOVER](docs/HANDOVER.md)**: what is being worked on now, and what comes next.
- **Commit messages**: what was done and how it was checked.
- **The code**: how things work.

Do not create new documents. If something needs writing down, it belongs in one
of the four places above. Git history is the record of the past; do not keep
history, done tasks, or evidence logs in any document.

## How to work

1. Take the task at the top of HANDOVER, or the one the owner gives you.
2. Before editing, write the task in HANDOVER in a few lines: what the person
   using Colonie can do afterward, how you will prove it, and what is out of scope.
3. Work in small steps. Each step is one commit that changes code; its message
   says what you checked, the result, and what you did not check.
4. When the task is done, **delete it from HANDOVER** and move the next one up.
   Rewrite HANDOVER as it stands now; never append a log to it.
5. Decide technical questions yourself. Ask the owner only about product choices.

## Writing rules

- Name things in plain words that say what a person can do, for example
  "Create and switch workspaces". Never invent codes or numbered IDs for
  tasks, stages, or questions. Order is shown by position in a list.
- HANDOVER stays under 100 lines with one active task. The blueprint stays short
  enough for the owner to read in one sitting.
- Docs, UI text, and app-authored context use English (US). Preserve user
  language and provider output.
- Talk to the owner in natural Bahasa Indonesia, for a nontechnical reader.
  Explain a feature as the person using it experiences it, before any detail.

## Product boundaries

- Today Colonie is a local macOS app. Server workspaces and invitations are
  future work. Do not bring back retired hosting, pairing, or integrations.
- Use the upstream ACP SDK and the maintained `@agentclientprotocol/*-acp`
  Claude/Codex adapters. Do not restore the legacy ACP client or native Codex driver.
- Preserve user message text. Provider and project instructions belong to the
  agent; record what the app sends, with secrets redacted.
- Normal bot settings must be enough. The ACP context inspector is a developer
  tool; transport details stay out of the normal UI.

## Safety and checks

- Never read credential contents. Check server and conversation changes against
  an isolated fixture (the `verify-colonie` skill), never the live app or real data.
  Methods are in [verification](docs/verification/README.md).
- Real-provider checks need a disposable workspace and a bounded task.
- Run one heavy job at a time and clean up what you start.
- `pnpm check` (typecheck, lint, tests, structure) must pass. The commit hook
  runs it and also refuses deleted test files, new documents, invented codes,
  and a HANDOVER over 100 lines. Fix the cause; never use `--no-verify`, never
  weaken or delete a test to get a pass. Only the owner bypasses the hook.
- If `git config core.hooksPath` is not `scripts/git-hooks`, set it before
  committing.
- Report failures and unchecked parts plainly. A passing compile or a simulated
  provider does not prove a real workflow works.
- Preserve unrelated changes and third-party attribution.
