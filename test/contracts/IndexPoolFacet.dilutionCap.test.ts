import { expect } from "chai";
import { ethers, network } from "./helpers/hardhat.js";
import { time, takeSnapshot, type SnapshotRestorer } from "./helpers/network-helpers.js";
import { deployOpenIndex, WAD, TIMELOCK, BPS } from "./helpers/index-vault.js";

/**
 * ============================================================================
 * IndexPoolFacet — §7.10 dilution-cap fix (adversarial review, 2026-08-06).
 *
 * THE FINDING THIS SUITE PROVES CLOSED: `deployToIndexPool` mints new index-
 * coin shares directly to the pool, growing `totalSupply`. `redeemProRata`
 * (`IndexCoreFacet.sol`) and `_previewSingleExit`'s pricing path
 * (`IndexValuation.previewSingleExit`) are BOTH deliberately price-free — they
 * divide by raw `totalSupply` and pay out raw `c.reserve` per constituent,
 * never reading the pool at all (`IndexCoreFacet.sol`'s own header: "it reads
 * no price"). The pool itself has no redemption path, so shares minted to it
 * are permanently unredeemable weight in that denominator: every deploy call
 * dilutes every other holder's REAL, immediately-realizable `redeemProRata`/
 * `redeemSingleAsset` payout, even while `nav()/totalSupply` (which DOES fold
 * the pool back in) looks perfectly healthy. `IndexPoolFacet.test.ts`'s
 * existing "redemption-value-neutral" test only checks `nav()` — a different
 * quantity from what `redeemProRata` actually pays out — which is exactly why
 * it did not catch this.
 *
 * THE FIX (`IndexPoolFacet.deployToIndexPool`'s header has the full
 * derivation of why this is the shipped approach and not a fold-in): folding
 * the pool's position into `redeemProRata`'s per-leg accounting is NOT sound
 * here, because `redeemProRata`/`_payOrDefer` pay out of this contract's own
 * token balance, never the pool's, and `IndexCoinPool` has no withdraw path
 * back to the vault. So the shipped fix instead BOUNDS the dilution: a
 * governed, timelocked cap (`PoolStorage.maxPoolShareBps`, default 5%, hard
 * ceiling 20%) on cumulative shares ever minted to the pool, as a fraction of
 * `totalSupply`, enforced on every `deployToIndexPool` call.
 *
 * This suite exercises the REAL invariant that matters — calling
 * `redeemProRata` before and after a deploy and measuring the actual token
 * payout, not `nav()` — and proves the cap makes the resulting dilution a
 * disclosed, bounded, provably-enforced maximum instead of an unbounded,
 * silently-compounding leak.
 * ============================================================================
 */
describe("IndexPoolFacet dilution cap (adversarial-review fix, 2026-08-06)", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  async function fixtureWithPool() {
    const fx = await deployOpenIndex();
    const paymentToken = fx.addrs[0]; // dividendAsset
    const Pool = await ethers.getContractFactory("IndexCoinPool");
    const pool: any = await Pool.deploy(paymentToken, fx.vaultAddr, fx.vaultAddr);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();
    await fx.vault.connect(fx.risk).queueIndexPool(poolAddr);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeIndexPool();
    await fx.vault.checkpointAll();
    return { ...fx, pool, poolAddr, paymentToken };
  }

  it("seeds the default 5% cap the instant the pool activates, not zero", async () => {
    const fx = await fixtureWithPool();
    expect(await fx.vault.maxPoolShareBps()).to.equal(500n);
    expect(await fx.vault.poolSharesMinted()).to.equal(0n);
  });

  // ══ THE REAL INVARIANT: redeemProRata's ACTUAL payout, not nav() ═══════

  it("bounds the REAL per-share redeemProRata payout decrease to the governed cap — the exact gap nav()-only tests missed", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[2]; // constituent drawn down for pricing/depth
    const untouchedLeg = 1; // c1's own reserve is NEVER touched by a deploy
                            // against a different shareToken — isolates the
                            // dilution effect from any reserve-level change.

    // Give alice a real, redeemable balance via the ordinary free mint path.
    const n = 3;
    await fx.vault
      .connect(fx.alice)
      .mintProRata(50n * WAD, [ethers.MaxUint256, ethers.MaxUint256, ethers.MaxUint256]);

    const supplyBefore: bigint = await fx.vault.totalSupply();
    const sharesIn = 10n * WAD;
    const minOut = new Array(n).fill(0n);

    const outBefore: bigint[] = await fx.vault
      .connect(fx.alice)
      .redeemProRata.staticCall(sharesIn, minOut);
    const untouchedReserveRatioBefore = outBefore[untouchedLeg];

    // Deploy up to (but not past) the 5% cap. Each call must succeed while
    // cumulative pool shares stay under the cap.
    for (let i = 0; i < 200; i++) {
      const poolShares: bigint = await fx.vault.poolSharesMinted();
      const supplyNow: bigint = await fx.vault.totalSupply();
      if ((poolShares * BPS) / supplyNow >= 480n) break; // stop just under 5%
      await fx.vault.connect(fx.bob).deployToIndexPool(shareToken, 3n * WAD);
    }

    const poolSharesFinal: bigint = await fx.vault.poolSharesMinted();
    const supplyAfter: bigint = await fx.vault.totalSupply();
    const capBps: bigint = await fx.vault.maxPoolShareBps();

    // The cap itself actually holds, on-chain, as measured.
    expect((poolSharesFinal * BPS) / supplyAfter).to.be.lte(capBps);
    expect(poolSharesFinal).to.be.gt(0n);
    expect(supplyAfter).to.be.gt(supplyBefore);

    const outAfter: bigint[] = await fx.vault
      .connect(fx.alice)
      .redeemProRata.staticCall(sharesIn, minOut);
    const untouchedReserveRatioAfter = outAfter[untouchedLeg];

    // c1's own reserve was never touched by any deploy against c2 — the ratio
    // moved ONLY because of totalSupply growth from pool minting. Bound the
    // REAL measured decrease against the cap's own guarantee: a holder can
    // never lose more than `capBps` worth of their `redeemProRata` payout to
    // this mechanism, no matter how many deploys land.
    expect(untouchedReserveRatioAfter).to.be.lte(untouchedReserveRatioBefore);
    const decreaseBps =
      ((untouchedReserveRatioBefore - untouchedReserveRatioAfter) * BPS) / untouchedReserveRatioBefore;
    expect(decreaseBps).to.be.lte(capBps);

    // And it is EXACTLY explained by supply growth (no other value moved for
    // this untouched leg) — floor-rounding aside, matching the closed-form
    // prediction confirms the cap bounds the exact mechanism the review
    // found, not a coincidentally-small number.
    const predicted = (untouchedReserveRatioBefore * supplyBefore) / supplyAfter;
    const diff =
      predicted > untouchedReserveRatioAfter
        ? predicted - untouchedReserveRatioAfter
        : untouchedReserveRatioAfter - predicted;
    expect(diff).to.be.lte(1_000n);
  });

  it("reverts once a further deploy would push cumulative pool shares over the cap", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[2];

    // Drive pool shares right up against the 5% default cap, using a small
    // enough per-call draw (and a comfortable stop margin) that no single
    // call itself overshoots the cap outright.
    for (let i = 0; i < 500; i++) {
      const poolShares: bigint = await fx.vault.poolSharesMinted();
      const supplyNow: bigint = await fx.vault.totalSupply();
      if ((poolShares * BPS) / supplyNow >= 450n) break;
      await fx.vault.connect(fx.alice).deployToIndexPool(shareToken, 1n * WAD);
    }

    // A further large deploy would blow through the cap and must revert —
    // not silently under-mint, not silently succeed.
    await expect(
      fx.vault.connect(fx.alice).deployToIndexPool(shareToken, 500n * WAD)
    ).to.be.revertedWithCustomError(fx.vault, "PoolShareCapExceeded");
  });

  // ══ Governance surface over the cap itself ═════════════════════════════

  it("gates maxPoolShareBps changes behind the same queue/execute timelock as everything else, with a hard ceiling", async () => {
    const fx = await fixtureWithPool();

    await expect(
      fx.vault.connect(fx.alice).queueMaxPoolShareBps(1_000n)
    ).to.be.revertedWithCustomError(fx.vault, "NotRoleHolder");

    // Cannot govern past the hard, non-governable 20% ceiling.
    await expect(
      fx.vault.connect(fx.risk).queueMaxPoolShareBps(2_001n)
    ).to.be.revertedWithCustomError(fx.vault, "BadParam");

    await fx.vault.connect(fx.risk).queueMaxPoolShareBps(1_000n);
    await expect(fx.vault.executeMaxPoolShareBps()).to.be.revertedWithCustomError(
      fx.vault,
      "TimelockNotElapsed"
    );
    expect(await fx.vault.maxPoolShareBps()).to.equal(500n); // unchanged until executed

    await time.increase(TIMELOCK + 1);
    await fx.vault.executeMaxPoolShareBps();
    expect(await fx.vault.maxPoolShareBps()).to.equal(1_000n);
  });
});
