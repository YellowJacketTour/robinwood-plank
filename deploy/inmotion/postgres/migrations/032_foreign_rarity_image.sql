-- Per-token art captured during rarity indexing (OpenSea/ME/UniSat).
-- Browse used to return imageUrl:null whenever the rarity index existed,
-- which blanked Milady (and every other indexed collection) in the grid.
ALTER TABLE plank_foreign_rarity
  ADD COLUMN IF NOT EXISTS image_url TEXT;
