-- EVM addresses are case-insensitive identities. Earlier projection writes
-- allowed checksum and lowercase spellings to become different primary keys,
-- double-counting tokens and splitting metadata/traits across two catalogs.
-- Merge every address-shaped key into lowercase before future writers (which
-- now canonicalize at the store boundary) continue indexing.

BEGIN;

INSERT INTO plank_collection_tokens (
  chain_slug, collection_slug, token_id, name, image_url, animation_url, media_type,
  traits, rarity_score, rarity_rank, rarity_percentile, rarity_tier, provenance,
  source_observed_at, projected_at, metadata_state, metadata_attempted_at, metadata_error)
SELECT chain_slug, lower(collection_slug), token_id, name, image_url, animation_url, media_type,
  traits, rarity_score, rarity_rank, rarity_percentile, rarity_tier, provenance,
  source_observed_at, projected_at, metadata_state, metadata_attempted_at, metadata_error
FROM plank_collection_tokens
WHERE collection_slug ~ '^0x[0-9A-Fa-f]{40}$' AND collection_slug <> lower(collection_slug)
ON CONFLICT (chain_slug, collection_slug, token_id) DO UPDATE SET
  name = COALESCE(EXCLUDED.name, plank_collection_tokens.name),
  image_url = COALESCE(EXCLUDED.image_url, plank_collection_tokens.image_url),
  animation_url = COALESCE(EXCLUDED.animation_url, plank_collection_tokens.animation_url),
  media_type = COALESCE(EXCLUDED.media_type, plank_collection_tokens.media_type),
  traits = CASE WHEN EXCLUDED.traits = '[]'::jsonb THEN plank_collection_tokens.traits ELSE EXCLUDED.traits END,
  rarity_score = COALESCE(EXCLUDED.rarity_score, plank_collection_tokens.rarity_score),
  rarity_rank = COALESCE(EXCLUDED.rarity_rank, plank_collection_tokens.rarity_rank),
  rarity_percentile = COALESCE(EXCLUDED.rarity_percentile, plank_collection_tokens.rarity_percentile),
  rarity_tier = COALESCE(EXCLUDED.rarity_tier, plank_collection_tokens.rarity_tier),
  provenance = ARRAY(SELECT DISTINCT unnest(plank_collection_tokens.provenance || EXCLUDED.provenance)),
  source_observed_at = GREATEST(plank_collection_tokens.source_observed_at, EXCLUDED.source_observed_at),
  projected_at = GREATEST(plank_collection_tokens.projected_at, EXCLUDED.projected_at),
  metadata_state = CASE
    WHEN plank_collection_tokens.metadata_state = 'complete' OR EXCLUDED.metadata_state = 'complete' THEN 'complete'
    WHEN plank_collection_tokens.metadata_state = 'empty' OR EXCLUDED.metadata_state = 'empty' THEN 'empty'
    ELSE plank_collection_tokens.metadata_state END,
  metadata_attempted_at = GREATEST(plank_collection_tokens.metadata_attempted_at, EXCLUDED.metadata_attempted_at),
  metadata_error = COALESCE(plank_collection_tokens.metadata_error, EXCLUDED.metadata_error);

DELETE FROM plank_collection_tokens
WHERE collection_slug ~ '^0x[0-9A-Fa-f]{40}$' AND collection_slug <> lower(collection_slug);

INSERT INTO plank_collection_membership_cursors (
  chain_slug, collection_slug, source, cursor, expected_count, observed_count,
  complete, last_error, source_observed_at, updated_at)
SELECT chain_slug, lower(collection_slug), source, cursor, expected_count, observed_count,
  complete, last_error, source_observed_at, updated_at
FROM plank_collection_membership_cursors
WHERE collection_slug ~ '^0x[0-9A-Fa-f]{40}$' AND collection_slug <> lower(collection_slug)
ON CONFLICT (chain_slug, collection_slug, source) DO UPDATE SET
  cursor = COALESCE(plank_collection_membership_cursors.cursor, EXCLUDED.cursor),
  expected_count = GREATEST(plank_collection_membership_cursors.expected_count, EXCLUDED.expected_count),
  observed_count = GREATEST(plank_collection_membership_cursors.observed_count, EXCLUDED.observed_count),
  complete = plank_collection_membership_cursors.complete OR EXCLUDED.complete,
  last_error = COALESCE(plank_collection_membership_cursors.last_error, EXCLUDED.last_error),
  source_observed_at = GREATEST(plank_collection_membership_cursors.source_observed_at, EXCLUDED.source_observed_at),
  updated_at = GREATEST(plank_collection_membership_cursors.updated_at, EXCLUDED.updated_at);

DELETE FROM plank_collection_membership_cursors
WHERE collection_slug ~ '^0x[0-9A-Fa-f]{40}$' AND collection_slug <> lower(collection_slug);

DELETE FROM plank_collection_token_projections
WHERE collection_slug ~ '^0x[0-9A-Fa-f]{40}$' AND collection_slug <> lower(collection_slug);

INSERT INTO plank_collection_token_projections (
  chain_slug, collection_slug, projected_count, expected_count, partial,
  provenance, source_observed_at, projected_at)
SELECT t.chain_slug, lower(t.collection_slug), COUNT(*)::integer,
  MAX(p.expected_count), BOOL_OR(p.partial),
  ARRAY['canonical-key-migration']::text[],
  MAX(COALESCE(p.source_observed_at, t.source_observed_at)), NOW()
FROM plank_collection_tokens t
LEFT JOIN plank_collection_token_projections p
  ON p.chain_slug=t.chain_slug AND lower(p.collection_slug)=lower(t.collection_slug)
WHERE t.collection_slug ~ '^0x[0-9A-Fa-f]{40}$'
GROUP BY t.chain_slug, lower(t.collection_slug)
ON CONFLICT (chain_slug, collection_slug) DO UPDATE SET
  projected_count=EXCLUDED.projected_count,
  expected_count=COALESCE(EXCLUDED.expected_count, plank_collection_token_projections.expected_count),
  partial=EXCLUDED.partial,
  provenance=EXCLUDED.provenance,
  source_observed_at=EXCLUDED.source_observed_at,
  projected_at=NOW();

COMMIT;
