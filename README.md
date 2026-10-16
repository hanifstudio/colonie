# Colonie

Colonie is a local-only macOS desktop app: a chat app where every bot is a real
agent running on your own machine.

Each bot has its own profile, model, memory, and workspace. Agents run through a
shared ACP execution boundary and the maintained Codex and Claude adapters, so
Colonie drives the `claude` and `codex` CLIs you already have installed and
signed in. Nothing is hosted here — the app, the harness server, and your data
all stay on this Mac.

## Requirements

- macOS
- Node 24 or newer, and pnpm
- At least one agent CLI on `PATH`, already signed in: `claude` or `codex`

## Run it locally

```sh
pnpm install --frozen-lockfile
pnpm colonie:web
```

`pnpm colonie:web` starts the harness server and the UI on loopback and prints
the local URL to open. Use `pnpm colonie` instead to run the same server behind
the Electron desktop window. Keep the terminal open; `Ctrl-C` stops the app but
does not remove saved work.

## Build the desktop app

```sh
pnpm colonie:build   # typecheck, UI build, server bundle, staged runtime
pnpm colonie:dist    # Electron macOS app in release/
```

## Where data lives

Everything Colonie keeps lives under `~/.colonie/`: bot profiles, transcripts,
per-thread event logs, workspaces, and `config.json` (holds your API keys —
treat it as a secret). Remove that directory to start clean.

## Docs

- [`docs/SPEC.md`](docs/SPEC.md) — product name and scope
- [`docs/PLAN.md`](docs/PLAN.md) — milestones
- [`docs/PROGRESS.md`](docs/PROGRESS.md) — verification and progress log
- [`docs/HANDOVER.md`](docs/HANDOVER.md) — current state
- [`docs/verification/README.md`](docs/verification/README.md) — how to verify changes

## License

Apache License 2.0 — see [`LICENSE`](LICENSE) and [`LICENSING.md`](LICENSING.md).
Third-party components keep their own terms under [`third_party/`](third_party/).