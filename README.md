# Colonie

Colonie is a native macOS app for people who work with AI bots. Each bot has its
own profile, selected model, memory, and working files, and runs through the
maintained Claude and Codex ACP adapters. The current implementation is local:
the app, its harness, and its data stay on this Mac. It reuses the native
desktop UI, persistence, and HTTP/SSE infrastructure. Read
[`docs/HANDOVER.md`](docs/HANDOVER.md) for the exact state and known limitations.

A future target with Local and Server workspaces is a design draft in
[`docs/COLONIE-BLUEPRINT.md`](docs/COLONIE-BLUEPRINT.md), not shipped today: do
not assume cloud execution, a companion app, or invitations work.

## Requirements

- macOS
- Node 24 or newer
- pnpm, pinned as `packageManager` in [`package.json`](package.json)
- Claude Code and/or Codex access, configured through the app's engine setup

A global CLI that is already logged in does not automatically log the app in.
Follow the engine setup shown in the app. Colonie does not copy or export tokens
between the app and the CLI.

## Source development

```sh
pnpm install --frozen-lockfile
pnpm colonie:web   # harness server and web preview on loopback
pnpm colonie       # same server behind the Electron desktop window
```

These regular launches use the app's own data, not an isolated verification
fixture. Real provider requests may consume your own provider allowance, so run
them only when intended.

## Building macOS artifacts

```sh
pnpm colonie:package   # unpacked .app
pnpm colonie:dist      # distribution artifacts
```

Both run the full build first (typecheck, UI build, server bundle, staged
runtime). Heavy builds are only needed when you need artifacts, so they are not
the default for documentation work. Current artifact status and limitations are
reported in [`docs/HANDOVER.md`](docs/HANDOVER.md); building source alone does
not establish that an installed artifact works.

## Where data lives

Colonie keeps bot profiles, history, and configuration under `~/.colonie/`.
The ACP engines use separate native configuration under the app's data directory;
authentication remains provider-owned. Treat the data as private: do not inspect
credential contents or remove saved data as part of verification.

The project folder holding Colonie's source is separate from this data
directory: `~/.colonie/` belongs to the installed app, not to your project.

## Documentation

| Path | Purpose |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | Working rules for this repository |
| [`docs/HANDOVER.md`](docs/HANDOVER.md) | Current state, verified behavior, next actions |
| [`docs/COLONIE-BLUEPRINT.md`](docs/COLONIE-BLUEPRINT.md) | Sole target design (draft) |
| [`docs/README.md`](docs/README.md) | Topic index for `docs/` |
| [`docs/verification/README.md`](docs/verification/README.md) | Isolated verification and evidence rules |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | Recent results and open blockers |

The blueprint is the single product plan. Keep only current guidance in `docs/`;
do not add duplicate specifications or in-repository archives.

## Third-party components

Bundled components retain their attribution under [`third_party/`](third_party/).
