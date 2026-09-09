-- Discovery must become browseable without waiting for a statistics pass.
-- Statement transition tables keep bulk discovery to one indexed upsert;
-- source rows and their browsing index commit or roll back together.
CREATE OR REPLACE FUNCTION plank_sync_hub_rank() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  EXECUTE format($query$
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
JOIN rank_changed changed ON c.id = changed.%I
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
$query$, CASE WHEN TG_TABLE_NAME = 'plank_multichain_collections' THEN 'id' ELSE 'collection_id' END);
  RETURN NULL;
END;
$function$;
CREATE TRIGGER plank_hub_rank_insert AFTER INSERT ON plank_multichain_collections
REFERENCING NEW TABLE AS rank_changed FOR EACH STATEMENT EXECUTE FUNCTION plank_sync_hub_rank();
CREATE TRIGGER plank_hub_rank_update AFTER UPDATE ON plank_multichain_collections
REFERENCING NEW TABLE AS rank_changed FOR EACH STATEMENT EXECUTE FUNCTION plank_sync_hub_rank();
CREATE TRIGGER plank_hub_rank_insert AFTER INSERT ON plank_multichain_snapshots
REFERENCING NEW TABLE AS rank_changed FOR EACH STATEMENT EXECUTE FUNCTION plank_sync_hub_rank();
CREATE TRIGGER plank_hub_rank_update AFTER UPDATE ON plank_multichain_snapshots
REFERENCING NEW TABLE AS rank_changed FOR EACH STATEMENT EXECUTE FUNCTION plank_sync_hub_rank();
CREATE TRIGGER plank_hub_rank_delete AFTER DELETE ON plank_multichain_snapshots
REFERENCING OLD TABLE AS rank_changed FOR EACH STATEMENT EXECUTE FUNCTION plank_sync_hub_rank();

-- Recover collections missed since migration 107. Existing rank rows stay intact.
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
WHERE NOT EXISTS (SELECT 1 FROM plank_market_hub_rank r WHERE r.collection_id = c.id)
ON CONFLICT (collection_id) DO NOTHING;
