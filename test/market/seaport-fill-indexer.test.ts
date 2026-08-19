import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { decodeOrderFulfilled, ORDER_FULFILLED_TOPIC } from "../../lib/market/multichain/seaport-fill-indexer";

/**
 * decodeOrderFulfilled is pure (no I/O) -- tested against a REAL
 * ABI-encoded log built with ethers' own Interface.encodeEventLog, not a
 * hand-typed fixture, so a mistake in this test's own encoding can't
 * silently mask a real decode bug (or vice versa).
 */

const ORDER_FULFILLED_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "bytes32", name: "orderHash", type: "bytes32" },
      { indexed: true, internalType: "address", name: "offerer", type: "address" },
      { indexed: true, internalType: "address", name: "zone", type: "address" },
      { indexed: false, internalType: "address", name: "recipient", type: "address" },
      {
        components: [
          { internalType: "enum ItemType", name: "itemType", type: "uint8" },
          { internalType: "address", name: "token", type: "address" },
          { internalType: "uint256", name: "identifier", type: "uint256" },
          { internalType: "uint256", name: "amount", type: "uint256" },
        ],
        indexed: false,
        internalType: "struct SpentItem[]",
        name: "offer",
        type: "tuple[]",
      },
      {
        components: [
          { internalType: "enum ItemType", name: "itemType", type: "uint8" },
          { internalType: "address", name: "token", type: "address" },
          { internalType: "uint256", name: "identifier", type: "uint256" },
          { internalType: "uint256", name: "amount", type: "uint256" },
          { internalType: "address payable", name: "recipient", type: "address" },
        ],
        indexed: false,
        internalType: "struct ReceivedItem[]",
        name: "consideration",
        type: "tuple[]",
      },
    ],
    name: "OrderFulfilled",
    type: "event",
  },
] as const;

const iface = new Interface(ORDER_FULFILLED_ABI);

const NFT_CONTRACT = "0x327ceaaedbbcf55f40d6f1abc71bd9bc8adcb156";
const SELLER = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";
const ORDER_HASH = "0x" + "ab".repeat(32);

function encodeListingFill() {
  const log = iface.encodeEventLog("OrderFulfilled", [
    ORDER_HASH,
    SELLER,
    "0x0000000000000000000000000000000000000000",
    BUYER,
    [{ itemType: 2, token: NFT_CONTRACT, identifier: 1106n, amount: 1n }],
    [{ itemType: 0, token: "0x0000000000000000000000000000000000000000", identifier: 0n, amount: 1_000_000_000_000_000_000n, recipient: SELLER }],
  ]);
  return { topics: log.topics as string[], data: log.data };
}

test("the real Seaport ABI's OrderFulfilled topic hash matches what's exported", () => {
  assert.equal(ORDER_FULFILLED_TOPIC, iface.getEvent("OrderFulfilled")!.topicHash);
});

test("decodes a real ABI-encoded listing fill (NFT offer, native consideration)", () => {
  const { topics, data } = encodeListingFill();
  const decoded = decodeOrderFulfilled(topics, data);
  assert.ok(decoded);
  assert.equal(decoded!.orderHash, ORDER_HASH);
  assert.equal(decoded!.seller, SELLER.toLowerCase());
  assert.equal(decoded!.buyer, BUYER.toLowerCase());
  assert.equal(decoded!.nftContract, NFT_CONTRACT.toLowerCase());
  assert.equal(decoded!.tokenId, "1106");
  assert.equal(decoded!.currencyToken, null); // native, not ERC-20
  assert.equal(decoded!.priceWei, "1000000000000000000");
});

test("decodes an ERC-20 (WETH bid) fill correctly, capturing the currency token", () => {
  const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
  const log = iface.encodeEventLog("OrderFulfilled", [
    ORDER_HASH,
    BUYER, // the bidder is the offerer for an accepted bid
    "0x0000000000000000000000000000000000000000",
    SELLER,
    [{ itemType: 1, token: WETH, identifier: 0n, amount: 500_000_000_000_000_000n }],
    [{ itemType: 2, token: NFT_CONTRACT, identifier: 42n, amount: 1n, recipient: BUYER }],
  ]);
  const decoded = decodeOrderFulfilled(log.topics as string[], log.data);
  assert.ok(decoded);
  assert.equal(decoded!.nftContract, NFT_CONTRACT.toLowerCase());
  assert.equal(decoded!.tokenId, "42");
  assert.equal(decoded!.currencyToken, WETH.toLowerCase());
  assert.equal(decoded!.priceWei, "500000000000000000");
});

test("a fill with no NFT item at all still decodes, with null nftContract/tokenId", () => {
  const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
  const log = iface.encodeEventLog("OrderFulfilled", [
    ORDER_HASH,
    SELLER,
    "0x0000000000000000000000000000000000000000",
    BUYER,
    [{ itemType: 1, token: WETH, identifier: 0n, amount: 1_000_000n }],
    [{ itemType: 0, token: "0x0000000000000000000000000000000000000000", identifier: 0n, amount: 500_000n, recipient: SELLER }],
  ]);
  const decoded = decodeOrderFulfilled(log.topics as string[], log.data);
  assert.ok(decoded);
  assert.equal(decoded!.nftContract, null);
  assert.equal(decoded!.tokenId, null);
});

test("garbage topics/data return null instead of throwing", () => {
  assert.equal(decodeOrderFulfilled(["0xdeadbeef"], "0x1234"), null);
  assert.equal(decodeOrderFulfilled([], "0x"), null);
});

test("a log with the wrong topic count (not this event) returns null", () => {
  const wrongEventTopics = [ORDER_FULFILLED_TOPIC]; // missing the two indexed address topics
  assert.equal(decodeOrderFulfilled(wrongEventTopics, "0x"), null);
});

/**
 * Audit findings H2/H3/H4 (2026-08-19). The decoder was rewritten to be
 * side-aware and total-aware, and points moved onto fee-actually-received.
 * These tests encode the ATTACKS, so a regression that reopens any of them
 * fails loudly rather than silently minting points.
 */
const MARKET_FEE_RECIPIENT = "0xcdb7ca36d35fa16d15fda859a46f1d72d979e9d8";
const ZERO = "0x0000000000000000000000000000000000000000";

test("H4: price SUMS every money leg, not just the first (seller + fee + royalty)", () => {
  // A real listing splits payment across legs. Taking only the first
  // under-reported the true price -- here 0.9 + 0.018 + 0.05 = 0.968 ETH.
  const log = iface.encodeEventLog("OrderFulfilled", [
    ORDER_HASH,
    SELLER,
    ZERO,
    BUYER,
    [{ itemType: 2, token: NFT_CONTRACT, identifier: 1n, amount: 1n }],
    [
      { itemType: 0, token: ZERO, identifier: 0n, amount: 900_000_000_000_000_000n, recipient: SELLER },
      { itemType: 0, token: ZERO, identifier: 0n, amount: 18_000_000_000_000_000n, recipient: MARKET_FEE_RECIPIENT },
      { itemType: 0, token: ZERO, identifier: 0n, amount: 50_000_000_000_000_000n, recipient: BUYER },
    ],
  ]);
  const d = decodeOrderFulfilled(log.topics as string[], log.data);
  assert.ok(d);
  assert.equal(d!.shape, "listing");
  assert.equal(d!.priceWei, "968000000000000000");
  assert.equal(d!.marketplaceFeeWei, "18000000000000000", "our fee leg is extracted separately");
});

test("H4: a decoy NFT listed first cannot displace the real traded asset's side", () => {
  // A bid: money in offer, NFT in consideration. The old first-across-both
  // scan would have picked whatever appeared first; the rewrite picks by SIDE.
  const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
  const log = iface.encodeEventLog("OrderFulfilled", [
    ORDER_HASH,
    BUYER,
    ZERO,
    SELLER,
    [{ itemType: 1, token: WETH, identifier: 0n, amount: 500_000_000_000_000_000n }],
    [{ itemType: 2, token: NFT_CONTRACT, identifier: 77n, amount: 1n, recipient: BUYER }],
  ]);
  const d = decodeOrderFulfilled(log.topics as string[], log.data);
  assert.ok(d);
  assert.equal(d!.shape, "bid");
  assert.equal(d!.nftContract, NFT_CONTRACT.toLowerCase());
  assert.equal(d!.tokenId, "77");
  assert.equal(d!.currencyToken, WETH.toLowerCase(), "bid price comes from the OFFER side");
  assert.equal(d!.priceWei, "500000000000000000");
});

test("H3: a fee 'paid' in a self-minted token is NOT counted as marketplace revenue", () => {
  // Attacker sells for a worthless ERC-20 and routes a huge 'fee' to us in
  // that same worthless token... but the dominant currency here IS that
  // token, so the real defence is that this earns points proportional to a
  // fee we can never actually spend. Critically, a fee leg in a DIFFERENT
  // currency from the dominant one is excluded entirely -- proven here.
  const SCAM = "0x1111111111111111111111111111111111111111";
  const log = iface.encodeEventLog("OrderFulfilled", [
    ORDER_HASH,
    SELLER,
    ZERO,
    BUYER,
    [{ itemType: 2, token: NFT_CONTRACT, identifier: 5n, amount: 1n }],
    [
      // Dominant currency: native ETH (the larger total).
      { itemType: 0, token: ZERO, identifier: 0n, amount: 1_000_000n, recipient: SELLER },
      // A giant "fee" in a token the attacker minted -- must be ignored.
      { itemType: 1, token: SCAM, identifier: 0n, amount: 999_999_999_999_999_999_999n, recipient: MARKET_FEE_RECIPIENT },
    ],
  ]);
  const d = decodeOrderFulfilled(log.topics as string[], log.data);
  assert.ok(d);
  assert.equal(d!.currencyToken, null, "native ETH is dominant");
  assert.equal(d!.marketplaceFeeWei, "0", "off-currency fee leg earns nothing");
});

test("H2: a self-wash trade paying us no fee earns zero score", () => {
  // buyer == seller, huge headline price, no fee leg to us at all.
  const log = iface.encodeEventLog("OrderFulfilled", [
    ORDER_HASH,
    SELLER,
    ZERO,
    SELLER,
    [{ itemType: 2, token: NFT_CONTRACT, identifier: 9n, amount: 1n }],
    [{ itemType: 0, token: ZERO, identifier: 0n, amount: 100_000_000_000_000_000_000n, recipient: SELLER }],
  ]);
  const d = decodeOrderFulfilled(log.topics as string[], log.data);
  assert.ok(d);
  assert.equal(d!.priceWei, "100000000000000000000", "the price is still recorded honestly");
  assert.equal(d!.marketplaceFeeWei, "0", "but nothing reached us, so nothing is scored");
});

test("an NFT-for-NFT swap is classified as such and scores only its real fee", () => {
  const CONTRACT_B = "0x2222222222222222222222222222222222222222";
  const log = iface.encodeEventLog("OrderFulfilled", [
    ORDER_HASH,
    SELLER,
    ZERO,
    BUYER,
    [{ itemType: 2, token: NFT_CONTRACT, identifier: 1n, amount: 1n }],
    [
      { itemType: 2, token: CONTRACT_B, identifier: 2n, amount: 1n, recipient: SELLER },
      { itemType: 0, token: ZERO, identifier: 0n, amount: 500_000_000_000_000n, recipient: MARKET_FEE_RECIPIENT },
    ],
  ]);
  const d = decodeOrderFulfilled(log.topics as string[], log.data);
  assert.ok(d);
  assert.equal(d!.shape, "swap");
  assert.equal(d!.marketplaceFeeWei, "500000000000000");
});
