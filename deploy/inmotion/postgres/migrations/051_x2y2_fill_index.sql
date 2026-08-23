-- Self-hosted, on-chain X2Y2 (X2Y2_r1) EvInventory fill index -- same
-- rationale as 023_seaport_fill_index.sql / 048_looksrare_fill_index.sql /
-- 049_wyvern_fill_index.sql / 050_blur_fill_index.sql, applied to the
-- fourth real historic marketplace this app had zero indexing for.
--
-- A PRIOR PASS DID NOT BUILD THIS -- WHY THIS PASS COULD
-- -------------------------------------------------------------------
-- The prior pass deferred X2Y2 because its real EvInventory event struct
-- (nested Order/Item/SettleDetail) could not be confirmed against a
-- genuinely published ABI/source, only pieced together from Etherscan log
-- snippets. This pass found and verified the real, authoritative,
-- Sourcify-"exact match" verified ABI for X2Y2_r1 directly
-- (https://sourcify.dev/server/v2/contract/1/
-- 0x6D7812d41A08BC2a910B562d8B56411964A4eD88), plus the real published
-- source at https://github.com/0xbe1/x2y2-contracts (X2Y2_r1.sol,
-- MarketConsts.sol, ERC721Delegate.sol) confirming both the exact
-- EvInventory field layout and how item.data decodes into a real NFT
-- contract/tokenId pair. See x2y2-fill-indexer.ts's own header for the
-- full event/struct text and decode citation.
--
-- ADDRESS SOURCE (cited, not guessed -- corrected after a live smoke test)
-- -------------------------------------------------------------------
-- Logs are scanned from 0x74312363e45DCaBA76c59ec49a7Aa8A65a67EeD3 (eth-
-- mainnet) -- the real, live-traffic X2Y2 Exchange PROXY, Sourcify "exact
-- match" verified, deployed block 14139341, Etherscan-labelled "X2Y2:
-- Exchange" with 901,846 real transactions. This is exactly the address
-- this task's own brief originally cited. The EvInventory event ABI itself
-- comes from the separate IMPLEMENTATION contract behind that proxy,
-- X2Y2_r1 at 0x6D7812d41A08BC2a910B562d8B56411964A4eD88 (also Sourcify
-- exact-match verified) -- delegatecall means the proxy is where real
-- events are emitted, but only the implementation's source defines the
-- event shape. A first attempt this pass scanned logs FROM the
-- implementation address by mistake and found near-zero real traffic (0
-- matching logs across a full year of blocks); the correct proxy address is
-- what plank_x2y2_fill_cursor/plank_x2y2_fills actually key off. See
-- x2y2-fill-indexer.ts's own header for the full account and the live
-- smoke-test evidence.
--
-- HONEST SCOPE, STATED NOT HIDDEN
-- -------------------------------------------------------------------
-- EvInventory's item.data bytes field is only decodable into a real NFT
-- contract/tokenId when delegateType corresponds to the real, published
-- ERC721Delegate (abi.decode(data, (Pair[])) where Pair = (IERC721 token,
-- uint256 tokenId)) -- confirmed straight from ERC721Delegate.sol. Only the
-- first Pair in that array is written as this row's nft_contract/token_id
-- (bundle fills with >1 pair are real but their extra legs are not
-- separately materialized here, same "first/primary leg" honesty stance
-- seaport-fill-indexer.ts documents for its own bundle case). Other
-- delegateType values (e.g. an ERC1155 delegate, if one is ever deployed
-- and used) are not decoded -- no ERC1155Delegate.sol source was found in
-- the verified repo, so nft_contract/token_id are left NULL for any
-- delegateType other than the confirmed ERC721 one rather than guessed.
--
-- SEPARATE TABLE, REUSES THE SHARED LOSSLESS LEG TABLES
-- -------------------------------------------------------------------
-- Same reasoning as the other three fill tables: plank_x2y2_fills is its
-- own summary table (X2Y2's EvInventory shape is unlike any other venue's
-- event), plank_market_event_assets / plank_market_event_payments
-- (migration 046) are reused as-is via venue_id = 'x2y2'.
--
-- Additive only; a build that has never heard of this table never queries it.

CREATE TABLE IF NOT EXISTS plank_x2y2_fills (
  id              BIGSERIAL PRIMARY KEY,

  chain_slug      TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  log_index       INTEGER NOT NULL,
  block_number    BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ,

  item_hash       TEXT NOT NULL,
  op              SMALLINT NOT NULL, -- Market.Op: 1=COMPLETE_SELL_OFFER, 2=COMPLETE_BUY_OFFER (only these two are real direct fills; others are auction/refund/cancel and are not written here)
  delegate_type   NUMERIC(78, 0) NOT NULL,

  seller          TEXT NOT NULL,
  buyer           TEXT NOT NULL,

  -- NULL when delegate_type isn't the confirmed ERC721Delegate (see header).
  nft_contract    TEXT,
  token_id        NUMERIC(78, 0),

  -- NULL currency_token means native ETH; X2Y2's own currency convention is
  -- the zero address for ETH-denominated orders, same normalization the
  -- other three fill tables already use.
  currency_token  TEXT,
  price_wei       NUMERIC(78, 0) NOT NULL,

  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plank_x2y2_fills_unique UNIQUE (chain_slug, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS plank_x2y2_fills_collection_idx
  ON plank_x2y2_fills (chain_slug, nft_contract, block_number DESC);

CREATE INDEX IF NOT EXISTS plank_x2y2_fills_block_idx
  ON plank_x2y2_fills (chain_slug, block_number DESC);

CREATE TABLE IF NOT EXISTS plank_x2y2_fill_cursor (
  cursor_key         TEXT PRIMARY KEY,
  last_indexed_block BIGINT NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
