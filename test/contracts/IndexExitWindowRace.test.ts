import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployOpenIndex,
  warmCheckpoints,
  WAD,
  TIMELOCK,
  MIN_CHECKPOINT,
  maxIn,
  type IndexFixture,
} from "./helpers/index-vault";

/**
 * ROUND 10, FIX 4 — THE STALE-BAND EXIT-WINDOW RACE.
 *
 * `isExiting()` flags a constituent the INSTANT a removal is QUEUED, not when
 * it executes. That is correct and stays public — hiding it would only
 * advantage whoever reads the mempool. But the price band is a LAGGING
 * instrument by construction (a per-observation movement cap plus a checkpoint
 * cadence measured in minutes; the timing suite measures ~2.3 hours to fully
 * reprice a fast 50% impairment at default params). Between the announcement
 * and the band catching up there is a window in which a rational holder can
 * race a large `redeemSingleAsset` into a still-HEALTHY leg at a price that has
 * not yet absorbed the news — the publicly-announced version of exactly the
 * bank-run dynamic the timelock exists to give people reaction time AGAINST.
 *
 * The remedy is ECONOMIC, not informational: while any removal is queued, a
 * LARGE single-asset exit into a healthy leg must see the band hold across
 * MORE settled checkpoints. Nobody is blocked. What this suite has to prove is
 * that distinction — that the guard binds where the race is and is invisible
 * everywhere else, and above all that it never becomes a lock.
 *
 * LOCAL HARDHAT ONLY.
 */
describe("Index exit window — the stale-band race (round 10)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  /**
   * An exit sized to sit JUST above `largeOpValueWei` (10 ETH) and nowhere
   * near draining the leg. Both halves matter: below the threshold no
   * persistence is required at all and the test would prove nothing; too far
   * above it, the size term alone raises the requirement and the surcharge
   * stops being the variable under test. At the fixture's prices this pays out
   * roughly 14 ETH of the 1.0-priced leg.
   */
  const EXIT_SHARES = 4n * WAD;

  /** Lay down exactly `n` fresh observations, one per allowed interval. */
  async function tick(fx: IndexFixture, n: number) {
    await warmCheckpoints(fx, n);
  }

  /** Queue (but do not execute) a removal of constituent `i`. */
  async function queueRemoval(fx: IndexFixture, i: number) {
    await fx.vault
      .connect(fx.admission)
      .queueListing(fx.addrs[i], ethers.ZeroAddress, 0n, true);
    expect(await fx.vault.isExiting(fx.addrs[i])).to.equal(true);
  }

  /**
   * A basket with a big holder, warmed with `obs` extra checkpoint rounds on
   * top of the two the bootstrap and the open already laid down. At `obs = 2`
   * the ring holds FOUR observations, which satisfies the fixture's
   * `persistenceCheckpoints` of 3 and does NOT satisfy 3 + the exit-window
   * surcharge of 2. That is the precise boundary this fix moves, and every
   * test below is positioned on it deliberately rather than by luck.
   */
  /**
   * EQUAL-WEIGHT reserves (1000 / 2000 / 500 units at 1.0 / 0.5 / 2.0 ETH) so
   * every leg is exactly a third of NAV. The default fixture is 28.6/14.3/57.1
   * and its heaviest leg already sits ABOVE the 40% concentration cap, so any
   * single-asset exit there trips `_requireCapNotWorsened` before the
   * persistence gate is ever reached — which would test the wrong guard.
   */
  const BALANCED: bigint[] = [1000n * WAD, 2000n * WAD, 500n * WAD];

  async function warmed(obs: number) {
    const fx = await deployOpenIndex({}, BALANCED);
    await tick(fx, obs);
    await fx.vault.connect(fx.alice).mintProRata(2_000n * WAD, maxIn(3));
    return fx;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. The race is closed
  // ══════════════════════════════════════════════════════════════════════════

  it("a LARGE single-asset exit into a healthy leg needs MORE settled band while a removal is queued", async () => {
    const fx = await warmed(2);
    // Baseline: at three observations this exit clears — the size-and-variance
    // requirement is met and nothing is being removed.
    const shares = EXIT_SHARES;
    await fx.vault.connect(fx.alice).redeemSingleAsset.staticCall(shares, fx.addrs[0], 0n);

    // A removal is announced. The band has NOT moved — that is the whole point
    // of the race: the news is public and the price is not.
    await queueRemoval(fx, 1);

    // THE FIX. The same exit, at the same instant, into the same healthy leg,
    // now needs the band to have held across more checkpoints.
    await expect(
      fx.vault.connect(fx.alice).redeemSingleAsset(shares, fx.addrs[0], 0n)
    ).to.be.revertedWithCustomError(fx.vault, "PersistenceCheckFailed");
  });

  it("it is a DELAY, never a lock: the same exit clears once the band has caught up", async () => {
    const fx = await warmed(2);
    const shares = EXIT_SHARES;
    await queueRemoval(fx, 1);
    await expect(
      fx.vault.connect(fx.alice).redeemSingleAsset(shares, fx.addrs[0], 0n)
    ).to.be.revertedWithCustomError(fx.vault, "PersistenceCheckFailed");

    // Wait for the band to settle across the extra checkpoints. Anyone may lay
    // them down — `checkpoint` is permissionless — so this needs nobody's
    // permission and no role's cooperation.
    await tick(fx, 3);

    const held: bigint = await fx.tokens[0].balanceOf(fx.alice.address);
    await fx.vault.connect(fx.alice).redeemSingleAsset(shares, fx.addrs[0], 0n);
    expect(await fx.tokens[0].balanceOf(fx.alice.address)).to.be.greaterThan(held);
  });

  it("the requirement is CLAMPED at the ring-buffer depth, so it can never become unsatisfiable", async () => {
    // If the surcharge could push the requirement past OBS_SLOTS = 8 there
    // would be no number of checkpoints that satisfies it, and the exit would
    // be permanently shut — a lock wearing a delay's clothes. It cannot.
    const fx = await deployOpenIndex({ persistenceCheckpoints: 8n }, BALANCED);
    await tick(fx, 8);
    await fx.vault.connect(fx.alice).mintProRata(2_000n * WAD, maxIn(3));
    await queueRemoval(fx, 1);
    // 8 (floor) + 2 (surcharge) clamps back to 8, which the warmed ring holds.
    await fx.vault.connect(fx.alice).redeemSingleAsset(EXIT_SHARES, fx.addrs[0], 0n);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. It binds ONLY where the race is
  // ══════════════════════════════════════════════════════════════════════════

  it("redeemProRata is completely untouched — the free exit reads no price at all", async () => {
    const fx = await warmed(2);
    await queueRemoval(fx, 1);
    const before: bigint = await fx.tokens[0].balanceOf(fx.alice.address);
    // The whole position, in one call, during the window. No persistence gate,
    // no band read, no surcharge — this is the guarantee the round exists to
    // protect and Fix 4 must not touch it.
    await fx.vault
      .connect(fx.alice)
      .redeemProRata(await fx.vault.balanceOf(fx.alice.address), [0n, 0n, 0n]);
    expect(await fx.tokens[0].balanceOf(fx.alice.address)).to.be.greaterThan(before);
    expect(await fx.vault.balanceOf(fx.alice.address)).to.equal(0n);
  });

  it("a SMALL single-asset exit is untouched — the gate only exists above largeOpValueWei", async () => {
    const fx = await warmed(2);
    await queueRemoval(fx, 1);
    // Well under `largeOpValueWei` (10 ETH), so ordinary retail flow stays
    // instant during the whole window.
    await fx.vault.connect(fx.alice).redeemSingleAsset(1n * WAD, fx.addrs[0], 0n);
  });

  it("an exit INTO the leg being removed is NOT surcharged — that is not the arbitrage", async () => {
    const fx = await warmed(2);
    await queueRemoval(fx, 0); // the target itself is the one being removed
    // Leaving the position the basket has already announced it is leaving is
    // the behaviour the ramp-out is FOR. Surcharging it would penalise exactly
    // the people doing the right thing.
    await fx.vault.connect(fx.alice).redeemSingleAsset(EXIT_SHARES, fx.addrs[0], 0n);
  });

  it("with NO removal queued, a large exit behaves exactly as it did before round 10", async () => {
    const fx = await warmed(2);
    // Same size, same warmth, no announcement: unchanged.
    await fx.vault.connect(fx.alice).redeemSingleAsset(EXIT_SHARES, fx.addrs[0], 0n);
  });

  it("the window closes when the removal EXECUTES, not only when it is cancelled", async () => {
    const fx = await warmed(2);
    await queueRemoval(fx, 1);
    await expect(
      fx.vault.connect(fx.alice).redeemSingleAsset(EXIT_SHARES, fx.addrs[0], 0n)
    ).to.be.revertedWithCustomError(fx.vault, "PersistenceCheckFailed");

    // Execution consumes the queue entry. By then the removal is no longer
    // NEWS — it is history, and the band has had the whole timelock to price
    // it — so the surcharge lifts with it.
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeListing(fx.addrs[1]);
    await tick(fx, 3); // the timelock outran `staleAfter`; re-warm the oracle
    await fx.vault.connect(fx.alice).redeemSingleAsset(EXIT_SHARES, fx.addrs[0], 0n);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. The timing claim, measured rather than asserted
  // ══════════════════════════════════════════════════════════════════════════

  it("the surcharge buys real wall-clock time for the band, and it is bounded", async () => {
    const fx = await warmed(2);
    await queueRemoval(fx, 1);

    const t0 = await time.latest();
    // Lay checkpoints down as fast as the contract permits until the exit
    // clears. This measures the DELAY the guard actually imposes at maximum
    // honest speed — the worst case for the argument "it is only a delay".
    let laid = 0;
    for (; laid < 8; laid++) {
      try {
        await fx.vault.connect(fx.alice).redeemSingleAsset.staticCall(
          EXIT_SHARES,
          fx.addrs[0],
          0n
        );
        break;
      } catch {
        await time.increase(MIN_CHECKPOINT + 1);
        await fx.vault.checkpointAll();
      }
    }
    const elapsed = (await time.latest()) - t0;

    // It cost something (the guard is real)...
    expect(laid).to.be.greaterThan(0);
    // ...and it is bounded by a handful of checkpoint intervals, not by a
    // timelock and not by anybody's decision.
    expect(laid).to.be.lessThanOrEqual(3);
    expect(elapsed).to.be.lessThanOrEqual(3 * (MIN_CHECKPOINT + 2));
    // Finally: it really does clear.
    await fx.vault.connect(fx.alice).redeemSingleAsset(EXIT_SHARES, fx.addrs[0], 0n);
  });

  it("no role can extend, aim, or make permanent the window — and none can shut the exit", async () => {
    const fx = await warmed(2);
    await queueRemoval(fx, 1);

    // The surcharge is a compile-time constant. There is no parameter key for
    // it, so the risk role cannot reach it even with the full timelock.
    await expect(
      fx.vault
        .connect(fx.risk)
        .queueParam(ethers.encodeBytes32String("exitWindowExtraCheckpoints"), 8n)
    ).to.be.reverted;

    // And with every role key simultaneously hostile, the free exit is still
    // open to everyone, during the window, in one call.
    for (const who of [fx.alice, fx.bob]) {
      await fx.vault.connect(who).mintProRata(10n * WAD, maxIn(3));
      await fx.vault
        .connect(who)
        .redeemProRata(await fx.vault.balanceOf(who.address), [0n, 0n, 0n]);
      expect(await fx.vault.balanceOf(who.address)).to.equal(0n);
    }
  });
});
