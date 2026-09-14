import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { keccak256, toUtf8Bytes, AbiCoder, zeroPadValue, toBeHex } from "ethers";
import {
  PUNK_BOUGHT_TOPIC,
  PUNK_BID_ENTERED_TOPIC,
  CRYPTOPUNKS_MARKET_ADDRESS,
  decodePunkBought,
  decodePunkBidEntered,
  resolvePunkSales,
  type PunkBoughtLog,
} from "../../lib/market/multichain/cryptopunks-fill-indexer";

// Independently derived from the canonical signatures in
// larvalabs/cryptopunks CryptoPunksMarket.sol, not from the ABI under test.
const PUNK_BOUGHT_SIG = "PunkBought(uint256,uint256,address,address)";
const PUNK_BID_ENTERED_SIG = "PunkBidEntered(uint256,uint256,address)";

test("the topic hashes are the contract's real ones (keccak of the canonical signatures)", () => {
  assert.equal(PUNK_BOUGHT_TOPIC, keccak256(toUtf8Bytes(PUNK_BOUGHT_SIG)));
  assert.equal(PUNK_BID_ENTERED_TOPIC, keccak256(toUtf8Bytes(PUNK_BID_ENTERED_SIG)));
  // Pinned literal values, cross-checked 2026-09-14 with two independent
  // keccak implementations against the verified source.
  assert.equal(PUNK_BOUGHT_TOPIC, "0x58e5d5a525e3b40bc15abaa38b5882678db1ee68befd2f60bafe3a7fd06db9e3");
  assert.equal(PUNK_BID_ENTERED_TOPIC, "0x5b859394fabae0c1ba88baffe67e751ab5248d2e879028b8c8d6897b0519f56a");
  assert.equal(CRYPTOPUNKS_MARKET_ADDRESS, "0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb");
});

const coder = AbiCoder.defaultAbiCoder();
const addrTopic = (a: string) => zeroPadValue(a, 32);
const uintTopic = (n: bigint) => zeroPadValue(toBeHex(n), 32);
const SELLER = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";
const BIDDER = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";

function boughtLog(punk: bigint, valueWei: bigint, from: string, to: string) {
  return { topics: [PUNK_BOUGHT_TOPIC, uintTopic(punk), addrTopic(from), addrTopic(to)], data: coder.encode(["uint256"], [valueWei]) };
}
function bidLog(punk: bigint, valueWei: bigint, bidder: string) {
  return { topics: [PUNK_BID_ENTERED_TOPIC, uintTopic(punk), addrTopic(bidder)], data: coder.encode(["uint256"], [valueWei]) };
}

test("decodes PunkBought and PunkBidEntered exactly, and nothing else", () => {
  const b = decodePunkBought(boughtLog(7804n, 4200000000000000000000n, SELLER, BUYER).topics, boughtLog(7804n, 4200000000000000000000n, SELLER, BUYER).data);
  assert.deepEqual(b, { punkIndex: "7804", valueWei: "4200000000000000000000", from: SELLER, to: BUYER });
  const bid = decodePunkBidEntered(bidLog(7804n, 5n, BIDDER).topics, bidLog(7804n, 5n, BIDDER).data);
  assert.deepEqual(bid, { punkIndex: "7804", valueWei: "5", bidder: BIDDER });
  // Cross-decoding: a bid log is not a purchase and vice versa.
  assert.equal(decodePunkBought(bidLog(1n, 1n, BIDDER).topics, bidLog(1n, 1n, BIDDER).data), null);
  assert.equal(decodePunkBidEntered(boughtLog(1n, 1n, SELLER, BUYER).topics, boughtLog(1n, 1n, SELLER, BUYER).data), null);
  assert.equal(decodePunkBought(["0xdead"], "0x"), null);
});

test("a real-value PunkBought is a 'buy'; the acceptBid path (value 0, to 0x0) is priced from the latest prior bid or dropped -- never a 0-price sale", async () => {
  const base = { chainSlug: "eth-mainnet", blockTimestamp: 1_700_000_000 };
  const buy: PunkBoughtLog = { ...base, txHash: "0xa", logIndex: 3, blockNumber: 100, bought: decodePunkBought(boughtLog(1n, 10n, SELLER, BUYER).topics, boughtLog(1n, 10n, SELLER, BUYER).data)! };
  const accept: PunkBoughtLog = { ...base, txHash: "0xb", logIndex: 5, blockNumber: 200, bought: decodePunkBought(boughtLog(2n, 0n, SELLER, ZERO).topics, boughtLog(2n, 0n, SELLER, ZERO).data)! };
  const orphan: PunkBoughtLog = { ...base, txHash: "0xc", logIndex: 1, blockNumber: 300, bought: decodePunkBought(boughtLog(3n, 0n, SELLER, ZERO).topics, boughtLog(3n, 0n, SELLER, ZERO).data)! };
  const asked: Array<[string, number, number]> = [];
  const resolver = async (punkIndex: string, beforeBlock: number, beforeLogIndex: number) => {
    asked.push([punkIndex, beforeBlock, beforeLogIndex]);
    if (punkIndex === "2") return { bid: { punkIndex: "2", valueWei: "77", bidder: BIDDER }, txHash: "0xbid", logIndex: 9 };
    return null;
  };
  const { sales, unresolved } = await resolvePunkSales([buy, accept, orphan], resolver);
  assert.deepEqual(asked, [["2", 200, 5], ["3", 300, 1]], "only the 0-value sales consult the bid history, strictly before the sale");
  assert.equal(sales.length, 2);
  assert.deepEqual(sales[0], { chainSlug: "eth-mainnet", txHash: "0xa", logIndex: 3, blockNumber: 100, blockTimestamp: 1_700_000_000, punkIndex: "1", seller: SELLER, buyer: BUYER, priceWei: "10", saleKind: "buy", bidTxHash: null, bidLogIndex: null });
  assert.deepEqual(sales[1], { chainSlug: "eth-mainnet", txHash: "0xb", logIndex: 5, blockNumber: 200, blockTimestamp: 1_700_000_000, punkIndex: "2", seller: SELLER, buyer: BIDDER, priceWei: "77", saleKind: "accept-bid", bidTxHash: "0xbid", bidLogIndex: 9 });
  assert.deepEqual(unresolved.map((u) => u.txHash), ["0xc"], "no bid found: an honest hole, not a free Punk");
  assert.ok(sales.every((s) => s.priceWei !== "0"));
});

test("the ledger table refuses a 0 price by constraint, and the feed union carries the twelfth venue", () => {
  const migration = readFileSync("deploy/inmotion/postgres/migrations/150_floor_observation_seed_and_cryptopunks_fills.sql", "utf8");
  assert.match(migration, /price_wei\s+NUMERIC\(78, 0\) NOT NULL CHECK \(price_wei > 0\)/);
  assert.match(migration, /sale_kind IN \('buy', 'accept-bid'\)/);
  const union = readFileSync("lib/market/multichain/ledger-union-sql.ts", "utf8");
  assert.equal((union.match(/FROM plank_cryptopunks_fills/g) ?? []).length, 2, "one branch in UNION_SQL, one in FEED_UNION_SQL");
  assert.match(union, /'sale', 'cryptopunks-market',[\s\S]*?FROM plank_cryptopunks_fills[\s\S]*?ORDER BY block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC\s+LIMIT \$3\)/, "the bounded branch orders by the exact global key on its 150 feed index");
  const lane = readFileSync("scripts/mesh-lane.ts", "utf8");
  assert.match(lane, /source === "cryptopunks-fills"/);
  assert.match(lane, /source === "cryptopunks-fills-genesis"/);
});
