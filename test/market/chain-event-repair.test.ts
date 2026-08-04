import assert from "node:assert/strict";
import test from "node:test";
import { orderFulfilledSettlement } from "../../lib/market/activity";
import { unpricedSaleBlockRanges } from "../../lib/market/chain-events";

const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
const SELLER = "0x9819bBB9c355Ab6F91304a1a54d301D72Ca31247";

const opts = { nftContract: NFT, currency: WETH };

/*
 * Every fixture below is a VERBATIM copy of a real OrderFulfilled event decoded
 * from this chain on 2026-08-04 while investigating why 131 of the ledger's 245
 * "sales" carried no price. Transaction hashes are quoted so any of them can be
 * re-pulled from Blockscout and checked.
 */

test("listing side: NFT in the offer, price is the consideration (tx 0xc00768b4…, token 431)", () => {
  const r = orderFulfilledSettlement(
    {
      offer: [{ itemType: 2, token: NFT, identifier: 431n, amount: 1n }],
      consideration: [
        { itemType: 1, token: WETH, identifier: 0n, amount: 2574000000000000n },
      ],
    },
    opts
  );
  assert.deepEqual(r.tokenIds, ["431"]);
  assert.equal(r.paidWei, 2574000000000000n);
});

test("BID side: NFT in the consideration, price is the offer (tx 0x56ea0b8f…, token 968)", () => {
  // The gap that made `fulfillAvailableAdvancedOrders` collection-bid fills
  // land in the ledger unpriced: the old decoder only ever read `offer` for the
  // NFT, so an accepted offer matched nothing and priced nothing.
  const r = orderFulfilledSettlement(
    {
      offer: [{ itemType: 1, token: WETH, identifier: 0n, amount: 5000000000000000n }],
      consideration: [
        { itemType: 2, token: NFT, identifier: 968n, amount: 1n, recipient: SELLER },
        { itemType: 1, token: WETH, identifier: 0n, amount: 50000000000000n },
      ],
    },
    opts
  );
  assert.deepEqual(r.tokenIds, ["968"]);
  assert.equal(r.paidWei, 5000000000000000n, "the full amount the buyer offered");
});

test("native (itemType 0) consideration counts — tx 0xbd7f18fe…, token 731, 0.00999999 ETH", () => {
  // Paid natively through a Seaport consideration leg by RelayApprovalProxyV3,
  // with tx.value = 0. A price rule that only reads tx.value cannot see this.
  const r = orderFulfilledSettlement(
    {
      offer: [{ itemType: 2, token: NFT, identifier: 731n, amount: 1n }],
      consideration: [
        {
          itemType: 0,
          token: "0x0000000000000000000000000000000000000000",
          identifier: 0n,
          amount: 9999990000000000n,
        },
      ],
    },
    opts
  );
  assert.equal(r.paidWei, 9999990000000000n);
});

test("a foreign ERC-20 (USDG, 6 decimals) is NOT counted as wei — tx 0xd339365d…, token 193", () => {
  // 20000000 USDG units summed into a wei total would render as an absurd ETH
  // price. Honestly unpriced beats confidently wrong.
  const r = orderFulfilledSettlement(
    {
      offer: [{ itemType: 2, token: NFT, identifier: 193n, amount: 1n }],
      consideration: [
        { itemType: 1, token: USDG, identifier: 0n, amount: 19800000n, recipient: SELLER },
        { itemType: 1, token: USDG, identifier: 0n, amount: 200000n, recipient: FEE_RECIPIENT },
      ],
    },
    opts
  );
  assert.deepEqual(r.tokenIds, ["193"], "still recognised as a fill of our token");
  assert.equal(r.paidWei, 0n, "but carries no ETH-denominated price");
});

test("an order that touches none of our tokens settles nothing", () => {
  const r = orderFulfilledSettlement(
    {
      offer: [{ itemType: 2, token: USDG, identifier: 7n, amount: 1n }],
      consideration: [{ itemType: 1, token: WETH, identifier: 0n, amount: 10n ** 18n }],
    },
    opts
  );
  assert.deepEqual(r.tokenIds, []);
  assert.equal(r.paidWei, 0n);
});

test("a multi-item order prices every token it settled", () => {
  const r = orderFulfilledSettlement(
    {
      offer: [
        { itemType: 2, token: NFT, identifier: 631n, amount: 1n },
        { itemType: 2, token: NFT, identifier: 632n, amount: 1n },
      ],
      consideration: [{ itemType: 1, token: WETH, identifier: 0n, amount: 4n }],
    },
    opts
  );
  assert.deepEqual(r.tokenIds, ["631", "632"]);
  assert.equal(r.paidWei, 4n);
});

test("unpricedSaleBlockRanges is a no-op without a database rather than throwing", async () => {
  // Guards the CLI's early exit path: no PG configured must mean "nothing to
  // do", never a crash inside a cron wrapper.
  const previous = process.env.PGHOST;
  delete process.env.PGHOST;
  try {
    assert.deepEqual(await unpricedSaleBlockRanges(), []);
  } finally {
    if (previous != null) process.env.PGHOST = previous;
  }
});
