-- Real bug found live 2026-08-26 verifying ipfs-corroboration.ts: a
-- `pointer_fp LIKE 'ipfs:%'` scan against plank_collection_tokens's 558k+
-- rows with no supporting index caused a real statement timeout. This
-- index supports both this prefix search (text_pattern_ops for LIKE) and
-- the CID-skip gate's own equality lookups (rarity-index-runner.ts's bulk
-- pointer_fp read).
CREATE INDEX IF NOT EXISTS plank_collection_tokens_pointer_fp_idx
  ON plank_collection_tokens (chain_slug, pointer_fp text_pattern_ops)
  WHERE pointer_fp IS NOT NULL;
