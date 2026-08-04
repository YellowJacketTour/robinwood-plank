-- Vault-aware wallet portfolio PnL: persisted CohortPositions
-- (lib/market/portfolio-pnl.ts) plus the historical NAV snapshot series that
-- feeds deposit/redeem valuation (lib/market/portfolio-nav-history.ts).
--
-- Positions are recomputed from scratch each refresh-market-data run (the
-- underlying event history is small enough per cohort to replay) and
-- upserted here, so an API route / UI page reads a precomputed row instead
-- of re-scanning vault-activity + re-reducing on every request. This table
-- is a cache of a pure computation, not a source of truth — safe to
-- truncate and rebuild at any time.
--
-- Additive only, safe against the immediately previous release.

CREATE TABLE IF NOT EXISTS vault_nav_snapshots (
  vault_address       TEXT NOT NULL,
  block_number        BIGINT NOT NULL,
  nav_per_share_wei   TEXT NOT NULL, -- bigint as text: exceeds int8 range headroom-safe, matches wei convention used elsewhere in this codebase
  eth_reserve_wei     TEXT NOT NULL,
  total_supply_wei    TEXT NOT NULL,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vault_address, block_number)
);

CREATE INDEX IF NOT EXISTS vault_nav_snapshots_lookup_idx
  ON vault_nav_snapshots (vault_address, block_number DESC);

CREATE TABLE IF NOT EXISTS cohort_positions (
  wallet_address        TEXT NOT NULL,
  vault_address         TEXT NOT NULL,
  shares_held_wei       TEXT NOT NULL,
  cost_basis_wei        TEXT NOT NULL,
  realized_pnl_wei      TEXT NOT NULL,
  realized_proceeds_wei TEXT NOT NULL,
  realized_cost_wei     TEXT NOT NULL,
  fee_drag_wei          TEXT NOT NULL,
  unmatched_shares_wei  TEXT NOT NULL,
  unmatched_proceeds_wei TEXT NOT NULL,
  event_count           INTEGER NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wallet_address, vault_address)
);

CREATE INDEX IF NOT EXISTS cohort_positions_wallet_idx
  ON cohort_positions (wallet_address);
