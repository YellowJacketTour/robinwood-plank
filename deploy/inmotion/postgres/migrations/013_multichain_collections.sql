-- Multi-chain NFT collection index -- current-state cache, not an event ledger.
--
-- WHY THIS IS A SEPARATE TABLE, NOT AN EXTENSION OF plank_chain_events
-- ----------------------------------------------------------------------
-- plank_chain_events is an append-only ledger of raw on-chain LOGS for one
-- collection on one chain (Robinhood Chain, 4663), built by directly reading
-- eth_getLogs and carrying hard-won per-log correctness rules (Seaport-fill
-- vs native-value pricing, mint exclusion, vault-mechanic classification --
-- see chain-indexer.ts). None of that generalizes to "any collection on any
-- chain": a Solana collection has no eth_getLogs, an Ethereum mainnet
-- collection's sale-price truth comes from a different marketplace contract
-- (or from a third-party API that already did this work), and this table is
-- deliberately NOT trying to re-derive raw settlement logic per chain.
--
-- Instead this is a periodically-refreshed CURRENT-STATE cache (floor price,
-- listing count, top listings) fed by external indexing APIs
-- (lib/market/multichain/*), upserted on a cron -- same "precompute once,
-- read many times from Postgres" shape as scripts/refresh-market-data.ts
-- already uses for the Robinhood-chain data, just without the append-only /
-- idempotent-log constraint that only makes sense for raw chain logs.
--
-- COMPATIBILITY
-- -------------
-- Purely additive. No existing table, route, or script reads or writes these.

-- One row per collection this app tracks outside Robinhood Chain (or
-- alongside it, for a chain this app also tracks natively -- the registry is
-- the single place that decides "is this a Plank collection or an indexed
-- one", which is exactly the plank-vs-non-plank distinction the UI needs to
-- enforce. is_vault_backed is what the UI checks before showing ANY
-- vault-style mechanic (burn-to-redeem, rake, progression) -- see
-- docs/marketplank/SPEC.md for why that must never be inferred from data
-- that came from an external API.
CREATE TABLE IF NOT EXISTS plank_multichain_collections (
  id BIGSERIAL PRIMARY KEY,

  -- Chain coordinates. chain_slug is the human-readable/adapter-routing key
  -- (e.g. "eth-mainnet", "polygon-mainnet", "solana-mainnet"); chain_id is
  -- the EVM numeric chainId where one exists (NULL for non-EVM chains).
  chain_slug TEXT NOT NULL,
  chain_id BIGINT,
  contract_address TEXT NOT NULL,

  -- Which adapter (lib/market/multichain/adapters/*) knows how to sync this
  -- row -- e.g. "alchemy-nft". Lets different chains use different backends
  -- without the sync job needing a hardcoded chain-to-adapter switch.
  adapter TEXT NOT NULL,

  name TEXT,
  image_url TEXT,
  external_url TEXT,

  -- The plank/non-plank line. FALSE for everything synced through this
  -- table today -- true vault backing is a deliberate, reviewed act (see
  -- MarketplankVaultV3.sol), never a side effect of adding a row here.
  is_vault_backed BOOLEAN NOT NULL DEFAULT FALSE,

  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plank_multichain_collections_unique UNIQUE (chain_slug, contract_address)
);

-- Current-state snapshot, one row per collection, overwritten on every sync
-- (not append-only -- this is "what's true right now", not a history).
CREATE TABLE IF NOT EXISTS plank_multichain_snapshots (
  collection_id BIGINT PRIMARY KEY REFERENCES plank_multichain_collections(id) ON DELETE CASCADE,

  floor_price_wei NUMERIC(78, 0),
  floor_price_currency TEXT,
  floor_price_marketplace TEXT,

  total_supply BIGINT,
  listed_count INTEGER,

  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when a sync attempt failed, so a stale snapshot is never confused
  -- with a confirmed-fresh one. NULL means the last attempt succeeded.
  sync_error TEXT
);

CREATE INDEX IF NOT EXISTS plank_multichain_snapshots_synced_idx
  ON plank_multichain_snapshots (synced_at DESC);
