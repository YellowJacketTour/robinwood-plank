#!/bin/bash
# Crash-resilient wrapper for _coingecko-sync-loop.mjs, same pattern as
# the other supervisors. Real rate math, live 2026-08-20: CoinGecko's
# unauthenticated NFT API rate limit is ~5-15 calls/min, so converging
# thousands of Solana + Bitcoin collections takes many real hours even
# running continuously -- this just makes "continuously" actually happen
# without a human relaunching it, same reasoning as the other loops.
# Getting a free CoinGecko Demo key (COINGECKO_API_KEY, 2-min signup, no
# cost) raises this to 100/min -- see coingecko-nft-stats.ts's own header.
cd "$(dirname "$0")/.."
source scripts/_supervisor-singleton.sh
supervisor_singleton "coingecko-nft-stats-sync-supervisor"
set -a; source <(grep -E "^[A-Z_]+=" .env.local); set +a

ATTEMPT=0
while true; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "=== coingecko-sync supervisor: attempt $ATTEMPT, $(date -u +%H:%M:%S) UTC ==="
  supervisor_run node --import tsx scripts/coingecko-nft-stats-sync-pass.mjs
  echo "=== coingecko-sync supervisor: pass exited code $? ==="
  sleep 2
done
