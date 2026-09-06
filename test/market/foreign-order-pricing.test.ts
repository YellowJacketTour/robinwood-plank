import assert from "node:assert/strict";
import test from "node:test";
import { priceForeignOrder } from "../../lib/market/multichain/trading/foreign-orders";

const eth = { nativeCurrencySymbol: "ETH", offerCurrencyAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", offerCurrencySymbol: "WETH" };
const polygon = { nativeCurrencySymbol: "POL", offerCurrencyAddress: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", offerCurrencySymbol: "WETH" };

function order(consideration: Array<{ itemType: number; token: string; startAmount: string }>) {
  return { consideration } as unknown as Parameters<typeof priceForeignOrder>[0];
}

test("native legs sum in native and are eligible for floor/cheapest", () => {
  const p = priceForeignOrder(order([
    { itemType: 0, token: "0x0000000000000000000000000000000000000000", startAmount: "950000000000000000" },
    { itemType: 0, token: "0x0000000000000000000000000000000000000000", startAmount: "50000000000000000" },
  ]), eth);
  assert.equal(p.priceAtomic, 1000000000000000000n);
  assert.equal(p.currencySymbol, "ETH");
  assert.equal(p.nativeEquivalent, true);
});

test("wrapped-native asks are priced 1:1 and labelled with the wrapped symbol", () => {
  const p = priceForeignOrder(order([{ itemType: 1, token: eth.offerCurrencyAddress, startAmount: "2000000000000000000" }]), eth);
  assert.equal(p.priceAtomic, 2000000000000000000n);
  assert.equal(p.currencySymbol, "WETH");
  assert.equal(p.nativeEquivalent, true);
});

test("a USDC ask on Polygon is not native-equivalent and never competes for the floor", () => {
  const p = priceForeignOrder(order([{ itemType: 1, token: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", startAmount: "5000000" }]), polygon);
  assert.equal(p.nativeEquivalent, false);
  assert.equal(p.priceAtomic, 5000000n);
});

test("mixed-currency consideration is flagged, never summed as one number", () => {
  const p = priceForeignOrder(order([
    { itemType: 0, token: "0x0000000000000000000000000000000000000000", startAmount: "1" },
    { itemType: 1, token: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", startAmount: "1" },
  ]), polygon);
  assert.equal(p.nativeEquivalent, false);
  assert.equal(p.currencySymbol, "MIXED");
});
