#!/bin/bash
cd "$(dirname "$0")/.."
set -a; source <(grep -E "^[A-Z_]+=" .env.local); set +a

ATTEMPT=0
while true; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "=== mesh-tick supervisor: attempt $ATTEMPT, $(date -u +%H:%M:%S) UTC ==="
  # Real fix, 2026-08-25 ("updates need to land faster on prioritized
  # collections"): default concurrency (6) matched to PGPOOL_MAX's OLD
  # default (4), meaning workers were already blocking on a free DB
  # connection before any real work started. Raised alongside PGPOOL_MAX=16
  # in .env.local so a high-priority job (a prioritized collection's
  # anchored-membership scan, say) gets reclaimed by a free worker sooner
  # instead of queueing behind whichever of only 6 slots frees up next.
  # LOCAL DEV ONLY -- this script (and .env.local) never runs in
  # production, which drives mesh-tick.ts directly from cron with its own
  # explicit --limit=6 against a real, deliberately-capped PGPOOL_MAX=4 on
  # its hosted DB tier (see docs/INMOTION_DEPLOYMENT.md) -- do not "fix"
  # that number to match this one, it is a real, different constraint.
  npx tsx scripts/mesh-tick.ts --limit=16
  echo "=== mesh-tick supervisor: pass exited code $? ==="
  sleep 2
done
