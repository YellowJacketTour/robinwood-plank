-- Sort-covering indexes for the two plank_market_events branches of the
-- activity feed. Companion to 148, which indexed the nine fill ledgers.
--
-- WHY THIS IS A SEPARATE FILE, AND OPTIONAL
-- -----------------------------------------
-- 148 could not carry these: test/market/notification-migration-integration
-- .test.ts holds plank_market_events in SHARE UPDATE EXCLUSIVE mode -- the
-- lock another role's notification maintenance holds in production -- and
-- CREATE INDEX needs SHARE, which that lock refuses. A migration that MUST
-- succeed cannot take that lock, and 148's fill indexes had to succeed.
--
-- This file is instead the second member of the runner's deferrable class
-- (scripts/notification-migration-policy.mjs), alongside 110: it is
-- additive, IF NOT EXISTS, data-independent, and pinned by sha256 so only
-- this reviewed text can be deferred. When the maintenance lock is held the
-- runner reports it PENDING, leaves it out of plank_schema_migrations, and
-- retries on the next deploy; when the lock is not held it applies like any
-- other migration. Nothing reads these indexes for correctness: the feed's
-- per-branch ORDER BY is the exact global key with or without them (see
-- 148's header), so a PENDING 149 only costs the two branches a sort.
--
-- MEASURED (seeded Beezie / base-mainnet, 44k market_events rows for the
-- collection, PostgreSQL 16 locally; production is 9.6, which is why the
-- tie-break column is in each index -- no incremental sort there):
--   without these indexes   two sorts over the collection's rows    91 ms
--   with them               two index scans of 50 rows each      0.37 ms
--
-- Each index is partial on exactly its branch's predicate, so it covers only
-- the rows that branch can return and the planner can use it for nothing
-- else by accident. The transfer branch orders block_number DESC NULLS LAST
-- because stream-venue rows in that branch carry NULL block_number and the
-- outer sort places NULLs last; the default DESC order (NULLS FIRST) would be
-- a different total order and the bound would be inexact.
--
-- Plain CREATE INDEX, not CONCURRENTLY: the migration runner wraps each file
-- in a transaction. Same tradeoff as 108, 113, 115, 147 and 148.

CREATE INDEX IF NOT EXISTS plank_market_events_transfer_feed_idx
  ON plank_market_events (chain_slug, lower(collection_key), block_timestamp DESC NULLS LAST, block_number DESC NULLS LAST, event_index DESC)
  WHERE event_type IN ('transfer', 'mint');

CREATE INDEX IF NOT EXISTS plank_market_events_stream_feed_idx
  ON plank_market_events (chain_slug, lower(collection_key), block_timestamp DESC NULLS LAST, sub_index DESC)
  WHERE event_type = 'sale' AND venue_id = 'opensea-stream';
