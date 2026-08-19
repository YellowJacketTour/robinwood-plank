-- Self-hosted activity ranking for EVM chains, built entirely from the
-- Transfer-log scanner (lib/market/multichain/discovery/evm-log-scan.ts) --
-- no third-party ranking API required.
--
-- WHY THIS EXISTS
-- ---------------
-- Magic Eden's v4 EVM API (Reservoir-powered, the one real candidate for a
-- free cross-EVM ranking source) was confirmed live 2026-08-17, multiple
-- retests, returning 503 "no healthy upstream" -- a real, ongoing outage,
-- not a wrong path. Rather than block on a third party coming back up, this
-- reverse-engineers what that endpoint would have given us: a ranked list
-- by observed volume. evm-log-scan.ts already scans every EVM chain's raw
-- Transfer activity every ~2 minutes for real-time discovery of ACTIVE
-- collections (>=MIN_TRANSFERS_TO_CONSIDER in one 10-block window); this
-- table is the accumulator that turns those same scans into a durable,
-- ever-growing per-contract activity history, so "top by volume" becomes a
-- SUM/ORDER BY over data we already collected for free, instead of a call
-- to anyone else's endpoint.
--
-- This is a genuinely different signal than plank_multichain_snapshots'
-- floor price: it is OUR OWN observed transfer counts, not marketplace
-- listing data, so a contract can appear here (real trading activity) even
-- before it's ever been registered as a tracked collection.
--
-- One row per (chain_slug, contract_address, day) so ranking windows (1d,
-- 7d, 30d, all-time) are all just a GROUP BY over the same table -- no
-- separate rollup jobs, same pattern as day-bucketed analytics elsewhere in
-- this app.
--
-- COMPATIBILITY: purely additive.

CREATE TABLE IF NOT EXISTS plank_multichain_activity_stats (
  chain_slug TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  activity_day DATE NOT NULL,
  transfer_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_slug, contract_address, activity_day)
);

CREATE INDEX IF NOT EXISTS plank_multichain_activity_stats_ranking_idx
  ON plank_multichain_activity_stats (chain_slug, activity_day, transfer_count DESC);
