-- Hash-First Multi-Source Hydration Doctrine -- Grok findings, docs/
-- marketplank/GROK-FINDINGS-intelligence-agency-maximal-vision-2026-08-26.md.
-- Stores the on-chain pointer's content-addressed fingerprint per token so
-- a future re-verification pass (triggered by a real ERC-4906
-- MetadataUpdate event, see onchain-extensions.ts's scanMetadataUpdateLogs)
-- can skip the IPFS/Arweave body fetch entirely when the on-chain pointer
-- hasn't actually changed -- content-addressing means a matching
-- fingerprint proves the body is unchanged, no fetch needed.
ALTER TABLE plank_collection_tokens
  ADD COLUMN IF NOT EXISTS pointer_fp text,
  ADD COLUMN IF NOT EXISTS pointer_uri text;
