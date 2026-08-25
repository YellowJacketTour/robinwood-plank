-- Pre-computed rarity for foreign (non-Robinhood-Chain) collections.
--
-- WHY THIS IS A BACKGROUND TABLE, NOT A LIVE COMPUTE
-- ----------------------------------------------------
-- lib/rarity.ts's information-content algorithm (the same one that powers
-- RobinWood's own rank/tier badges) needs EVERY token's traits to produce
-- a real rank -- GRiBBiTS alone is 4,500+ tokens. Fetching that per page
-- load would mean thousands of OpenSea calls per visitor; instead
-- scripts/index-foreign-rarity.ts paginates a collection ONCE, computes
-- the snapshot with lib/rarity-generic.ts (the same math, generalized
-- beyond RobinWood's fixed Base/Background/Holographic schema), and this
-- table is what a page load actually reads from -- same "precompute once,
-- read many times" shape as plank_multichain_snapshots.
--
-- COMPATIBILITY: purely additive. No existing table, route, or script
-- reads or writes these rows.

CREATE TABLE IF NOT EXISTS plank_foreign_rarity (
  chain_slug TEXT NOT NULL,
  collection_slug TEXT NOT NULL,
  token_id TEXT NOT NULL,

  name TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  rank INTEGER NOT NULL,
  percentile DOUBLE PRECISION NOT NULL,
  tier TEXT NOT NULL,

  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (chain_slug, collection_slug, token_id)
);

-- One row per indexed collection, so a "when was this last indexed / how
-- many tokens" summary doesn't require scanning plank_foreign_rarity.
--
-- trait_index (added alongside, not a separate migration -- both come from
-- the SAME scripts/index-foreign-rarity.ts pagination pass): the full
-- traitType -> value -> [tokenId] map, JSON-encoded. This is what powers
-- the trait-criteria bid builder (ForeignOfferForm, mirroring native's
-- OfferForm + trait-criteria.ts's resolveCriteriaTokenIds, which is pure
-- and chain-agnostic -- it just needs a real TraitMap to operate on). A
-- collection-wide criteria bid ("any Purple Frog") needs the EXACT token
-- id set at signing time so seaport-js can build its Merkle root over
-- that set, which is why this has to be the same real index rarity uses,
-- not a live per-request OpenSea call for a 4,000+ token collection.
CREATE TABLE IF NOT EXISTS plank_foreign_rarity_collections (
  chain_slug TEXT NOT NULL,
  collection_slug TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  trait_index JSONB,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (chain_slug, collection_slug)
);
