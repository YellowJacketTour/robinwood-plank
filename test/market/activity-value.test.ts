import assert from "node:assert/strict";
import test from "node:test";
import { activityValue } from "../../lib/market/activity-value";

test("activity valuation respects six-decimal stablecoin atomic units", async () => {
  const value = await activityValue({ atomic: "8920000", decimals: 6, symbol: "USDC" });
  assert.equal(value.priceAmount, "8.92");
  assert.equal(value.priceDecimals, 6);
  assert.equal(value.priceSymbol, "USDC");
  if (value.priceUsd != null) assert.ok(value.priceUsd > 8 && value.priceUsd < 10);
});

test("activity valuation preserves unknown currencies but never invents USD", async () => {
  const value = await activityValue({
    atomic: "123450000",
    decimals: 6,
    symbol: "NOT_A_REAL_QUOTE",
    tokenAddress: "0x1111111111111111111111111111111111111111",
  });
  assert.equal(value.priceAmount, "123.45");
  assert.equal(value.priceUsd, null);
  assert.equal(value.usdSource, null);
});

test("activity valuation handles Bitcoin and Solana native precision", async () => {
  const btc = await activityValue({ atomic: "12345678", decimals: 8, symbol: "BTC" });
  const sol = await activityValue({ atomic: "1500000000", decimals: 9, symbol: "SOL" });
  assert.equal(btc.priceAmount, "0.12345678");
  assert.equal(sol.priceAmount, "1.5");
});
