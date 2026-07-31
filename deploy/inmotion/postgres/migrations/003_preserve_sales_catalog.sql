-- The royalty-aware sales catalog backs Highest sale, total volume, sale count
-- and /api/market/sales-history. It was written with a 7-day TTL while nothing
-- scheduled ever rebuilt it, and readSalesCatalog() had no rebuild-on-miss
-- branch, so a week after the last manual seed every sale surface rendered "—"
-- and stayed that way.
--
-- Same treatment as 002 gave the rarity and vault-activity snapshots: this is a
-- last-known-good snapshot, not a disposable request cache. Rows imported from
-- Upstash (or written by a previous release) may still carry the source TTL, so
-- clear it on activation.
UPDATE plank_kv_values
   SET expires_at = NULL,
       updated_at = NOW()
 WHERE key_name IN (
   'plank:market:sales-catalog-v2',
   'plank:market:sales-catalog-v1'
 );
