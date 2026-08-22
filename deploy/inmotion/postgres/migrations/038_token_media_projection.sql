-- Preserve the original motion asset separately from its poster image.
-- `image_url` remains the universally renderable fallback; animation is
-- opt-in on one focused surface so catalog grids stay bounded and smooth.
ALTER TABLE plank_collection_tokens
  ADD COLUMN IF NOT EXISTS animation_url TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT;

