-- Generalized cross-process provider call pacer (Unified Mesh Continuum
-- build, docs/marketplank/GROK-FINDINGS-unified-maximal-hydration-2026-08-26.md
-- item #1's mechanism). Same atomic-claim pattern already shipped for
-- OpenSea (opensea-key-pool.ts's claimOpenSeaPaceSlot, which stored its
-- slot in plank_kv_values) -- broken out into its own dedicated table now
-- that a second real caller (lib/market/multichain/discovery/provider-pace.ts)
-- exists, so a provider's pacing state is never accidentally aliased
-- against an unrelated plank_kv_values key.
CREATE TABLE IF NOT EXISTS provider_pace_state (
  pace_key text PRIMARY KEY,
  -- Epoch-ms of the next allowed call slot for this key. Always in the
  -- future relative to the claim that set it (see claimProviderPaceSlot's
  -- own header for why this is the whole mechanism).
  next_slot_at_ms bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
