# Handover — Colonie, 2026-10-14

**Current release state (October 15):** Colonie 0.2.0 beta is deployed at
`https://172.104.33.55` with ordinary account signup/sign-in. The new
`colonie-platform` service uses a dedicated Neon schema and loopback port 19091;
the old service/data are retained on 18891. The HTTPS gateway now serves the
new platform and the Mac download. The Apple silicon installer is available at
`/downloads/Colonie-0.2.0-arm64.dmg`; its complete HTTPS download matches the
local SHA-256. The packaged app passed isolated Cloud and Local signup/onboarding,
chat and switching with deterministic providers. Actual Linux Cloud Claude
text turns passed separately in disposable Neon schemas, using inherited
native auth read-only. The public signup page was rendered read-only; no agent
created a production account or tested a mutation against live data.

See `docs/RELEASE-0.2.0.md` for the current user flow and `docs/PROGRESS.md` for
exact commands/results. `docs/WORKSPACE-PLAN.md` records the owner's direction;
the historical pairing steps below are superseded. Final source refinements
for long history and view concurrency passed; the release suite is 255 tests
plus 61 native checks. Source branch: `colonie/multi-workspace-beta`.
Real Composio provisioning/OAuth/tool use, a recipient's real
Local engine login/turn, physical-phone use and quarantined/notarized Mac
installation remain unverified. The deployment has no Composio org key.
R2 is optional and unused because no endpoint/account ID was supplied.

**Current direction supersedes the historical next steps below:** The owner
approved a Slack-like multi-workspace product: humans and bots are members,
Groups and private human/bot DMs, global signup/sign-in without mandatory email
confirmation, and Local/Cloud selected separately for each new workspace.
Cloud invitations enter the intended workspace without engine setup. Ordinary
people use account sign-in, not pairing codes. The owner explicitly authorized
implementation and deployment and supplied Neon/R2 infrastructure credentials.
Read `docs/WORKSPACE-PLAN.md` for the confirmed journeys and implementation
boundaries. Secrets are held outside the repo and are never included in docs or
delegated prompts. Isolated tests still precede deployment; do not test writes
against the owner's existing conversations or credential files. The earlier
pairing deployment is historical infrastructure evidence, not the target UX.

**Latest phone-access update (2026-10-14):** The owner requested phone access
using the VPS IP, with no domain. `https://172.104.33.55` is now publicly served
with a valid Let's Encrypt IP certificate by a dedicated Caddy gateway. The
app remains loopback-only and now runs under `OMB_LOOPBACK_TRUST=service`;
the earlier single-owner override was removed. The app unit now launches via
the maintained headless CLI, which can generate its initial pairing invitation
under service trust. Isolated TLS/proxy checks proved pairing, Secure/HttpOnly
cookies, authorized access, rejection of unpaired and cross-origin requests,
and session persistence. Production public checks were read-only. Phone
pairing and a phone conversation remain for the owner to confirm; no renderer
QA was possible because no browser surface was available. Full evidence is
appended to PROGRESS and `.devone/evidence/public-ip-pairing-2026-10-14.json`.
The initial owner invite is single-use and expires five minutes after app
startup; its value is not stored in docs. Next: owner pairs the phone, then
continues local/cloud desktop onboarding. Claude remains quota-blocked until
its reported 05:10 WIB reset. Earlier owner-trust notes below are historical.

**Latest provider update (2026-10-14, 03:47 WIB):** The owner completed both
engine sign-ins personally. An isolated Linux HTTP -> ACP -> real Codex turn
passed: exact `COLONIE_CODEX_LINUX_OK` reply, persisted history, completed input
receipt, 4.6 seconds. Claude authenticated but rejected its one test request
because its session quota was exhausted; it reported reset at 05:10 WIB.
Do not report Claude conversation success. The owner's data was mounted
read-only during the real-provider checks; all conversation/workspace state
was disposable. Evidence is appended to `docs/PROGRESS.md` and retained in
`.devone/evidence/vps-real-turn-2026-10-14.json`. A temporary owner-only SSH
tunnel currently exposes the VPS at `http://127.0.0.1:18991` on the Mac (exec
session 11990). Next: owner browser interaction, retry Claude after quota reset,
then step 4. Renderer/desktop cloud mode and teammate access remain unverified;
the single-owner trust override still must be removed before sharing access.
The commissioning update below describes the earlier state before sign-in.

**Codex commissioning update (2026-10-14):** Step 1 is complete for single-owner
access. The VPS service is enabled, running, and survived an explicit service
restart; both ports remain loopback-only. The installed unit has a deliberate
single-owner `OMB_LOOPBACK_TRUST=owner` drop-in. Isolated Linux checks proved
headless HTTP pairing, paired-session persistence after switching to `service`,
and CLI `serve` bootstrap under `service`; the raw-index unit cannot create its
first pairing code in `service`. Prepare an admin session and remove the owner
override before anyone else gets access. No engine sign-in or real turn was
performed. Actual commands/results and the staged-binary owner login commands
are appended to `docs/PROGRESS.md`. **Next action is step 2, performed by the
owner.** The original build-in-flight and step 1 text below is historical.

Written for the next agent (Codex) taking over from the Claude session that did
the work below. Read this file and `docs/SPEC.md`'s *Product direction change*
section. You do not need to read the rest of `docs/`; most of it describes
upstream OpenMausBot's product, not this fork, and following it will steer you
wrong. That is a real hazard in this repo, not a style preference.

## The goal, in the owner's words

Colonie is a shared workspace where a team works with AI agents. At onboarding
the person chooses one of two modes:

- **Local** — Colonie runs on their machine, they sign their own engines in,
  nothing is shared. This is exactly how Colonie behaves today.
- **Cloud** — Colonie points at the team's server. They sign in to nothing and
  need no AI subscription of their own. Bots, conversations and memory are the
  workspace's and are shared.

The owner's near-term test of success: **a teammate downloads Colonie and can
talk to a bot.** Cloud mode is what makes that possible for a non-technical
teammate, because it removes both barriers — a per-person subscription, and a
terminal command to sign an engine in.

The owner is not a programmer. Explain in plain terms, never report a step as
done without evidence, and do not hand them a decision they have already made.

## Access

| | |
|---|---|
| Repo | `https://github.com/hanifstudio/colonie` (private, remote `colonie`) |
| `origin` | still upstream `milind-soni/OpenMausBot` — leave it alone |
| VPS | `ssh colonie-vps` (root@172.104.33.55, key `~/.ssh/id_ed25519_akamai`) |
| Host | Ubuntu 24.04.4, x86_64, 8 GB, 4 vCPU, 146 GB free |
| On the VPS | app at `/opt/colonie/app`, data at `/opt/colonie/data`, user `colonie` |
| Server→GitHub | read-only deploy key, already working |

Node 24 is **not** the default locally. Prefix local commands with
`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`.

## State right now

**Done and verified** (evidence in `docs/PROGRESS.md`, newest entry first):

- `enterprise/` retired. It was source-available, not Apache 2.0, and forbade
  hosting for third parties. ~2k lines.
- All non-ACP engine drivers retired. ~42k lines, 93 files. Colonie admits
  exactly `codex-acp` and `claude-acp`; `server/devone/profile.ts` enforces it.
- Two stale onboarding tests fixed. The ACP suite is green: 333 passed.
- Headless operation proven locally: the server boots with no Electron, serves
  the renderer itself from `OMB_STATIC_DIR`, lists both engines as available,
  and binds `127.0.0.1` only.
- `OMB_LOOPBACK_TRUST=service` proven to refuse session-less loopback on
  `/api/config`, `/api/instances`, `/api/sessions`, `/api/usage` (403) while
  `/api/health` still answers. Default `owner` trust returns 200 on all of them.
- Installable macOS build: `Colonie-0.1.101-arm64.dmg` (345 MB) and `.zip`.
  Ad-hoc signed, `codesign --verify --deep --strict` passes, and a copy carrying
  Safari's quarantine attribute launches.

**In flight on the VPS** — the last thing the Claude session was doing:

`pnpm colonie:build:server` was running under user `colonie`, and had already
staged both ACP adapters for `linux/x64` (`codex-acp 2.1.1` with `codex 0.159.3`,
`claude-acp 0.88.0` with `sdk 0.3.293`). Check with:

```bash
ssh colonie-vps 'pgrep -f colonie:build:server >/dev/null && echo building || tail -5 /opt/colonie/build.log'
ssh colonie-vps 'du -sh /opt/colonie/app/dist /opt/colonie/app/dist-server'
```

## Next steps, in order

### 1. Finish the server install (you can do this)

```bash
ssh colonie-vps 'install -m 644 /opt/colonie/app/scripts/colonie/colonie.service /etc/systemd/system/colonie.service'
ssh colonie-vps 'systemctl daemon-reload && systemctl enable --now colonie && sleep 10 && systemctl status colonie --no-pager | head -12'
ssh colonie-vps 'curl -sf http://127.0.0.1:18891/api/health'
```

**Decide the trust mode deliberately.** The unit ships
`OMB_LOOPBACK_TRUST=service`. While the owner is the only person reaching the
server, upstream's own documentation says `owner` trust is correct — *"on a
server one person uses that is fine: the bots are theirs"*. Under `service`
trust a client needs a paired session, and **nobody has verified that pairing
can be bootstrapped on a headless server**. Test it before assuming either way.
It must be `service` before a second person has access, because every bot's
shell is a loopback caller and could otherwise rewrite settings and keys.

Then verify a restart survives, and record the output in `PROGRESS.md`:

```bash
ssh colonie-vps 'systemctl restart colonie' && sleep 10 && ssh colonie-vps 'curl -sf http://127.0.0.1:18891/api/health'
```

### 2. Owner signs the engines in (the owner does this, not you)

Give them the commands; do not ask for or handle credentials.

```bash
ssh colonie-vps
sudo -iu colonie
export OMB_DATA_DIR=/opt/colonie/data
CODEX_HOME="$OMB_DATA_DIR/native/codex" npx @openai/codex login
CLAUDE_CONFIG_DIR="$OMB_DATA_DIR/native/claude" npx @anthropic-ai/claude-code /login
```

Each prints a URL for them to open in their own browser. Colonie derives the
exact command from the live environment and shows it in the app; if the app and
this page disagree, trust the app.

### 3. First real turn on Linux — this is the real-provider check

Nothing has yet proven an agent turn completes on Linux. After sign-in, from the
owner's laptop:

```bash
ssh -N -L 18891:127.0.0.1:18891 colonie-vps   # leave running
# then open http://127.0.0.1:18891 in a browser
```

Send one bounded message to a disposable working folder. Record it in
`PROGRESS.md` as the real-provider check, separately from the HTTP checks.
Compilation and `/api/health` prove nothing about this.

### 4. Two modes in the welcome flow

The remaining product work, and the thing that reaches the owner's goal. Detail
is in `SPEC.md` under *Two modes, chosen at onboarding*. In short:

- `src/components/onboarding/WelcomeFlow.tsx` has steps `hello`, `engines`,
  `permissions`, `bot`. Add a mode choice **before** `engines`, because cloud
  mode skips engine sign-in entirely.
- **Cloud mode through a browser already works** and needs no code: the renderer
  fetches `/api/...` relatively and the server serves the renderer. This is how
  Windows teammates are served — there is no Windows build and none is needed.
- **Cloud mode in the desktop app** needs one change: `electron/main.mjs:346`
  loads `http://127.0.0.1:${SERVER_PORT}` unconditionally. It must load the
  configured workspace address when the person chose cloud, plus client pairing
  so the session is authorised.
- Local mode is today's behaviour. It needs only to be offered as a choice.

### 5. Ship the download

`Colonie-0.1.101-arm64.dmg` exists in `release/colonie/`. Upload it to the
owner's Cloudflare R2 (credentials not yet shared) and point the download page
at the real URL. The page is a private Claude Artifact at
`https://claude.ai/artifact/W4rTLBrhKbPZ2NZj2cTdgF`; its button is a placeholder
and the owner must Share the page before teammates can open it.

Install steps on that page are correct for macOS 15+: System Settings →
Privacy & Security → **Open Anyway**. Control-click → Open no longer bypasses
Gatekeeper on this macOS and must not be suggested.

### Deferred by explicit owner decision — do not start these

Multiple workspaces; per-person identity and permissions; per-person memory
(the owner wants memory shared so the team's way of working stays uniform); the
workspace spend cap; Chief archive-instead-of-delete; group chat; replacing a
team chat tool. Also rejected: Pi Durable, and any broad rewrite of inherited
infrastructure.

Leftover cosmetic references to retired engines remain in `server/config.ts`
(~60 sites) and under `src/`/`shared/` (~35 files). They reach persisted
settings, so they need their own slice with data-compatibility rules. Not urgent.

## Traps this session actually hit — do not rediscover these

1. **Typecheck green does not mean the build works.** Three deleted proxies were
   referenced by **path string**, not by import, so `pnpm typecheck` passed while
   `pnpm build:server` failed. Before deleting any server file, check
   `SPAWNED_PROXIES` in `server/proxy-paths.ts` and the entry-point list in
   `scripts/bundle-server.mjs`, and run `pnpm build:server`.
2. **`pnpm colonie:build` cannot run on a server.** It regenerates the app icon
   through headless Chromium and fails with `browserType.launch: Executable
   doesn't exist`. Use `pnpm colonie:build:server`.
3. **Ad-hoc signing plus hardened runtime kills the app silently** — no output,
   no crash report. `identity: null` is worse still: it skips signing entirely
   and the app reads as *"damaged"*. Current config is `identity: "-"` with
   `hardenedRuntime: false`; turn hardened runtime back on only together with a
   real Developer ID and notarization.
4. **A delegated worker in this repo inherits `AGENTS.md`**, which tells every
   agent to read `SPEC.md`, `PLAN.md` and `PROGRESS.md` first. One worker spent
   its entire run doing that and reported nothing. State in the brief that the
   lead has already done the reading.
5. **Do not give a worker bare engine names to grep.** `droid` matches 443 lines
   because of "Android"; `grok` matches 75; `cursor` matches the mouse cursor.
   Use precise patterns like `driver: "grokAgent"`.
6. **The pre-push hook runs lint and the locale check.** It will reject a push
   over an unused import. Run `pnpm exec oxlint --deny-warnings .` first.

## Verification rules that apply to every change

From `AGENTS.md`, and they were earned here: never claim a workflow passed on
compilation alone; use isolated fixtures and disposable data directories, never
the owner's live install; and separate simulated, real-provider, renderer and
desktop evidence in `PROGRESS.md`. State what you did **not** verify, every time.
