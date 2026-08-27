#!/bin/bash
# Crash-resilient wrapper for evm-hypersync-backfill-pass.mjs (short-pass
# discovery+backfill scan across every EVM chain). A native (NAPI-RS) module
# segfaulting shouldn't silently kill hours of intended backfill progress --
# confirmed live 2026-08-20 (the first long-run attempt died to a
# segmentation fault within seconds of starting, no useful stack, process
# just gone). Cursors persist in Postgres between invocations, so a crash
# loses at most a few seconds of in-flight work, never real progress --
# this just makes that resumption automatic instead of requiring a human
# to notice and manually relaunch.
cd "$(dirname "$0")/.."
source scripts/_supervisor-singleton.sh
supervisor_singleton "evm-hypersync-backfill-supervisor"
set -a; source <(grep -E "^[A-Z_]+=" .env.local); set +a

ATTEMPT=0
while true; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "=== supervisor: attempt $ATTEMPT, $(date -u +%H:%M:%S) UTC ==="
  supervisor_run node --import tsx scripts/evm-hypersync-backfill-pass.mjs
  code=$?
  echo "=== supervisor: pass exited code $code ==="
  sleep 2
done
