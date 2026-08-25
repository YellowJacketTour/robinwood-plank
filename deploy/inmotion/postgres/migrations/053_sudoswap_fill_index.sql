-- Self-hosted, on-chain Sudoswap v1 AMM-pool swap index -- same rationale as
-- 023_seaport_fill_index.sql, applied to the venue this app's own
-- venue-registry.ts previously recorded as CONFIRMED BLOCKED / planned.
--
-- SEPARATE TABLE, AMM-POOL SHAPED, NOT MAKER/TAKER
-- -------------------------------------------------------------------
-- Sudoswap v1 is a bonding-curve AMM: every trade is against a per-collection
-- pool contract, not a signed maker order matched by a taker, so this table's
-- shape is pool_address + direction (buy-from-pool / sell-to-pool) +
-- counterparty, not seller/buyer maker/taker columns that don't apply here.
-- Batched swaps (a real Sudoswap feature -- swapTokenForSpecificNFTs /
-- swapNFTsForToken both take a real `uint256[] nftIds`) are stored as a real
-- NUMERIC[] array rather than forcing one-id-per-row or truncating to the
-- first id.
--
-- ADDRESS / EVENT SOURCE (cited, not guessed)
-- -------------------------------------------------------------------
-- LSSVMPairFactory 0xb16c1342e617a5b6e4b631eb114483fdb289c0a4 (eth-mainnet),
-- same address already cited in venue-registry.ts, Etherscan-labeled
-- "Sudoswap: Pair Factory". SwapNFTInPair()/SwapNFTOutPair() event
-- signatures copied verbatim from sudoswap's own published source,
-- https://github.com/sudoswap/lssvm/blob/main/src/LSSVMPair.sol -- both are
-- REAL, VERIFIED, PARAMETERLESS. See sudoswap-fill-indexer.ts's own header
-- for the full receipt-log-correlation technique this table's rows are
-- built from (HyperSync JoinMode.JoinAll, not calldata decode, not a trace).
--
-- HONEST NULLS
-- -------------------------------------------------------------------
-- currency_token/price_wei are NULL for native-ETH-denominated pools -- the
-- real amount paid is only observable via internal/trace-level ETH transfer
-- visibility (LSSVMPair refunds excess ETH internally, an untracked
-- transfer), explicitly out of scope for this app's log-only architecture.
-- ERC20-denominated pools DO get a real, non-NULL price_wei (summed from the
-- real accompanying ERC20 Transfer log(s), excluding the real, separately-
-- identifiable protocol-fee leg paid to the factory address above).
--
-- Additive only; a build that has never heard of this table never queries it.

CREATE TABLE IF NOT EXISTS plank_sudoswap_fills (
  id              BIGSERIAL PRIMARY KEY,

  chain_slug      TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  log_index       INTEGER NOT NULL,
  block_number    BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ,

  pool_address    TEXT NOT NULL,
  event_name      TEXT NOT NULL CHECK (event_name IN ('SwapNFTInPair','SwapNFTOutPair')),
  direction       TEXT NOT NULL CHECK (direction IN ('buy-from-pool','sell-to-pool')),

  -- The real user address on the other side of the pool, recovered from the
  -- accompanying ERC721 Transfer log(s). NULL only if no NFT leg correlated
  -- (a row is never written in that case -- see writeSudoswapFills).
  counterparty    TEXT,

  nft_contract    TEXT,
  token_ids       NUMERIC(78, 0)[] NOT NULL DEFAULT '{}',

  -- NULL currency_token = native-ETH-denominated pool, price genuinely not
  -- recoverable from logs alone -- see header. Non-null = the real ERC20
  -- contract address observed moving in the correlated Transfer leg(s).
  currency_token  TEXT,
  price_wei       NUMERIC(78, 0),

  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plank_sudoswap_fills_unique UNIQUE (chain_slug, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS plank_sudoswap_fills_collection_idx
  ON plank_sudoswap_fills (chain_slug, nft_contract, block_number DESC);

CREATE INDEX IF NOT EXISTS plank_sudoswap_fills_pool_idx
  ON plank_sudoswap_fills (chain_slug, pool_address, block_number DESC);

CREATE INDEX IF NOT EXISTS plank_sudoswap_fills_block_idx
  ON plank_sudoswap_fills (chain_slug, block_number DESC);

-- Same shape/reasoning as every other venue's own cursor table -- separate
-- key space, watches a topic0-only (no address filter) log selection no
-- other cursor shares.
CREATE TABLE IF NOT EXISTS plank_sudoswap_fill_cursor (
  cursor_key         TEXT PRIMARY KEY,
  last_indexed_block BIGINT NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
