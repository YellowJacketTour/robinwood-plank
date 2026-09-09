-- Transactional, statement-level invalidation. No per-token network messages,
-- no event-sequence watermark (allocated IDs are not commit order).
-- Old AND new transition rows invalidate both sides of an identity update.
CREATE OR REPLACE FUNCTION plank_notify_market_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_sql text;
  scopes jsonb;
  scope_count bigint;
  row_count bigint;
  payload text;
BEGIN
  source_sql := CASE TG_OP
    WHEN 'INSERT' THEN 'SELECT * FROM new_rows'
    WHEN 'DELETE' THEN 'SELECT * FROM old_rows'
    ELSE 'SELECT * FROM old_rows UNION ALL SELECT * FROM new_rows' END;
  IF TG_TABLE_NAME = 'plank_multichain_snapshots' THEN
    source_sql := format('SELECT c.chain_slug, c.contract_address FROM (%s) s
      JOIN plank_multichain_collections c ON c.id = s.collection_id', source_sql);
  END IF;
  EXECUTE format('WITH changed AS (%s), coordinates AS (
    SELECT DISTINCT chain_slug AS chain, %I AS collection FROM changed
  ) SELECT (SELECT count(*) FROM changed), count(*),
    COALESCE((SELECT jsonb_agg(jsonb_build_object(''chainSlug'', chain, ''collectionKey'', collection))
      FROM (SELECT * FROM coordinates ORDER BY chain, collection LIMIT 32) bounded), ''[]''::jsonb)
    FROM coordinates', source_sql, TG_ARGV[1]) INTO row_count, scope_count, scopes;
  IF row_count = 0 THEN RETURN NULL; END IF;
  payload := jsonb_build_object('type', 'invalidate', 'family', TG_ARGV[0],
    'scopes', scopes, 'changedRows', row_count, 'omittedScopes', 0)::text;
  -- Never silently truncate a large statement. Broadcast a resnapshot with
  -- an exact omitted scope count; do not risk PostgreSQL's 8KB NOTIFY limit.
  IF scope_count > 32 OR octet_length(payload) > 7000 THEN
    payload := jsonb_build_object('type', 'resync', 'family', TG_ARGV[0],
      'scopes', '[]'::jsonb, 'changedRows', row_count,
      'omittedScopes', scope_count, 'reason', 'statement-scope-overflow')::text;
  END IF;
  PERFORM pg_notify('plank_market_changes', payload);
  RETURN NULL;
END;
$$;

DO $$
DECLARE spec record;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('plank_collection_tokens', 'tokens', 'collection_slug'),
    ('plank_collection_token_projections', 'tokens', 'collection_slug'),
    ('plank_foreign_rarity', 'rarity', 'collection_slug'),
    ('plank_foreign_rarity_collections', 'rarity', 'collection_slug'),
    ('plank_collection_cells', 'hydration', 'collection_key'),
    ('plank_market_live_orders', 'orders', 'collection_key'),
    ('plank_market_events', 'activity', 'collection_key'),
    ('plank_multichain_collections', 'collection', 'contract_address')
    ,('plank_multichain_snapshots', 'collection', 'contract_address')
  ) AS specs(table_name, family, key_column)
  LOOP
    EXECUTE format('CREATE TRIGGER plank_changes_insert AFTER INSERT ON %I
      REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
      EXECUTE FUNCTION plank_notify_market_changes(%L, %L)', spec.table_name, spec.family, spec.key_column);
    EXECUTE format('CREATE TRIGGER plank_changes_update AFTER UPDATE ON %I
      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
      EXECUTE FUNCTION plank_notify_market_changes(%L, %L)', spec.table_name, spec.family, spec.key_column);
    EXECUTE format('CREATE TRIGGER plank_changes_delete AFTER DELETE ON %I
      REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
      EXECUTE FUNCTION plank_notify_market_changes(%L, %L)', spec.table_name, spec.family, spec.key_column);
  END LOOP;
END;
$$;
