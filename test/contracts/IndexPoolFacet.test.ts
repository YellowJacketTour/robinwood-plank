import { expect } from "chai";
import { ethers, network } from "./helpers/hardhat.js";
import { time, takeSnapshot, type SnapshotRestorer } from "./helpers/network-helpers.js";
import { deployOpenIndex, WAD, TIMELOCK } from "./helpers/index-vault.js";

/**
 * ============================================================================
 * IndexPoolFacet — design doc §7.10, 2026-08-06 task brief.
 *
 * Proves the five guarantees the task brief names:
 *   1. `deployToIndexPool` prices identically to what an external
 *      `mintSingleAsset` depositor gets — no favorable self-dealing.
 *   2. The deploy action is redemption-value-neutral (§7.4's invariant holds
 *      across the call — moving value from `c.reserve` into an LP position
 *      is a wash at the moment it happens).
 *   3. The pool's own 1% fee compounds into its own reserves.
 *   4. The closed-form valuation tracks real reserve changes after simulated
 *      trading (not stale).
 *   5. A same-block swap immediately followed by a deploy or single-asset
 *      mint/redeem is refused by the same-block guard — the explicit
 *      staleness mitigation the brief asks for.
 * ============================================================================
 */
describe("IndexPoolFacet (design doc §7.10)", () => {
  // This suite advances the shared Hardhat clock by the full timelock delay
  // (48h) to exercise `queueIndexPool`/`executeIndexPool`. Mocha shares ONE
  // network across every test file, so without restoring afterwards, that
  // jump would silently expire the fixed-endTime Seaport orders the later
  // Seaport suites sign — the exact contamination `ScopedRoles.isolation.test.ts`'s
  // own header already documents and guards against the same way.
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  it("queueIndexPool/executeIndexPool is timelocked like every other risk-surface change — no direct setter", async () => {
    const fx = await deployOpenIndex();
    const paymentToken = fx.addrs[0];
    const Pool = await ethers.getContractFactory("IndexCoinPool");
    const pool: any = await Pool.deploy(paymentToken, fx.vaultAddr, fx.vaultAddr);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    await expect(fx.vault.connect(fx.alice).queueIndexPool(poolAddr)).to.be.revertedWithCustomError(
      fx.vault,
      "NotRoleHolder"
    );
    await fx.vault.connect(fx.risk).queueIndexPool(poolAddr);
    await expect(fx.vault.executeIndexPool()).to.be.revertedWithCustomError(fx.vault, "TimelockNotElapsed");
    expect(await fx.vault.indexPool()).to.equal(ethers.ZeroAddress);

    await time.increase(TIMELOCK + 1);
    await fx.vault.executeIndexPool();
    expect(await fx.vault.indexPool()).to.equal(poolAddr);

    // One-way latch: cannot be queued again once set.
    await expect(fx.vault.connect(fx.risk).queueIndexPool(poolAddr)).to.be.revertedWithCustomError(
      fx.vault,
      "PoolAlreadySet"
    );
  });


  async function fixtureWithPool() {
    const fx = await deployOpenIndex();
    const paymentToken = fx.addrs[0]; // dividendAsset, per deployOpenIndex
    const Pool = await ethers.getContractFactory("IndexCoinPool");
    const pool: any = await Pool.deploy(paymentToken, fx.vaultAddr, fx.vaultAddr);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();
    await fx.vault.connect(fx.risk).queueIndexPool(poolAddr);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeIndexPool();
    // The timelock wait is long enough to stale out every constituent's
    // price band (default `staleAfter` is far shorter) — refresh it, same as
    // `warmCheckpoints` does elsewhere in this suite, so pricing-dependent
    // calls below see live bands rather than `StalePrice()`.
    await fx.vault.checkpointAll();
    return { ...fx, pool, poolAddr, paymentToken };
  }

  // ══ 1. No favorable self-dealing ═════════════════════════════════════

  it("prices a deploy identically to what an external mintSingleAsset depositor gets", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    const amount = 10n * WAD;

    const externalShares: bigint = await fx.vault
      .connect(fx.alice)
      .mintSingleAsset.staticCall(shareToken, amount, 0n);
    const deploySharesMinted: bigint = await fx.vault
      .connect(fx.alice)
      .deployToIndexPool.staticCall(shareToken, amount);

    expect(deploySharesMinted).to.equal(externalShares);
  });

  // ══ 2. Redemption-value-neutral ══════════════════════════════════════

  it("is redemption-value-neutral: nav/totalSupply does not decrease across a deploy call", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    const amount = 25n * WAD;

    const [navLowBefore] = await fx.vault.nav();
    const supplyBefore: bigint = await fx.vault.totalSupply();
    const rvBefore = (navLowBefore * WAD) / supplyBefore;

    await fx.vault.connect(fx.alice).deployToIndexPool(shareToken, amount);

    const [navLowAfter] = await fx.vault.nav();
    const supplyAfter: bigint = await fx.vault.totalSupply();
    const rvAfter = (navLowAfter * WAD) / supplyAfter;

    expect(rvAfter).to.be.gte(rvBefore);
  });

  it("caps the drawn-down share amount at what is actually in reserve", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    const reserve: bigint = await fx.vault.reserveOf(shareToken);

    await expect(
      fx.vault.connect(fx.alice).deployToIndexPool(shareToken, reserve + 1n)
    ).to.be.revertedWithCustomError(fx.vault, "InsufficientPoolFunding");
  });

  // ══ 3. The pool's own fee compounds into its own reserve ══════════════

  it("compounds its 1% swap fee directly into its own reserves (no distribution)", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    await fx.vault.connect(fx.alice).deployToIndexPool(shareToken, 100n * WAD);

    const [reservePayment0, reserveCoin0] = await fx.pool.getReserves();
    const k0 = reservePayment0 * reserveCoin0;

    // A payment-in swap, then an equal-and-opposite-direction coin-in swap.
    // With a zero fee this round trip would leave `k` exactly unchanged; the
    // 1% fee on EACH leg strictly grows it, and reserves are never anyone's
    // to withdraw — only the pool's own accounting can be checked.
    const paymentToken = await ethers.getContractAt("MockIndexToken", fx.paymentToken);
    await paymentToken.mint(fx.bob.address, 5n * WAD);
    const bobPaymentBefore: bigint = await paymentToken.balanceOf(fx.bob.address);
    await paymentToken.connect(fx.bob).approve(fx.poolAddr, ethers.MaxUint256);
    await fx.pool.connect(fx.bob).swap(true, 5n * WAD, 0n, fx.bob.address);

    const coinOut: bigint = await fx.vault.balanceOf(fx.bob.address);
    await fx.vault.connect(fx.bob).approve(fx.poolAddr, ethers.MaxUint256);
    await fx.pool.connect(fx.bob).swap(false, coinOut, 0n, fx.bob.address);

    const [reservePayment1, reserveCoin1] = await fx.pool.getReserves();
    const k1 = reservePayment1 * reserveCoin1;

    expect(k1).to.be.gt(k0);
    // Bob round-tripped payment -> coin -> payment and paid ~2% total in
    // fees, so he ends up with strictly LESS payment token than he started
    // with — the fee left the trader's hands and stayed in the pool.
    const bobPaymentAfter: bigint = await paymentToken.balanceOf(fx.bob.address);
    expect(bobPaymentAfter).to.be.lt(bobPaymentBefore);
  });

  // ══ 4. The closed-form valuation tracks real reserve changes ══════════

  it("tracks live pool reserves after simulated trading, not a stale snapshot", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    await fx.vault.connect(fx.alice).deployToIndexPool(shareToken, 100n * WAD);

    // Everything BUT the pool's own contribution to navLow (`B` in the
    // closed-form's own notation) is untouched by pool swaps — only
    // constituent reserves move `B`, and swaps never touch those. So `B` can
    // be solved for, ONCE, from the closed-form identity at t0, and then used
    // to independently predict navLow at t1 purely from the pool's NEW live
    // reserves — which is exactly the "not stale" claim this test makes.
    const [rPay0, rCoin0] = await fx.pool.getReserves();
    const supply0: bigint = await fx.vault.totalSupply();
    const [navLow0] = await fx.vault.nav();
    const otherLow = (navLow0 * (supply0 - rCoin0)) / supply0 - rPay0;

    // Trade against the pool, then confirm the closed-form output moved
    // with the REAL new reserves, not the pre-trade ones.
    const paymentToken = await ethers.getContractAt("MockIndexToken", fx.paymentToken);
    await paymentToken.mint(fx.bob.address, 20n * WAD);
    await paymentToken.connect(fx.bob).approve(fx.poolAddr, ethers.MaxUint256);
    await fx.pool.connect(fx.bob).swap(true, 20n * WAD, 0n, fx.bob.address);

    const [rPay1, rCoin1] = await fx.pool.getReserves();
    const supply1: bigint = await fx.vault.totalSupply();
    expect(rPay1).to.not.equal(rPay0);
    expect(rCoin1).to.not.equal(rCoin0);
    expect(supply1).to.equal(supply0); // a swap never mints or burns

    const expected1 = ((otherLow + rPay1) * supply1) / (supply1 - rCoin1);
    const [navLow1] = await fx.vault.nav();
    // `otherLow` above was itself back-derived from a floor-rounded on-chain
    // `mulDiv`, so the re-forward prediction is exact up to a handful of wei
    // of rounding slack, not bit-for-bit — the claim under test is "tracks
    // the live reserves", not "is rounding-identical to a re-derivation done
    // in the opposite direction".
    const diff = navLow1 > expected1 ? navLow1 - expected1 : expected1 - navLow1;
    expect(diff).to.be.lte(1_000n);
    expect(navLow1).to.not.equal(navLow0);
  });

  // ══ 5. Same-block flash-trade guard ════════════════════════════════════

  it("refuses deployToIndexPool in the same block the pool itself just acted", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    await fx.vault.connect(fx.alice).deployToIndexPool(shareToken, 100n * WAD);

    const paymentToken = await ethers.getContractAt("MockIndexToken", fx.paymentToken);
    await paymentToken.mint(fx.bob.address, 5n * WAD);
    await paymentToken.connect(fx.bob).approve(fx.poolAddr, ethers.MaxUint256);

    await network.provider.send("evm_setAutomine", [false]);
    try {
      const tx1 = await fx.pool.connect(fx.bob).swap(true, 5n * WAD, 0n, fx.bob.address);
      const tx2 = await fx.vault.connect(fx.alice).deployToIndexPool(shareToken, 1n * WAD);
      await network.provider.send("evm_mine", []);
      await tx1.wait();
      let reverted = false;
      try {
        await tx2.wait();
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
  });

  it("refuses mintSingleAsset in the same block the pool itself just acted", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    await fx.vault.connect(fx.alice).deployToIndexPool(shareToken, 100n * WAD);

    const paymentToken = await ethers.getContractAt("MockIndexToken", fx.paymentToken);
    await paymentToken.mint(fx.bob.address, 5n * WAD);
    await paymentToken.connect(fx.bob).approve(fx.poolAddr, ethers.MaxUint256);

    await network.provider.send("evm_setAutomine", [false]);
    try {
      const tx1 = await fx.pool.connect(fx.bob).swap(true, 5n * WAD, 0n, fx.bob.address);
      const tx2 = await fx.vault.connect(fx.carol).mintSingleAsset(shareToken, 1n * WAD, 0n);
      await network.provider.send("evm_mine", []);
      await tx1.wait();
      let reverted = false;
      try {
        await tx2.wait();
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
  });

  it("allows deployToIndexPool again once a block has passed with no pool action", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    await fx.vault.connect(fx.alice).deployToIndexPool(shareToken, 100n * WAD);
    // Not same-block as the pool's last action (a normal, separately-mined
    // tx) — must succeed.
    await expect(fx.vault.connect(fx.alice).deployToIndexPool(shareToken, 1n * WAD)).to.not.be
      .reverted;
  });
});
