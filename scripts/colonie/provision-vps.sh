#!/usr/bin/env bash
# Host setup for a Colonie server on Ubuntu 24.04 x86_64. See
# docs/deploy-colonie-vps.md. Idempotent: safe to re-run.
#
# What it does NOT do, on purpose: start the service, join the tailnet, publish
# anything, change the firewall, or sign an engine in. Each of those is an
# explicit step a person takes, because each one changes who can reach this
# machine or what it can spend.
set -euo pipefail

NODE_MAJOR=24
APP_USER=colonie
APP_HOME=/opt/colonie

log() { printf '\n==> %s\n' "$*"; }
need_root() { [[ $EUID -eq 0 ]] || { echo "run with sudo: sudo bash $0" >&2; exit 1; }; }

need_root

log "Checking the host"
arch=$(uname -m)
[[ $arch == x86_64 ]] || {
  echo "This script targets x86_64; found $arch." >&2
  echo "The Codex adapter ships a per-architecture binary, so stop and check" >&2
  echo "docs/deploy-colonie-vps.md before continuing on $arch." >&2
  exit 1
}
. /etc/os-release
echo "    $PRETTY_NAME on $arch"
[[ ${VERSION_ID:-} == 24.04 ]] || echo "    note: written against Ubuntu 24.04; continuing anyway"

mem_mb=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
echo "    ${mem_mb} MB RAM"
(( mem_mb >= 3500 )) || {
  echo "Less than ~4 GB of RAM. The build alone needs more than this." >&2
  exit 1
}

log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git rsync python3 >/dev/null

log "Installing Node ${NODE_MAJOR} from NodeSource"
if ! command -v node >/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt $NODE_MAJOR ]]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node -v)"

log "Enabling pnpm through corepack"
corepack enable >/dev/null 2>&1 || true
echo "    corepack $(corepack --version 2>/dev/null || echo 'unavailable')"

log "Installing Tailscale"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
fi
echo "    $(tailscale version | head -1)"
echo "    not joined to a tailnet — run 'sudo tailscale up' yourself"

log "Creating the ${APP_USER} service user"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_HOME" --shell /bin/bash "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$APP_HOME" "$APP_HOME/app" "$APP_HOME/data"
echo "    $APP_HOME owned by $APP_USER, data dir mode 0750"

log "Done"
cat <<'NEXT'
    This host is ready. Nothing is running yet.

    Next, from docs/deploy-colonie-vps.md:
      3. sudo -iu colonie, then clone and build the app
      4. sign the engines in (owner only, once)
      5. install and start the systemd unit
      6. sudo tailscale up, then tailscale serve --bg 18891

    The service is not started and nothing is reachable until you do step 5.
NEXT
