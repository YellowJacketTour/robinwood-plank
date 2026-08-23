-- Durable, read-optimised token catalogs for multichain collection pages.
-- Public requests read this projection only; background indexers may merge
-- provider pages into it without making visitor traffic hit upstream APIs.

CREATE TABLE IF NOT EXISTS plank_collection_tokens (
  chain_slug TEXT NOT NULL,
  collection_slug TEXT NOT NULL,
  token_id TEXT NOT NULL,
  name TEXT,
  image_url TEXT,
  rarity_score DOUBLE PRECISION,
  rarity_rank INTEGER,
  rarity_percentile DOUBLE PRECISION,
  rarity_tier TEXT,
  provenance TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  source_observed_at TIMESTAMPTZ NOT NULL,
  projected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_slug, collection_slug, token_id)
);
CREATE INDEX IF NOT EXISTS plank_collection_tokens_browse_idx
  ON plank_collection_tokens (chain_slug, lower(collection_slug),
    (CASE WHEN token_id ~ '^[0-9]+$' THEN token_id::numeric END), token_id);
CREATE INDEX IF NOT EXISTS plank_collection_tokens_rank_idx
  ON plank_collection_tokens (chain_slug, lower(collection_slug), rarity_rank, token_id);

CREATE TABLE IF NOT EXISTS plank_collection_token_projections (
  chain_slug TEXT NOT NULL,
  collection_slug TEXT NOT NULL,
  projected_count INTEGER NOT NULL DEFAULT 0 CHECK (projected_count >= 0),
  expected_count INTEGER CHECK (expected_count IS NULL OR expected_count >= 0),
  partial BOOLEAN NOT NULL DEFAULT TRUE,
  provenance TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  source_observed_at TIMESTAMPTZ NOT NULL,
  projected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_slug, collection_slug)
);

-- Existing rarity catalogs become immediately readable through the projection.
INSERT INTO plank_collection_tokens (
  chain_slug, collection_slug, token_id, name, image_url, rarity_score,
  rarity_rank, rarity_percentile, rarity_tier, provenance, source_observed_at, projected_at)
SELECT r.chain_slug, r.collection_slug, r.token_id, NULLIF(r.name, ''), r.image_url,
  r.score, r.rank, r.percentile, r.tier, ARRAY['rarity-index']::TEXT[], r.indexed_at, NOW()
FROM plank_foreign_rarity r
ON CONFLICT (chain_slug, collection_slug, token_id) DO NOTHING;

INSERT INTO plank_collection_token_projections (
  chain_slug, collection_slug, projected_count, expected_count, partial,
  provenance, source_observed_at, projected_at)
SELECT c.chain_slug, c.collection_slug, COUNT(r.token_id)::INTEGER,
  CASE WHEN c.partial THEN NULL ELSE c.sample_size END,
  c.partial, ARRAY['rarity-index']::TEXT[], c.indexed_at, NOW()
FROM plank_foreign_rarity_collections c
LEFT JOIN plank_foreign_rarity r
  ON r.chain_slug = c.chain_slug AND r.collection_slug = c.collection_slug
GROUP BY c.chain_slug, c.collection_slug, c.sample_size, c.partial, c.indexed_at
ON CONFLICT (chain_slug, collection_slug) DO NOTHING;
