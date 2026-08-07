import assert from "node:assert/strict";
import { test } from "node:test";
import { planSweep, assertSweepTotal, SWEEP_MAX } from "../../lib/market/sweep";
import type { MarketCollection, Listing } from "../../lib/market/types";

/**
 * "Sweep the floorboards" batch-buy planning — same security model as the
 * single-buy flow: every order re-derived from its signature in the buyer's
 * browser, forged/tampered orders dropped BEFORE the wallet prompt, and the
 * displayed total always the exact sum of what the signed orders charge.
 *
 * Run with: npm run test:market
 */

const NATIVE = "0x0000000000000000000000000000000000000000";
const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";
const SELLER = "0x1111111111111111111111111111111111111111";
const BUYER = "0x3333333333333333333333333333333333333333";

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

function rawOrder(tokenId: string, priceWei: string, seller = SELLER) {
  return {
    parameters: {
      offerer: seller,
      offer: [
        {
          itemType: 2,
          token: NFT,
          identifierOrCriteria: tokenId,
          startAmount: "1",
          endAmount: "1",
        },
      ],
      consideration: [
        {
          itemType: 0,
          token: NATIVE,
          identifierOrCriteria: "0",
          startAmount: priceWei,
          endAmount: priceWei,
          recipient: seller,
        },
      ],
      startTime: "0",
      endTime: String(futureEnd),
    },
    signature: "0xdeadbeef",
  };
}

let nextId = 0;
function makeListing(
  tokenId: string,
  priceWei: string,
  overrides: Partial<Listing & { rawOrder: unknown }> = {}
): Listing & { rawOrder: unknown } {
  return {
    id: `listing-${String(nextId++).padStart(4, "0")}`,
    collectionSlug: "robinwood",
    tokenId,
    maker: SELLER,
    priceWei,
    expiresAt: new Date(futureEnd * 1000).toISOString(),
    kind: "fixed",
    rawOrder: rawOrder(tokenId, priceWei),
    ...overrides,
  };
}

const ETH = (n: number) => (BigInt(n) * BigInt(10) ** BigInt(18)).toString();

test("aggregate total is the exact sum of the DERIVED prices of the cheapest N", () => {
  const listings = [
    makeListing("1", ETH(3)),
    makeListing("2", ETH(1)),
    makeListing("3", ETH(2)),
    makeListing("4", ETH(9)),
  ];
  const plan = planSweep(listings, 3, collection);
  assert.equal(plan.items.length, 3);
  assert.deepEqual(
    plan.items.map((i) => i.derived.tokenId),
    ["2", "3", "1"],
    "cheapest first, by derived price"
  );
  assert.equal(plan.totalWei, ETH(6));
  assert.equal(plan.droppedInvalid, 0);
});

test("cheapness is judged on the SIGNED order, not relay metadata", () => {
  // Relay claims 0.1 ETH but the signed order demands 100 ETH. It must sort
  // by the real 100 ETH price (and the total must reflect it) — the classic
  // show-one-price-charge-another attack, applied to sweep ordering.
  const liar = makeListing("7", "100000000000000000", {
    rawOrder: rawOrder("7", ETH(100)),
    priceWei: "100000000000000000", // relay's lie
  });
  const honest = makeListing("8", ETH(1));
  const plan = planSweep([liar, honest], 1, collection);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].derived.tokenId, "8", "the honest 1 ETH order is the floor");
  assert.equal(plan.totalWei, ETH(1));
});

test("a forged/tampered order in the batch is excluded and the total adjusts", () => {
  const good1 = makeListing("1", ETH(1));
  const good2 = makeListing("2", ETH(2));
  // Tampered: wrong contract inside the signed order.
  const forged = makeListing("3", "1", {
    rawOrder: (() => {
      const o = rawOrder("3", "1");
      o.parameters.offer[0].token = "0x9999999999999999999999999999999999999999";
      return o;
    })(),
  });
  // Mismatch: relay claims tokenId 4, signature covers tokenId 44.
  const mismatch = makeListing("4", ETH(1), { rawOrder: rawOrder("44", "1") });

  const plan = planSweep([forged, good1, mismatch, good2], 4, collection);
  assert.equal(plan.items.length, 2);
  assert.equal(plan.totalWei, ETH(3), "total is only the valid orders");
  assert.equal(plan.droppedInvalid, 2);
});

test("empty and all-invalid batches produce a clean empty plan (no zero-value tx)", () => {
  const empty = planSweep([], 5, collection);
  assert.equal(empty.items.length, 0);
  assert.equal(empty.totalWei, "0");

  const forged = makeListing("1", ETH(1), {
    rawOrder: { parameters: {}, signature: "" },
  });
  const allBad = planSweep([forged], 5, collection);
  assert.equal(allBad.items.length, 0);
  assert.equal(allBad.totalWei, "0");
  assert.equal(allBad.droppedInvalid, 1);

  // And the wallet gate refuses an empty sweep outright.
  assert.throws(() => assertSweepTotal([], "0", collection), /Nothing to sweep/);
});

test("caps at SWEEP_MAX and ignores nonsense counts", () => {
  const listings = Array.from({ length: SWEEP_MAX + 5 }, (_, i) =>
    makeListing(String(i + 1), ETH(1))
  );
  assert.equal(planSweep(listings, 999, collection).items.length, SWEEP_MAX);
  assert.equal(planSweep(listings, -3, collection).items.length, 0);
  assert.equal(planSweep(listings, 2.9, collection).items.length, 2);
});

test("dedupes by tokenId keeping the cheapest — two listings of one plank can't both fill", () => {
  const cheap = makeListing("5", ETH(1));
  const dear = makeListing("5", ETH(2));
  const other = makeListing("6", ETH(3));
  const plan = planSweep([dear, cheap, other], 3, collection);
  assert.equal(plan.items.length, 2);
  assert.equal(plan.totalWei, ETH(4), "1 + 3, not 1 + 2 + 3");
});

test("excludes the buyer's own listings", () => {
  const own = makeListing("9", ETH(1), {
    maker: BUYER,
    rawOrder: rawOrder("9", ETH(1), BUYER),
  });
  const other = makeListing("10", ETH(2));
  const plan = planSweep([own, other], 2, collection, BUYER.toUpperCase());
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].derived.tokenId, "10");
  assert.equal(plan.droppedInvalid, 0, "own listing is excluded, not invalid");
});

test("assertSweepTotal passes when nothing drifted", () => {
  const plan = planSweep([makeListing("1", ETH(1)), makeListing("2", ETH(2))], 2, collection);
  assertSweepTotal(plan.items, plan.totalWei, collection); // must not throw
});

test("FINAL GATE: an order swapped underneath the plan aborts at confirm — never re-prices silently", () => {
  const plan = planSweep([makeListing("1", ETH(1)), makeListing("2", ETH(2))], 2, collection);
  // Attacker (compromised relay refresh, upstream bug…) swaps a signed order
  // for a pricier one after the plan was shown.
  plan.items[1].listing.rawOrder = rawOrder("2", ETH(50));
  assert.throws(
    () => assertSweepTotal(plan.items, plan.totalWei, collection),
    /Sweep total changed/
  );
});

test("FINAL GATE: a tokenId mismatch injected post-plan aborts at confirm", () => {
  const plan = planSweep([makeListing("1", ETH(1))], 1, collection);
  plan.items[0].listing.rawOrder = rawOrder("999", ETH(1));
  assert.throws(
    () => assertSweepTotal(plan.items, plan.totalWei, collection),
    /doesn't match its signature/
  );
});

test("FINAL GATE: an order made invalid post-plan throws, not drops", () => {
  const plan = planSweep([makeListing("1", ETH(1))], 1, collection);
  plan.items[0].listing.rawOrder = { parameters: {}, signature: "" };
  assert.throws(() => assertSweepTotal(plan.items, plan.totalWei, collection));
});
