-- Bounded prefix search for the global collection-token projection. These
-- indexes keep piece search independent of total catalog size.
CREATE INDEX IF NOT EXISTS plank_collection_tokens_token_id_prefix_idx
  ON plank_collection_tokens (token_id text_pattern_ops);
CREATE INDEX IF NOT EXISTS plank_collection_tokens_name_prefix_idx
  ON plank_collection_tokens (lower(name) text_pattern_ops)
  WHERE name IS NOT NULL;
