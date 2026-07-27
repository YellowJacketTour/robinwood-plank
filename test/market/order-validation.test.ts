import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OrderValidationError,
  validateListingOrder,
  validateOfferOrder,
} from "../../lib/market/order-validation";
import type { MarketCollection } from "../../lib/market/types";

/**
 * Regression tests for the 2026-07-27 audit's most serious web-layer finding:
 * the order relay trusted client-supplied price/token/maker and never checked
 * them against the signed order, so a listing could display one price while
 * the wallet was asked to sign a different one.
 *
 * Run with: npm run test:market
 */

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

const paidCollection: MarketCollection = { ...freeCollection, slug: "other", feeBps: 50 };

const futureEnd = Math.floor(Date.now() / 1000) + 86_400;

function listing(overrides: Record<string, unknown> = {}) {
  return {
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
      endTime: String(futureEnd),
      ...overrides,
    },
    signature: "0xdeadbeef",
  };
}

test("derives price and token from the signed order, not any client claim", () => {
  const d = validateListingOrder(listing(), freeCollection);
  assert.equal(d.priceWei, "1000000000000000000");
  assert.equal(d.tokenId, "1106");
  assert.equal(d.maker, SELLER);
});

test("THE ATTACK: a hidden extra payment is counted in the displayed price", () => {
  // Attacker signs an order that pays them 99 ETH on top of a 1 ETH headline
  // price. Pre-fix the card showed the client-claimed 1 ETH; the wallet was
  // asked for 100 ETH. Now the derived price is the true total.
  const malicious = listing();
  malicious.parameters.consideration.push({
    itemType: 0,
    token: NATIVE,
    identifierOrCriteria: "0",
    startAmount: "99000000000000000000",
    endAmount: "99000000000000000000",
    recipient: ATTACKER,
  });

  const d = validateListingOrder(malicious, freeCollection);
  assert.equal(d.priceWei, "100000000000000000000", "must surface the real 100 ETH total");
});

test("rejects an order for a contract other than the collection it claims", () => {
  const wrong = listing();
  wrong.parameters.offer[0].token = "0x9999999999999999999999999999999999999999";
  assert.throws(() => validateListingOrder(wrong, freeCollection), OrderValidationError);
});

test("rejects an escalating price masquerading as a fixed one", () => {
  const dutch = listing();
  dutch.parameters.consideration[0].endAmount = "5000000000000000000";
  assert.throws(() => validateListingOrder(dutch, freeCollection), OrderValidationError);
});

test("rejects a listing priced in a token instead of ETH", () => {
  const erc20 = listing();
  erc20.parameters.consideration[0].itemType = 1;
  erc20.parameters.consideration[0].token = WETH;
  assert.throws(() => validateListingOrder(erc20, freeCollection), OrderValidationError);
});

test("rejects an order with no signature", () => {
  const unsigned = listing() as Record<string, unknown>;
  unsigned.signature = "";
  assert.throws(() => validateListingOrder(unsigned, freeCollection), OrderValidationError);
});

test("rejects a listing that strips the marketplace fee", () => {
  // Fee-bearing collection, but the order pays the treasury nothing.
  assert.throws(() => validateListingOrder(listing(), paidCollection), OrderValidationError);
});

test("accepts a listing that pays the fee correctly", () => {
  const withFee = listing();
  // 0.5% of the 1 ETH total goes to the treasury.
  withFee.parameters.consideration[0].startAmount = "995000000000000000";
  withFee.parameters.consideration[0].endAmount = "995000000000000000";
  withFee.parameters.consideration.push({
    itemType: 0,
    token: NATIVE,
    identifierOrCriteria: "0",
    startAmount: "5000000000000000",
    endAmount: "5000000000000000",
    recipient: TREASURY,
  });
  const d = validateListingOrder(withFee, paidCollection);
  assert.equal(d.priceWei, "1000000000000000000");
});

test("rejects a bid denominated in native ETH (Seaport can never fill it)", () => {
  const nativeBid = {
    parameters: {
      offerer: ATTACKER,
      offer: [
        {
          itemType: 0,
          token: NATIVE,
          identifierOrCriteria: "0",
          startAmount: "1000000000000000000",
          endAmount: "1000000000000000000",
        },
      ],
      consideration: [
        {
          itemType: 2,
          token: NFT,
          identifierOrCriteria: "1106",
          startAmount: "1",
          endAmount: "1",
          recipient: ATTACKER,
        },
      ],
      startTime: "0",
      endTime: String(futureEnd),
    },
    signature: "0xdeadbeef",
  };
  assert.throws(() => validateOfferOrder(nativeBid, freeCollection, WETH), OrderValidationError);
});

test("accepts a WETH collection-wide bid and derives its amount", () => {
  const bid = {
    parameters: {
      offerer: ATTACKER,
      offer: [
        {
          itemType: 1,
          token: WETH,
          identifierOrCriteria: "0",
          startAmount: "2000000000000000000",
          endAmount: "2000000000000000000",
        },
      ],
      consideration: [
        {
          itemType: 4, // ERC721_WITH_CRITERIA — any token in the collection
          token: NFT,
          identifierOrCriteria: "0",
          startAmount: "1",
          endAmount: "1",
          recipient: ATTACKER,
        },
      ],
      startTime: "0",
      endTime: String(futureEnd),
    },
    signature: "0xdeadbeef",
  };
  const d = validateOfferOrder(bid, freeCollection, WETH);
  assert.equal(d.priceWei, "2000000000000000000");
  assert.equal(d.tokenId, undefined, "collection-wide bid has no single token id");
});

test("rejects a bid that would deliver the NFT to someone other than the bidder", () => {
  const rerouted = {
    parameters: {
      offerer: ATTACKER,
      offer: [
        {
          itemType: 1,
          token: WETH,
          identifierOrCriteria: "0",
          startAmount: "1000000000000000000",
          endAmount: "1000000000000000000",
        },
      ],
      consideration: [
        {
          itemType: 2,
          token: NFT,
          identifierOrCriteria: "1106",
          startAmount: "1",
          endAmount: "1",
          recipient: SELLER, // not the bidder
        },
      ],
      startTime: "0",
      endTime: String(futureEnd),
    },
    signature: "0xdeadbeef",
  };
  assert.throws(() => validateOfferOrder(rerouted, freeCollection, WETH), OrderValidationError);
});
