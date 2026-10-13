# Deploying Colonie on a VPS

How Colonie runs as a shared always-on workspace on one Linux server, so the
bots stay reachable with every laptop closed. This is M11 step 4b in `PLAN.md`;
the direction it serves is *Product direction change* in `SPEC.md`.

This page is written for the host it was designed against: **Ubuntu 24.04,
x86_64, 8 GB RAM, 4 vCPU, 160 GB disk** (Linode `g6-dedicated-4`). Smaller works
for one person; 4 GB is the floor, because the build itself needs headroom.

## What is being deployed

Colonie is already two separable parts, which is why no architectural change is
needed: a **server** that holds the conversations and runs the engines, and a
**renderer** that the server can serve over HTTP itself. The desktop app is one
window onto that server, a browser is another.

```
  your laptop (Colonie.app)  ─┐
  a teammate's browser       ─┼─►  Tailscale  ─►  127.0.0.1:18891  ─►  Colonie server
  a Windows teammate         ─┘                                          │
                                                                         ├─► codex-acp  ─► Codex
                                                                         └─► claude-acp ─► Claude
```

Three properties of this shape matter:

- **The server never opens a public port.** It binds `127.0.0.1` only, and that
  stays true here. Tailscale reaches it over the tailnet; nothing is exposed to
  the internet, and there is no certificate to manage.
- **Windows teammates need no build.** They open the renderer in a browser.
  `electron-builder.colonie.yml` has no Windows target and does not need one.
- **Engine sign-in happens on the server, once, over SSH.** Colonie's ACP
  sign-in is a terminal command by design (`AcpRuntime.signInCommand()`), and it
  carries the isolated config directory so the login lands inside Colonie's own
  data dir rather than in `~/.codex` or `~/.claude`.

## Before you start: give the fork a remote

The work so far exists only on the development laptop, and this deployment needs
a way to move it. Both are solved by pushing the fork to a private repository:

```bash
# on the laptop, once
gh repo create <your-org>/colonie --private --source=. --remote=colonie
git push -u colonie main
```

`origin` stays pointed at upstream OpenMausBot so future upstream changes can
still be fetched. Do not make the repository public: it carries no secrets
today, but it is a private fork of someone else's Apache-2.0 project with its
own product direction, and that is a decision to make deliberately rather than
by default.

If a private repository is not wanted, `rsync -a --exclude node_modules
--exclude release --exclude dist-devone ./ colonie-vps:~/colonie/` also works,
but then the laptop is still the only copy of the history.

## 1. Reach the server

Add the host to `~/.ssh/config` on the laptop so every later command is short:

```
Host colonie-vps
  HostName <the Linode IPv4>
  User hanif
  IdentityFile ~/.ssh/<the key you authorized>
```

Confirm it before going further: `ssh colonie-vps 'uname -m && lsb_release -ds'`
must print `x86_64` and `Ubuntu 24.04...`. The architecture is load-bearing —
the Codex adapter ships a per-architecture binary.

## 2. Provision the host

`scripts/colonie/provision-vps.sh` does the host setup, and is safe to re-run:

```bash
scp scripts/colonie/provision-vps.sh colonie-vps:/tmp/
ssh colonie-vps 'bash /tmp/provision-vps.sh'
```

It installs Node 24 from NodeSource, enables pnpm through corepack, installs
Tailscale, creates a `colonie` system user that owns the service and its data,
and writes nothing outside `/opt/colonie`, `/etc/systemd/system` and the package
manager's own paths. It does not start the service, join the tailnet, or touch
the firewall; those are explicit steps below.

## 3. Install Colonie

```bash
ssh colonie-vps
sudo -iu colonie
git clone https://github.com/<your-org>/colonie.git /opt/colonie/app
cd /opt/colonie/app
pnpm install --frozen-lockfile
pnpm colonie:build
```

`pnpm colonie:build` runs the renderer and server builds and stages both ACP
adapters for `linux-x64`. Expect the install to need several GB transiently; the
160 GB disk absorbs it comfortably.

## 4. Sign the engines in

Colonie keeps its engine state under its own data directory, so this login does
not touch any `~/.codex` or `~/.claude` the server may also have:

```bash
# still as the colonie user
export OMB_DATA_DIR=/opt/colonie/data
CODEX_HOME="$OMB_DATA_DIR/native/codex" npx @openai/codex login
CLAUDE_CONFIG_DIR="$OMB_DATA_DIR/native/claude" npx @anthropic-ai/claude-code /login
```

Each prints a URL to open in a browser on your own machine. The exact command
for a given install is also shown in the app, and Colonie derives it from the
live environment rather than from this page — if the two disagree, trust the app.

Only the owner does this. Teammates never sign an engine in; they use the
workspace's engines.

## 5. Run it as a service

```bash
sudo install -m 644 /opt/colonie/app/scripts/colonie/colonie.service \
  /etc/systemd/system/colonie.service
sudo systemctl daemon-reload
sudo systemctl enable --now colonie
systemctl status colonie --no-pager
curl -sf http://127.0.0.1:18891/api/health
```

The unit sets `OMB_LOOPBACK_TRUST=service`, which is **required** on any server
more than one person reaches, and is M11 step 5. Without it, every loopback
caller is trusted as the owner — and every bot's shell is a loopback caller, so
a teammate could ask a bot to change settings, keys, MCP servers or webhooks.
Do not remove it to debug something.

## 6. Let people in, over Tailscale only

```bash
sudo tailscale up            # authenticate this machine into your tailnet
sudo tailscale serve --bg 18891
tailscale serve status
```

`tailscale serve` publishes Colonie inside the tailnet with HTTPS and leaves the
listener on `127.0.0.1`. Teammates install Tailscale, join the tailnet, and open
the printed `https://<host>.<tailnet>.ts.net` address: Mac users in the desktop
app or a browser, Windows users in a browser.

Nothing here opens a port to the internet. If you later want public access,
that is a separate decision with its own identity and exposure questions — not
a flag to flip on this setup.

## Verifying the deployment

Run these from the laptop and record the results in `PROGRESS.md`:

```bash
ssh colonie-vps 'curl -sf http://127.0.0.1:18891/api/health'
ssh colonie-vps 'curl -sf http://127.0.0.1:18891/api/instances' | python3 -m json.tool | head -20
ssh colonie-vps 'systemctl is-active colonie && systemctl is-enabled colonie'
ssh colonie-vps 'sudo systemctl restart colonie' && sleep 10 && \
  ssh colonie-vps 'curl -sf http://127.0.0.1:18891/api/health'
```

`/api/instances` must list exactly `codex-acp` and `claude-acp`. A restart must
come back without manual help; that is the whole point of the deployment.

One thing compilation and HTTP checks cannot tell you: whether a real turn
completes on Linux. Send one bounded message from the app after sign-in, to a
disposable working folder, and record that separately as the real-provider
check.

## Known limits of this setup

- **Linux is newly exercised.** Everything before this ran on macOS. The
  adapters' Linux binaries and the engines' Linux behaviour are not yet proven
  here; treat the first real turn as evidence, not a formality.
- **One workspace.** Multiple workspaces lived in the removed `enterprise/`
  layer and are owned work if wanted (`SPEC.md`).
- **No spend cap.** The workspace spend limit also lived in `enterprise/`. With
  API keys and several people, an agent in a loop can run up a bill unnoticed.
  Deferred deliberately; revisit before the team grows.
- **No per-person identity.** Messages carry no author yet (M11 step 6), so the
  transcript cannot say who asked for something and approvals are anonymous.
- **Backups are yours.** `/opt/colonie/data` holds every conversation, the
  memory store and the engine logins. Nothing here backs it up.
