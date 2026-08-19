-- NFT-for-NFT / OTC swap listings -- roadmap item: "nft for nft trades...
-- maybe even otc nft and coin trades for any asset combination."
--
-- WHY A NEW TABLE, NOT market_orders OR market_bundle_listings
-- ---------------------------------------------------------------
-- A swap's shape is fundamentally different from either existing order
-- type: market_orders assumes ONE token id and ONE currency total;
-- market_bundle_listings assumes N tokens from a SINGLE collection priced
-- in one native-ETH total. A swap's offer AND consideration sides can each
-- independently hold multiple NFTs from DIFFERENT contracts, plus an
-- optional native-ETH top-up on the CONSIDERATION side (paid by whoever
-- fulfills -- see lib/market/order-validation.ts's validateSwapOrder for
-- why the OFFER side can never carry native ETH: Seaport itself has no
-- allowance mechanism for ETH, only for ERC-20/ERC-721). Forcing this
-- shape into either existing table's columns would either lose data or
-- require a JSONB escape hatch that defeats the point of a typed table.
--
-- CROSS-CHAIN FROM DAY ONE
-- -------------------------
-- Unlike native listings/offers/bundles (which rolled out Robinhood-first
-- then per-foreign-chain), this feature ships already generalized -- the
-- schema and validator take chain_slug/chain_id as first-class from the
-- start, since the underlying Seaport mechanics (arbitrary offer/
-- consideration item combinations, proven live by OpenSea's own
-- discontinued "Deals" feature) are already proven identical on every
-- chain this app trades on (see foreign-chain-registry.ts).
--
-- Additive only; a build that has never heard of this table never queries it.

CREATE TABLE IF NOT EXISTS market_swap_listings (
  id              TEXT PRIMARY KEY,
  chain_slug      TEXT NOT NULL,
  chain_id        BIGINT NOT NULL,
  maker           VARCHAR(42) NOT NULL,

  -- Each item: {contractAddress, tokenId}. JSONB (not a join table) --
  -- read-mostly, always read as a whole array with the listing, never
  -- queried by individual item; a join table would only add write
  -- complexity for zero real query benefit here.
  offer_items          JSONB NOT NULL,
  consideration_items   JSONB NOT NULL,
  -- Paid by the fulfiller, not the maker -- see this file's header.
  consideration_native_wei NUMERIC(78, 0) NOT NULL DEFAULT 0,

  -- The real signed Seaport order -- same "store the whole thing, derive
  -- display fields from it at read time" pattern every other native order
  -- table in this app already uses (market_orders.raw_order,
  -- market_bundle_listings.payload).
  payload         JSONB NOT NULL,

  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_swap_listings_chain_idx
  ON market_swap_listings (chain_slug, expires_at);

CREATE INDEX IF NOT EXISTS market_swap_listings_maker_idx
  ON market_swap_listings (maker);
