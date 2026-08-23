#!/bin/bash
# Single, idempotent entry point for every long-running local process this
# repo needs (dev server + all 6 supervisor loops). REAL PROBLEM THIS FIXES:
# every prior launch this session used a bare `nohup ... &` with no PID
# tracking, so a re-launch after a crash/restart had no way to know whether
# a previous instance was still alive -- risking either an orphaned zombie
# process nobody kills, or (if launched twice) two copies of the same
# supervisor racing on the same real API keys/DB rows. This script tracks
# every process's real PID in a pidfile, checks real liveness (not just
# file existence -- a stale pidfile from a crashed process must not block
# a fresh launch) before starting anything, and never starts a second copy
# of something already running.
cd "$(dirname "$0")/.."
PIDDIR="/c/tmp/plank-pids"
mkdir -p "$PIDDIR" /c/tmp/plank-supervisor-logs

is_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

launch_if_dead() {
  local name="$1"
  local cmd="$2"
  local pidfile="$PIDDIR/$name.pid"
  local log="/c/tmp/plank-supervisor-logs/$name.log"
  if [ -f "$pidfile" ] && is_alive "$(cat "$pidfile")"; then
    echo "[$name] already running (pid $(cat "$pidfile")), skipping"
    return
  fi
  rm -f "$pidfile"
  nohup bash -c "$cmd" > "$log" 2>&1 &
  local newpid=$!
  disown
  echo "$newpid" > "$pidfile"
  echo "[$name] launched, pid $newpid"
}

# REAL BUG FIXED 2026-08-23: `next dev` forks through bash -> npx -> node ->
# cmd.exe -> the real listening node.exe, so bash's own $! only ever
# captures an intermediate wrapper PID that exits almost immediately once
# it hands off -- is_alive() on that PID is always false a moment later,
# so launch_if_dead's guard never actually worked for this one entry and
# every re-run started a second real dev server, racing for the same port
# (confirmed live: a second launch DID fire; the only reason it didn't
# leave two live servers is the OS's own port-bind collision killed the
# loser -- real luck, not a real guard). Checking the actual LISTENING
# port instead of a PID is the correct, robust liveness check for this
# specific process (unlike the bash supervisor loops below, which stay in
# one long-lived `while true` process and are correctly PID-trackable).
if netstat -ano 2>/dev/null | grep -q ":3800.*LISTENING"; then
  echo "[devserver] already listening on 3800, skipping"
else
  nohup bash -c "npx next dev -p 3800" > "/c/tmp/plank-supervisor-logs/devserver.log" 2>&1 &
  disown
  echo "[devserver] launched (port-checked)"
fi
launch_if_dead "refresh-market-data-supervisor" "bash scripts/refresh-market-data-supervisor.sh"
launch_if_dead "other-chains-discovery-supervisor" "bash scripts/other-chains-discovery-supervisor.sh"
launch_if_dead "evm-hypersync-backfill-supervisor" "bash scripts/evm-hypersync-backfill-supervisor.sh"
launch_if_dead "genesis-seaport-backfill-supervisor" "bash scripts/genesis-seaport-backfill-supervisor.sh"
launch_if_dead "coingecko-nft-stats-sync-supervisor" "bash scripts/coingecko-nft-stats-sync-supervisor.sh"
launch_if_dead "opensea-stats-sync-supervisor" "bash scripts/opensea-stats-sync-supervisor.sh"

echo "=== all checks done ==="
