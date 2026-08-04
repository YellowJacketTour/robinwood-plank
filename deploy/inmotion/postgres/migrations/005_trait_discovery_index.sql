-- Cross-collection trait index + faceted-filter counts + OpenRarity-style
-- scores for the discovery/search surface (docs: feat/discovery-ux).
--
-- Additive only, compatible with the immediately previous release: nothing
-- here touches or replaces an existing table, so an app build that has never
-- heard of these tables simply never queries them.
--
-- Trait taxonomy is NOT assumed uniform across collections — every row is
-- scoped by `collection` (the market collection slug from
-- lib/market/collections.ts), so two collections may use completely
-- different trait_type sets independently. Everything is keyed off
-- (collection, trait_type, trait_value), never a global trait vocabulary.

-- One row per (collection, token, trait). This is the durable, queryable
-- twin of the in-memory TraitIndex built by lib/market/trait-index.ts — that
-- index stays the hot path for existing trait-bid/sweep flows; this table
-- exists so the discovery search API and the offline rarity batch job (see
-- scripts/compute-rarity.ts) can query/aggregate with SQL instead of holding
-- a full collection scan in a Worker isolate.
CREATE TABLE IF NOT EXISTS collection_token_traits (
  collection TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  trait_type TEXT NOT NULL,
  trait_value TEXT NOT NULL,
  display_type TEXT,
  PRIMARY KEY (collection, token_id, trait_type)
);

CREATE INDEX IF NOT EXISTS collection_token_traits_facet_idx
  ON collection_token_traits (collection, trait_type, trait_value);

CREATE INDEX IF NOT EXISTS collection_token_traits_token_idx
  ON collection_token_traits (collection, token_id);

-- Precomputed facet counts for the filter panel's default (unfiltered) view.
-- Live, filter-aware counts (the count reflecting the OTHER facets currently
-- selected) cannot be served from a static table — the discovery API
-- computes those directly against collection_token_traits, scoped by the
-- current selection. This table only serves the fast initial paint and any
-- caller that wants plain global counts without composing that query.
CREATE TABLE IF NOT EXISTS collection_trait_facet_counts (
  collection TEXT NOT NULL,
  trait_type TEXT NOT NULL,
  trait_value TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection, trait_type, trait_value)
);

-- OpenRarity-style (information-content) rarity scores, computed offline by
-- the batch job in scripts/compute-rarity.ts and read at request time —
-- never computed per API request. See lib/market/rarity-score.ts for the
-- scoring math (probability = count / total_tokens_in_collection,
-- information content = -log2(probability), token score = sum across the
-- token's traits).
CREATE TABLE IF NOT EXISTS collection_token_rarity (
  collection TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  rank INTEGER NOT NULL,
  trait_count INTEGER NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection, token_id)
);

CREATE INDEX IF NOT EXISTS collection_token_rarity_rank_idx
  ON collection_token_rarity (collection, rank);
