import assert from "node:assert/strict";
import test from "node:test";
import { lamportsToSolDecimal } from "../../lib/market/multichain/adapters/magiceden-solana-trade";

test("Magic Eden REST price is decimal SOL, converted exactly from lamports", () => {
  assert.equal(lamportsToSolDecimal("1500000000"), 1.5);
  assert.equal(lamportsToSolDecimal("1"), 0.000000001);
  assert.equal(lamportsToSolDecimal("0"), 0);
  assert.equal(lamportsToSolDecimal("123456789012"), 123.456789012);
  assert.throws(() => lamportsToSolDecimal("-1"));
});
