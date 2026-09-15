-- The hub's UNFILTERED rankings -- the page every visitor lands on -- had no
-- index that could serve its ORDER BY, and never did.
--
-- WHAT 107 BUILT, AND WHY IT DOES NOT APPLY
-- -----------------------------------------
-- Migration 107 gave every sort an index led by chain_slug:
--
--   plank_market_hub_rank_default_idx (chain_slug, is_vault_backed DESC, ...)
--   plank_market_hub_rank_vol24_idx   (chain_slug, volume_24h_wei DESC NULLS LAST)
--   ... floor / sales / change, same shape
--
-- Its own comment states the reasoning: "each is (chain_slug, key) because
-- the chain tab is nearly always applied, and a leading equality column lets
-- the index serve both the filter and the ordering in a single scan." That
-- is exactly right WHEN a chain tab is applied. The default view applies
-- none -- no chain filter, no WHERE at all -- so there is no equality on the
-- leading column, and a btree cannot deliver its 2nd..Nth columns in order
-- without one. The planner falls back to reading the whole table and sorting.
--
-- MEASURED (local PostgreSQL 16, 300,351 rows, cache-warm):
--   unfiltered default order, before      Seq Scan 300,351 rows + top-N sort
--   unfiltered default order, after       0.312 ms, 5 buffers
--   unfiltered volume sort, before        Parallel Seq Scan, 100,117 rows x 3
--   unfiltered volume sort, after         0.107 ms
--   floor / sales / change sorts, after   0.346 / 0.413 / 0.463 ms
--
-- Local PostgreSQL 16 hides this behind parallel workers (~40-90 ms).
-- PRODUCTION IS 9.6, WHICH HAS NONE: that same scan is the 12.7 s measured
-- live on 2026-09-14 for a cold /api/market/multichain (a repeat with the
-- same cache key answered in 0.19 s -- the cost was never the response, it
-- was building it).
--
-- WHY A SECOND INDEX PER SORT, NOT A REPLACEMENT
-- ----------------------------------------------
-- 107's chain-led indexes are correct and fast for the chain-tab views
-- (measured: 0.057 ms for eth-mainnet in the default order) and are left
-- exactly as they are. These are the same keys WITHOUT the leading
-- chain_slug, for the view that has no chain equality to offer. Each carries
-- the FULL ORDER BY the query builds -- including the tie-break
-- (has_floor, holder_count, volume_30d_wei, chain_slug, contract_address) --
-- because a btree serves a sort only for the prefix it actually stores; an
-- index of the leading column alone would still sort.
--
-- COST, STATED PLAINLY: ~27 MB each, ~135 MB total, on a 34 MB table whose
-- indexes already total 193 MB. That is the price of turning the landing
-- page from a full-table sort into an index seek. refreshHubRank upserts ONE
-- row at a time (never a bulk rebuild), so maintenance is per-row.
--
-- Plain CREATE INDEX, not CONCURRENTLY: the runner wraps each file in a
-- transaction. Same tradeoff as 107, 148 and 150. This table is a derived
-- rank cache -- a rebuild reconstructs it -- so the lock is on a table no
-- writer blocks on for long.

-- The default order (HUB_DEFAULT_ORDER in lib/market/multichain/hub-rank.ts).
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_global_idx
  ON plank_market_hub_rank (
    is_vault_backed DESC,
    sales_24h DESC NULLS LAST,
    sales_7d DESC NULLS LAST,
    has_floor DESC,
    holder_count DESC NULLS LAST,
    volume_30d_wei DESC NULLS LAST,
    chain_slug,
    contract_address
  );

-- One per user-selectable sort, each the full key the sorted ORDER BY builds:
--   <sort> DESC NULLS LAST, is_vault_backed DESC, sales_24h DESC NULLS LAST,
--   has_floor DESC, holder_count DESC NULLS LAST, volume_30d_wei DESC NULLS
--   LAST, chain_slug, contract_address
-- (see listCollectionsWithSnapshotsPage's `orderBy`). Volume is first
-- because it is the hub's default sort as of PR #516.
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_global_volume_24h_wei_idx
  ON plank_market_hub_rank (volume_24h_wei DESC NULLS LAST, is_vault_backed DESC, sales_24h DESC NULLS LAST, has_floor DESC, holder_count DESC NULLS LAST, volume_30d_wei DESC NULLS LAST, chain_slug, contract_address);
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_global_floor_price_wei_idx
  ON plank_market_hub_rank (floor_price_wei DESC NULLS LAST, is_vault_backed DESC, sales_24h DESC NULLS LAST, has_floor DESC, holder_count DESC NULLS LAST, volume_30d_wei DESC NULLS LAST, chain_slug, contract_address);
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_global_sales_24h_idx
  ON plank_market_hub_rank (sales_24h DESC NULLS LAST, is_vault_backed DESC, sales_24h DESC NULLS LAST, has_floor DESC, holder_count DESC NULLS LAST, volume_30d_wei DESC NULLS LAST, chain_slug, contract_address);
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_global_floor_change_pct_idx
  ON plank_market_hub_rank (floor_change_pct DESC NULLS LAST, is_vault_backed DESC, sales_24h DESC NULLS LAST, has_floor DESC, holder_count DESC NULLS LAST, volume_30d_wei DESC NULLS LAST, chain_slug, contract_address);

-- Holders and listed: PARTIAL, for the same reason 107 made its chain-led
-- pair partial -- they are ~80% and ~85% NULL in production, and NULLS LAST
-- never reads a NULL entry, so a full index would be four-fifths dead
-- weight. The partial index serves the entire non-null head of the sort,
-- which is every row a visitor paging that column will ever reach.
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_global_holder_count_idx
  ON plank_market_hub_rank (holder_count DESC, is_vault_backed DESC, sales_24h DESC NULLS LAST, has_floor DESC, volume_30d_wei DESC NULLS LAST, chain_slug, contract_address)
  WHERE holder_count IS NOT NULL;
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_global_listed_count_idx
  ON plank_market_hub_rank (listed_count DESC, is_vault_backed DESC, sales_24h DESC NULLS LAST, has_floor DESC, holder_count DESC NULLS LAST, volume_30d_wei DESC NULLS LAST, chain_slug, contract_address)
  WHERE listed_count IS NOT NULL;
