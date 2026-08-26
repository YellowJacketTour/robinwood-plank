-- Real gap found live 2026-08-26 (HyperSync-primary hydration cutover, per
-- external Grok research review): the anchored-membership scan (and every
-- other membership source) treated "ever appeared in a Transfer log" as
-- permanent membership -- a burned token (transferred to the zero address)
-- stayed counted forever. Against an on-chain totalSupply()-style
-- denominator that also never counts burns back out, this made 100% an
-- unreachable target for any collection with real burns (confirmed live:
-- Decentraland Estates). Track burn state explicitly so "complete" can mean
-- "every currently-existing token accounted for," matching real on-chain
-- truth, not "every token ID that ever existed."
ALTER TABLE plank_collection_tokens
  ADD COLUMN IF NOT EXISTS is_burned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS plank_collection_tokens_burned_idx
  ON plank_collection_tokens (chain_slug, collection_slug)
  WHERE is_burned;
