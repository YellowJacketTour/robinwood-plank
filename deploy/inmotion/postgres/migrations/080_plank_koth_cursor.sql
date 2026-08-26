-- Season 2 $PLANK KOTH's own dedicated scan cursor -- previously
-- plank-koth-watch.ts borrowed readCursor/writeCursor from
-- lib/market/multichain/discovery/evm-log-scan.ts (against
-- plank_multichain_discovery_cursor), which works but transitively drags
-- the whole multichain module graph (store.ts, alchemy adapters,
-- control-plane, etc.) into anything that imports it -- real friction for
-- shipping the $PLANK KOTH backend anywhere the broader multichain system
-- isn't deployed. This is the same simple string-key -> integer-value
-- cursor shape, just in its own table with zero dependency on that system.
CREATE TABLE IF NOT EXISTS plank_koth_cursor (
  cursor_key TEXT PRIMARY KEY,
  cursor_value BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
