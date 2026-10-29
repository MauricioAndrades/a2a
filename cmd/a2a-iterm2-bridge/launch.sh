#!/usr/bin/env bash
# a2a iTerm2 bridge launcher.
# Usage: launch.sh {start|stop|status|restart|foreground}
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The a2a iTerm2 plugin is the bridge plus plugin surfaces (present, status,
# status-bar component) on the same socket; fall back to the bare bridge if
# the plugin is not present in this checkout.
PLUGIN="$HERE/../a2a-iterm2-plugin/plugin.py"
if [[ -f "$PLUGIN" ]]; then
  BRIDGE="$PLUGIN"
else
  BRIDGE="$HERE/bridge.py"
fi

STATE_DIR="${A2A_ITERM2_BRIDGE_STATE_DIR:-$HOME/.local/state/a2a}"
PIDFILE="$STATE_DIR/iterm2-bridge.pid"
LOGFILE="$STATE_DIR/iterm2-bridge.log"
SOCKET="${A2A_ITERM2_BRIDGE_SOCKET:-$STATE_DIR/iterm2-bridge.sock}"

mkdir -p "$STATE_DIR"

find_python() {
  if [[ -n "${A2A_PYTHON:-}" && -x "$A2A_PYTHON" ]]; then
    echo "$A2A_PYTHON"; return 0
  fi
  local candidates=(
    "$HOME/.config/iterm2/AppSupport/iterm2env/versions/3.14.0/bin/python3.14"
    "$HOME/Library/Application Support/iTerm2/iterm2env/versions/3.14.0/bin/python3.14"
  )
  for c in "${candidates[@]}"; do
    [[ -x "$c" ]] && { echo "$c"; return 0; }
  done
  local glob
  for glob in \
    "$HOME/.config/iterm2/AppSupport/iterm2env/versions"/*/bin/python3* \
    "$HOME/Library/Application Support/iTerm2/iterm2env/versions"/*/bin/python3*; do
    [[ -x "$glob" && "$glob" != *-config ]] && { echo "$glob"; return 0; }
  done
  ensure_venv
}

# Fallback when iTerm2's own Python runtime is not installed: a private venv
# under $STATE_DIR with the `iterm2` package (bridge.py's only third-party
# import). Built once from the first python3 on PATH; reused afterwards.
VENV="$STATE_DIR/iterm2-venv"
ensure_venv() {
  local vpy="$VENV/bin/python3"
  if [[ -x "$vpy" ]] && "$vpy" -c 'import iterm2' 2>/dev/null; then
    echo "$vpy"; return 0
  fi
  local base
  base="$(command -v python3 || true)"
  [[ -n "$base" ]] || { echo "no python3 on PATH to build $VENV" >&2; return 1; }
  echo "building iterm2 python env at $VENV (one-time) from $base" >&2
  "$base" -m venv "$VENV" >&2 || return 1
  "$VENV/bin/python3" -m pip install --quiet --disable-pip-version-check iterm2 >&2 || return 1
  echo "$vpy"
}

is_running() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

cmd_status() {
  if is_running; then
    echo "running (pid $(cat "$PIDFILE"))  socket=$SOCKET"
  else
    echo "not running"
    return 1
  fi
}

cmd_stop() {
  if ! is_running; then
    echo "not running"
    rm -f "$PIDFILE"
    return 0
  fi
  local pid
  pid="$(cat "$PIDFILE")"
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || { rm -f "$PIDFILE" "$SOCKET"; echo "stopped"; return 0; }
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PIDFILE" "$SOCKET"
  echo "killed"
}

cmd_start() {
  if is_running; then
    echo "already running (pid $(cat "$PIDFILE"))"; return 0
  fi
  local py
  py="$(find_python)" || { echo "no usable python with the iterm2 package; set A2A_PYTHON" >&2; exit 1; }
  # The socket and pid file are written by the bridge itself, and only after
  # it holds the single-instance lock: a start refused as split-brain must
  # not delete the live instance's socket or overwrite its pid file.
  A2A_ITERM2_BRIDGE_SOCKET="$SOCKET" A2A_ITERM2_BRIDGE_PIDFILE="$PIDFILE" nohup "$py" "$BRIDGE" >>"$LOGFILE" 2>&1 &
  local pid=$!
  # The bridge removes a stale socket once it holds the lock and binds a new
  # one only after iTerm2's API accepts the connection, so "pid file names
  # this process and the socket exists" is the readiness signal.
  for _ in $(seq 1 50); do
    [[ "$(cat "$PIDFILE" 2>/dev/null)" == "$pid" && -S "$SOCKET" ]] && { echo "iterm bridge started (pid $pid)  socket=$SOCKET"; return 0; }
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  echo "iterm bridge failed to start; last log lines from $LOGFILE:" >&2
  tail -n 15 "$LOGFILE" >&2
  kill "$pid" 2>/dev/null || true
  exit 1
}

cmd_foreground() {
  local py
  py="$(find_python)" || { echo "no usable python with the iterm2 package; set A2A_PYTHON" >&2; exit 1; }
  # exec keeps this pid, so the pid file the bridge writes (after taking the
  # instance lock) is right for status/stop when launchd runs it.
  exec env A2A_ITERM2_BRIDGE_SOCKET="$SOCKET" A2A_ITERM2_BRIDGE_PIDFILE="$PIDFILE" "$py" "$BRIDGE"
}

# Auto-start through a per-user launchd agent. iTerm2's AutoLaunch folder is
# not used: AutoLaunch .py scripts need iTerm2's own Python runtime, which is
# not installed by default, and the plugin's reconnect loop already follows
# iTerm2 quitting and relaunching. KeepAlive restarts the plugin if it exits.
LAUNCHD_LABEL="com.a2a.iterm2-plugin"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"

cmd_install() {
  find_python >/dev/null || { echo "no usable python with the iterm2 package; set A2A_PYTHON" >&2; exit 1; }
  if [[ -f "$LAUNCHD_PLIST" ]]; then
    launchctl bootout "gui/$(id -u)" "$LAUNCHD_PLIST" 2>/dev/null || true
  fi
  # A manually started copy would race the launchd one for the socket.
  if is_running; then cmd_stop >/dev/null; fi
  mkdir -p "$(dirname "$LAUNCHD_PLIST")"
  cat >"$LAUNCHD_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HERE/launch.sh</string>
    <string>foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGFILE</string>
  <key>StandardErrorPath</key><string>$LOGFILE</string>
</dict>
</plist>
PLIST
  launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_PLIST"
  for _ in $(seq 1 50); do
    [[ -S "$SOCKET" ]] && is_running && { echo "a2a iTerm2 plugin installed (launchd $LAUNCHD_LABEL, pid $(cat "$PIDFILE"))  socket=$SOCKET"; return 0; }
    sleep 0.2
  done
  echo "a2a iTerm2 plugin installed but not yet listening; check $LOGFILE" >&2
  exit 1
}

cmd_uninstall() {
  if [[ -f "$LAUNCHD_PLIST" ]]; then
    launchctl bootout "gui/$(id -u)" "$LAUNCHD_PLIST" 2>/dev/null || true
    rm -f "$LAUNCHD_PLIST"
    rm -f "$PIDFILE" "$SOCKET"
    echo "a2a iTerm2 plugin uninstalled (removed $LAUNCHD_PLIST)"
  else
    echo "a2a iTerm2 plugin is not installed"
  fi
}

launchd_managed() {
  [[ -f "$LAUNCHD_PLIST" ]] && launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1
}

case "${1:-}" in
  start)
    if launchd_managed; then echo "managed by launchd ($LAUNCHD_LABEL); $(cmd_status || true)"; exit 0; fi
    cmd_start ;;
  stop)
    if launchd_managed; then echo "managed by launchd ($LAUNCHD_LABEL), which restarts it; use: $0 uninstall" >&2; exit 1; fi
    cmd_stop ;;
  status)     cmd_status ;;
  restart)
    if launchd_managed; then launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"; echo "restarted via launchd"; exit 0; fi
    cmd_stop; cmd_start ;;
  foreground) cmd_foreground ;;
  install)    cmd_install ;;
  uninstall)  cmd_uninstall ;;
  *) echo "usage: $0 {start|stop|status|restart|foreground|install|uninstall}" >&2; exit 2 ;;
esac
