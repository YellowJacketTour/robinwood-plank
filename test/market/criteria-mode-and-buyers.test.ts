import assert from "node:assert/strict";
import test from "node:test";
import { chooseCriteriaMode } from "../../lib/market/multichain/trading/criteria-mode";
import { MAX_CRITERIA_TOKEN_IDS } from "../../lib/market/criteria";
import { rankBuyers, type BuyerRow } from "../../lib/market/multichain/biggest-buyers";

test("criteria: collection scope prefers a proven wildcard, else a complete Merkle set, else refuses", () => {
  assert.equal(chooseCriteriaMode({ scope: "collection", tokenIds: [], indexCoverage: 0.3, wildcardProven: true }).mode, "wildcard");
  const m = chooseCriteriaMode({ scope: "collection", tokenIds: ["1", "2", "2"], indexCoverage: 1, wildcardProven: false });
  assert.equal(m.mode, "merkle");
  assert.deepEqual(m.mode === "merkle" ? m.tokenIds : [], ["1", "2"]);
  assert.equal(chooseCriteriaMode({ scope: "collection", tokenIds: ["1"], indexCoverage: 0.9, wildcardProven: false }).mode, "refuse");
  const big = Array.from({ length: MAX_CRITERIA_TOKEN_IDS + 1 }, (_, i) => String(i));
  assert.equal(chooseCriteriaMode({ scope: "collection", tokenIds: big, indexCoverage: 1, wildcardProven: false }).mode, "refuse");
});

test("criteria: trait/tier scope never uses a wildcard and refuses on an incomplete index", () => {
  assert.equal(chooseCriteriaMode({ scope: "trait", tokenIds: ["1"], indexCoverage: 1, wildcardProven: true }).mode, "merkle");
  assert.equal(chooseCriteriaMode({ scope: "trait", tokenIds: ["1"], indexCoverage: 0.99, wildcardProven: true }).mode, "refuse");
  assert.equal(chooseCriteriaMode({ scope: "tier", tokenIds: [], indexCoverage: 1, wildcardProven: true }).mode, "refuse");
  assert.equal(chooseCriteriaMode({ scope: "tier", tokenIds: ["1"], indexCoverage: null, wildcardProven: true }).mode, "refuse");
});

test("biggest buyers rank by real USD, then sales; unpriced buyers sort last but are not dropped", () => {
  const row = (buyer: string, usd: number | null, sales: number): BuyerRow => ({ buyer, usd, sales, unpricedSales: usd == null ? sales : 0, amountAtomic: null, currencySymbol: null, firstBuyAt: null, lastBuyAt: null, distinctTokens: sales });
  const ranked = rankBuyers([row("0xb", 100, 1), row("0xa", null, 9), row("0xc", 100, 3), row("0xd", 5000, 1)]);
  assert.deepEqual(ranked.map((r) => r.buyer), ["0xd", "0xc", "0xb", "0xa"]);
});
