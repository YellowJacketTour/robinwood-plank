#!/bin/bash
# Continuous driver for refresh-market-data.ts -- the full-coverage sweep
# (every chain's discovery, Ordinals Wallet included, rarity/traits, sales,
# vault, portfolio, etc; see that file's own header for the complete list).
#
# REAL GAP THIS FIXES: refresh-market-data.ts's own header documents an
# intended "cron, ~15m" cadence, but nothing on this machine or in CI/prod
# ever actually invoked it on a schedule -- confirmed live 2026-08-23 via
# `ps aux` showing zero supervisor processes running (only the dev server).
# The per-source supervisor scripts next to this one (evm-hypersync,
# genesis-seaport, coingecko, opensea, other-chains) each cover ONE narrow
# slice; this is the one that drives the rest, Ordinals Wallet collection
# discovery + rarity indexing included -- without it, "continuously hydrate
# toward complete" was never actually true, no matter how complete the
# underlying code was.
#
# No deadline, by explicit owner direction (same reasoning as the deadline
# removal from the other 5 supervisors in this directory): a fixed timeout
# on cursor-resumable, real, compounding progress toward a genuinely
# complete record serves no purpose except silently stopping it.
cd "$(dirname "$0")/.."
set -a; source <(grep -E "^[A-Z_]+=" .env.local); set +a

ATTEMPT=0
while true; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "=== refresh-market-data supervisor: attempt $ATTEMPT, $(date -u +%H:%M:%S) UTC ==="
  npx tsx scripts/refresh-market-data.ts --full
  code=$?
  echo "=== refresh-market-data supervisor: pass exited code $code ==="
  # Real pacing, not a self-imposed limit: this pass touches many
  # already-rate-limited sources whose OWN gates (source-budget.ts,
  # control-plane.ts, mesh/jail.ts) already throttle each real HTTP call --
  # this sleep just prevents an instant-exit pass (e.g. everything already
  # fresh) from spinning the loop hot with no real work happening.
  sleep 30
done
