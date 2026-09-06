-- Unified edge (docs/marketplank/SPEC-UNIFIED-EDGE-AND-INTELLIGENCE-2026-09-05.md).
--
-- Two additive tables. Nothing before this migration reads either.
--
-- 1) plank_provider_ledger -- ONE ledger for every external call this app
--    makes (OpenSea, Magic Eden, Helius, UniSat, Ordiscan, CoinGecko,
--    Alchemy NFT, raw JSON-RPC, HyperSync ...). One row per
--    (source, key id, chain, minute), incremented with a single fast UPSERT
--    from an in-process buffer that flushes every few seconds -- never a
--    held transaction across a network fetch (PGPOOL_MAX=4, see
--    lib/market/multichain/singleflight-cache.ts). This is the cross-
--    process, cross-restart truth behind /api/market/rpc-usage; the older
--    lib/market/rpc-meter.ts stays as the per-process compute-unit view.
CREATE TABLE IF NOT EXISTS plank_provider_ledger (
  source          TEXT        NOT NULL,
  key_id          TEXT        NOT NULL DEFAULT '',
  chain_slug      TEXT        NOT NULL DEFAULT '',
  minute_start    TIMESTAMPTZ NOT NULL,
  calls           INTEGER     NOT NULL DEFAULT 0,
  ok              INTEGER     NOT NULL DEFAULT 0,
  errors          INTEGER     NOT NULL DEFAULT 0,
  rate_limited    INTEGER     NOT NULL DEFAULT 0,
  timeouts        INTEGER     NOT NULL DEFAULT 0,
  budget_refused  INTEGER     NOT NULL DEFAULT 0,
  cost_units      NUMERIC     NOT NULL DEFAULT 0,
  latency_sum_ms  BIGINT      NOT NULL DEFAULT 0,
  latency_max_ms  INTEGER     NOT NULL DEFAULT 0,
  last_error      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source, key_id, chain_slug, minute_start)
);

CREATE INDEX IF NOT EXISTS plank_provider_ledger_minute_idx
  ON plank_provider_ledger (minute_start DESC);

-- 2) plank_demand_intents -- the demand bus. Every viewport, hover, click,
--    search, wallet-connect and sweep intent lands here once per
--    (chain, subject, kind, client) so "how many distinct people are
--    watching this cell right now" is a real count, never a guess. The
--    mesh queue (plank_data_jobs) is still the only thing that does work;
--    this table only feeds the priority function in
--    lib/market/multichain/edge/demand-bus.ts.
CREATE TABLE IF NOT EXISTS plank_demand_intents (
  chain_slug          TEXT        NOT NULL,
  subject             TEXT        NOT NULL,
  kind                TEXT        NOT NULL,
  client_hash         TEXT        NOT NULL,
  money_at_stake_usd  NUMERIC     NOT NULL DEFAULT 0,
  hits                INTEGER     NOT NULL DEFAULT 1,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_slug, subject, kind, client_hash)
);

CREATE INDEX IF NOT EXISTS plank_demand_intents_subject_recent_idx
  ON plank_demand_intents (chain_slug, subject, last_seen_at DESC);
