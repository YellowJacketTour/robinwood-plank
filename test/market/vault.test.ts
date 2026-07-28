import assert from "node:assert/strict";
import test from "node:test";
import { redeemCostWei, SHARE_UNIT } from "../../lib/market/vault";

test("random redeem costs 1.0 share plus the redeem fee, no premium", () => {
  // 100 bps = 1% redeem fee, no target premium since it's not targeted.
  const cost = redeemCostWei(100, 250, false);
  assert.equal(cost, SHARE_UNIT + SHARE_UNIT / BigInt(100));
});

test("targeted redeem costs 1.0 share plus BOTH the redeem fee and the premium", () => {
  // This is exactly the gap a user could get burned by: having exactly 1.0
  // share, picking a specific plank, and hitting an unexplained revert
  // because the premium pushes the real cost above their balance.
  const cost = redeemCostWei(100, 250, true);
  assert.equal(cost, SHARE_UNIT + (SHARE_UNIT * BigInt(350)) / BigInt(10_000));
});

test("zero fees and zero premium still cost exactly 1.0 share", () => {
  assert.equal(redeemCostWei(0, 0, false), SHARE_UNIT);
  assert.equal(redeemCostWei(0, 0, true), SHARE_UNIT);
});
