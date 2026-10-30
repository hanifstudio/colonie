#!/bin/sh
set -eu

# dpkg preserves an existing directory's mode during an in-place upgrade.
# A configured DEB needs Electron's Chromium sandbox root-owned and setuid. The
# bot's separate Chrome uses its normal user-namespace sandbox, with an exact
# root-owned AppArmor allowlist on Ubuntu 24.04. Never disable the sandbox or
# change the machine-wide user-namespace restriction.
if [ -n "${COLONIE_POSTINSTALL_TEST_ROOT:-}" ]; then
  TEST_ROOT="$(realpath -e -- "$COLONIE_POSTINSTALL_TEST_ROOT")"
  case "$TEST_ROOT" in
    /tmp/*) APP_ROOT=$TEST_ROOT ;;
    *)
      echo "Colonie test install root must stay under /tmp" >&2
      exit 1
      ;;
  esac
  EXPECTED_OWNER="$(id -un):$(id -gn)"
  TEST_MODE=1
  APPARMOR_DIR=$APP_ROOT/test-system/apparmor.d
  APPARMOR_PARSER=$APP_ROOT/test-system/apparmor_parser
  APPARMOR_STATUS=$APP_ROOT/test-system/apparmor_status
  USERNS_RESTRICTION=$APP_ROOT/test-system/apparmor_restrict_unprivileged_userns
else
  APP_ROOT=/opt/Colonie
  EXPECTED_OWNER=root:root
  TEST_MODE=0
  APPARMOR_DIR=/etc/apparmor.d
  APPARMOR_PARSER=/sbin/apparmor_parser
  APPARMOR_STATUS=/sbin/apparmor_status
  USERNS_RESTRICTION=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
  if [ -L /opt ] || [ "$(stat -c '%U:%G:%a' -- /opt)" != root:root:755 ]; then
    echo "Colonie package ancestor is unsafe: /opt must be root:root 0755" >&2
    exit 1
  fi
fi

repair_directory() {
  target=$1
  if [ -L "$target" ] || [ ! -d "$target" ]; then
    echo "Colonie package directory is missing or unsafe: $target" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then chown root:root -- "$target"; fi
  chmod 0755 -- "$target"
  actual="$(stat -c '%U:%G:%a' -- "$target")"
  if [ "$actual" != "$EXPECTED_OWNER:755" ]; then
    echo "Colonie could not secure package directory: $target ($actual)" >&2
    exit 1
  fi
}

repair_executable() {
  target=$1
  if [ -L "$target" ] || [ ! -f "$target" ]; then
    echo "Colonie package executable is missing or unsafe: $target" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then chown root:root -- "$target"; fi
  chmod 0755 -- "$target"
  actual="$(stat -c '%U:%G:%a' -- "$target")"
  if [ "$actual" != "$EXPECTED_OWNER:755" ]; then
    echo "Colonie could not secure package executable: $target ($actual)" >&2
    exit 1
  fi
}

repair_chromium_sandbox() {
  target=$1
  if [ -L "$target" ] || [ ! -f "$target" ]; then
    echo "Colonie Chromium sandbox is missing or unsafe: $target" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then chown root:root -- "$target"; fi
  chmod 4755 -- "$target"
  actual="$(stat -c '%U:%G:%a' -- "$target")"
  if [ "$actual" != "$EXPECTED_OWNER:4755" ]; then
    echo "Colonie could not secure Chromium sandbox: $target ($actual)" >&2
    exit 1
  fi
}

secure_browser_tree() {
  # No symlinks or special files may redirect the package's privileged repair
  # outside this exact resource. Preserve executable bits on Chrome sidecars.
  unsafe=$(find "$BROWSER_ROOT" ! -type d ! -type f -print -quit)
  if [ -n "$unsafe" ]; then
    echo "Colonie browser resource is missing or unsafe: $unsafe" >&2
    exit 1
  fi
  unsafe=$(find "$BROWSER_ROOT" -type f -links +1 -print -quit)
  if [ -n "$unsafe" ]; then
    echo "Colonie browser resource has an unsafe hard link: $unsafe" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then
    find "$BROWSER_ROOT" -type d -exec chown root:root -- {} +
    find "$BROWSER_ROOT" -type f -exec chown root:root -- {} +
  fi
  find "$BROWSER_ROOT" -type d -exec chmod 0755 -- {} +
  find "$BROWSER_ROOT" -type f -exec chmod u-s,g-s,go-w,a+r -- {} +
  repair_executable "$BROWSER_ROOT/agent-browser"
  repair_executable "$BROWSER_ROOT/chrome/chrome-headless-shell-linux64/chrome-headless-shell"
}

install_browser_apparmor_profile() {
  profile=$APP_ROOT/resources/colonie-browser.apparmor
  if [ -L "$profile" ] || [ ! -f "$profile" ] || [ "$(stat -c '%h' -- "$profile")" != 1 ]; then
    echo "Colonie browser AppArmor profile is missing or unsafe: $profile" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then chown root:root -- "$profile"; fi
  chmod 0644 -- "$profile"
  restricted=0
  if [ -f "$USERNS_RESTRICTION" ]; then
    # dash's read builtin reads one byte at a time. Numeric procfs sysctls
    # return EOF on the next read, before the newline, so set -e aborts the
    # install even after reading a valid digit. Read the value in one buffer.
    if ! restricted=$(cat -- "$USERNS_RESTRICTION"); then
      echo "Colonie could not read the browser user-namespace restriction." >&2
      exit 1
    fi
    case "$restricted" in
      0|1) ;;
      *)
        echo "Colonie browser user-namespace restriction is invalid; refusing unsafe sandbox setup." >&2
        exit 1
        ;;
    esac
  fi

  if [ ! -d "$APPARMOR_DIR" ] || [ ! -x "$APPARMOR_PARSER" ]; then
    if [ "$restricted" = 1 ]; then
      echo "Colonie needs apparmor and apparmor_parser to configure the browser sandbox on this host." >&2
      exit 1
    fi
    return
  fi
  # Older hosts lack the AppArmor 4 ABI and user-namespace restriction.
  # They use Chrome's normal sandbox without this optional allowlist.
  # Never skip policy setup on a host exposing the restriction sysctl.
  if [ ! -f "$APPARMOR_DIR/abi/4.0" ] && [ ! -e "$USERNS_RESTRICTION" ]; then
    return
  fi
  # The policy directory belongs to the OS: validate it, never chmod it.
  if [ -L "$APPARMOR_DIR" ] || [ "$(stat -c '%U:%G:%a' -- "$APPARMOR_DIR")" != "$EXPECTED_OWNER:755" ]; then
    echo "Colonie AppArmor policy directory is unsafe: $APPARMOR_DIR" >&2
    exit 1
  fi
  target=$APPARMOR_DIR/colonie-browser
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
    echo "Colonie AppArmor profile target is unsafe: $target" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then
    install -o root -g root -m 0644 -- "$profile" "$target"
  else
    install -m 0644 -- "$profile" "$target"
  fi
  # Image builders stage policy for the target's next boot, not the host kernel.
  if [ "$TEST_MODE" -eq 0 ] && [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; then return; fi
  # Installed AppArmor tools do not mean the kernel module is enabled. Keep
  # policy for a future boot, but do not fail installation on an unrestricted
  # host booted with AppArmor disabled. A restricted host still fails closed.
  if [ ! -x "$APPARMOR_STATUS" ] || ! "$APPARMOR_STATUS" --enabled >/dev/null 2>&1; then
    if [ "$restricted" = 1 ]; then
      echo "Colonie cannot load its browser sandbox policy while AppArmor restrictions are active but AppArmor is unavailable." >&2
      exit 1
    fi
    return
  fi
  # Replace only our profile. Reloading all profiles or weakening the global
  # restriction would change unrelated applications' security settings.
  "$APPARMOR_PARSER" -r "$target"
}

repair_directory "$APP_ROOT"
repair_directory "$APP_ROOT/resources"
repair_chromium_sandbox "$APP_ROOT/chrome-sandbox"
BROWSER_ROOT=$APP_ROOT/resources/browser-engine
repair_directory "$BROWSER_ROOT"
secure_browser_tree
install_browser_apparmor_profile
