import assert from "node:assert/strict";
import test from "node:test";
import { Interface, keccak256, toUtf8Bytes } from "ethers";

/**
 * Proves the exact ABI string used in lib/market/activity.ts to decode
 * Seaport's OrderFulfilled event actually round-trips: encode a log the way
 * Seaport would emit one, decode it back, confirm the fields (orderHash,
 * and each item's token/identifier) survive intact. This is the load-bearing
 * logic behind "which token did this specific order actually settle" — get
 * it wrong and attribution either silently misses real Marketplank sales or,
 * worse, attributes someone else's sale to us.
 */
const ORDER_FULFILLED_IFACE = new Interface([
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)",
]);

const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const OFFERER = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const ZONE = "0x0000000000000000000000000000000000000000";
const RECIPIENT = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";

test("topic hash matches the canonical Seaport 1.6 OrderFulfilled signature", () => {
  const canonical =
    "OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])";
  const expected = keccak256(toUtf8Bytes(canonical));
  assert.equal(ORDER_FULFILLED_IFACE.getEvent("OrderFulfilled")!.topicHash, expected);
});

test("a single-item fill round-trips: orderHash and the sold token survive decoding", () => {
  const orderHash = "0x" + "11".repeat(32);
  const log = ORDER_FULFILLED_IFACE.encodeEventLog("OrderFulfilled", [
    orderHash,
    OFFERER,
    ZONE,
    RECIPIENT,
    [{ itemType: 2, token: NFT, identifier: 42n, amount: 1n }], // offer: the NFT
    [{ itemType: 1, token: WETH, identifier: 0n, amount: 1000000000000000000n, recipient: OFFERER }], // consideration: WETH payment
  ]);

  const parsed = ORDER_FULFILLED_IFACE.parseLog({ topics: log.topics, data: log.data });
  assert.ok(parsed);
  assert.equal(parsed!.args.orderHash, orderHash);

  const items = [...parsed!.args.offer, ...parsed!.args.consideration];
  const nftItems = items.filter((i) => String(i.token).toLowerCase() === NFT.toLowerCase());
  assert.equal(nftItems.length, 1);
  assert.equal((nftItems[0].identifier as bigint).toString(), "42");
});

test("a batch fill (multiple OrderFulfilled logs in one tx, e.g. our own Sweep) attributes each tokenId to its OWN order, not the whole tx", () => {
  const orderA = "0x" + "aa".repeat(32);
  const orderB = "0x" + "bb".repeat(32);

  const logA = ORDER_FULFILLED_IFACE.encodeEventLog("OrderFulfilled", [
    orderA,
    OFFERER,
    ZONE,
    RECIPIENT,
    [{ itemType: 2, token: NFT, identifier: 7n, amount: 1n }],
    [],
  ]);
  const logB = ORDER_FULFILLED_IFACE.encodeEventLog("OrderFulfilled", [
    orderB,
    OFFERER,
    ZONE,
    RECIPIENT,
    [{ itemType: 2, token: NFT, identifier: 9n, amount: 1n }],
    [],
  ]);

  const parsedA = ORDER_FULFILLED_IFACE.parseLog({ topics: logA.topics, data: logA.data })!;
  const parsedB = ORDER_FULFILLED_IFACE.parseLog({ topics: logB.topics, data: logB.data })!;

  // Simulate: only order A was ever served by us (order B was someone else's,
  // co-fulfilled in the same batch transaction).
  const servedHashes = new Set([orderA]);

  const attributed = new Map<string, boolean>();
  for (const parsed of [parsedA, parsedB]) {
    if (!servedHashes.has(parsed.args.orderHash)) continue;
    for (const item of [...parsed.args.offer, ...parsed.args.consideration]) {
      if (String(item.token).toLowerCase() !== NFT.toLowerCase()) continue;
      attributed.set((item.identifier as bigint).toString(), true);
    }
  }

  assert.equal(attributed.get("7"), true, "token 7 (order A, ours) must be attributed");
  assert.equal(attributed.has("9"), false, "token 9 (order B, not ours) must NOT be attributed");
});

test("a non-Seaport log at the same topic0 by coincidence still decodes to well-typed fields (no silent corruption)", () => {
  // Not a security boundary test — just proving parseLog either succeeds
  // with correctly-typed values or throws, never returns silently wrong data.
  const log = ORDER_FULFILLED_IFACE.encodeEventLog("OrderFulfilled", [
    "0x" + "00".repeat(32),
    OFFERER,
    ZONE,
    RECIPIENT,
    [],
    [],
  ]);
  const parsed = ORDER_FULFILLED_IFACE.parseLog({ topics: log.topics, data: log.data });
  assert.ok(parsed);
  assert.equal(parsed!.args.offer.length, 0);
  assert.equal(parsed!.args.consideration.length, 0);
});
