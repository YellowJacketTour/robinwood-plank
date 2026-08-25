import assert from "node:assert/strict";
import test from "node:test";
import { computeCurrencyAwareFloors } from "../../lib/market/multichain/currency-floor";

const now = Date.parse("2026-08-22T18:00:00Z");
const chainSlug = "polygon-mainnet";

test("currency floors compare atomic values only within the same currency", () => {
  const result = computeCurrencyAwareFloors([
    { orderId: "usdc-high", amountAtomic: "9000000", currency: { chainSlug, tokenAddress: "0xusdc", symbol: "USDC", decimals: 6 } },
    { orderId: "usdc-low", amountAtomic: "8500000", currency: { chainSlug, tokenAddress: "0xusdc", symbol: "USDC", decimals: 6 } },
    { orderId: "weth", amountAtomic: "3000000000000000", currency: { chainSlug, tokenAddress: "0xweth", symbol: "WETH", decimals: 18 } },
  ], { nowMs: now });
  assert.equal(result.byCurrency.length, 2);
  assert.equal(result.byCurrency.find((floor) => floor.currency.symbol === "USDC")?.orderId, "usdc-low");
  assert.equal(result.canonicalUsd, null);
  assert.equal(result.incomparableCurrencies, true);
});

test("a canonical USD floor requires fresh attributable quotes for every currency", () => {
  const quoteTime = "2026-08-22T17:59:00Z";
  const result = computeCurrencyAwareFloors([
    { orderId: "usdc", amountAtomic: "8500000", currency: { chainSlug, tokenAddress: "0xusdc", symbol: "USDC", decimals: 6 }, usdQuote: { usdPerToken: 1, observedAt: quoteTime, source: "chainlink" } },
    { orderId: "weth", amountAtomic: "3000000000000000", currency: { chainSlug, tokenAddress: "0xweth", symbol: "WETH", decimals: 18 }, usdQuote: { usdPerToken: 2400, observedAt: quoteTime, source: "chainlink" } },
  ], { nowMs: now });
  assert.equal(result.canonicalUsd?.orderId, "weth");
  assert.equal(result.canonicalUsd?.amountUsd, 7.2);
});

test("stale quotes fail closed", () => {
  const result = computeCurrencyAwareFloors([
    { orderId: "one", amountAtomic: "1", currency: { chainSlug, tokenAddress: null, symbol: "POL", decimals: 0 }, usdQuote: { usdPerToken: 1, observedAt: "2026-08-22T17:00:00Z", source: "oracle" } },
  ], { nowMs: now, maxQuoteAgeMs: 300_000 });
  assert.equal(result.canonicalUsd, null);
  assert.equal(result.byCurrency[0].usdQuote, null);
});
