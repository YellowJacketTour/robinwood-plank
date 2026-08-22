#!/bin/bash
# Crash-resilient wrapper for _genesis-backfill-loop.mjs, same pattern as
# _backfill-supervisor.sh. Real scale check, live 2026-08-20 ("i want from
# all genesis blocks no exceptions"): some chains (Arbitrum ~496M blocks,
# Optimism ~155M, Avalanche ~93M current height) are FAR larger than the
# ~25M-block chains (eth-mainnet, base-mainnet) -- full genesis-to-head
# coverage at 50k blocks/call is thousands of real calls on those chains,
# genuinely multi-day work, not a bug or something to fake-converge.
# Cursors persist in Postgres between passes regardless of how long this
# runs, so leaving it running is real, compounding progress.
cd "$(dirname "$0")/.."
set -a; source <(grep -E "^[A-Z_]+=" .env.local); set +a

DEADLINE=$(( $(date +%s) + 24 * 60 * 60 ))
ATTEMPT=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "=== genesis-backfill supervisor: attempt $ATTEMPT, $(date -u +%H:%M:%S) UTC ==="
  npx tsx scripts/genesis-seaport-backfill-pass.mjs
  echo "=== genesis-backfill supervisor: pass exited code $? ==="
  sleep 2
done
echo "=== genesis-backfill supervisor: 24h deadline reached ==="
