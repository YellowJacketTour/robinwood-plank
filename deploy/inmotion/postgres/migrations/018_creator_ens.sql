-- Real ENS name for a collection's creator/owner wallet, "whenever
-- publicly known" -- resolved via a real reverse-lookup against Ethereum
-- mainnet (ENS itself is Ethereum-only by protocol, but resolves names
-- for wallets regardless of which chain the COLLECTION lives on, since
-- it's a lookup keyed purely by address). Confirmed live 2026-08-18 with
-- a real address (vitalik.eth resolved correctly via ethers'
-- provider.lookupAddress against a public mainnet RPC). Separate column
-- from creator_handle (that one holds a Twitter handle when present) so
-- the UI can distinguish and prefer the right label.
ALTER TABLE plank_multichain_collections ADD COLUMN IF NOT EXISTS creator_ens TEXT;
