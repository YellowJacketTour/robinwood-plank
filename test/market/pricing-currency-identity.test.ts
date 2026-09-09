import assert from "node:assert/strict";
import test from "node:test";
import { pricingAssetForCurrency } from "../../lib/market/asset-price-hourly";

test("historical pricing keeps native, wrapped-native and offer assets distinct", () => {
  assert.deepEqual(pricingAssetForCurrency("eth-mainnet", "0x0000000000000000000000000000000000000000"), {asset: "ETH", decimals: 18});
  assert.deepEqual(pricingAssetForCurrency("polygon-mainnet", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"), {asset: "ETH", decimals: 18});
  assert.deepEqual(pricingAssetForCurrency("polygon-mainnet", "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"), {asset: "POL", decimals: 18});
  assert.deepEqual(pricingAssetForCurrency("solana-mainnet", null), {asset: "SOL", decimals: 9});
  assert.equal(pricingAssetForCurrency("unknown-chain", null), null);
  assert.equal(pricingAssetForCurrency("eth-mainnet", "0x1111111111111111111111111111111111111111"), null);
});
