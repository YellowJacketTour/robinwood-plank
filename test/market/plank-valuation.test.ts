import assert from "node:assert/strict";
import test from "node:test";

import {
  PLANK_SUPPLY_BASIS,
  PLANK_VALUATION_LABEL,
  VALUATION_DIVERGENCE_WARN_PCT,
  baseUnitsToTokens,
  computeFdvUsd,
  supplySharePct,
  valuationDivergencePct,
} from "../../lib/plank-valuation";

/**
 * Real values observed on Robinhood Chain / GeckoTerminal on 2026-07-31.
 * Kept as literals so a regression in the math is caught against the actual
 * live figures rather than round numbers that hide precision bugs.
 */
const TOTAL_SUPPLY_RAW = 888420069420888000000000000000000n;
const TOTAL_SUPPLY_TOKENS = 888420069420888;
const PRICE_USD = 0.000000000412105037817799;
/** GeckoTerminal's own `fdv_usd` for the same price snapshot. */
const GECKOTERMINAL_FDV = 366122.386290974;

test("total supply decodes exactly from base units", () => {
  // 8.884e32 is far past Number.MAX_SAFE_INTEGER — a naive Number(raw)/1e18
  // corrupts the multiplicand behind every figure on the page.
  assert.equal(baseUnitsToTokens(TOTAL_SUPPLY_RAW, 18), TOTAL_SUPPLY_TOKENS);
  assert.ok(TOTAL_SUPPLY_TOKENS <= Number.MAX_SAFE_INTEGER);
});

test("baseUnitsToTokens keeps the sub-token remainder", () => {
  assert.equal(baseUnitsToTokens(1500000000000000000n, 18), 1.5);
  assert.equal(baseUnitsToTokens(0n, 18), 0);
});

test("our FDV reproduces GeckoTerminal's to the cent", () => {
  const fdv = computeFdvUsd(PRICE_USD, TOTAL_SUPPLY_TOKENS);
  assert.ok(fdv != null);
  // Same basis (price x total supply), so this must agree to floating-point
  // noise. If it ever doesn't, one of us changed which supply we multiply.
  assert.ok(
    Math.abs(fdv - GECKOTERMINAL_FDV) < 0.01,
    `computed ${fdv} vs GeckoTerminal ${GECKOTERMINAL_FDV}`
  );
});

test("FDV is null, never zero, when an input is missing", () => {
  // A "$0.00" valuation would read as a real, catastrophic number.
  assert.equal(computeFdvUsd(null, TOTAL_SUPPLY_TOKENS), null);
  assert.equal(computeFdvUsd(PRICE_USD, null), null);
  assert.equal(computeFdvUsd(Number.NaN, TOTAL_SUPPLY_TOKENS), null);
  assert.equal(computeFdvUsd(PRICE_USD, Number.POSITIVE_INFINITY), null);
  assert.equal(computeFdvUsd(-1, TOTAL_SUPPLY_TOKENS), null);
});

test("divergence against a live aggregator stays inside the warn threshold", () => {
  const fdv = computeFdvUsd(PRICE_USD, TOTAL_SUPPLY_TOKENS);
  // DexScreener's deepest-pool FDV at the same snapshot: $365,114.
  const gt = valuationDivergencePct(fdv, GECKOTERMINAL_FDV);
  const ds = valuationDivergencePct(fdv, 365114);
  assert.ok(gt != null && Math.abs(gt) < VALUATION_DIVERGENCE_WARN_PCT);
  assert.ok(ds != null && Math.abs(ds) < VALUATION_DIVERGENCE_WARN_PCT);
});

test("divergence is null rather than Infinity against a zero baseline", () => {
  assert.equal(valuationDivergencePct(100, 0), null);
  assert.equal(valuationDivergencePct(100, null), null);
});

test("supply concentration matches the observed on-chain share", () => {
  // balanceOf(PLANK_SUPPLY_RECIPIENT) on 2026-07-31.
  const held = 504438253705376;
  const pct = supplySharePct(held, TOTAL_SUPPLY_TOKENS);
  assert.ok(pct != null);
  assert.ok(pct > 56 && pct < 58, `expected ~56.8%, got ${pct}`);
});

test("supply share degrades to null, not 0%, on a failed read", () => {
  // 0% concentration reads as reassuring; it must never stand in for unknown.
  assert.equal(supplySharePct(null, TOTAL_SUPPLY_TOKENS), null);
  assert.equal(supplySharePct(1, 0), null);
});

test("the published basis is FDV and is never labelled market cap", () => {
  assert.equal(PLANK_SUPPLY_BASIS, "fdv");
  assert.doesNotMatch(PLANK_VALUATION_LABEL, /market\s*cap/i);
});
