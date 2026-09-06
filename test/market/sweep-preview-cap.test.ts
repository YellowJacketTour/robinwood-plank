import assert from "node:assert/strict";
import test from "node:test";
import { assertSweepMatchesPreview } from "../../lib/market/multichain/trading/foreign-fulfill";

const eth = { nativeCurrencySymbol: "ETH", offerCurrencyAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", offerCurrencySymbol: "WETH" };
const ZERO = "0x0000000000000000000000000000000000000000";

function order(hash: string, amounts: Array<{ itemType: number; token: string; startAmount: string }>) {
  return {
    orderHash: hash,
    chain: "ethereum",
    signature: "0xsig",
    parameters: { consideration: amounts.map((a) => ({ ...a, endAmount: a.startAmount })) },
  } as unknown as Parameters<typeof assertSweepMatchesPreview>[0]["freshOrders"][number];
}

test("executes exactly the previewed set at or below previewed prices, capped at the confirmed total plus tips", () => {
  const fresh = [order("0xa", [{ itemType: 0, token: ZERO, startAmount: "1000" }]), order("0xb", [{ itemType: 0, token: ZERO, startAmount: "900" }])];
  const out = assertSweepMatchesPreview({ freshOrders: fresh, expectedPrices: { "0xa": "1000", "0xb": "1000" }, expectedTotalWei: "2000", chain: eth, tipBps: 180 });
  assert.equal(out.orders.length, 2);
  assert.equal(out.totalWei, 1000n + 18n + 900n + 16n);
});

test("refuses an order that was not in the preview", () => {
  const fresh = [order("0xzz", [{ itemType: 0, token: ZERO, startAmount: "1" }])];
  assert.throws(() => assertSweepMatchesPreview({ freshOrders: fresh, expectedPrices: { "0xa": "1" }, chain: eth, tipBps: 180 }), /not in the confirmed preview/);
});

test("refuses an order whose fresh price rose above the preview", () => {
  const fresh = [order("0xa", [{ itemType: 0, token: ZERO, startAmount: "1001" }])];
  assert.throws(() => assertSweepMatchesPreview({ freshOrders: fresh, expectedPrices: { "0xa": "1000" }, chain: eth, tipBps: 180 }), /rose above/);
});

test("refuses an order priced in a non-native token even if the number looks small", () => {
  const fresh = [order("0xa", [{ itemType: 1, token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", startAmount: "5" }])];
  assert.throws(() => assertSweepMatchesPreview({ freshOrders: fresh, expectedPrices: { "0xa": "1000" }, chain: eth, tipBps: 180 }), /priced in/);
});

test("refuses when the batch total exceeds the confirmed total plus tips", () => {
  const fresh = [order("0xa", [{ itemType: 0, token: ZERO, startAmount: "1000" }]), order("0xb", [{ itemType: 0, token: ZERO, startAmount: "1000" }])];
  assert.throws(() => assertSweepMatchesPreview({ freshOrders: fresh, expectedPrices: { "0xa": "1000", "0xb": "1000" }, expectedTotalWei: "1500", chain: eth, tipBps: 180 }), /exceeds the confirmed total/);
});
