-- Finite development economy allocation, distinct from any on-chain currency.
-- Existing player balances are preserved and included in the opening supply.
-- Re-running this migration never refills the reserve.
CREATE TABLE IF NOT EXISTS charmville_grain_reserve (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  grain BIGINT NOT NULL CHECK (grain >= 0),
  opening_supply NUMERIC(30,0) NOT NULL CHECK (opening_supply >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (grain <= opening_supply)
);
INSERT INTO charmville_grain_reserve(id, grain, opening_supply)
SELECT 1, 1000000, 1000000 + COALESCE(SUM(grain), 0) FROM charmville_yards
ON CONFLICT (id) DO NOTHING;
