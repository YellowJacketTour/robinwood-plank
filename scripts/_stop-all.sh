#!/bin/bash
# Companion to _launch-all.sh -- kills every process this repo's launcher
# started, by real tracked PID (never a broad pkill by name, which could
# hit an unrelated process sharing "node" or "bash"). Also reaps any
# pidfile whose process already died on its own (a stale file otherwise
# permanently blocks _launch-all.sh from believing it's dead -- no it
# doesn't, is_alive() checks real liveness -- but this still cleans up the
# stale file so `ls` reflects reality).
#
# REAL INCIDENT 2026-08-23, root cause of a real disk-space emergency:
# this used to call bash's own `kill "$pid"`, which only signals the
# tracked WRAPPER pid (the top-level bash loop) -- it does NOT kill the
# process TREE that wrapper spawned (bash -> npx -> node -> cmd.exe ->
# node -> tsx, 5+ levels deep on Windows). Every "stop and relaunch" this
# session left the previous run's real worker processes orphaned and
# running invisibly, since the wrapper looked dead but its children never
# got the signal. Confirmed live: after one stop+relaunch cycle, 27 real
# orphaned processes across 4-5 duplicate refresh-market-data.ts trees and
# 2 duplicate coingecko trees were found still running, all still writing
# logs and hammering the DB -- and killing them properly freed the drive
# from 44MB to 17.3GB free INSTANTLY, proving this was the actual leak,
# not external clutter. `taskkill //F //T //PID` (the `//T` flag) kills
# the entire process tree, not just the one PID -- this is now used
# everywhere a process is stopped in this script, including devserver
# (which already used taskkill but was missing //T).
devpid="$(netstat -ano 2>/dev/null | awk '/:3800 .*LISTENING/ {print $NF; exit}')"
if [ -n "$devpid" ]; then
  taskkill //F //T //PID "$devpid" >/dev/null 2>&1 && echo "[devserver] killed pid $devpid (tree)" || echo "[devserver] could not kill pid $devpid"
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
    taskkill //F //T //PID "$pid" >/dev/null 2>&1
    echo "[$name] killed pid $pid (tree)"
  else
    echo "[$name] already dead (stale pidfile removed)"
  fi
  rm -f "$pidfile"
done
