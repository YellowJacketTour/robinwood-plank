import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeCriteriaProof,
  computeCriteriaRoot,
  CriteriaError,
  normalizeTokenIds,
  verifyCriteriaProof,
} from "../../lib/market/criteria";
import {
  OrderValidationError,
  validateOfferOrder,
} from "../../lib/market/order-validation";
import { assertAcceptableTraitOffer } from "../../lib/market/seaport";
import { traitFloorWei } from "../../lib/market/traits";
import type { MarketCollection } from "../../lib/market/types";

/**
 * TRAIT-scoped criteria bids (2026-07-28).
 *
 * These tests cover the web-layer half; the definitive fulfillment proof —
 * a criteria bid actually filled against the REAL deployed Seaport 1.6
 * bytecode, plus its negative cases — is
 * test/contracts/SeaportCriteriaFulfill.test.ts (npm run test:contracts).
 *
 * The 2026-07-27 audit's A5 rule (an OPAQUE non-zero root must be rejected)
 * is deliberately untouched: audit-round3.test.ts still asserts it, and the
 * new acceptance path requires the server-verified snapshot to reproduce the
 * root exactly.
 */

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";
const BIDDER = "0x2222222222222222222222222222222222222222";

const collection: MarketCollection = {
  slug: "robinwood",
  name: "RobinWood",
  contractAddress: NFT,
  tokenStandard: "ERC721",
  image: "/x.png",
  trustBadges: [],
  feeBps: 0,
  royaltyBps: 0,
  royaltyRecipient: "0x0000000000000000000000000000000000000000",
};

const futureEnd = Math.floor(Date.now() / 1000) + 86_400;
const TRAIT_SET = ["3", "17", "42", "99", "256"];

function traitBid(root: string, offerAmount = "1000000000000000000") {
  return {
    parameters: {
      offerer: BIDDER,
      offer: [
        {
          itemType: 1,
          token: WETH,
          identifierOrCriteria: "0",
          startAmount: offerAmount,
          endAmount: offerAmount,
        },
      ],
      consideration: [
        {
          itemType: 4, // ERC721_WITH_CRITERIA
          token: NFT,
          identifierOrCriteria: root,
          startAmount: "1",
          endAmount: "1",
          recipient: BIDDER,
        },
      ],
      startTime: "0",
      endTime: String(futureEnd),
      totalOriginalConsiderationItems: 1,
    },
    signature: "0xdeadbeef",
  };
}

// ── Tree construction and cross-verification ────────────────────────────────

test("criteria root/proof round-trips against the independent on-chain-algorithm verifier", () => {
  const root = computeCriteriaRoot(TRAIT_SET);
  for (const id of TRAIT_SET) {
    const proof = computeCriteriaProof(TRAIT_SET, id);
    assert.equal(verifyCriteriaProof(root, id, proof), true, `member ${id} must verify`);
    assert.equal(verifyCriteriaProof(root, "7", proof), false, "non-member must not verify");
  }
});

test("normalizeTokenIds rejects junk and canonicalizes duplicates/ordering", () => {
  assert.throws(() => normalizeTokenIds([]), CriteriaError);
  assert.throws(() => normalizeTokenIds(["1", "abc"]), CriteriaError);
  assert.throws(() => normalizeTokenIds(["-1"]), CriteriaError);
  assert.throws(
    () => normalizeTokenIds(Array.from({ length: 4_001 }, (_, i) => String(i + 1))),
    CriteriaError
  );
  assert.deepEqual(normalizeTokenIds(["09", "2", "9", "10"]), ["2", "9", "10"]);
  // Canonicalization means root is order/duplication independent.
  assert.equal(
    computeCriteriaRoot(["42", "3", "3", "099"]),
    computeCriteriaRoot(["3", "42", "99"])
  );
});

test("computeCriteriaProof refuses a token outside the set", () => {
  assert.throws(() => computeCriteriaProof(TRAIT_SET, "7"), CriteriaError);
});

// ── Validator: the NEW narrow trait acceptance, old rejections intact ──────

test("TRAIT: a criteria bid whose root matches the verified snapshot validates and exposes criteriaRoot", () => {
  const root = computeCriteriaRoot(TRAIT_SET);
  const d = validateOfferOrder(traitBid(root), collection, WETH, {
    criteriaTokenIds: TRAIT_SET,
  });
  assert.equal(d.priceWei, "1000000000000000000");
  assert.equal(d.tokenId, undefined, "a trait bid names no single token");
  assert.equal(d.criteriaRoot, root);
});

test("TRAIT: seaport-js emits the root as hex — a decimal encoding of the same root also validates", () => {
  const root = computeCriteriaRoot(TRAIT_SET);
  const d = validateOfferOrder(traitBid(BigInt(root).toString()), collection, WETH, {
    criteriaTokenIds: TRAIT_SET,
  });
  assert.equal(d.criteriaRoot, root);
});

test("TRAIT: root committing to a DIFFERENT set than the snapshot is rejected", () => {
  const otherRoot = computeCriteriaRoot([...TRAIT_SET, "7"]);
  assert.throws(
    () => validateOfferOrder(traitBid(otherRoot), collection, WETH, { criteriaTokenIds: TRAIT_SET }),
    OrderValidationError
  );
});

test("TRAIT: a zero (wildcard) root under a trait snapshot is rejected — wildcard stays disabled", () => {
  assert.throws(
    () => validateOfferOrder(traitBid("0"), collection, WETH, { criteriaTokenIds: TRAIT_SET }),
    OrderValidationError
  );
});

test("TRAIT: a snapshot alongside a plain single-token (non-criteria) order is rejected", () => {
  const single = traitBid("1106");
  single.parameters.consideration[0].itemType = 2; // plain ERC721
  assert.throws(
    () => validateOfferOrder(single, collection, WETH, { criteriaTokenIds: TRAIT_SET }),
    OrderValidationError
  );
});

test("AUDIT A5 UNCHANGED: without a snapshot, any non-zero root is still rejected", () => {
  const root = computeCriteriaRoot(TRAIT_SET);
  // Even a root we COULD verify is rejected when no verified snapshot is
  // supplied — the collection-wide finding stays closed.
  assert.throws(() => validateOfferOrder(traitBid(root), collection, WETH), OrderValidationError);
});

// ── Accept path: proof handed to the wallet is cross-checked in-browser ────

test("assertAcceptableTraitOffer returns a resolver for an owned in-set token", () => {
  const root = computeCriteriaRoot(TRAIT_SET);
  const derived = validateOfferOrder(traitBid(root), collection, WETH, {
    criteriaTokenIds: TRAIT_SET,
  });
  const criteria = assertAcceptableTraitOffer(
    { priceWei: derived.priceWei, criteriaTokenIds: [...TRAIT_SET] },
    derived,
    "42"
  );
  assert.equal(criteria.identifier, "42");
  assert.equal(verifyCriteriaProof(root, "42", criteria.proof), true);
});

test("assertAcceptableTraitOffer fails closed on every mismatch", () => {
  const root = computeCriteriaRoot(TRAIT_SET);
  const derived = validateOfferOrder(traitBid(root), collection, WETH, {
    criteriaTokenIds: TRAIT_SET,
  });
  const offer = { priceWei: derived.priceWei, criteriaTokenIds: [...TRAIT_SET] };
  // Seller's token outside the committed set.
  assert.throws(() => assertAcceptableTraitOffer(offer, derived, "7"), /qualify/i);
  // Relay-shown price differs from the signature-derived one.
  assert.throws(
    () => assertAcceptableTraitOffer({ ...offer, priceWei: "1" }, derived, "42"),
    /price/i
  );
  // Relay-tampered snapshot no longer reproduces the signed root.
  assert.throws(
    () =>
      assertAcceptableTraitOffer(
        { ...offer, criteriaTokenIds: [...TRAIT_SET, "7"] },
        derived,
        "42"
      ),
    /snapshot/i
  );
  // Missing snapshot.
  assert.throws(
    () => assertAcceptableTraitOffer({ priceWei: derived.priceWei }, derived, "42"),
    /snapshot/i
  );
  // A non-trait derived order can never go through the trait accept path.
  assert.throws(
    () => assertAcceptableTraitOffer(offer, { ...derived, criteriaRoot: undefined }, "42"),
    /not a trait/i
  );
});

// ── Floor by trait ──────────────────────────────────────────────────────────

test("traitFloorWei picks the cheapest live listing within the trait set only", () => {
  const listings = [
    { tokenId: "42", priceWei: "3000000000000000000" },
    { tokenId: "99", priceWei: "2000000000000000000" },
    { tokenId: "7", priceWei: "1000000000000000000" }, // cheapest, but outside the trait
  ];
  assert.equal(traitFloorWei(listings, TRAIT_SET), "2000000000000000000");
  assert.equal(traitFloorWei(listings, ["500"]), null);
  assert.equal(traitFloorWei([], TRAIT_SET), null);
});
