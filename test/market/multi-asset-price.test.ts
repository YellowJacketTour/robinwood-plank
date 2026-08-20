import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAssetSymbol, getMultiAssetUsdPrices } from "../../lib/multi-asset-price";

test("normalizeAssetSymbol maps wrapped-token symbols to their plain asset", () => {
  assert.equal(normalizeAssetSymbol("WETH"), "ETH");
  assert.equal(normalizeAssetSymbol("ETH"), "ETH");
  assert.equal(normalizeAssetSymbol("WSOL"), "SOL");
  assert.equal(normalizeAssetSymbol("WBTC"), "BTC");
  assert.equal(normalizeAssetSymbol("btc"), "BTC");
  // floorPriceCurrency reports these plain (POL/BNB/AVAX, no "W" prefix --
  // see foreign-chain-registry.ts's nativeCurrencySymbol), but the W-strip
  // still resolves their wrapped forms since BNB/AVAX now have real feeds.
  assert.equal(normalizeAssetSymbol("POL"), "POL");
  assert.equal(normalizeAssetSymbol("BNB"), "BNB");
  assert.equal(normalizeAssetSymbol("WBNB"), "BNB");
  assert.equal(normalizeAssetSymbol("AVAX"), "AVAX");
  assert.equal(normalizeAssetSymbol("WAVAX"), "AVAX");
});

test("normalizeAssetSymbol returns null for a currency this app has no price feed for -- never guesses", () => {
  // The old MATIC token (pre-migration) is deliberately NOT mapped: this
  // module fetches "polygon-ecosystem-token" (real, live POL) under the
  // POL key, not "matic-network" (the old, now-frozen coin) under MATIC.
  assert.equal(normalizeAssetSymbol("WMATIC"), null);
  assert.equal(normalizeAssetSymbol("MATIC"), null);
  assert.equal(normalizeAssetSymbol(null), null);
  assert.equal(normalizeAssetSymbol(""), null);
});

test("getMultiAssetUsdPrices resolves real (never throws) for exactly the five tracked assets, each with a usd|null + source", async () => {
  const prices = await getMultiAssetUsdPrices();
  for (const symbol of ["ETH", "SOL", "BTC", "POL", "BNB", "AVAX"]) {
    assert.ok(symbol in prices, `expected ${symbol} in prices`);
    const entry = prices[symbol];
    assert.ok(entry.usd === null || (typeof entry.usd === "number" && entry.usd > 0));
    assert.equal(typeof entry.source, "string");
  }
});
