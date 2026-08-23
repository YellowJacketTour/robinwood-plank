#!/bin/bash
# Companion to _launch-all.sh -- kills every process this repo's launcher
# started, by real tracked PID (never a broad pkill by name, which could
# hit an unrelated process sharing "node" or "bash"). Also reaps any
# pidfile whose process already died on its own (a stale file otherwise
# permanently blocks _launch-all.sh from believing it's dead -- no it
# doesn't, is_alive() checks real liveness -- but this still cleans up the
# stale file so `ls` reflects reality).
# devserver has no pidfile (see _launch-all.sh's own comment on why bash's
# $! can't track it) -- stop it by finding the real PID actually LISTENING
# on 3800 instead.
devpid="$(netstat -ano 2>/dev/null | awk '/:3800 .*LISTENING/ {print $NF; exit}')"
if [ -n "$devpid" ]; then
  taskkill //F //PID "$devpid" >/dev/null 2>&1 && echo "[devserver] killed pid $devpid" || echo "[devserver] could not kill pid $devpid"
else
  echo "[devserver] not running"
fi

PIDDIR="/c/tmp/plank-pids"
[ -d "$PIDDIR" ] || { echo "no pidfiles found"; exit 0; }

for pidfile in "$PIDDIR"/*.pid; do
  [ -f "$pidfile" ] || continue
  name="$(basename "$pidfile" .pid)"
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    echo "[$name] killed pid $pid"
  else
    echo "[$name] already dead (stale pidfile removed)"
  fi
  rm -f "$pidfile"
done
