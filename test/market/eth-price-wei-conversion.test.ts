import { test } from "node:test";
import assert from "node:assert/strict";
import { ethWeiToNumber, weiToUsd } from "../../lib/eth-price.ts";

test("ethWeiToNumber: real production amount 0.0000202 ETH does not truncate to 0", () => {
  // Real bug found live 2026-08-26: the old milli-ETH-truncation approach
  // rounded any amount under 0.001 ETH down to exactly 0, misclassifying a
  // real confirmed production buy (tx 0x92f5e14f...6c91c) as "no value paid."
  const wei = 20197402078658n; // ~0.0000202 ETH
  const eth = ethWeiToNumber(wei);
  assert.ok(eth > 0, `expected a real positive ETH amount, got ${eth}`);
  assert.ok(Math.abs(eth - 0.000020197402078658) < 1e-12);
});

test("weiToUsd: the same small real amount converts to a real positive USD value, not $0", () => {
  const wei = 20197402078658n;
  const usd = weiToUsd(wei, 2469.6);
  assert.ok(usd > 0, `expected a real positive USD value, got ${usd}`);
  assert.ok(Math.abs(usd - 0.0499) < 0.001);
});

test("ethWeiToNumber: whole-ETH precision is preserved for large amounts", () => {
  const wei = 123_456_789_000_000_000_000n; // 123.456789 ETH
  const eth = ethWeiToNumber(wei);
  assert.ok(Math.abs(eth - 123.456789) < 1e-9);
});

test("ethWeiToNumber: zero and negative inputs behave sanely", () => {
  assert.equal(ethWeiToNumber(0n), 0);
  assert.equal(ethWeiToNumber(-1_000_000_000_000_000_000n), -1);
});

test("ethWeiToNumber: malformed input fails closed to 0, never throws", () => {
  assert.equal(ethWeiToNumber("not-a-number"), 0);
  assert.equal(ethWeiToNumber(undefined), 0);
  assert.equal(ethWeiToNumber(null), 0);
});
