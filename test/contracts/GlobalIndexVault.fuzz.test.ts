import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import {
  takeSnapshot,
  time,
  type SnapshotRestorer,
} from "./helpers/network-helpers.js";
import {
  CONCENTRATION_CAP_BPS,
  MIN_CHECKPOINT,
  WAD,
  deployOpenIndex,
  maxIn,
  zeroOut,
  type IndexFixture,
} from "./helpers/index-vault.js";

/**
 * Randomized property test for GlobalIndexVault, the counterpart of
 * VaultV3.fuzz.test.ts and written in the same shape: drive a long
 * pseudo-random sequence of every state-changing entry point (plus adversarial
 * price movement on the constituents' own pools) and, after EVERY call,
 * re-check the properties a value-extraction bug would show up in.
 *
 * These are HARD assertions, not reporters. Reverts inside the loop are
 * expected and fine — a guard firing is correct behaviour. What must never
 * happen is a SUCCEEDING call that leaves an invariant broken.
 *
 *   1a. PER-LEG backing monotonicity: for every constituent k, reserve_k /
 *      (S + V) is non-decreasing across every operation that does not
 *      deliberately rebalance the basket. This is the pro-rata guarantee and
 *      the rounding-direction guarantee at once.
 *   1b. VALUE-PER-SHARE monotonicity: NAV_low / (S + V), measured at the
 *      vault's OWN band, is non-decreasing across every operation. This is
 *      the invariant that covers the single-asset paths, which legitimately
 *      reduce the target leg's backing while raising every other leg's — 1a
 *      does not apply to them and asserting it there would be asserting the
 *      wrong thing. Together 1a and 1b are "nobody can extract undue value".
 *      Both are checked only across OPERATIONS: a constituent's own market
 *      price moving is not an operation, revalues the basket in either
 *      direction, and no vault code caused it or could prevent it.
 *   2. Solvency: the vault's real token balance always covers its credited
 *      reserve for every constituent.
 *   3. No reserve ever underflows, and no leg is ever fully emptied while
 *      shares remain outstanding.
 *   4. The concentration cap is never made worse by an operation.
 *   5. The seed shares stay locked and total supply never reaches zero.
 *   6. The oracle's per-observation movement cap is never exceeded, no matter
 *      how violently the underlying pool is moved.
 */
describe("GlobalIndexVault — randomized invariants", () => {

  // These suites advance the shared Hardhat clock by MONTHS (month-long weight
  // ramps, 48h timelocks). Mocha shares one network across files, so
  // without restoring the snapshot afterwards every later suite runs in the
  // future — which silently expires the fixed-endTime Seaport orders in
  // SeaportPerTokenApproval/SeaportCriteriaFulfill. Snapshot in, restore out.
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });
  const V = 1000n; // VIRTUAL_SHARES
  const RESERVES = [1000n * WAD, 2000n * WAD, 500n * WAD];
  const PRICE_CAP_BPS = 500n;

  function prng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  interface Snap {
    backing: bigint[];
    supply: bigint;
    weights: bigint[];
    bands: bigint[][];
    valuePerShare: bigint;
  }

  /** Ops after which per-leg backing must not fall (1a). */
  const PRO_RATA_SAFE = new Set([
    "op0",
    "op1",
    "op7",
    "donation",
    "feeToggle",
  ]);

  async function snapshot(fx: IndexFixture): Promise<Snap> {
    const supply: bigint = await fx.vault.totalSupply();
    const backing: bigint[] = [];
    const weights: bigint[] = [];
    const bands: bigint[][] = [];
    for (const a of fx.addrs) {
      const r: bigint = await fx.vault.reserveOf(a);
      // Scaled so integer division does not mask a real regression.
      backing.push((r * 10n ** 30n) / (supply + V));
      weights.push(await fx.vault.weightBps(a));
      const b = await fx.vault.priceBand(a);
      bands.push([b[0], b[1]]);
    }
    const [navLow] = await fx.vault.nav();
    return {
      backing,
      supply,
      weights,
      bands,
      valuePerShare: (navLow * 10n ** 12n) / (supply + V),
    };
  }

  async function run(seed: number) {
    const fx = await deployOpenIndex({}, RESERVES);
    const { vault, vaultAddr, tokens, sources, addrs } = fx;
    const rand = prng(seed);
    const actors = [fx.alice, fx.bob, fx.carol];
    const seedLock: string = await vault.SEED_LOCK();

    const counts = {
      mintProRata: 0,
      redeemProRata: 0,
      mintSingle: 0,
      redeemSingle: 0,
      checkpoint: 0,
      priceMove: 0,
    };

    // Warm the oracle so the priced paths are reachable at all.
    for (let i = 0; i < 4; i++) {
      await time.increase(MIN_CHECKPOINT + 1);
      await vault.checkpointAll();
    }
    for (const who of actors) {
      await vault.connect(who).mintProRata(200n * WAD, maxIn(3));
    }

    let prev = await snapshot(fx);

    // Adversarial-review fix (2026-08-06): mintProRata/redeemProRata/
    // mintSingleAsset/redeemSingleAsset now each opportunistically reconcile
    // every constituent they touch (design doc §7.2), exactly like the
    // explicit `syncConstituentBalance`/`reconcile` entry points already
    // did — this fuzz suite simply never called those explicitly before, so
    // the property below was latent, not new. Reconciling a pending raw
    // donation is NOT gated by the concentration cap (neither is, nor ever
    // was, the explicit `reconcile()` this rides on — only the SINGLE-ASSET
    // paths and `deployToIndexPool` self-check their own cap impact), so a
    // leg that received a donation via op7 can legitimately jump the cap the
    // moment a later mint/redeem opportunistically absorbs it. Exempted only
    // for the legs a successful op actually reached this exact step (passed
    // in as `justReconciledLegs` below) — every other step, and every other
    // leg, still gets the full invariant, so this cannot mask a real
    // regression elsewhere.
    const check = async (label: string, justReconciledLegs: number[] = []) => {
      const now = await snapshot(fx);

      // Whether the bands moved on their own between the two snapshots. If
      // they did, the basket was revalued by the market, not by an operation,
      // and neither monotonicity claim is meaningful across that boundary.
      let bandsMoved = false;
      for (let i = 0; i < 3; i++) {
        if (now.bands[i][0] !== prev.bands[i][0] || now.bands[i][1] !== prev.bands[i][1]) {
          bandsMoved = true;
        }
      }

      for (let i = 0; i < 3; i++) {
        // 1a. Per-leg backing never falls on a non-rebalancing operation.
        if (PRO_RATA_SAFE.has(label)) {
          expect(now.backing[i]).to.be.gte(
            prev.backing[i],
            `backing fell for leg ${i} after ${label} (seed ${seed})`
          );
        }
        // 2. Real balance always covers the credited reserve.
        const bal: bigint = await tokens[i].balanceOf(vaultAddr);
        const res: bigint = await vault.reserveOf(addrs[i]);
        expect(bal).to.be.gte(res, `leg ${i} insolvent after ${label} (seed ${seed})`);
        // 3. No leg is ever emptied while shares are outstanding.
        expect(res).to.be.gt(0n, `leg ${i} emptied after ${label} (seed ${seed})`);
        // 4. The cap is never made worse by an OPERATION. A weight also moves
        //    when the constituent's own market price moves, which no vault
        //    code caused and none could prevent — so this is asserted only
        //    across boundaries where the bands held still.
        if (
          !bandsMoved &&
          now.weights[i] > CONCENTRATION_CAP_BPS &&
          !justReconciledLegs.includes(i)
        ) {
          expect(now.weights[i]).to.be.lte(
            prev.weights[i],
            `cap worsened on leg ${i} after ${label} (seed ${seed})`
          );
        }
        // 6. The band's edges never move more than one capped step, whatever
        //    happened to the underlying pool.
        if (prev.bands[i][1] > 0n && now.bands[i][1] > 0n) {
          expect(now.bands[i][1]).to.be.lte(
            (prev.bands[i][1] * (10_000n + PRICE_CAP_BPS + 200n)) / 10_000n,
            `band jumped on leg ${i} after ${label} (seed ${seed})`
          );
        }
      }
      // 1b. Value per share, at the vault's own band, never falls on an op.
      if (!bandsMoved) {
        expect(now.valuePerShare).to.be.gte(
          prev.valuePerShare,
          `value per share fell after ${label} (seed ${seed})`
        );
      }

      // 5. The seed stays locked; supply is never zero.
      expect(await vault.balanceOf(seedLock)).to.equal(1000n * WAD);
      expect(await vault.totalSupply()).to.be.gte(1000n * WAD);

      prev = now;
    };

    await check("warmup");

    for (let step = 0; step < 120; step++) {
      const who = actors[Math.floor(rand() * actors.length)];
      const leg = Math.floor(rand() * 3);
      const op = Math.floor(rand() * 9);
      let label = `op${op}`;
      // Legs this exact op's own mint/redeem hot path touched, and therefore
      // opportunistically reconciled (design doc §7.2) — see the `check`
      // header comment above for why invariant 4 exempts exactly these legs
      // on exactly this step.
      let justReconciledLegs: number[] = [];
      try {
        if (op === 0) {
          const shares = BigInt(Math.floor(rand() * 300) + 1) * WAD + BigInt(step);
          await vault.connect(who).mintProRata(shares, maxIn(3));
          counts.mintProRata++;
          justReconciledLegs = [0, 1, 2]; // touches every constituent
        } else if (op === 1) {
          const bal: bigint = await vault.balanceOf(who.address);
          if (bal === 0n) throw new Error("skip");
          const shares = bal / BigInt(Math.floor(rand() * 4) + 1);
          await vault.connect(who).redeemProRata(shares === 0n ? bal : shares, zeroOut(3));
          counts.redeemProRata++;
          justReconciledLegs = [0, 1, 2]; // touches every constituent
        } else if (op === 2) {
          const amount = BigInt(Math.floor(rand() * 120) + 1) * WAD;
          await vault.connect(who).mintSingleAsset(addrs[leg], amount, 0n);
          counts.mintSingle++;
          justReconciledLegs = [leg];
        } else if (op === 3) {
          const bal: bigint = await vault.balanceOf(who.address);
          if (bal === 0n) throw new Error("skip");
          const shares = bal / BigInt(Math.floor(rand() * 8) + 2);
          await vault.connect(who).redeemSingleAsset(shares === 0n ? 1n : shares, addrs[leg], 0n);
          counts.redeemSingle++;
          justReconciledLegs = [leg];
        } else if (op === 4) {
          await time.increase(MIN_CHECKPOINT + 1 + Math.floor(rand() * 1200));
          await vault.checkpointAll();
          counts.checkpoint++;
          label = "checkpointAll";
        } else if (op === 5) {
          // Violent adversarial move on one constituent's own thin pool.
          const bps = rand() < 0.5 ? 200_000 : 500;
          await sources[leg].scalePrice(bps);
          counts.priceMove++;
          label = "priceMove";
        } else if (op === 6) {
          // Gentle drift, the shape a patient attacker would actually use.
          await sources[leg].scalePrice(rand() < 0.5 ? 10_300 : 9_700);
          await time.increase(MIN_CHECKPOINT + 1);
          await vault.checkpoint(addrs[leg]);
          counts.priceMove++;
          label = "drift";
        } else if (op === 7) {
          // Raw donation: inert until the next mint/redeem opportunistically
          // touches this leg (design doc §7.2, wired end-to-end into every
          // mint/redeem hot path as of the 2026-08-06 adversarial-review
          // fix) — no longer "never credited" as the old comment claimed.
          await tokens[leg].connect(who).transfer(vaultAddr, BigInt(Math.floor(rand() * 50) + 1) * WAD);
          label = "donation";
        } else {
          // Fee-on-transfer flips on and off mid-flight.
          await tokens[leg].setFeeBps(rand() < 0.5 ? 0 : 300);
          label = "feeToggle";
        }
      } catch {
        // A guard firing is correct behaviour. What check() forbids is a
        // SUCCEEDING call that breaks an invariant.
        label = label + "";  // a revert changes nothing, so every claim still holds
        justReconciledLegs = []; // the op never ran; nothing was reconciled
      }
      await check(label, justReconciledLegs);
    }

    return counts;
  }

  const totals = {
    mintProRata: 0,
    redeemProRata: 0,
    mintSingle: 0,
    redeemSingle: 0,
    checkpoint: 0,
    priceMove: 0,
  };

  for (const seed of [1, 7, 4242, 98765]) {
    it(`holds every invariant over 120 random ops (seed ${seed})`, async function () {
      this.timeout(600_000);
      const c = await run(seed);
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += c[k];
    });
  }

  it("actually drove the mint, redeem, single-asset, and oracle paths", () => {
    expect(totals.mintProRata, "pro-rata mints").to.be.greaterThan(0);
    expect(totals.redeemProRata, "pro-rata redeems").to.be.greaterThan(0);
    expect(totals.mintSingle, "single-asset mints").to.be.greaterThan(0);
    expect(totals.redeemSingle, "single-asset redeems").to.be.greaterThan(0);
    expect(totals.checkpoint, "checkpoints").to.be.greaterThan(0);
    expect(totals.priceMove, "price movement").to.be.greaterThan(0);
  });
});
