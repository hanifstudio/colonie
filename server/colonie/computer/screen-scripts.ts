// Files baked into the bot-computer image. They are strings, not files, so the
// bundled server carries them; `prepareManagedImage` writes them next to the
// Dockerfile. Each one is syntax-checked by screen-scripts.test.ts.

/** One screen per bot: an X display, a window manager and a Cua driver of its own. */
export const COLONIE_SCREEN_SCRIPT = `#!/bin/bash
# One screen of the bot computer. colonie-screen up <n> <token> [bot] | down <n> | list
# A screen is an X display, a window manager, and its own Cua driver; the viewer
# reaches it by token through the one websockify that serves them all. A marker
# per screen says who has it; a marker whose display is gone (the container was
# stopped and started again) is stale and is dropped, never believed.
set -euo pipefail
state=/run/colonie
mkdir -p "$state/screens"; touch "$state/tokens"
driver=\${COLONIE_CUA:-/usr/local/libexec/colonie/cua-driver}
cmd=\${1:-}; n=\${2:-}
case "$cmd" in
  up|down) [[ "$n" =~ ^([2-9]|[1-9][0-9])$ ]] || { echo "screen number must be 2 or more" >&2; exit 2; } ;;
esac
rfb=$((5900 + \${n:-0}))
sock=/run/user/1000/colonie-cua-$n.sock
wait_for() { for _ in $(seq 1 60); do "$@" >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
alive() { pgrep -f "Xtigervnc :$1 " >/dev/null 2>&1; }
forget() {
  local m=$1
  rm -f "$state/screens/$m" "$state/wm$m.pid" "/run/user/1000/colonie-cua-$m.sock" "/tmp/.X$m-lock" "/tmp/.X11-unix/X$m"
}
# the viewer's token file is exactly the live screens' tokens
retoken() {
  local f m tmp="$state/tokens.new"
  : > "$tmp"
  for f in "$state"/screens/*; do
    [ -e "$f" ] || continue
    m=$(basename "$f")
    read -r _ t < "$f" || continue
    echo "$t: 127.0.0.1:$((5900 + m))" >> "$tmp"
  done
  mv "$tmp" "$state/tokens"
}
case "$cmd" in
  up)
    token=\${3:?token}; bot=\${4:--}
    [[ "$token" =~ ^[A-Za-z0-9_-]{16,80}$ ]] || { echo "bad token" >&2; exit 2; }
    [[ "$bot" =~ ^[A-Za-z0-9_-]{1,80}$ ]] || { echo "bad bot" >&2; exit 2; }
    if [ -f "$state/screens/$n" ]; then
      if alive "$n"; then echo "exists"; exit 0; fi
      forget "$n"
    fi
    rm -f "/tmp/.X$n-lock" "/tmp/.X11-unix/X$n"
    setsid Xtigervnc ":$n" -rfbport "$rfb" -geometry 1280x800 -depth 24 -localhost=1 -ac \\
      -SecurityTypes None -AlwaysShared >"$state/x$n.log" 2>&1 &
    wait_for test -S "/tmp/.X11-unix/X$n" || { echo "screen $n did not start" >&2; exit 1; }
    export DISPLAY=":$n" DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus HOME=/home/cua
    xsetroot -solid '#202225'
    setsid xfwm4 --compositor=off >"$state/wm$n.log" 2>&1 &
    echo $! > "$state/wm$n.pid"
    rm -f "$sock"
    CUA_DRIVER_INSTALL_CHANNEL=python_package CUA_DRIVER_RS_TELEMETRY_ENABLED=0 CUA_DRIVER_RS_UPDATE_CHECK=0 \\
      setsid "$driver" serve --socket "$sock" --permission-mode standard >"$state/cua$n.log" 2>&1 &
    wait_for test -S "$sock" || { echo "driver for screen $n did not start" >&2; exit 1; }
    echo "$bot $token" > "$state/screens/$n"
    retoken
    echo "up"
    ;;
  down)
    pkill -f "colonie-cua-$n.sock" || true
    if [ -f "$state/wm$n.pid" ]; then kill "$(cat "$state/wm$n.pid")" 2>/dev/null || true; fi
    pkill -f "Xtigervnc :$n " || true
    forget "$n"
    retoken
    echo "down"
    ;;
  list)
    for f in "$state"/screens/*; do
      [ -e "$f" ] || continue
      m=$(basename "$f")
      if alive "$m"; then echo "$m $(cat "$f")"; else forget "$m"; fi
    done
    retoken
    ;;
  *) echo "usage: colonie-screen up <n> <token> [bot] | down <n> | list" >&2; exit 2 ;;
esac
`;

/** The one viewer endpoint for every screen: a token names the screen it reaches. */
export const TOKEN_NOVNC_SCRIPT = `#!/bin/bash
set -euo pipefail
mkdir -p /run/colonie; touch /run/colonie/tokens
exec websockify --web=/usr/share/novnc --token-plugin=TokenFile --token-source=/run/colonie/tokens "\${NOVNC_PORT:-6901}"
`;

/** Replaces the base desktop's session: a window manager only, so a screen costs little memory. */
export const LIGHT_XSTARTUP_SCRIPT = `#!/bin/bash
# A light session: a window manager and a plain background. Bots bring their own apps.
set -euo pipefail
export XDG_SESSION_TYPE=x11
if [[ -z "\${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
  eval "$(dbus-launch --sh-syntax --exit-with-session)"
fi
for _ in $(seq 1 20); do
  if xset q >/dev/null 2>&1; then xset s off; xset -dpms; xset s noblank; break; fi
  sleep 1
done
xsetroot -solid '#202225'
exec xfwm4 --compositor=off
`;
