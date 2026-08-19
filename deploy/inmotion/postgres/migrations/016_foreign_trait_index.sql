-- Adds the trait_index column to the already-applied
-- plank_foreign_rarity_collections table (014_foreign_rarity.sql ran
-- before this column existed) -- see that migration's updated header for
-- what this column is and why it lives here.
ALTER TABLE plank_foreign_rarity_collections ADD COLUMN IF NOT EXISTS trait_index JSONB;
