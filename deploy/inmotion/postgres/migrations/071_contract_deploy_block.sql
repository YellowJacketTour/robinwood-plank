-- Real, immutable contract-deployment-block cache. A binary search over
-- eth_getCode is the only way to discover this (no vendor exposes it
-- directly for a free public RPC), and it's a real, one-time fact about
-- the contract -- never changes, so it's computed once and reused forever
-- as the anchor to seed a collection's own membership backfill exactly at
-- the block it could first possibly exist, instead of blindly walking a
-- global multi-million-block window that includes blocks the collection
-- provably could not have minted in.
CREATE TABLE IF NOT EXISTS plank_contract_deploy_block (
  chain_slug TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  deploy_block BIGINT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_slug, contract_address)
);
