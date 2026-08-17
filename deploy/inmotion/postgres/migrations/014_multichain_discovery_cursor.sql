-- Resumable cursor for the EVM Transfer-log discovery scanner
-- (lib/market/multichain/discovery/evm-log-scan.ts).
--
-- WHY THIS EXISTS
-- ---------------
-- The multi-chain registry (013_multichain_collections.sql) only tracks
-- collections someone already pointed it at. This is the free, always-
-- scanning discovery mechanism for EVM chains: no ranking API required (the
-- gap documented in migration 013 and lib/market/multichain/types.ts's
-- ChainAdapter.discoverTopCollections doc comment), just the same raw
-- eth_getLogs technique chain-indexer.ts already runs in production for
-- Robinhood Chain, generalized to scan UNFILTERED (no address) for the
-- Transfer topic and tally activity by contract instead of tracking one
-- known address.
--
-- Verified live 2026-08-17 against a real (non-demo) Alchemy key: the free
-- tier caps eth_getLogs at a 10-block range per call — Ethereum mainnet
-- produces a block roughly every 12s, so 10 blocks is close to 2 minutes of
-- chain time, a near-exact match for the existing 2-minute cron cadence.
-- Same "one cursor, one code path for backfill and live sync" property as
-- plank_chain_index_cursor.
--
-- COMPATIBILITY: purely additive.

CREATE TABLE IF NOT EXISTS plank_multichain_discovery_cursor (
  chain_slug TEXT PRIMARY KEY,
  last_scanned_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
