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
