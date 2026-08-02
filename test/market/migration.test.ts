import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMigrationPlan,
  redeemCostShares,
  formatShares,
  SHARE_UNIT,
  type VaultPosition,
} from "../../lib/market/migration.ts";

const base = (over: Partial<VaultPosition>): VaultPosition => ({
  address: "0xvault",
  generation: 2,
  version: "V2",
  walletShares: 0n,
  lpShareCredit: 0n,
  lpEthCredit: 0n,
  redeemCostShares: redeemCostShares(100), // 1% => 1.01 shares
  poolShareReserve: 10n * SHARE_UNIT,
  poolEthReserve: 10n * SHARE_UNIT,
  ...over,
});

test("redeemCostShares: 1% fee is 1.01 shares", () => {
  assert.equal(redeemCostShares(100), SHARE_UNIT + SHARE_UNIT / 100n);
});

test("empty wallet has no value and is complete", () => {
  const plan = buildMigrationPlan([base({ walletShares: 0n })]);
  assert.equal(plan.hasValue, false);
  assert.equal(plan.complete, true);
  assert.equal(plan.sources.length, 0);
});

test("3.03 shares redeem 3 planks with no dust (each costs 1.01)", () => {
  const plan = buildMigrationPlan([base({ walletShares: (SHARE_UNIT * 303n) / 100n })]);
  assert.equal(plan.sources.length, 1);
  const s = plan.sources[0];
  assert.equal(s.redeemableNfts, 3);
  assert.equal(s.dustShares, 0n);
  assert.equal(s.hasDust, false);
});

test("0.45 shares is pure dust — zero redeemable, dust flagged", () => {
  const plan = buildMigrationPlan([base({ walletShares: (SHARE_UNIT * 45n) / 100n })]);
  const s = plan.sources[0];
  assert.equal(s.redeemableNfts, 0);
  assert.equal(s.hasDust, true);
  assert.equal(s.dustShares, (SHARE_UNIT * 45n) / 100n);
});

test("V2 LP credit is counted toward redeemable shares and flags a withdrawal", () => {
  const plan = buildMigrationPlan([
    base({ walletShares: 0n, lpShareCredit: (SHARE_UNIT * 202n) / 100n, lpEthCredit: SHARE_UNIT / 1000n }),
  ]);
  const s = plan.sources[0];
  assert.equal(s.needsLpWithdraw, true);
  assert.equal(s.redeemableNfts, 2); // 2.02 / 1.01
  assert.equal(s.lpWithdrawCovered, true);
});

test("LP withdrawal is flagged uncovered when credits exceed reserves", () => {
  const plan = buildMigrationPlan([
    base({
      lpShareCredit: 20n * SHARE_UNIT, // exceeds the 10-share reserve
      poolShareReserve: 10n * SHARE_UNIT,
    }),
  ]);
  assert.equal(plan.sources[0].lpWithdrawCovered, false);
});

test("uncovered LP is NOT counted as redeemable (no doomed redeem loop)", () => {
  // 0.5 wallet shares + 2.0 LP credit the pool can't cover. Folding LP in would
  // report redeemableNfts >= 1 and offer a redeem that reverts (insufficient
  // wallet balance) with no withdraw step available — an inescapable loop.
  const plan = buildMigrationPlan([
    base({
      walletShares: SHARE_UNIT / 2n, // 0.5 — below one redeem on its own
      lpShareCredit: 2n * SHARE_UNIT,
      poolShareReserve: 1n * SHARE_UNIT, // < credit → uncovered
    }),
  ]);
  const s = plan.sources[0];
  assert.equal(s.lpWithdrawCovered, false);
  assert.equal(s.redeemableNfts, 0); // off the 0.5 wallet balance alone, not 2.5
  assert.equal(s.stuckLpShares, 2n * SHARE_UNIT); // surfaced separately
  assert.equal(plan.sources.length, 1); // still "has value" (LP is stuck, not gone)
});

test("multiple sources are ordered V2 before V1 and summed", () => {
  const v1 = base({ generation: 1, version: "V1", address: "0xv1", walletShares: (SHARE_UNIT * 202n) / 100n });
  const v2 = base({ generation: 2, version: "V2", address: "0xv2", walletShares: (SHARE_UNIT * 101n) / 100n });
  const plan = buildMigrationPlan([v1, v2]);
  assert.equal(plan.sources[0].version, "V2"); // newest first
  assert.equal(plan.sources[1].version, "V1");
  assert.equal(plan.totalRedeemableNfts, 3); // 1 from V2 + 2 from V1
});

test("formatShares renders a short decimal", () => {
  assert.equal(formatShares((SHARE_UNIT * 303n) / 100n), "3.0300");
  assert.equal(formatShares(SHARE_UNIT + SHARE_UNIT / 100n), "1.0100");
});
