-- Real bug found live 2026-08-25: a max-observed-token-id-based known_supply
-- inference assumed dense, gap-free token ids -- false for a real collection
-- with genuinely un-minted ids in its range (confirmed live: OpenSea's own
-- API returns "not found" for a real Lil Pudgys id our inference assumed
-- existed). Once a real on-chain totalSupply() confirms the true count,
-- this flag stops the id-inference ratchet-up from immediately re-inflating
-- known_supply back past that authoritative value on the very next read.
ALTER TABLE collection_archival_stats
  ADD COLUMN IF NOT EXISTS known_supply_chain_confirmed BOOLEAN NOT NULL DEFAULT FALSE;
