-- Rarity and vault activity are last-known-good snapshots, not disposable
-- request caches. Their upstream rebuilds are expensive and rate-limited.
-- Existing Upstash-imported rows may still carry a source TTL, so make the
-- cutover durable as soon as this release is activated.
UPDATE plank_kv_values
   SET expires_at = NULL,
       updated_at = NOW()
 WHERE key_name IN (
   'plank:market:rarity-snapshot-v4',
   'plank:market:vault-activity-v3'
 );
