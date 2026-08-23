-- A complete full-population rarity snapshot is terminal evidence that the
-- token projection was complete at that indexed boundary. Repair projections
-- that a later no-op membership visit incorrectly reopened as partial.

UPDATE plank_collection_token_projections p
SET partial = FALSE,
    expected_count = r.sample_size,
    projected_at = GREATEST(p.projected_at, r.indexed_at),
    provenance = ARRAY(SELECT DISTINCT unnest(p.provenance || ARRAY['complete-rarity-reconciliation']::text[]))
FROM plank_foreign_rarity_collections r
WHERE r.chain_slug = p.chain_slug
  AND lower(r.collection_slug) = lower(p.collection_slug)
  AND r.partial = FALSE
  AND p.projected_count = r.sample_size;
