import assert from "node:assert/strict";
import test from "node:test";
import { runOpenSeaRobinhoodDiscoveryScan } from "../../lib/market/multichain/discovery/opensea-robinhood-scan";
import { isNotRealCollectibleArt } from "../../lib/market/multichain/discovery/evm-log-scan";

// This test environment has no OPENSEA_API_KEY and no durable KV, so
// getOpenSeaApiKey() resolves to null -- runOpenSeaRobinhoodDiscoveryScan
// must fail closed (return a structured error, never throw and never make
// a live network call) exactly like resolve-opensea-slug.test.ts's own
// fail-closed shape for the same missing-key scenario.

test("runOpenSeaRobinhoodDiscoveryScan fails closed (never throws) without a configured OpenSea key", async () => {
  const result = await runOpenSeaRobinhoodDiscoveryScan();
  assert.equal(result.registered, 0);
  assert.equal(result.pagesScanned, 0);
  assert.ok(result.error, "expected a structured error, not a silent no-op");
  assert.match(result.error!, /no OpenSea API key/);
});

test("runOpenSeaRobinhoodDiscoveryScan respects maxPages as an upper bound, not a target -- fails closed before ever paging", async () => {
  const result = await runOpenSeaRobinhoodDiscoveryScan({ maxPages: 1 });
  assert.equal(result.pagesScanned, 0);
});

// isNotRealCollectibleArt is reused (not re-implemented) by the new
// discovery path -- these two cases pin the exact real-world DeFi-position
// naming convention that filter is built around, matching evm-log-scan.ts's
// own documented findings, so a future edit to that shared filter can't
// silently stop excluding position NFTs from Robinhood-Chain discovery too.
test("isNotRealCollectibleArt rejects a Uniswap-V3-fork position NFT by name, even with a real image", () => {
  assert.equal(isNotRealCollectibleArt("Uniswap V3 Positions NFT-V1", "https://example.com/logo.png"), true);
});

test("isNotRealCollectibleArt accepts a real collection with a name and image", () => {
  assert.equal(isNotRealCollectibleArt("Burger Brokers", "https://i2c.seadn.io/collection/burger-brokers/image.png"), false);
});
