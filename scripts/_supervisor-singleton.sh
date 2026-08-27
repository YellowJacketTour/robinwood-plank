#!/bin/bash
# Process-local protection for every long-running development supervisor.
# This guard deliberately lives inside each supervisor so direct launches,
# including agent/Claude shell commands, cannot bypass _launch-all.sh.

# A bare PID can be recycled by an unrelated process between this
# supervisor's exit and its next launch, especially across a long-idle dev
# machine -- MSYS `ps -p PID` still reports a live PID's start time (STIME)
# with no -o support here, so pairing PID+STIME is the fingerprint: a
# recycled PID will almost certainly show a different start time, and a
# vacated one shows none at all.
_supervisor_fingerprint() {
  local pid="$1"
  ps -p "$pid" 2>/dev/null | awk -v p="$pid" '$1 == p { print $7 }'
}

supervisor_singleton() {
  local name="$1"
  SUPERVISOR_NAME="$name"
  : "${SUPERVISOR_LOCK_ROOT:=/c/tmp/plank-supervisor-locks}"
  SUPERVISOR_LOCK_DIR="$SUPERVISOR_LOCK_ROOT/$name.lock"
  mkdir -p "$SUPERVISOR_LOCK_ROOT"

  if ! mkdir "$SUPERVISOR_LOCK_DIR" 2>/dev/null; then
    local owner="" owner_stime="" live_stime=""
    [ -f "$SUPERVISOR_LOCK_DIR/pid" ] && owner="$(cat "$SUPERVISOR_LOCK_DIR/pid" 2>/dev/null)"
    [ -f "$SUPERVISOR_LOCK_DIR/stime" ] && owner_stime="$(cat "$SUPERVISOR_LOCK_DIR/stime" 2>/dev/null)"
    if [ -n "$owner" ]; then
      live_stime="$(_supervisor_fingerprint "$owner")"
    fi
    if [ -n "$owner" ] && [ -n "$live_stime" ] && [ "$live_stime" = "$owner_stime" ]; then
      echo "[$name] singleton already running (pid $owner); refusing duplicate launch"
      exit 0
    fi
    # The owner died without running its trap, or its PID was recycled by
    # an unrelated process. Reclaim only this named lock.
    rm -rf "$SUPERVISOR_LOCK_DIR"
    if ! mkdir "$SUPERVISOR_LOCK_DIR" 2>/dev/null; then
      echo "[$name] could not acquire singleton lock" >&2
      exit 1
    fi
  fi

  echo "$$" > "$SUPERVISOR_LOCK_DIR/pid"
  _supervisor_fingerprint "$$" > "$SUPERVISOR_LOCK_DIR/stime"
  trap supervisor_cleanup EXIT INT TERM HUP
}

supervisor_cleanup() {
  local code=$?
  trap - EXIT INT TERM HUP
  if [ -n "${SUPERVISOR_CHILD_PID:-}" ]; then
    local live_stime
    live_stime="$(_supervisor_fingerprint "$SUPERVISOR_CHILD_PID")"
    if [ -n "$live_stime" ] && [ "$live_stime" = "${SUPERVISOR_CHILD_STIME:-}" ]; then
      # Windows Git Bash does not propagate signals through npx/cmd/tsx.
      # Kill the explicit child tree so stopping a supervisor leaves no Node
      # grandchildren behind. Fingerprint-checked so a PID reused by an
      # unrelated process in the gap between exit and cleanup is never hit.
      taskkill.exe //F //T //PID "$SUPERVISOR_CHILD_PID" >/dev/null 2>&1 || true
    fi
  fi
  if [ -n "${SUPERVISOR_LOCK_DIR:-}" ] && [ "$(cat "$SUPERVISOR_LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$SUPERVISOR_LOCK_DIR"
  fi
  exit "$code"
}

supervisor_run() {
  "$@" &
  SUPERVISOR_CHILD_PID=$!
  SUPERVISOR_CHILD_STIME="$(_supervisor_fingerprint "$SUPERVISOR_CHILD_PID")"
  wait "$SUPERVISOR_CHILD_PID"
  local code=$?
  SUPERVISOR_CHILD_PID=""
  return "$code"
}
