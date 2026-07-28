import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OrderValidationError,
  validateListingOrder,
  validateOfferOrder,
} from "../../lib/market/order-validation";
import type { MarketCollection } from "../../lib/market/types";

/** Hostile round-3 audit probes. Each test asserts the SAFE behaviour and is
 * expected to FAIL against the current validator. Nothing is fixed here. */

const TREASURY = "0xcdb7ca36d35fa16d15fda859a46f1d72d979e9d8";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const NATIVE = "0x0000000000000000000000000000000000000000";
const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";
const SELLER = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x2222222222222222222222222222222222222222";

const freeCollection: MarketCollection = {
  slug: "robinwood",
  name: "RobinWood",
  contractAddress: NFT,
  tokenStandard: "ERC721",
  image: "/x.png",
  trustBadges: [],
  feeBps: 0,
};

const futureEnd = Math.floor(Date.now() / 1000) + 86_400;

function bid(consideration: unknown[], offerAmount = "1000000000000000000") {
  return {
    parameters: {
      offerer: ATTACKER,
      offer: [
        {
          itemType: 1,
          token: WETH,
          identifierOrCriteria: "0",
          startAmount: offerAmount,
          endAmount: offerAmount,
        },
      ],
      consideration,
      startTime: "0",
      endTime: String(futureEnd),
      totalOriginalConsiderationItems: consideration.length,
    },
    signature: "0xdeadbeef",
  };
}

const nftItem = (recipient = ATTACKER, id = "1106", amount = "1") => ({
  itemType: 2,
  token: NFT,
  identifierOrCriteria: id,
  startAmount: amount,
  endAmount: amount,
  recipient,
});

// A-1 — the clawback bid.
test("A1: bid that claws back 99% of its own headline amount must be rejected", () => {
  const malicious = bid([
    nftItem(),
    {
      itemType: 1,
      token: WETH,
      identifierOrCriteria: "0",
      startAmount: "990000000000000000",
      endAmount: "990000000000000000",
      recipient: ATTACKER, // NOT the treasury — a pure siphon
    },
  ]);
  assert.throws(() => validateOfferOrder(malicious, freeCollection, WETH), OrderValidationError);
});

// A-2 — the displayed number must be the seller's NET, not the gross.
// NOTE (fix, 2026-07-27): as originally written A2 reused A1's exact order and
// asserted it VALIDATES with a net price — but A1 (correctly) demands that
// same order be REJECTED, since any ERC-20 consideration routed to a non-
// treasury recipient is a clawback. Both cannot hold; we fail closed (A1
// wins). The net-price property A2 exists to prove is therefore asserted on
// the only legitimate deduction shape: a treasury fee item. The assertion is
// unchanged in spirit and strictly stronger than before (gross would be 1e18).
test("A2: derived priceWei must equal what the seller actually nets", () => {
  const withFee = bid([
    nftItem(),
    {
      itemType: 1,
      token: WETH,
      identifierOrCriteria: "0",
      startAmount: "5000000000000000", // 0.5% fee, deducted from the seller
      endAmount: "5000000000000000",
      recipient: TREASURY,
    },
  ]);
  const d = validateOfferOrder(withFee, { ...freeCollection, feeBps: 50 }, WETH);
  assert.equal(d.priceWei, "995000000000000000", `displayed ${d.priceWei} but seller nets 0.995e18`);
});

// A-3 — one payment, N planks.
test("A3: bid demanding TWO NFTs for one payment must be rejected", () => {
  const greedy = bid([nftItem(ATTACKER, "1106"), nftItem(ATTACKER, "1107")]);
  assert.throws(() => validateOfferOrder(greedy, freeCollection, WETH), OrderValidationError);
});

// A-4 — ERC721 amount must be exactly 1.
test("A4: bid whose NFT consideration amount is 5 must be rejected", () => {
  const bad = bid([nftItem(ATTACKER, "1106", "5")]);
  assert.throws(() => validateOfferOrder(bad, freeCollection, WETH), OrderValidationError);
});

// A-5 — criteria root shown as an unrestricted collection bid.
test("A5: criteria bid with a non-zero merkle root must not be shown as collection-wide", () => {
  const rooted = bid([
    {
      itemType: 4,
      token: NFT,
      identifierOrCriteria:
        "8888888888888888888888888888888888888888888888888888888888888888",
      startAmount: "1",
      endAmount: "1",
      recipient: ATTACKER,
    },
  ]);
  assert.throws(() => validateOfferOrder(rooted, freeCollection, WETH), OrderValidationError);
});

// A-6 — endTime overflow crashes with the wrong error class (500, not 400).
test("A6: absurd endTime must raise OrderValidationError, not a raw RangeError", () => {
  const l = {
    parameters: {
      offerer: SELLER,
      offer: [
        {
          itemType: 2,
          token: NFT,
          identifierOrCriteria: "1106",
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [
        {
          itemType: 0,
          token: NATIVE,
          identifierOrCriteria: "0",
          startAmount: "1000000000000000000",
          endAmount: "1000000000000000000",
          recipient: SELLER,
        },
      ],
      startTime: "0",
      endTime: "99999999999999999999",
    },
    signature: "0xdeadbeef",
  };
  assert.throws(() => validateListingOrder(l, freeCollection), OrderValidationError);
});

// A-7 — offerer casing is echoed verbatim into the stored/displayed record.
test("A7: derived maker should be normalised, not echoed in attacker casing", () => {
  const l = {
    parameters: {
      offerer: "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa",
      offer: [
        { itemType: 2, token: NFT, identifierOrCriteria: "1106", startAmount: "1", endAmount: "1" },
      ],
      consideration: [
        {
          itemType: 0,
          token: NATIVE,
          identifierOrCriteria: "0",
          startAmount: "1000000000000000000",
          endAmount: "1000000000000000000",
          recipient: SELLER,
        },
      ],
      startTime: "0",
      endTime: String(futureEnd),
    },
    signature: "0xdeadbeef",
  };
  const d = validateListingOrder(l, freeCollection);
  // NOTE (fix, 2026-07-27): the original assertion expected SELLER
  // (0x1111...), a DIFFERENT wallet from the order's offerer — no
  // normalisation can satisfy that, and silently rewriting the maker to
  // another address would itself be a bug. The property under test is
  // "normalised, not echoed": the maker must be the offerer, lowercased.
  assert.equal(
    d.maker,
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    `maker echoed as ${d.maker}`
  );
});

// A-8 — control: treasury fee item on a bid is legitimate and must still pass.
test("A8: control — a clean WETH bid with a treasury fee item still validates", () => {
  const clean = bid([
    nftItem(),
    {
      itemType: 1,
      token: WETH,
      identifierOrCriteria: "0",
      startAmount: "5000000000000000",
      endAmount: "5000000000000000",
      recipient: TREASURY,
    },
  ]);
  const d = validateOfferOrder(clean, { ...freeCollection, feeBps: 50 }, WETH);
  assert.equal(d.tokenId, "1106");
});
