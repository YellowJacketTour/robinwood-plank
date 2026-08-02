import assert from "node:assert/strict";
import test from "node:test";
import { redeemCostWei, SHARE_UNIT } from "../../lib/market/vault";
import { vaultGeneration } from "../../lib/market/vault-registry";

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

/**
 * Adding liquidity to an older pool must be impossible, not merely discouraged.
 *
 * The absolute-credit LP primitive on the second-generation pool has a proven,
 * externally exploitable flaw (audit held privately; the rule is in
 * AGENTS.md). Nothing enforced it in code until 2026-08-02 — the Instant Swap
 * switcher lists every configured pool and contributeLiquidity() targeted
 * whichever was selected.
 *
 * Pins the guard's predicate at the layer that cannot be routed around, so a
 * future entry point to add-liquidity inherits it. Withdrawal is deliberately
 * NOT covered here: removeLiquidity must keep working on older pools so
 * /migrate can get people out.
 */
test("generation decides whether a pool may take NEW liquidity", () => {
  assert.equal(vaultGeneration("0xb2019Fd4cA24502e812C0C73b751Fa49979BF708"), 1);
  assert.equal(vaultGeneration("0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04"), 2);
  // Anything that is not a known older deployment is current-generation.
  assert.equal(vaultGeneration("0xacE28f72Fc3e15eA1671e689806694A9b0cE047D"), 3);

  // Stated as the predicate rather than the addresses so it keeps holding when
  // a fourth generation ships.
  const blocked = (a: string) => vaultGeneration(a) < 3;
  assert.equal(blocked("0xb2019Fd4cA24502e812C0C73b751Fa49979BF708"), true);
  assert.equal(blocked("0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04"), true);
  assert.equal(blocked("0xacE28f72Fc3e15eA1671e689806694A9b0cE047D"), false);
});
