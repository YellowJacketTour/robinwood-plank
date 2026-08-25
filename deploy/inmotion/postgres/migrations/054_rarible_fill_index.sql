-- Self-hosted, on-chain Rarible ExchangeV2 matchOrders fill index -- same
-- rationale as 023_seaport_fill_index.sql, applied to the venue this app's
-- own venue-registry.ts previously recorded as CONFIRMED BLOCKED / planned.
--
-- ADDRESS / EVENT / FUNCTION SOURCE (cited, not guessed)
-- -------------------------------------------------------------------
-- ExchangeV2 0x9757F2d2b135150BBeb65308D4a91804107cd8D6 (eth-mainnet), same
-- address already cited in venue-registry.ts, Rarible's own
-- docs.rarible.org/reference/contract-addresses. `event Match(bytes32
-- leftHash, bytes32 rightHash, uint newLeftFill, uint newRightFill)` copied
-- verbatim from https://github.com/rarible/protocol-contracts,
-- projects/exchange-v2/contracts/ExchangeV2Core.sol -- confirmed genuinely
-- near-parameterless (no NFT/price/party fields). Real data recovered from
-- the SAME transaction's own `matchOrders(...)` calldata instead -- see
-- rarible-fill-indexer.ts's own header for the full ABI-decode technique,
-- cross-checked against TransferExecutor.sol's real asset-data encoding.
--
-- HONEST NULLS
-- -------------------------------------------------------------------
-- nft_contract/token_id are NULL when the NFT-side order's asset class was
-- neither ERC721 nor ERC1155 (Rarible also defines COLLECTION and
-- CRYPTO_PUNKS asset classes whose real data encoding was not independently
-- verified this pass -- undecoded_asset_class records which one, honestly,
-- rather than guessing the layout). currency_token NULL means ETH-
-- denominated (a real, correct value, not a gap) rather than ERC20.
--
-- Additive only; a build that has never heard of this table never queries it.

CREATE TABLE IF NOT EXISTS plank_rarible_fills (
  id                    BIGSERIAL PRIMARY KEY,

  chain_slug            TEXT NOT NULL,
  tx_hash               TEXT NOT NULL,
  log_index             INTEGER NOT NULL,
  block_number          BIGINT NOT NULL,
  block_timestamp       TIMESTAMPTZ,

  left_hash             TEXT NOT NULL,
  right_hash            TEXT NOT NULL,

  seller                TEXT NOT NULL,
  buyer                 TEXT NOT NULL,

  nft_contract          TEXT,
  token_id              NUMERIC(78, 0),
  nft_amount            NUMERIC(78, 0) NOT NULL,

  -- NULL currency_token = real ETH-denominated match (not a gap). Non-null =
  -- the real ERC20 contract address decoded from the buyer order's own
  -- makeAsset.data.
  currency_token        TEXT,
  price_wei             NUMERIC(78, 0),

  -- Set (to the real bytes4 asset-class selector observed) only when the
  -- NFT-side asset class was neither ERC721 nor ERC1155 -- see header.
  undecoded_asset_class  TEXT,

  indexed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plank_rarible_fills_unique UNIQUE (chain_slug, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS plank_rarible_fills_collection_idx
  ON plank_rarible_fills (chain_slug, nft_contract, block_number DESC);

CREATE INDEX IF NOT EXISTS plank_rarible_fills_block_idx
  ON plank_rarible_fills (chain_slug, block_number DESC);

-- Same shape/reasoning as every other venue's own cursor table -- separate
-- key space, watches its own address+topic pair.
CREATE TABLE IF NOT EXISTS plank_rarible_fill_cursor (
  cursor_key         TEXT PRIMARY KEY,
  last_indexed_block BIGINT NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
