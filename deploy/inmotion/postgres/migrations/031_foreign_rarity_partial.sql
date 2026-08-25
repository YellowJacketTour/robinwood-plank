-- Honesty flag for foreign rarity sample vs full supply.
ALTER TABLE plank_foreign_rarity_collections
  ADD COLUMN IF NOT EXISTS partial BOOLEAN NOT NULL DEFAULT FALSE;
