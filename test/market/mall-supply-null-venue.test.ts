import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * The mall guard could not fire in the case it exists for.
 *
 * Shared-storefront contracts (Art Blocks, Manifold, Engine, shared-1155
 * factories) host many unrelated projects on ONE contract, so a chain
 * totalSupply() or a max-observed-token-id describes the whole mall rather
 * than the project. Measured on Friendship Bracelets:
 *
 *     venue project supply      38,965
 *     archive knownSupply    2,000,335   <- the shared core, 51x
 *     tokensEverHydrated        39,153   <- MORE than the project has
 *     displayed archive depth     1.96%
 *
 * The archive had already hydrated that project completely and reported 2%.
 *
 * PR #391/#393 added a ratio guard: refuse a chain supply more than
 * MALL_SUPPLY_RATIO times the venue's. But BOTH guard sites required the
 * venue supply to be non-null before they could fire:
 *
 *     projectSupply != null && ... && realSupply > projectSupply * RATIO
 *     inferred != null && venueSupplyForRatchet != null && ...
 *
 * So a collection with NO venue snapshot skipped the check entirely and had
 * the mall's number written -- in the first case as CHAIN-CONFIRMED, the
 * strongest claim in the schema, made from the weakest evidence.
 *
 * A shared core with no venue row is the likeliest mall of all: it is the
 * shape a factory contract has before any single project on it is indexed.
 */

const LEDGER = readFileSync("lib/market/multichain/archival-ledger.ts", "utf8").replace(
  /\r\n/g,
  "\n"
);

/** A named function's body, bounded by the next top-level declaration. */
function fn(name: string): string {
  const start = LEDGER.indexOf(`export async function ${name}`);
  assert.ok(start > 0, `${name} must exist`);
  const end = LEDGER.indexOf("\nexport ", start + 1);
  return LEDGER.slice(start, end > start ? end : undefined);
}

test("a chain supply with no venue cross-check is NOT chain-confirmed", () => {
  const body = fn("correctKnownSupplyFromChain");
  assert.match(body, /if \(!haveVenue\) return null;/,
    "no cross-check must mean no confirmation");
  // The old shape: the mall test gated behind a non-null venue supply.
  assert.ok(
    !/projectSupply != null &&\s*Number\.isFinite\(projectSupply\) &&\s*projectSupply > 0 &&\s*realSupply >/.test(
      body
    ),
    "the mall test must not be gated on having a venue supply"
  );
});

test("the max-id ratchet declines to move when it cannot be checked", () => {
  const body = fn("getArchivalStatsForCollection");
  assert.match(body, /inferenceIsUnverifiable/,
    "an unverifiable inference must be named, not silently treated as safe");
  assert.match(
    body,
    /!inferenceIsUnverifiable/,
    "and it must actually block the ratchet from writing"
  );
});

test("the ratio guard itself is unchanged", () => {
  // This work closes a hole in WHEN the guard runs. It must not weaken the
  // guard: a chain number well above the venue's is still a mall.
  assert.match(LEDGER, /MALL_SUPPLY_RATIO/, "the ratio must still exist");
  assert.match(
    fn("correctKnownSupplyFromChain"),
    /realSupply > projectSupply! \* MALL_SUPPLY_RATIO/,
    "the ratio test must still fire when the venue IS known"
  );
});

/**
 * The decision as a pure function, so the rule can be exercised directly
 * rather than only asserted as source text.
 */
function mayWriteChainSupply(
  realSupply: number,
  venueSupply: number | null,
  ratio: number
): boolean {
  const haveVenue = venueSupply != null && Number.isFinite(venueSupply) && venueSupply > 0;
  if (!haveVenue) return false;
  return !(realSupply > venueSupply! * ratio);
}

test("the Friendship Bracelets shape is refused", () => {
  // 2,000,335 against a venue supply of 38,965 is ~51x.
  assert.equal(mayWriteChainSupply(2_000_335, 38_965, 2), false);
});

test("an ordinary collection is still accepted", () => {
  // A normal contract reads its own supply; chain and venue agree closely.
  assert.equal(mayWriteChainSupply(10_000, 10_000, 2), true);
  // Small disagreements are normal (a venue lagging a few mints) and must
  // not be mistaken for a mall.
  assert.equal(mayWriteChainSupply(10_050, 10_000, 2), true);
});

test("no venue supply is refused, not waved through", () => {
  // The bug, as a value. Both a plausible number and an absurd one must be
  // refused when there is nothing to check them against.
  assert.equal(mayWriteChainSupply(2_000_335, null, 2), false, "the mall case");
  assert.equal(mayWriteChainSupply(10_000, null, 2), false, "and the innocent-looking one");
  assert.equal(mayWriteChainSupply(10_000, 0, 2), false, "a zero venue supply is not a check");
});
