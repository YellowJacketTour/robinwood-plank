#!/bin/bash
# Crash-resilient wrapper for opensea-stats-sync-pass.mjs, same pattern as
# the other supervisors. This is the real fix for the Alchemy-429-caused
# empty Floor/24h Volume cells (Polygon, BNB, Optimism, Avalanche, etc.)
# -- an entirely independent source with its own circuit breaker, not
# blocked by Alchemy's still-unrecovered quota exhaustion.
cd "$(dirname "$0")/.."
set -a; source <(grep -E "^[A-Z_]+=" .env.local); set +a

ATTEMPT=0
while true; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "=== opensea-stats-sync supervisor: attempt $ATTEMPT, $(date -u +%H:%M:%S) UTC ==="
  npx tsx scripts/opensea-stats-sync-pass.mjs
  echo "=== opensea-stats-sync supervisor: pass exited code $? ==="
  sleep 2
done
