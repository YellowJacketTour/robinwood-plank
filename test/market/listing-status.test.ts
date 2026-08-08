import assert from "node:assert/strict";
import test from "node:test";
import {
  isMarketplankRelistRequired,
  MARKETPLANK_RELIST_MESSAGE,
} from "../../lib/market/types";

test("requires relisting for a legacy Marketplank order", () => {
  assert.equal(
    isMarketplankRelistRequired({ venue: undefined, royaltyEnforced: false }),
    true
  );
});

test("does not apply the Marketplank relist state to OpenSea rows", () => {
  assert.equal(
    isMarketplankRelistRequired({ venue: "opensea", royaltyEnforced: false }),
    false
  );
});

test("leaves compliant Marketplank orders available", () => {
  assert.equal(
    isMarketplankRelistRequired({ venue: undefined, royaltyEnforced: true }),
    false
  );
});

test("keeps the buyer-facing explanation explicit", () => {
  assert.equal(
    MARKETPLANK_RELIST_MESSAGE,
    "This listing needs to be unlisted and relisted before it can be purchased on Marketplank."
  );
});
