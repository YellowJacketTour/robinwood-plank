import assert from "node:assert/strict";
import test from "node:test";
import { buyForeignListingNow } from "../../lib/market/multichain/trading/foreign-fulfill";
import { isCrossChainBuyable, VENUE_LABELS, venueLabel } from "../../lib/market/types";
import {
  SOLANA_CHAIN_SLUG,
  BITCOIN_CHAIN_SLUG,
  isSolanaChainSlug,
  isBitcoinChainSlug,
  isNonEvmChainSlug,
} from "../../lib/market/multichain/trading/non-evm-chains";
import { satsToPriceWei, fetchUniSatListings } from "../../lib/market/multichain/trading/solana-bitcoin-listings";

// These exercise the real, unmocked non-EVM (Solana/Bitcoin) additions:
// chainSlug identity, the fail-closed guards buyForeignListingNow's new
// branches run BEFORE ever touching a wallet or network, isCrossChainBuyable
// widening to the two new venues, and the UniSat price-scaling helper. None
// of this needs a browser wallet or a live network call to be real and
// unmocked -- these are the same kind of "guard executes before any
// side-effecting call" properties multichain-robinhood-branch.test.ts and
// multichain-accept-offer-and-wallet-summary.test.ts already prove for the
// Robinhood-Chain branches.

test("SOLANA_CHAIN_SLUG/BITCOIN_CHAIN_SLUG match the real chainSlug values this app actually stores -- not invented strings", () => {
  // Confirmed by reading scripts/seed-multichain-collections.ts and
  // scripts/discover-multichain-collections.ts directly: both write
  // chainSlug: "solana-mainnet" for every Solana row in
  // plank_multichain_collections, the exact value
  // app/api/market/multichain/route.ts passes straight through to
  // GlobalMarketHub.tsx's card links (`/market/multichain/${c.chainSlug}/...`).
  // A prior pass here used bare "solana" (a stale sort-order-array literal,
  // not the real per-row value) -- every real Solana card's link would
  // never have matched this file's branches at all.
  assert.equal(SOLANA_CHAIN_SLUG, "solana-mainnet");
  // No prior art for Bitcoin anywhere in this codebase -- "bitcoin-mainnet"
  // matches the "-mainnet" suffix convention every other real chainSlug
  // uses (eth-mainnet, avax-mainnet, solana-mainnet, ...).
  assert.equal(BITCOIN_CHAIN_SLUG, "bitcoin-mainnet");
});

test("isSolanaChainSlug/isBitcoinChainSlug/isNonEvmChainSlug classify correctly and don't cross-match", () => {
  assert.equal(isSolanaChainSlug("solana-mainnet"), true);
  assert.equal(isSolanaChainSlug("bitcoin-mainnet"), false);
  assert.equal(isSolanaChainSlug("eth-mainnet"), false);
  assert.equal(isBitcoinChainSlug("bitcoin-mainnet"), true);
  assert.equal(isBitcoinChainSlug("solana-mainnet"), false);
  assert.equal(isNonEvmChainSlug("solana-mainnet"), true);
  assert.equal(isNonEvmChainSlug("bitcoin-mainnet"), true);
  assert.equal(isNonEvmChainSlug("eth-mainnet"), false);
  assert.equal(isNonEvmChainSlug("robinhood"), false);
});

test("buyForeignListingNow rejects a Solana purchase with no priceWei before touching Phantom or the network", async () => {
  await assert.rejects(
    () => buyForeignListingNow({ chainSlug: "solana-mainnet", orderHash: "3KMHzE4AYcEwbp3isTT3cV5rycH7XH8MjHAWrTKosBcS" }),
    /priceWei is required for a Solana purchase/
  );
});

test("buyForeignListingNow rejects a Bitcoin purchase with no priceWei before touching UniSat or the network", async () => {
  await assert.rejects(
    () => buyForeignListingNow({ chainSlug: "bitcoin-mainnet", orderHash: "abc123i0" }),
    /priceWei is required for a Bitcoin purchase/
  );
});

test("isCrossChainBuyable treats magiceden/unisat venues the same as opensea for Buy-affordance purposes", () => {
  assert.equal(
    isCrossChainBuyable({ venue: "magiceden", foreignChainSlug: "solana-mainnet", foreignOrderHash: "mint123" }),
    true
  );
  assert.equal(
    isCrossChainBuyable({ venue: "unisat", foreignChainSlug: "bitcoin-mainnet", foreignOrderHash: "insc123i0" }),
    true
  );
  // Missing the order hash (not yet a re-fetchable listing) still fails closed.
  assert.equal(isCrossChainBuyable({ venue: "magiceden", foreignChainSlug: "solana-mainnet" }), false);
});

test("VENUE_LABELS/venueLabel cover the two new venues with real display names", () => {
  assert.equal(VENUE_LABELS.magiceden, "Magic Eden");
  assert.equal(VENUE_LABELS.unisat, "UniSat");
  assert.equal(venueLabel({ venue: "magiceden" }), "Magic Eden");
  assert.equal(venueLabel({ venue: "unisat" }), "UniSat");
});

test("satsToPriceWei scales satoshis to the same 18-decimal-equivalent convention every other chain's priceWei uses, and is the exact inverse of foreign-fulfill.ts's unscale step", () => {
  // 1 BTC = 100_000_000 sats -- scaled by 1e10 lands on 1e18, matching a
  // "1.0" whole-unit magnitude the same way 1 ETH (1e18 wei) or 1 SOL
  // (1e9 lamports * 1e9) already do for their own chains.
  assert.equal(satsToPriceWei(100_000_000), (BigInt(100_000_000) * BigInt(10_000_000_000)).toString());
  // Round-trips through foreign-fulfill.ts's own `sats = priceWei / 1e10n` unscale expression.
  const priceWei = satsToPriceWei(54_321);
  const recoveredSats = BigInt(priceWei) / BigInt(10_000_000_000);
  assert.equal(recoveredSats.toString(), "54321");
});

test("fetchUniSatListings fails closed with a clear, actionable error when UNISAT_API_KEY is unset -- never silently returns fabricated rows", async () => {
  const original = process.env.UNISAT_API_KEY;
  delete process.env.UNISAT_API_KEY;
  try {
    await assert.rejects(() => fetchUniSatListings("some-collection", 5), /UNISAT_API_KEY is not configured/);
  } finally {
    if (original !== undefined) process.env.UNISAT_API_KEY = original;
  }
});

// Real, unmocked, LIVE network test -- skipped (not failed) when
// UNISAT_API_KEY isn't in this process's environment, since `tsx --test`
// does not auto-load .env.local the way Next's own dev/build does (unlike
// a plain `npm run test:market` invocation, running with the key exported
// first -- e.g. `set -a && source <(grep UNISAT_API_KEY .env.local) && set
// -a && npm run test:market` -- exercises this for real). This is the
// regression test for a REAL bug found and fixed 2026-08-19: the request
// body this function sent (`{collectionId, limit, offset}`, flat) was
// silently wrong against the live API -- it returns 200 with a body
// validation error, not a 401/403, so a key-is-present check alone would
// never have caught it. The live API's own error messages were used to
// discover the real current shape: `{start, limit, filter: {nftType:
// "collection", collectionId}, sort: {}}`.
test("fetchUniSatListings returns real, well-shaped listings against the live API when a real key is present", { skip: !process.env.UNISAT_API_KEY }, async () => {
  const listings = await fetchUniSatListings("bitcoin-frogs", 3);
  assert.ok(Array.isArray(listings));
  assert.ok(listings.length > 0, "expected at least one real active bitcoin-frogs listing");
  for (const l of listings) {
    assert.equal(typeof l.id, "string");
    assert.ok(l.id.length > 0);
    assert.equal(typeof l.priceWei, "string");
    assert.ok(BigInt(l.priceWei) > BigInt(0));
  }
});
