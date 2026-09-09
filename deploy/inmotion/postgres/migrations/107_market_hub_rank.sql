-- The Global Market Hub's sort, made indexable.
--
-- MEASURED ON PRODUCTION 2026-09-09, signed in through the backstage door:
--
--     /api/market/multichain?limit=500   4,934 ms, 698 KB
--     /api/market/multichain?limit=40    HTTP 504 after 60,081 ms
--
-- The smaller page timed out. The first cause was `COUNT(*) OVER()`, a window
-- aggregate evaluated over the whole result set before LIMIT; that is fixed.
--
-- It was only HALF the problem. The default ordering is:
--
--     (c.is_vault_backed) DESC, s.sales_24h DESC NULLS LAST,
--     s.sales_7d DESC NULLS LAST, (s.floor_price_wei IS NOT NULL) DESC,
--     s.holder_count DESC NULLS LAST, s.volume_30d_wei DESC NULLS LAST,
--     c.chain_slug, c.contract_address
--
-- Every sort key but the first and last two lives in `snapshots`, while the
-- filter (`chain_slug`) lives in `collections`. **Postgres cannot index a sort
-- that spans two tables.** So every hub page still scans `collections`,
-- hash-joins ~345,000 snapshot rows, sorts all of them, and takes forty.
-- Removing the window count removed one of two full passes.
--
-- Two further blockers, both in the same query:
--
--   * `NULLIF(s.floor_price_wei, '')::numeric` -- the column is NUMERIC(78,0)
--     (013:68) and a numeric can never equal the empty string, so this is dead
--     defensive code. It is not harmless: an expression sort cannot use a
--     plain column index even if one existed.
--   * `(s.floor_price_wei IS NOT NULL) DESC` -- an expression tie-break, for
--     the same reason unindexable. Materialised here as `has_floor`.
--
-- There is also NO index on `chain_slug`, the hottest predicate in the app.
-- A code comment rationalised it ("~115ms parallel seq scan, no dedicated
-- index needed at this size") measured at ~320k rows. That reasoning had a
-- shelf life and it has expired.
--
-- THE FIX: collapse the sort keys and the filter key into ONE table, so the
-- hub's default page becomes an index scan touching ~40 rows instead of a
-- sort over a third of a million.
--
-- A real table, not a MATERIALIZED VIEW: REFRESH MATERIALIZED VIEW
-- CONCURRENTLY over 345k rows on every sync cycle is its own load problem, and
-- a view cannot be updated incrementally by the writer that already knows
-- exactly which row changed.

CREATE TABLE IF NOT EXISTS plank_market_hub_rank (
  collection_id     BIGINT PRIMARY KEY
                      REFERENCES plank_multichain_collections(id) ON DELETE CASCADE,
  chain_slug        TEXT NOT NULL,
  contract_address  TEXT NOT NULL,
  is_vault_backed   BOOLEAN NOT NULL DEFAULT FALSE,
  floor_price_wei   NUMERIC(78, 0),
  volume_24h_wei    NUMERIC(78, 0),
  sales_24h         INTEGER,
  volume_7d_wei     NUMERIC(78, 0),
  sales_7d          INTEGER,
  volume_30d_wei    NUMERIC(78, 0),
  holder_count      INTEGER,
  listed_count      INTEGER,
  floor_change_pct  DOUBLE PRECISION,
  -- Materialises `(floor_price_wei IS NOT NULL)`, which as an expression could
  -- never be part of an index. Stored, so the tie-break is a plain column.
  has_floor         BOOLEAN NOT NULL DEFAULT FALSE,
  refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The DEFAULT ordering, in one index, in exactly the query's own key order.
-- A composite index only serves a sort whose leading columns match, so the
-- column order here is not cosmetic -- it is the contract with the query.
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_default_idx
  ON plank_market_hub_rank (
    chain_slug,
    is_vault_backed DESC,
    sales_24h DESC NULLS LAST,
    sales_7d DESC NULLS LAST,
    has_floor DESC,
    holder_count DESC NULLS LAST,
    volume_30d_wei DESC NULLS LAST
  );

-- One index per user-selectable sort. Each is (chain_slug, key) because the
-- chain tab is nearly always applied, and a leading equality column lets the
-- index serve both the filter and the ordering in a single scan.
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_vol24_idx
  ON plank_market_hub_rank (chain_slug, volume_24h_wei DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_floor_idx
  ON plank_market_hub_rank (chain_slug, floor_price_wei DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_sales_idx
  ON plank_market_hub_rank (chain_slug, sales_24h DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_change_idx
  ON plank_market_hub_rank (chain_slug, floor_change_pct DESC NULLS LAST);

-- Holders and listed are ~80% and ~85% NULL respectively (measured live over
-- 40 top rows). A full index on those would be four-fifths dead entries that
-- NULLS LAST never reads, so these are PARTIAL: roughly 5x smaller, and they
-- serve the whole non-null head of each sort.
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_holders_idx
  ON plank_market_hub_rank (chain_slug, holder_count DESC)
  WHERE holder_count IS NOT NULL;
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_listed_idx
  ON plank_market_hub_rank (chain_slug, listed_count DESC)
  WHERE listed_count IS NOT NULL;

-- The count the hub shows as "X of Y". With chain_slug leading every index
-- above, a filtered count is an index-only scan rather than the seq scan it
-- is today.
CREATE INDEX IF NOT EXISTS plank_market_hub_rank_chain_idx
  ON plank_market_hub_rank (chain_slug);

-- The missing index on the base table, independent of this summary. Even with
-- the hub served from plank_market_hub_rank, `chain_slug` is filtered directly
-- on plank_multichain_collections by discovery, coverage and admin paths.
--
-- NOT CONCURRENTLY: this runner wraps each migration in a transaction and
-- CREATE INDEX CONCURRENTLY cannot run inside one -- the same trade-off
-- migration 105 documents. If the lock window is a concern on the live host,
-- build it by hand with CONCURRENTLY first and this statement becomes a no-op.
CREATE INDEX IF NOT EXISTS plank_multichain_collections_chain_idx
  ON plank_multichain_collections (chain_slug);

-- Seed from what already exists, so the table is useful the moment it lands
-- rather than after a full sync cycle. Idempotent: re-running updates in
-- place, and ON CONFLICT keeps the seed safe if a writer got there first.
INSERT INTO plank_market_hub_rank (
  collection_id, chain_slug, contract_address, is_vault_backed,
  floor_price_wei, volume_24h_wei, sales_24h, volume_7d_wei, sales_7d,
  volume_30d_wei, holder_count, listed_count, floor_change_pct, has_floor
)
SELECT
  c.id, c.chain_slug, c.contract_address, COALESCE(c.is_vault_backed, FALSE),
  s.floor_price_wei, s.volume_24h_wei, s.sales_24h, s.volume_7d_wei, s.sales_7d,
  s.volume_30d_wei, s.holder_count, s.listed_count, s.floor_change_pct,
  (s.floor_price_wei IS NOT NULL)
FROM plank_multichain_collections c
LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
ON CONFLICT (collection_id) DO UPDATE SET
  chain_slug       = EXCLUDED.chain_slug,
  contract_address = EXCLUDED.contract_address,
  is_vault_backed  = EXCLUDED.is_vault_backed,
  floor_price_wei  = EXCLUDED.floor_price_wei,
  volume_24h_wei   = EXCLUDED.volume_24h_wei,
  sales_24h        = EXCLUDED.sales_24h,
  volume_7d_wei    = EXCLUDED.volume_7d_wei,
  sales_7d         = EXCLUDED.sales_7d,
  volume_30d_wei   = EXCLUDED.volume_30d_wei,
  holder_count     = EXCLUDED.holder_count,
  listed_count     = EXCLUDED.listed_count,
  floor_change_pct = EXCLUDED.floor_change_pct,
  has_floor        = EXCLUDED.has_floor,
  refreshed_at     = NOW();
