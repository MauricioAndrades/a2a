#!/usr/bin/env bash
# a2a iTerm2 bridge launcher.
# Usage: launch.sh {start|stop|status|restart|foreground}
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE="$HERE/bridge.py"

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
  return 1
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
  py="$(find_python)" || { echo "python not found; set A2A_PYTHON" >&2; exit 1; }
  rm -f "$SOCKET"
  A2A_ITERM2_BRIDGE_SOCKET="$SOCKET" nohup "$py" "$BRIDGE" >>"$LOGFILE" 2>&1 &
  echo $! >"$PIDFILE"
  echo "started (pid $!)  log=$LOGFILE  socket=$SOCKET"
}

cmd_foreground() {
  local py
  py="$(find_python)" || { echo "python not found; set A2A_PYTHON" >&2; exit 1; }
  rm -f "$SOCKET"
  exec env A2A_ITERM2_BRIDGE_SOCKET="$SOCKET" "$py" "$BRIDGE"
}

case "${1:-}" in
  start)      cmd_start ;;
  stop)       cmd_stop ;;
  status)     cmd_status ;;
  restart)    cmd_stop; cmd_start ;;
  foreground) cmd_foreground ;;
  *) echo "usage: $0 {start|stop|status|restart|foreground}" >&2; exit 2 ;;
esac
