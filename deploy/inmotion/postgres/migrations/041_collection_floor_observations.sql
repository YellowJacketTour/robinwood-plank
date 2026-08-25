-- Append-only executable floor observations. A 24h floor change is only
-- defensible when both endpoints are observed; sales activity alone does not
-- prove that the cheapest executable listing moved.

CREATE TABLE IF NOT EXISTS plank_collection_floor_observations (
  id BIGSERIAL PRIMARY KEY,
  collection_id BIGINT NOT NULL REFERENCES plank_multichain_collections(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  price_atomic NUMERIC(78, 0) NOT NULL CHECK (price_atomic > 0),
  currency TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  listed_count INTEGER CHECK (listed_count IS NULL OR listed_count >= 0),
  source TEXT NOT NULL,
  observation_bucket TIMESTAMPTZ NOT NULL DEFAULT date_trunc('minute', NOW()),
  UNIQUE (collection_id, marketplace, observation_bucket)
);

CREATE INDEX IF NOT EXISTS plank_floor_observations_collection_time_idx
  ON plank_collection_floor_observations (collection_id, observed_at DESC);
