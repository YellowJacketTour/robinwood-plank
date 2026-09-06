import assert from "node:assert/strict";
import test from "node:test";
import { mapStreamEvent, parseNftId, chainSlugForOpenSeaChain, subIndexFor, parseEnvelope, selectEvent } from "../../lib/market/multichain/edge/opensea-stream";

const sold = {
  item: { nft_id: "ethereum/0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D/1234", chain: { name: "ethereum" } },
  collection: { slug: "boredapeyachtclub" },
  sale_price: "7500000000000000000",
  payment_token: { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18, usd_price: "2500.00" },
  maker: { address: "0xAaaa000000000000000000000000000000000001" },
  taker: { address: "0xBbbb000000000000000000000000000000000002" },
  transaction: { hash: "0xdeadbeef", timestamp: "2026-09-06T10:00:00.000000+00:00" },
  event_timestamp: "2026-09-06T10:00:01.000000+00:00",
};

test("nft_id parses into chain/contract/token and OpenSea chain names map to our slugs", () => {
  assert.deepEqual(parseNftId("base/0xAbC/7"), { chain: "base", contract: "0xabc", tokenId: "7" });
  assert.equal(chainSlugForOpenSeaChain("ethereum"), "eth-mainnet");
  assert.equal(chainSlugForOpenSeaChain("base"), "base-mainnet");
  assert.equal(chainSlugForOpenSeaChain("matic"), "polygon-mainnet");
  assert.equal(chainSlugForOpenSeaChain("klaytn"), null, "unsupported chains are dropped, never guessed");
});

test("item_sold becomes a sale row with real amounts, parties and a USD figure from the payload's own token price", () => {
  const row = mapStreamEvent("item_sold", sold);
  assert.ok(row);
  assert.equal(row.eventType, "sale");
  assert.equal(row.chainSlug, "eth-mainnet");
  assert.equal(row.collectionKey, "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d");
  assert.equal(row.tokenId, "1234");
  assert.equal(row.txHash, "0xdeadbeef");
  assert.equal(row.seller, "0xaaaa000000000000000000000000000000000001");
  assert.equal(row.buyer, "0xbbbb000000000000000000000000000000000002");
  assert.equal(row.amountAtomic, "7500000000000000000");
  assert.equal(row.amountUsd, "18750.000000");
  assert.equal(row.currencySymbol, "ETH");
});

test("listings key on order hash; offers record the bidder as buyer; unknown kinds and missing hashes are null", () => {
  const listed = mapStreamEvent("item_listed", { ...sold, base_price: "1000", order_hash: "0xorder1", transaction: undefined });
  assert.ok(listed);
  assert.equal(listed.eventType, "listing-created");
  assert.equal(listed.txHash, "0xorder1");
  assert.equal(listed.seller, "0xaaaa000000000000000000000000000000000001");
  const offer = mapStreamEvent("item_received_offer", { ...sold, base_price: "500", order_hash: "0xorder2" });
  assert.ok(offer);
  assert.equal(offer.eventType, "bid-created");
  assert.equal(offer.buyer, "0xaaaa000000000000000000000000000000000001");
  assert.equal(mapStreamEvent("item_listed", { ...sold, base_price: "1", order_hash: undefined }), null);
  assert.equal(mapStreamEvent("something_new", sold), null);
  assert.equal(mapStreamEvent("item_sold", { ...sold, item: { nft_id: "klaytn/0xabc/1", chain: { name: "klaytn" } } }), null);
});

test("sub_index is stable per nft id and distinct across items in one transaction", () => {
  assert.equal(subIndexFor("ethereum/0xabc/1"), subIndexFor("ethereum/0xabc/1"));
  assert.notEqual(subIndexFor("ethereum/0xabc/1"), subIndexFor("ethereum/0xabc/2"));
});

test("Phoenix array envelopes (what OpenSea actually sends) and object envelopes both parse", () => {
  const arr = parseEnvelope(JSON.stringify(["1", null, "collection:*", "item_sold", { event_type: "item_sold", payload: sold }]));
  assert.ok(arr);
  assert.equal(arr.event, "item_sold");
  assert.equal(arr.topic, "collection:*");
  const obj = parseEnvelope(JSON.stringify({ topic: "collection:*", event: "item_listed", payload: { payload: sold }, ref: 1 }));
  assert.equal(obj?.event, "item_listed");
  assert.equal(parseEnvelope("not json"), null);
});

test("selection: sales as rows for everyone, listings as floor state for tracked collections, the rest skipped", () => {
  const sale = mapStreamEvent("item_sold", sold);
  const bid = mapStreamEvent("item_received_bid", { ...sold, base_price: "1", order_hash: "0xo" });
  const xfer = mapStreamEvent("item_transferred", { ...sold, from_account: { address: "0x1" }, to_account: { address: "0x2" } });
  const tracked = new Set(["eth-mainnet:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d"]);
  const listed = mapStreamEvent("item_listed", { ...sold, base_price: "1", order_hash: "0xl" });
  assert.equal(selectEvent("item_sold", sale, null), "row");
  assert.equal(selectEvent("item_listed", listed, tracked), "floor");
  assert.equal(selectEvent("item_listed", listed, new Set()), "skip");
  assert.equal(selectEvent("item_received_bid", bid, tracked), "skip");
  assert.equal(selectEvent("item_transferred", xfer, tracked), "skip");
});

test("the inner payload's own chain string wins over nft_id", () => {
  const row = mapStreamEvent("item_sold", { ...sold, chain: "base" });
  assert.equal(row?.chainSlug, "base-mainnet");
});
