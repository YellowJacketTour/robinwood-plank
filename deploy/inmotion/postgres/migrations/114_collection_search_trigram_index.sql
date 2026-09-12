-- Collection search was a sequential scan of the whole catalog, per keystroke.
--
-- WHAT RUNS
-- ---------
-- searchTrackedCollectionsByName (lib/market/multichain/store.ts), behind
-- /api/market/multichain/collection-search, is the hub's search box:
--
--     WHERE (c.name ILIKE '%q%' OR c.contract_address ILIKE '%q%')
--
-- A LEADING wildcard defeats every b-tree. The only indexes on this table are
-- (chain_slug) and a partial (chain_slug, alias_symbol), neither of which can
-- serve it, so the planner scans the entire catalog and re-evaluates three more
-- ILIKE predicates per row in the ORDER BY.
--
-- Measured here on a 300,162-row catalog: 5,112 buffers, ~70 ms, two extra
-- parallel workers -- for ONE keystroke, against a pool capped at
-- PGPOOL_MAX=4. Production's catalog is larger still (the route's own comments
-- cite 317k-383k tracked collections).
--
-- WHY TRIGRAM
-- -----------
-- A GIN trigram index is the only structure that can serve a leading-wildcard
-- ILIKE. gin_trgm_ops indexes every 3-character substring, so '%wizard%'
-- becomes an index lookup rather than a scan.
--
-- WHY THIS MIGRATION CANNOT SIMPLY SAY "CREATE EXTENSION"
-- ------------------------------------------------------
-- No migration in this repo has ever used CREATE EXTENSION, and production is
-- PostgreSQL 9.6 on shared cPanel hosting (.github/workflows/inmotion.yml
-- pins a 9.6 legacy job precisely because "production rejected
-- transition-table syntax"). pg_trgm SHIPS with 9.6 -- verified against the
-- same postgres:9.6-alpine image CI uses -- but CREATE EXTENSION requires
-- privileges a shared-hosting role may not hold.
--
-- A migration that hard-fails on a permissions error would block the entire
-- deploy pipeline for what is an optimisation. So this is written to degrade:
-- if the extension cannot be created, the index is skipped and a NOTICE
-- explains why. The search keeps working exactly as it does today -- slowly,
-- but correctly -- and the migration still reports success.
--
-- That is deliberate and it is the honest shape for THIS change specifically:
-- the index is a pure performance addition with no correctness role, so its
-- absence must not be an outage. A test asserts the planner uses it WHEN the
-- extension is present, so a silently-missing index on a capable database
-- still fails CI rather than passing unnoticed.

DO $$
DECLARE
  has_trgm BOOLEAN;
BEGIN
  -- Already installed? Then nothing to try.
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') INTO has_trgm;

  IF NOT has_trgm THEN
    BEGIN
      CREATE EXTENSION pg_trgm;
      has_trgm := TRUE;
    EXCEPTION WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
      RAISE NOTICE 'pg_trgm unavailable (%): collection search keeps its sequential scan. This is a performance skip, not a failure.', SQLERRM;
      has_trgm := FALSE;
    END;
  END IF;

  IF has_trgm THEN
    -- One index per searched column. `name` is what users actually type;
    -- contract_address is searched with the same leading wildcard and would
    -- otherwise still force a scan whenever the name index found nothing.
    CREATE INDEX IF NOT EXISTS plank_multichain_collections_name_trgm_idx
      ON plank_multichain_collections USING GIN (name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS plank_multichain_collections_address_trgm_idx
      ON plank_multichain_collections USING GIN (contract_address gin_trgm_ops);
    RAISE NOTICE 'pg_trgm present: collection search indexes created.';
  END IF;
END
$$;
