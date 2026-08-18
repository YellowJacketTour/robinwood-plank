import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAssetSymbol, getMultiAssetUsdPrices } from "../../lib/multi-asset-price";

test("normalizeAssetSymbol maps wrapped-token symbols to their plain asset", () => {
  assert.equal(normalizeAssetSymbol("WETH"), "ETH");
  assert.equal(normalizeAssetSymbol("ETH"), "ETH");
  assert.equal(normalizeAssetSymbol("WSOL"), "SOL");
  assert.equal(normalizeAssetSymbol("WBTC"), "BTC");
  assert.equal(normalizeAssetSymbol("btc"), "BTC");
});

test("normalizeAssetSymbol returns null for a currency this app has no price feed for -- never guesses", () => {
  assert.equal(normalizeAssetSymbol("WBNB"), null);
  assert.equal(normalizeAssetSymbol("WMATIC"), null);
  assert.equal(normalizeAssetSymbol("WAVAX"), null);
  assert.equal(normalizeAssetSymbol(null), null);
  assert.equal(normalizeAssetSymbol(""), null);
});

test("getMultiAssetUsdPrices resolves real (never throws) for exactly the three tracked assets, each with a usd|null + source", async () => {
  const prices = await getMultiAssetUsdPrices();
  for (const symbol of ["ETH", "SOL", "BTC"]) {
    assert.ok(symbol in prices, `expected ${symbol} in prices`);
    const entry = prices[symbol];
    assert.ok(entry.usd === null || (typeof entry.usd === "number" && entry.usd > 0));
    assert.equal(typeof entry.source, "string");
  }
});
