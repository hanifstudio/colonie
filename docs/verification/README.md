# Verifying Colonie

How to check a change without touching real data. Pick the smallest check that
covers what changed, and report what actually ran.

## Which check

| What changed | Check |
|---|---|
| Docs only | Links and paths. No build. |
| Server or engine code | The focused test files, then `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm structure:check`. Then a throwaway server (below) when behavior matters. |
| Electron shell | `pnpm test:electron` and `node --check` on the changed file. |
| Interface | `pnpm build`, plus a look in a real window, which is usually the owner's step. |
| Packaging | `pnpm colonie:package`, then launch the app with throwaway data. |
| Real engine behavior | A small, bounded task in a throwaway workspace, only after the simulated check passes. |

Run one heavy job at a time (builds, the full suite, Electron, real engines).

## A throwaway server

```sh
env -u COMPOSIO_API_KEY HOME=$(mktemp -d) COLONIE_PROFILE=1 \
  COLONIE_DATA_DIR=$(mktemp -d) COLONIE_PORT=<free port> node server/index.ts
```

Setting only `COLONIE_DATA_DIR` does not isolate it: some settings are read
from `HOME`, and the shell exports `COMPOSIO_API_KEY` to every child. Call only
local routes such as `/api/health`, `/api/bots`, `/api/instances`, and
`/api/config`. Never call a route that reaches a real engine. Stop the process
and delete the folders afterward.

The simulated engine for tests is `server/acp/testing/fake-agent.ts`. The
app-level fixture engine is `server/testing/fake-acp-cli.ts`.

## Never

- Never test against the owner's running app or `~/.colonie`. Never run
  `pnpm colonie --real-data`. Plain `pnpm colonie` uses `~/.colonie-dev-data`,
  which is the owner's development data: still not a throwaway.
- Never read credential or token contents.
- Never kill processes by name. Stop only what you started.

## Saying what was proven

Name the kind of evidence. Each proves only its own layer:

- **Code checks:** typecheck, lint, unit tests.
- **Simulated engine:** the real app with a fake engine. Not real AI behavior.
- **Real engine:** a bounded request to Claude or Codex. Not proof the UI works.
- **Real window:** someone clicked through the interface or the packaged app.

A passing build is not proof that a feature works. Report failures and
unchecked parts plainly in the commit message.
