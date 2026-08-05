import { expect } from "chai";
import { ethers } from "hardhat";
import { takeSnapshot, time, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { TIMELOCK, WAD, defaultParams, paramsTuple } from "./helpers/index-vault";

/**
 * Audit-style suite for GlobalIndexVault Part E: the REALIZED-VARIANCE
 * calibration of the size-proportional persistence gate.
 *
 *     required = clamp( requiredCheckpoints(ethValue)
 *                       + realizedVolBps(token) / VOL_STEP_BPS,
 *                       floor, ceiling )
 *
 * The contract is careful to describe this as a rolling realized-variance
 * PROXY and explicitly not an EVT / GPD tail fit, and it rests its safety on
 * two things rather than on the statistics being right:
 *
 *   - THE CLAMP. Compile-time floor and ceiling that no role, no timelock and
 *     no amount of manufactured checkpoint history can move. This file proves
 *     the box holds from both sides.
 *   - THE ASYMMETRY. The calibration window is LONG (90 days, thousands of
 *     checkpoints) and it scales a SHORT window (a handful of checkpoints).
 *     A burst of self-induced volatility is therefore a vanishing fraction of
 *     the denominator — and, more importantly, it pushes the requirement in
 *     the direction that HURTS the attacker. Both halves are asserted.
 *
 * Every numeric expectation here is computed from the accumulator's own
 * definition (sum of squared capped per-checkpoint moves in bps, over the
 * sample count) in TypeScript, so a change to the Solidity that alters the
 * measure shows up as a disagreement rather than as a silently-updated value.
 *
 * LOCAL HARDHAT ONLY. Nothing in this repo may deploy any of these contracts
 * until the external audit gate (§2.6) clears.
 */
describe("GlobalIndexVault — realized-variance persistence calibration (Part E)", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const OBS_SLOTS = 8n; // MAX_REQUIRED_CHECKPOINTS
  const VOL_STEP_BPS = 100n;
  const MIN_REQUIRED = 2n;
  const VARIANCE_WINDOW = 90 * 24 * 3_600;
  const MIN_CHECKPOINT = Number(defaultParams.minCheckpointInterval);
  const PRICE_CAP_BPS = defaultParams.priceCapBps; // 500
  const LARGE_OP = defaultParams.largeOpValueWei; // 10 ETH

  function isqrt(n: bigint): bigint {
    if (n < 2n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
      x = y;
      y = (x + n / x) / 2n;
    }
    return x;
  }

  /**
   * A one-constituent basket, priced 1.0 ETH, whose price source this test
   * drives directly. One leg keeps the accounting of "how many samples exist"
   * unambiguous, which is what lets the expectations below be EXACT rather
   * than approximate.
   */
  async function singleLegIndex(overrides: any = {}) {
    const [, roleAdmin, seeder, alice, , , admission, risk, allocation] =
      await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockIndexToken");
    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    const token: any = await Token.deploy("v", "v");
    const source: any = await Source.deploy(100n * WAD, 100n * WAD);
    const addr = await token.getAddress();

    const Vault = await ethers.getContractFactory("GlobalIndexVault");
    const vault: any = await Vault.deploy(
      "gi",
      "gi",
      [roleAdmin.address, admission.address, risk.address, allocation.address],
      seeder.address,
      TIMELOCK,
      paramsTuple({ ...defaultParams, ...overrides })
    );
    const vaultAddr = await vault.getAddress();

    await vault.connect(seeder).seedConstituent(addr, await source.getAddress(), 10_000);
    await token.mint(seeder.address, 100_000n * WAD);
    await token.connect(seeder).approve(vaultAddr, ethers.MaxUint256);
    // seedConstituent lays down observation 0 (no move sample);
    // seedDeposit lays down observation 1, which IS a sample, of move 0.
    await vault.connect(seeder).seedDeposit(addr, 10_000n * WAD);
    await vault.connect(seeder).openIndex(1_000n * WAD);

    await token.mint(alice.address, 1_000_000n * WAD);
    await token.connect(alice).approve(vaultAddr, ethers.MaxUint256);

    // samples/sumSq mirror the contract's accumulator exactly, starting from
    // the one zero-move sample seedDeposit produced.
    return {
      risk,
      seeder,
      alice,
      vault,
      vaultAddr,
      token,
      source,
      addr,
      samples: 1n,
      sumSq: 0n,
      // The last price the ORACLE stored, which is the capped one — not the
      // source's raw spot. Both `_observe` and this mirror measure moves
      // against it.
      prevPrice: WAD,
    };
  }

  /**
   * Advance one `minCheckpointInterval` and checkpoint, having first scaled
   * the price by `scaleBps`. Mirrors the contract's accumulator exactly,
   * including the per-observation movement cap and every flooring division, so
   * the expectations elsewhere in this file are exact rather than approximate.
   */
  async function step(fx: any, scaleBps: bigint) {
    if (scaleBps !== 10_000n) await fx.source.scalePrice(scaleBps);
    const eth: bigint = await fx.source.ethReserve();
    const sh: bigint = await fx.source.shareReserve();
    const spot = (eth * WAD) / sh;

    const prev: bigint = fx.prevPrice;
    const hi = (prev * (10_000n + PRICE_CAP_BPS)) / 10_000n;
    const lo = (prev * (10_000n - PRICE_CAP_BPS)) / 10_000n;
    let capped = spot;
    if (capped > hi) capped = hi;
    if (capped < lo) capped = lo;
    if (capped === 0n) capped = 1n;
    const delta = capped > prev ? capped - prev : prev - capped;
    const moveBps = (delta * 10_000n) / prev;

    await time.increase(MIN_CHECKPOINT + 1);
    await fx.vault.checkpoint(fx.addr);

    fx.sumSq += moveBps * moveBps;
    fx.samples += 1n;
    fx.prevPrice = capped;
  }

  const expectedVol = (fx: any) => isqrt(BigInt(fx.sumSq) / BigInt(fx.samples));

  async function setParam(vault: any, risk: any, key: string, value: bigint) {
    await vault.connect(risk).queueParam(ethers.encodeBytes32String(key), value);
    await time.increase(TIMELOCK + 1);
    await vault.executeParam(ethers.encodeBytes32String(key));
  }

  // ══ 1. THE MEASURE ITSELF ═════════════════════════════════════════════

  describe("realizedVolBps", () => {
    it("is ZERO for a constituent whose price has never moved", async () => {
      const fx = await singleLegIndex();
      for (let i = 0; i < 10; i++) await step(fx, 10_000n);
      expect(fx.sumSq).to.equal(0n);
      expect(await fx.vault.realizedVolBps(fx.addr)).to.equal(0n);
    });

    it("is the exact RMS of the settled per-checkpoint moves", async () => {
      const fx = await singleLegIndex();
      // Nine consecutive +3.00% moves. Each is exactly 300 bps at this depth:
      // the source multiplies its ETH reserve by 1.03, the share reserve is
      // fixed, and 1e20 * 1.03^k stays integral for k <= 10 — so there is no
      // rounding to argue about and the expectation can be hand-computed.
      for (let i = 0; i < 9; i++) await step(fx, 10_300n);
      expect(fx.sumSq).to.equal(9n * 300n * 300n);
      expect(fx.samples).to.equal(10n);
      expect(await fx.vault.realizedVolBps(fx.addr)).to.equal(expectedVol(fx));
      // sqrt(9*90000/10) = sqrt(81000) = 284
      expect(await fx.vault.realizedVolBps(fx.addr)).to.equal(284n);
    });

    it("measures the CAPPED move, so a rejected spike cannot inflate the calibration", async () => {
      // The direction matters: a hostile constituent that could inflate the
      // calibration with an un-priced spike would be inflating the gate with a
      // number the oracle itself refused to believe.
      const fx = await singleLegIndex();
      await step(fx, 20_000n); // a 100% spike, capped to 500 bps
      expect(fx.sumSq).to.equal(500n * 500n);
      expect(fx.samples).to.equal(2n);
      // sqrt(250000/2) = sqrt(125000) = 353
      expect(await fx.vault.realizedVolBps(fx.addr)).to.equal(353n);
      expect(await fx.vault.realizedVolBps(fx.addr)).to.equal(expectedVol(fx));

      // A 100x spike records the identical 500 bps — the measure is bounded by
      // the price cap, not by the attacker's budget.
      const fx2 = await singleLegIndex();
      await step(fx2, 1_000_000n);
      expect(await fx2.vault.realizedVolBps(fx2.addr)).to.equal(353n);
    });

    it("counts DOWN moves exactly like up moves — the measure is unsigned", async () => {
      const fx = await singleLegIndex();
      for (let i = 0; i < 6; i++) await step(fx, 9_700n); // -3.00%
      const down: bigint = await fx.vault.realizedVolBps(fx.addr);

      const fx2 = await singleLegIndex();
      for (let i = 0; i < 6; i++) await step(fx2, 10_300n); // +3.00%
      expect(down).to.equal(await fx2.vault.realizedVolBps(fx2.addr));
    });

    it("SURVIVES the 90-day window roll: history tumbles into `prev` instead of being erased", async () => {
      const fx = await singleLegIndex();
      for (let i = 0; i < 20; i++) await step(fx, 10_400n);
      const before: bigint = await fx.vault.realizedVolBps(fx.addr);
      expect(before).to.be.greaterThan(300n);

      // Cross the window boundary. `cur` rolls into `prev` and `cur` restarts,
      // and the read is prev+cur — so the measure must NOT reset to zero, which
      // would hand an attacker a free low-requirement window every 90 days.
      await time.increase(VARIANCE_WINDOW + 1);
      await fx.vault.checkpoint(fx.addr);
      const after: bigint = await fx.vault.realizedVolBps(fx.addr);
      expect(after).to.be.greaterThan(0n);
      // One extra zero-move sample against 21 — a small dilution, not a wipe.
      expect(after).to.be.at.least(before - 20n);
      expect(after).to.be.at.most(before);
    });
  });

  // ══ 2. THE REQUIREMENT, AND ITS CLAMP ═════════════════════════════════

  describe("requiredCheckpointsFor", () => {
    it("with no volatility, reduces exactly to the size-only requirement", async () => {
      const fx = await singleLegIndex();
      for (let i = 0; i < 6; i++) await step(fx, 10_000n);
      expect(await fx.vault.realizedVolBps(fx.addr)).to.equal(0n);

      for (const v of [0n, LARGE_OP - 1n, LARGE_OP, LARGE_OP * 3n, LARGE_OP * 20n]) {
        expect(await fx.vault.requiredCheckpointsFor(fx.addr, v)).to.equal(
          await fx.vault.requiredCheckpoints(v)
        );
      }
    });

    it("the size-only term matches its documented closed form and saturates at OBS_SLOTS", async () => {
      const fx = await singleLegIndex();
      const base = defaultParams.persistenceCheckpoints; // 3
      // Below the large-op threshold there is no scaling at all.
      expect(await fx.vault.requiredCheckpoints(0n)).to.equal(base);
      expect(await fx.vault.requiredCheckpoints(LARGE_OP - 1n)).to.equal(base);
      // required = base + floor(v / unit) - 1
      for (const steps of [1n, 2n, 3n, 5n, 6n, 7n, 50n]) {
        const want = base + steps - 1n;
        expect(await fx.vault.requiredCheckpoints(LARGE_OP * steps)).to.equal(
          want > OBS_SLOTS ? OBS_SLOTS : want
        );
      }
    });

    it("MORE VOLATILITY MEANS MORE CONFIRMATION — the requirement is monotone in realized vol", async () => {
      // Four otherwise-identical constituents, distinguished only by how
      // violently their price has historically moved.
      const results: bigint[] = [];
      const vols: bigint[] = [];
      for (const scale of [10_000n, 10_100n, 10_300n, 10_500n]) {
        const fx = await singleLegIndex();
        for (let i = 0; i < 15; i++) await step(fx, scale);
        vols.push(await fx.vault.realizedVolBps(fx.addr));
        results.push(await fx.vault.requiredCheckpointsFor(fx.addr, LARGE_OP));
      }
      for (let i = 1; i < results.length; i++) {
        expect(vols[i], `vol ${i}`).to.be.greaterThan(vols[i - 1]);
        expect(results[i], `required ${i}`).to.be.at.least(results[i - 1]);
      }
      // And the extremes really are different, so this is not a vacuous
      // non-strict monotonicity assertion.
      expect(results[results.length - 1]).to.be.greaterThan(results[0]);
    });

    it("implements the closed form exactly: size term + vol/100, clamped to [persistenceCheckpoints, 8]", async () => {
      const fx = await singleLegIndex();
      for (let i = 0; i < 9; i++) await step(fx, 10_200n);
      const vol: bigint = await fx.vault.realizedVolBps(fx.addr);
      expect(vol).to.equal(expectedVol(fx));

      const floorReq =
        defaultParams.persistenceCheckpoints < MIN_REQUIRED
          ? MIN_REQUIRED
          : defaultParams.persistenceCheckpoints;
      for (const v of [0n, LARGE_OP, LARGE_OP * 2n, LARGE_OP * 4n, LARGE_OP * 100n]) {
        const size: bigint = await fx.vault.requiredCheckpoints(v);
        let want = size + vol / VOL_STEP_BPS;
        if (want < floorReq) want = floorReq;
        if (want > OBS_SLOTS) want = OBS_SLOTS;
        expect(await fx.vault.requiredCheckpointsFor(fx.addr, v), `value ${v}`).to.equal(want);
      }
    });

    it("THE CEILING HOLDS: no combination of size and volatility can exceed the ring-buffer depth", async () => {
      const fx = await singleLegIndex();
      // Maximum sustainable volatility: every checkpoint moves by the full
      // price cap, which is the most the oracle will ever record.
      for (let i = 0; i < 25; i++) await step(fx, 10_000n + PRICE_CAP_BPS);
      const vol: bigint = await fx.vault.realizedVolBps(fx.addr);
      expect(vol).to.be.at.least(480n); // ~500 bps RMS, floored at every step
      // vol/100 alone is already ~4, plus a huge size term.
      for (const v of [LARGE_OP * 1_000n, ethers.parseEther("1000000000")]) {
        expect(await fx.vault.requiredCheckpointsFor(fx.addr, v)).to.equal(OBS_SLOTS);
      }
      // A requirement deeper than the retained history would brick both priced
      // paths outright, so the ceiling IS the ring-buffer depth.
      expect(OBS_SLOTS).to.equal(8n);
    });

    it("THE FLOOR HOLDS: a perfectly quiet constituent still needs `persistenceCheckpoints`, and governance cannot go below 2", async () => {
      const fx = await singleLegIndex();
      const { vault, risk, addr } = fx;
      for (let i = 0; i < 8; i++) await step(fx, 10_000n);
      expect(await vault.realizedVolBps(addr)).to.equal(0n);
      expect(await vault.requiredCheckpointsFor(addr, 0n)).to.equal(
        defaultParams.persistenceCheckpoints
      );

      // The lowest value governance can install is 2, which is exactly
      // MIN_REQUIRED_CHECKPOINTS — so the compile-time floor is belt-and-braces
      // rather than the only thing holding the line. Both are asserted.
      await setParam(vault, risk, "persistenceCheckpoints", 2n);
      expect(await vault.requiredCheckpointsFor(addr, 0n)).to.equal(MIN_REQUIRED);

      const key = ethers.encodeBytes32String("persistenceCheckpoints");
      for (const bad of [0n, 1n, 9n]) {
        await vault.connect(risk).queueParam(key, bad);
        await time.increase(TIMELOCK + 1);
        await expect(vault.executeParam(key)).to.be.revertedWithCustomError(vault, "BadParam");
      }
      expect(await vault.requiredCheckpointsFor(addr, 0n)).to.equal(MIN_REQUIRED);
    });
  });

  // ══ 3. THE ANTI-GAMING ARGUMENT, DRIVEN ═══════════════════════════════

  describe("the calibration cannot be gamed by a short burst of self-induced volatility", () => {
    it("a burst pushes the requirement UP, which is the direction that costs the attacker", async () => {
      // The whole reason this is safe to compute from a manipulable price
      // series: the only thing an attacker buys by thrashing their own pool is
      // a LONGER confirmation window on their own extraction.
      const fx = await singleLegIndex();
      for (let i = 0; i < 30; i++) await step(fx, 10_000n); // long, quiet history
      const quiet: bigint = await fx.vault.requiredCheckpointsFor(fx.addr, LARGE_OP * 2n);

      for (let i = 0; i < 6; i++) await step(fx, 10_000n + PRICE_CAP_BPS); // the burst
      const afterBurst: bigint = await fx.vault.requiredCheckpointsFor(fx.addr, LARGE_OP * 2n);
      expect(afterBurst).to.be.at.least(quiet);
    });

    it("and it cannot push the requirement DOWN: the burst is diluted by the long window", async () => {
      // The attack that would actually pay is the reverse one — manufacture a
      // history quiet enough to SHRINK the requirement. Against a constituent
      // with real volatility on the books, a short burst of manufactured quiet
      // barely moves the denominator.
      const fx = await singleLegIndex();
      for (let i = 0; i < 60; i++) await step(fx, 10_000n + PRICE_CAP_BPS); // real vol
      const volatile: bigint = await fx.vault.realizedVolBps(fx.addr);
      const req: bigint = await fx.vault.requiredCheckpointsFor(fx.addr, LARGE_OP);

      // Ten manufactured zero-move checkpoints, which is already a burst an
      // attacker has to pay for in gas and in chain time.
      for (let i = 0; i < 10; i++) await step(fx, 10_000n);
      const after: bigint = await fx.vault.realizedVolBps(fx.addr);

      // The RMS fell — it must, that is what a mean does — but only slightly,
      // and the requirement did not move at all.
      expect(after).to.be.lessThan(volatile);
      expect(after * 100n).to.be.greaterThan(volatile * 85n); // < 15% erosion
      expect(await fx.vault.requiredCheckpointsFor(fx.addr, LARGE_OP)).to.equal(req);
      // Independently: the measure matches the mirrored accumulator, so the
      // dilution above is arithmetic and not an artefact.
      expect(after).to.equal(expectedVol(fx));
    });

    it("the ASYMMETRY is structural: the calibration window is orders of magnitude longer than the window it scales", async () => {
      const fx = await singleLegIndex();
      // VARIANCE_WINDOW / minCheckpointInterval is the number of checkpoints
      // an attacker would have to dominate to move the calibration, against
      // the handful the persistence gate itself looks at.
      const calibrationSamples = BigInt(VARIANCE_WINDOW) / BigInt(MIN_CHECKPOINT);
      const shortWindow = OBS_SLOTS;
      expect(calibrationSamples / shortWindow).to.be.greaterThan(1_000n);

      // And whatever happens to the calibration, the answer stays inside the
      // compile-time box. This is the defence that does not depend on the
      // statistics being right.
      for (let i = 0; i < 40; i++) {
        await step(fx, i % 2 === 0 ? 10_000n + PRICE_CAP_BPS : 10_000n - PRICE_CAP_BPS);
      }
      for (const v of [0n, 1n, LARGE_OP, ethers.parseEther("10000000")]) {
        const r: bigint = await fx.vault.requiredCheckpointsFor(fx.addr, v);
        expect(r).to.be.at.least(MIN_REQUIRED);
        expect(r).to.be.at.most(OBS_SLOTS);
      }
    });
  });

  // ══ 4. THE GATE THE CALIBRATION FEEDS ═════════════════════════════════

  describe("the priced paths gate on the CALIBRATED requirement", () => {
    it("a large operation on a THRASHING constituent is refused, and the same one on a quiet leg is not", async () => {
      // Quiet leg: a big single-asset mint clears the persistence gate.
      const quiet = await singleLegIndex();
      for (let i = 0; i < 8; i++) await step(quiet, 10_000n);
      expect(await quiet.vault.realizedVolBps(quiet.addr)).to.equal(0n);
      await expect(quiet.vault.connect(quiet.alice).mintSingleAsset(quiet.addr, 100n * WAD, 0n))
        .to.not.be.reverted;

      // Thrashing leg: identical size, identical parameters, refused — both
      // because the requirement rose and because a band that is moving cannot
      // satisfy it. That conjunction IS the gate.
      const wild = await singleLegIndex();
      // Eight consecutive full-cap steps: the most a truncated oracle will
      // ever record, and a band that is visibly still moving.
      for (let i = 0; i < 8; i++) await step(wild, 10_000n + PRICE_CAP_BPS);
      expect(await wild.vault.realizedVolBps(wild.addr)).to.be.greaterThan(400n);
      // At 2x the large-op unit the size term alone is 4; the volatility term
      // adds ~4 more and the clamp takes it to the ceiling. Picking a size
      // BELOW saturation is what makes this show the calibration doing work
      // rather than the size term already being maxed out.
      expect(
        await wild.vault.requiredCheckpointsFor(wild.addr, LARGE_OP * 2n)
      ).to.be.greaterThan(await wild.vault.requiredCheckpoints(LARGE_OP * 2n));
      await expect(
        wild.vault.connect(wild.alice).mintSingleAsset(wild.addr, 100n * WAD, 0n)
      ).to.be.revertedWithCustomError(wild.vault, "PersistenceCheckFailed");
    });

    it("small operations are never gated at all, whatever the volatility", async () => {
      const fx = await singleLegIndex();
      for (let i = 0; i < 10; i++) {
        await step(fx, i % 2 === 0 ? 10_000n + PRICE_CAP_BPS : 10_000n - PRICE_CAP_BPS);
      }
      expect(await fx.vault.realizedVolBps(fx.addr)).to.be.greaterThan(400n);
      // Under `largeOpValueWei` the gate does not run — ordinary retail flow
      // stays instant, which is the documented design.
      const [lo] = await fx.vault.priceBand(fx.addr);
      const smallUnits = (LARGE_OP * WAD) / lo / 2n; // ~half a "large op" in value
      expect(smallUnits).to.be.greaterThan(0n);
      await expect(fx.vault.connect(fx.alice).mintSingleAsset(fx.addr, smallUnits, 0n)).to.not.be
        .reverted;
    });

    it("persistenceHolds (the fixed-N view) and the calibrated form can disagree, and the priced paths use the calibrated one", async () => {
      const fx = await singleLegIndex();
      for (let i = 0; i < 8; i++) await step(fx, 10_300n); // persistent drift
      const fixedN: bigint = defaultParams.persistenceCheckpoints;
      const calibrated: bigint = await fx.vault.requiredCheckpointsFor(fx.addr, LARGE_OP * 3n);
      expect(calibrated).to.be.greaterThan(fixedN);

      // The fixed-N view is what a UI should read; it is deliberately NOT what
      // the gate enforces, and the two are asserted to be distinguishable so a
      // future refactor cannot quietly collapse them.
      expect(await fx.vault.persistenceHolds(fx.addr)).to.equal(
        await fx.vault.persistenceHoldsFor(fx.addr, fixedN)
      );
      expect(await fx.vault.requiredCheckpoints(LARGE_OP * 3n)).to.be.lessThan(calibrated);
    });
  });
});
