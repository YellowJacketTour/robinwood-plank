-- Sort-covering indexes so the activity feed reads N rows per venue, not all of them.
--
-- WHAT THE FEED DOES TODAY
-- ------------------------
-- lib/market/multichain/ledger-activity.ts builds one collection's activity
-- feed by UNION ALL-ing eleven ledgers, sorting the whole result, and taking
-- `limit` rows. Every branch returns EVERY row the collection has ever had in
-- that venue; the LIMIT applies only after the union. Migration 147 gave the
-- last un-indexed branch (Wyvern) a seekable index, which turned an impossible
-- read into a possible one -- but the union still fetched every row before
-- discarding all but 50.
--
-- MEASURED (EXPLAIN ANALYZE, BUFFERS; seeded, cache-warm)
--
--   BAYC / eth-mainnet, seaport 61k + wyvern 30k rows for the collection:
--     today's shape, LIMIT after the union    top-N heapsort over ~90k rows   ~500 ms
--     per-branch LIMIT on these indexes       385 buffers                    148 ms cold
--   Beezie / base-mainnet, market_events 44k rows for the collection:
--     today's shape                           22,000 rows read                 59 ms
--     per-branch LIMIT on these indexes       2 index scans, 50 rows each   0.37 ms
--
-- WHY THE PER-BRANCH ORDER IS THE GLOBAL KEY, EXACTLY
-- ---------------------------------------------------
-- The feed's outer sort is
--
--     COALESCE(block_timestamp, epoch) DESC, block_number DESC NULLS LAST, log_index DESC
--
-- If every branch's ORDER BY is that same total order, then the union of the
-- per-branch top-Ns is a superset of the true top-N, and the outer sort over
-- (11 x N) rows is exact. That is a structural property of top-N over a
-- union; it assumes nothing about the data.
--
-- Two earlier designs assumed more and were WRONG, caught by comparing the
-- bounded and unbounded top-50 as sets on seeded data before any code was
-- written:
--
--   1. Per-branch ORDER BY block_number DESC (block height is a total order on
--      time within one chain). Correct only when block_timestamp is monotone
--      in block_number, which a seed with cyclic timestamps violated -- and
--      which real data violates wherever a timestamp was never backfilled.
--      BAYC: 50 of 50 rows differed.
--   2. The same, with the OpenSea-stream branch forced first via NULLS FIRST.
--      The transfer branch of plank_market_events also holds stream-venue
--      rows with NULL block_number, which a block-ordered bound mis-ranks.
--      Beezie: 44 of 50 rows differed. And a permanent stream row -- a venue
--      the fill indexer never reaches -- would float to the top forever.
--
-- With the exact key, both collections match 0/0. (block_timestamp DESC NULLS
-- LAST is the same order as COALESCE(ts, epoch) DESC for every real timestamp,
-- and unlike the COALESCE expression it is indexable.)
--
-- WHY THE EXISTING INDEXES CANNOT DO THIS
-- ---------------------------------------
-- Each fill table has (chain_slug, nft_contract, block_number DESC). The
-- per-branch sort leads with block_timestamp and needs the tie-break column
-- in the index to stop after N rows; without it the planner reads every row
-- of the collection and sorts. PostgreSQL 13+ would bridge that with an
-- incremental sort; production is PostgreSQL 9.6, which cannot. The tie-break
-- is not cosmetic: if the Nth row's block holds three fills and the branch
-- stops after an arbitrary one, the outer sort can prefer a fill the branch
-- never returned -- a silent miss.
--
-- The existing indexes are left in place: the coverage aggregate and the
-- holder-count derivation read the unbounded union through them, and this
-- repo's migrations do not drop what a live reader may be on.
--
-- Plain CREATE INDEX, not CONCURRENTLY: the migration runner wraps each file
-- in a transaction. Same tradeoff as 108, 113, 115 and 147.

-- Nine fill ledgers. block_number is NOT NULL on every fill table.
CREATE INDEX IF NOT EXISTS plank_seaport_fills_feed_idx
  ON plank_seaport_fills (chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS plank_wyvern_fills_feed_idx
  ON plank_wyvern_fills (chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS plank_looksrare_fills_feed_idx
  ON plank_looksrare_fills (chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS plank_blur_fills_feed_idx
  ON plank_blur_fills (chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS plank_x2y2_fills_feed_idx
  ON plank_x2y2_fills (chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS plank_foundation_fills_feed_idx
  ON plank_foundation_fills (chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS plank_sudoswap_fills_feed_idx
  ON plank_sudoswap_fills (chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS plank_rarible_fills_feed_idx
  ON plank_rarible_fills (chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS plank_cryptokitties_fills_feed_idx
  ON plank_cryptokitties_fills (chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC);

-- The transfer/mint branch of plank_market_events. block_number is nullable
-- here (stream-venue transfers carry none), hence NULLS LAST on it as well.
-- event_type is filtered during the ordered scan, not placed in the key: an
-- IN-list in the key would need two scans merged, which loses the index
-- order on 9.6.
CREATE INDEX IF NOT EXISTS plank_market_events_feed_idx
  ON plank_market_events (chain_slug, lower(collection_key), block_timestamp DESC NULLS LAST, block_number DESC NULLS LAST, event_index DESC);

-- The OpenSea-stream sale branch: its tie-break is sub_index, so it needs
-- its own key. Partial, because stream rows are tiny by construction -- they
-- exist only until the on-chain fill indexer catches the same transaction.
CREATE INDEX IF NOT EXISTS plank_market_events_stream_feed_idx
  ON plank_market_events (chain_slug, lower(collection_key), block_timestamp DESC NULLS LAST, sub_index DESC)
  WHERE venue_id = 'opensea-stream';
