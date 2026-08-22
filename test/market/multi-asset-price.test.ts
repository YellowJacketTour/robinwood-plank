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
  assert.equal(normalizeAssetSymbol("MATIC"), "POL");
  assert.equal(normalizeAssetSymbol("WMATIC"), "POL");
  assert.equal(normalizeAssetSymbol("BNB"), "BNB");
  assert.equal(normalizeAssetSymbol("WBNB"), "BNB");
  assert.equal(normalizeAssetSymbol("AVAX"), "AVAX");
  assert.equal(normalizeAssetSymbol("WAVAX"), "AVAX");
  assert.equal(normalizeAssetSymbol("USDC"), "USDC");
  assert.equal(normalizeAssetSymbol("USDT"), "USDT");
});

test("normalizeAssetSymbol returns null for a currency this app has no price feed for -- never guesses", () => {
  // Unknown currencies remain null; aliases explicitly covered above are
  // the only exception and share the same fetched native-asset quote.
  assert.equal(normalizeAssetSymbol(null), null);
  assert.equal(normalizeAssetSymbol(""), null);
});

test("getMultiAssetUsdPrices resolves every supported quote currency without throwing", async () => {
  const prices = await getMultiAssetUsdPrices();
  for (const symbol of ["ETH", "SOL", "BTC", "POL", "BNB", "AVAX", "USDC", "USDT"]) {
    assert.ok(symbol in prices, `expected ${symbol} in prices`);
    const entry = prices[symbol];
    assert.ok(entry.usd === null || (typeof entry.usd === "number" && entry.usd > 0));
    assert.equal(typeof entry.source, "string");
  }
});
