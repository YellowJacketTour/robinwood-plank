import assert from "node:assert/strict";
import test from "node:test";
import { isSolanaChainSlug, isBitcoinChainSlug, isNonEvmChainSlug, SOLANA_CHAIN_SLUG, BITCOIN_CHAIN_SLUG } from "../../lib/market/multichain/trading/non-evm-chains";
import { isCrossChainBuyable, VENUE_LABELS } from "../../lib/market/types";

// Real, unmocked assertions on the chain-family recognition every new
// Solana/Bitcoin branch (listings/activity/owned/offers/my-listings routes,
// foreign-fulfill.ts's buyForeignListingNow, MultichainCollectionView.tsx's
// requireAccount) depends on -- fail-closed on any other chainSlug string,
// matching this codebase's existing "robinhood" branch-guard style.

test("isSolanaChainSlug matches only the real, DB-populated slug (see scripts/seed-multichain-collections.ts)", () => {
  assert.equal(isSolanaChainSlug(SOLANA_CHAIN_SLUG), true);
  assert.equal(isSolanaChainSlug("solana"), false); // the bare form is NOT what real rows carry -- must not silently match
  assert.equal(isSolanaChainSlug("eth-mainnet"), false);
  assert.equal(isSolanaChainSlug(""), false);
});

test("isBitcoinChainSlug matches only the real chosen slug", () => {
  assert.equal(isBitcoinChainSlug(BITCOIN_CHAIN_SLUG), true);
  assert.equal(isBitcoinChainSlug("bitcoin"), false);
  assert.equal(isBitcoinChainSlug("robinhood"), false);
});

test("isNonEvmChainSlug is true for exactly the two non-EVM chains and false for every EVM/robinhood chainSlug", () => {
  assert.equal(isNonEvmChainSlug(SOLANA_CHAIN_SLUG), true);
  assert.equal(isNonEvmChainSlug(BITCOIN_CHAIN_SLUG), true);
  assert.equal(isNonEvmChainSlug("robinhood"), false);
  assert.equal(isNonEvmChainSlug("eth-mainnet"), false);
  assert.equal(isNonEvmChainSlug("base-mainnet"), false);
});

// isCrossChainBuyable is the single gate ListingCard/openSweepPreview/etc
// use to decide whether a Buy affordance renders at all -- extending
// ListingVenue with "magiceden"/"unisat" is worthless if this function
// doesn't also recognize them, so this is the load-bearing assertion for
// the whole Solana/Bitcoin Buy button existing.

test("isCrossChainBuyable recognizes magiceden and unisat venues exactly like opensea, given foreignChainSlug+foreignOrderHash", () => {
  const base = { foreignChainSlug: SOLANA_CHAIN_SLUG, foreignOrderHash: "someTokenMintOrInscriptionId" };
  assert.equal(isCrossChainBuyable({ venue: "opensea", ...base }), true);
  assert.equal(isCrossChainBuyable({ venue: "magiceden", ...base }), true);
  assert.equal(isCrossChainBuyable({ venue: "unisat", ...base }), true);
});

test("isCrossChainBuyable still fails closed without both a chainSlug and an orderHash, for every venue including the two new ones", () => {
  assert.equal(isCrossChainBuyable({ venue: "magiceden", foreignChainSlug: SOLANA_CHAIN_SLUG, foreignOrderHash: undefined }), false);
  assert.equal(isCrossChainBuyable({ venue: "unisat", foreignChainSlug: undefined, foreignOrderHash: "abc123i0" }), false);
  assert.equal(isCrossChainBuyable({ venue: undefined, foreignChainSlug: SOLANA_CHAIN_SLUG, foreignOrderHash: "x" }), false);
});

test("VENUE_LABELS has a real, non-empty label for both new venues", () => {
  assert.equal(VENUE_LABELS.magiceden, "Magic Eden");
  assert.equal(VENUE_LABELS.unisat, "UniSat");
});
