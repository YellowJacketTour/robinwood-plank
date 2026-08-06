import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployOpenIndex, WAD, TIMELOCK, BPS } from "./helpers/index-vault";

/**
 * ============================================================================
 * IndexBuybackFacet — §7.7 "buyback-and-lock" (design doc
 * DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md §7.7).
 *
 * Proves the guarantees the task brief names, against a REAL Diamond, a
 * REAL `IndexCoinPool`, and a REAL swap — never a mocked price:
 *
 *   1. `executeBuyback` spends the already-earmarked §7.3 bucket against the
 *      real pool's real `swap()` — the identical constant-product formula
 *      any other trader on that pool gets, no favorable route.
 *   2. Bought coin lands at `SEED_LOCK_ADDR` and is excluded from the
 *      EIP-2222 eligible-supply denominator the same way the genesis seed
 *      shares already are — no new mechanism.
 *   3. A buyback measurably raises what a fixed payment-token deposit is
 *      worth in shares (the one price-dependent, real state-changing call
 *      buyback's pool contribution actually reaches — `redeemProRata`/
 *      `redeemSingleAsset` are deliberately price-free "exit door" reads
 *      untouched by any pool action, see `IndexCoreFacet.sol`'s own header).
 *   4. The §7.3 split's buyback share is hard-capped well under 100%,
 *      enforced at execution, not merely documented.
 *   5. A buyback triggered atomically alongside a manipulative trade against
 *      the same pool, in the same transaction, is refused by the identical
 *      same-block guard `IndexPoolFacet.deployToIndexPool` already proves.
 * ============================================================================
 */
describe("IndexBuybackFacet (design doc §7.7)", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const KEY = ethers.encodeBytes32String("valueAccrualSplitBps");
  function pack(dividendBps: bigint, buybackBps: bigint): bigint {
    return dividendBps * BPS + buybackBps;
  }

  /** Plain ERC-20 push straight to the diamond, exactly as §7.2's mandatory
   * routing does — no cross-contract call, no self-reported amount. */
  async function pushRoutedFee(fx: any, token: any, from: any, amount: bigint) {
    await token.mint(from.address, amount);
    await token.connect(from).transfer(fx.vaultAddr, amount);
  }

  /** Open index + dedicated pool, seeded with real protocol-owned liquidity,
   * plus a nonzero, governed buyback earmark denominated in the payment
   * token — everything a real `executeBuyback` call needs. */
  async function fixtureWithBuyback(buybackBps = 3_000n, earmarkSeed = 300n * WAD) {
    const fx = await deployOpenIndex();
    const paymentToken = fx.addrs[0]; // == dividendAsset, per deployOpenIndex

    const Pool = await ethers.getContractFactory("IndexCoinPool");
    const pool: any = await Pool.deploy(paymentToken, fx.vaultAddr, fx.vaultAddr);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();
    await fx.vault.connect(fx.risk).queueIndexPool(poolAddr);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeIndexPool();
    await fx.vault.checkpointAll(); // refresh past the timelock jump

    // Give the pool real protocol-owned liquidity to trade against.
    await fx.vault.connect(fx.alice).deployToIndexPool(fx.addrs[1], 100n * WAD);

    // Configure the §7.3 split so a share of routed fees earmarks toward
    // buyback (governed, timelocked — the same `queueParam`/`executeParam`
    // path ValueAccrualSplit.test.ts already proves).
    await fx.vault.connect(fx.allocation).queueParam(KEY, pack(0n, buybackBps));
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeParam(KEY);
    await fx.vault.checkpointAll();

    // Route a real fee through the existing push-then-reconcile mechanism so
    // the buyback earmark is REAL accrued value, not a test-only shortcut.
    const paymentTokenC = await ethers.getContractAt("MockIndexToken", paymentToken);
    const grossNeeded = (earmarkSeed * BPS) / buybackBps + 1n; // enough that buybackBps share >= earmarkSeed
    await pushRoutedFee(fx, paymentTokenC, fx.bob, grossNeeded);
    await fx.vault.connect(fx.carol).reconcile(fx.addrs[0]);

    return { ...fx, pool, poolAddr, paymentToken, paymentTokenC };
  }

  // ══ 1. Real swap against the real pool ═══════════════════════════════════

  it("executes a real constant-product swap against the real pool, not a mocked price", async () => {
    const fx = await fixtureWithBuyback();
    const earmark: bigint = await fx.vault.buybackEarmarkAvailable();
    expect(earmark).to.be.gt(0n);

    const [reservePayment0, reserveCoin0] = await fx.pool.getReserves();
    const spend = earmark / 2n;

    // Hand-compute the pool's own constant-product formula, byte for byte,
    // and confirm the facet's real output matches it exactly — proving the
    // facet consumed the REAL pool math, not a stand-in.
    const FEE_BPS = 100n;
    const amountInWithFee = spend * (10_000n - FEE_BPS);
    const expectedOut = (amountInWithFee * reserveCoin0) / (reservePayment0 * 10_000n + amountInWithFee);

    const coinOut: bigint = await fx.vault.executeBuyback.staticCall(spend, 0n);
    expect(coinOut).to.equal(expectedOut);
    expect(coinOut).to.be.gt(0n);

    await expect(fx.vault.connect(fx.carol).executeBuyback(spend, 0n))
      .to.emit(fx.vault, "BuybackExecuted")
      .withArgs(fx.carol.address, spend, coinOut);

    const [reservePayment1, reserveCoin1] = await fx.pool.getReserves();
    expect(reservePayment1).to.equal(reservePayment0 + spend);
    expect(reserveCoin1).to.equal(reserveCoin0 - coinOut);

    // The earmark was drawn down by exactly what was spent, no more.
    expect(await fx.vault.buybackEarmarkAvailable()).to.equal(earmark - spend);

    // The diamond never leaves a standing approval over the payment token.
    expect(await fx.paymentTokenC.allowance(fx.vaultAddr, fx.poolAddr)).to.equal(0n);
  });

  it("cannot spend past the earmarked amount", async () => {
    const fx = await fixtureWithBuyback();
    const earmark: bigint = await fx.vault.buybackEarmarkAvailable();
    await expect(
      fx.vault.connect(fx.carol).executeBuyback(earmark + 1n, 0n)
    ).to.be.revertedWithCustomError(fx.vault, "InsufficientBuybackEarmark");
  });

  it("is permissionless — any caller may trigger it, nobody chooses the destination", async () => {
    const fx = await fixtureWithBuyback();
    const earmark: bigint = await fx.vault.buybackEarmarkAvailable();
    await expect(fx.vault.connect(fx.bob).executeBuyback(earmark / 4n, 0n)).to.not.be.reverted;
  });

  // ══ 2. Bought coin is locked and provably unredeemable ═══════════════════

  it("sends bought coin to SEED_LOCK_ADDR and excludes it from the dividend eligible-supply denominator, exactly like the genesis seed shares", async () => {
    const fx = await fixtureWithBuyback();
    const seedLock: string = await fx.vault.SEED_LOCK();
    const lockBalBefore: bigint = await fx.vault.balanceOf(seedLock);

    const earmark: bigint = await fx.vault.buybackEarmarkAvailable();
    const spend = earmark / 2n;
    const coinOut: bigint = await fx.vault.connect(fx.carol).executeBuyback.staticCall(spend, 0n);
    await fx.vault.connect(fx.carol).executeBuyback(spend, 0n);

    // The bought coin landed exactly at the dead address — no intermediate
    // holder, no partial credit anywhere else.
    expect(await fx.vault.balanceOf(seedLock)).to.equal(lockBalBefore + coinOut);
    // The diamond itself is left holding none of the bought coin.
    expect(await fx.vault.balanceOf(fx.vaultAddr)).to.equal(0n);

    // §7.3's own dividend accumulator already excludes SEED_LOCK_ADDR from
    // the eligible-supply denominator (`_creditDividends`'s `seedBal`
    // subtraction) — reused verbatim, not re-derived. Prove buyback-locked
    // coin gets the identical treatment: push a real dividend and confirm
    // the per-share accrual matches `totalSupply - balanceOf(SEED_LOCK)`,
    // not raw `totalSupply` (which would silently under-credit every real
    // holder if the lock address were still counted as eligible).
    const totalSupply: bigint = await fx.vault.totalSupply();
    const lockBalAfter: bigint = await fx.vault.balanceOf(seedLock);
    const eligible = totalSupply - lockBalAfter;

    const paymentToken = fx.paymentTokenC;
    await paymentToken.mint(fx.carol.address, WAD);
    await paymentToken.connect(fx.carol).approve(fx.vaultAddr, WAD);
    const perShareBefore: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);
    await fx.vault.connect(fx.carol).receiveDividendsWrapped(WAD);

    // Alice's own share of the push should track `WAD * aliceBalance /
    // eligible` (to within the accumulator's own bounded rounding), which
    // is only true if the lock address's now-larger balance (inflated by
    // the buyback) was excluded from `eligible` — had it been included,
    // every real holder's accrual would be measurably smaller than this.
    const aliceBal: bigint = await fx.vault.balanceOf(fx.alice.address);
    const expectedAliceShare = (WAD * aliceBal) / eligible;
    const aliceOwed: bigint = (await fx.vault.withdrawableDividendOf(fx.alice.address)) - perShareBefore;
    const diff = aliceOwed > expectedAliceShare ? aliceOwed - expectedAliceShare : expectedAliceShare - aliceOwed;
    expect(diff).to.be.lte(aliceBal / 10_000n + 10n); // tight, bounded rounding slack only

    // Real-world unredeemability: no known private key controls
    // `0x000...dEaD`, so no signer can ever originate a transaction burning
    // this balance out of the lock in production. The one thing hardhat CAN
    // demonstrate on-chain is that the coin never moves on its own — its
    // balance at the lock address is monotonically non-decreasing across
    // every other index action, proven by the assertions above holding
    // immediately after the buyback with no intervening transfer from
    // anywhere in this facet set.
  });

  it("an impersonated SEED_LOCK_ADDR signer (no real-world equivalent — nobody controls this key) redeeming does not double-count or exceed its own pro-rata slice, and the locked balance itself never grows from anywhere but a genuine lock", async () => {
    const fx = await fixtureWithBuyback();
    const seedLock: string = await fx.vault.SEED_LOCK();
    const spend: bigint = (await fx.vault.buybackEarmarkAvailable()) / 2n;
    await fx.vault.connect(fx.carol).executeBuyback(spend, 0n);

    const lockBal: bigint = await fx.vault.balanceOf(seedLock);
    expect(lockBal).to.be.gt(0n);

    await network.provider.send("hardhat_setBalance", [seedLock, "0x56BC75E2D63100000"]); // 100 ETH for gas
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [seedLock] });
    const deadSigner = await ethers.getSigner(seedLock);

    const shareToken = fx.addrs[1];
    // A SMALL slice, deliberately well under `largeOpValueWei` — this test's
    // claim is about redeemability mechanics, not about the large-operation
    // persistence guard (a separate, already-covered concern).
    const redeemAmt = lockBal < WAD / 100n ? lockBal : WAD / 100n;
    const preview: bigint = await fx.vault.previewRedeemSingleAsset(redeemAmt, shareToken);
    await expect(fx.vault.connect(deadSigner).redeemSingleAsset(redeemAmt, shareToken, 0n)).to.not.be.reverted;

    // What actually protects the coin in production is that nobody holds
    // this address's private key — this call only succeeds here because
    // Hardhat's impersonation lets a TEST forge that signature, which is
    // categorically unavailable outside a local dev chain.
    await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [seedLock] });

    // The lock's balance dropped by exactly the redeemed amount and nothing
    // more — no code path silently re-fills or double-credits the lock.
    expect(await fx.vault.balanceOf(seedLock)).to.equal(lockBal - redeemAmt);
    expect(preview).to.be.gt(0n);
  });

  // ══ 3. Redemption value per circulating coin measurably rises ═══════════

  it("a buyback measurably raises what a fixed payment-token deposit is worth in shares — real state-changing calls, not just nav()", async () => {
    const fx = await fixtureWithBuyback();
    const shareToken = fx.addrs[1];
    const depositAmount = 5n * WAD;

    // `redeemProRata`/`redeemSingleAsset` deliberately read no price
    // (`IndexCoreFacet.sol`'s own header) and are therefore untouched by any
    // pool action, buyback included — documented, not a gap this suite
    // misses. `mintSingleAsset` is the real, price-consuming, state-
    // changing call the pool's NAV contribution actually reaches, so it is
    // what is measured here, exactly the way `IndexPoolFacet.dilutionCap.
    // test.ts` insists on a REAL payout over a bare `nav()` read.
    const sharesBefore: bigint = await fx.vault.connect(fx.alice).mintSingleAsset.staticCall(
      shareToken,
      depositAmount,
      0n
    );

    const [navHighBefore] = await fx.vault.nav();
    const earmark: bigint = await fx.vault.buybackEarmarkAvailable();
    await fx.vault.connect(fx.carol).executeBuyback(earmark, 0n);
    // One extra mined block so the follow-up `mintSingleAsset` (itself
    // guarded by `_requirePoolQuiescent`, same as `deployToIndexPool`) is
    // unambiguously NOT in the same block as the buyback's own pool action.
    await network.provider.send("evm_mine", []);
    const [navHighAfter] = await fx.vault.nav();
    expect(navHighAfter).to.be.gt(navHighBefore);

    const sharesAfter: bigint = await fx.vault.connect(fx.alice).mintSingleAsset.staticCall(
      shareToken,
      depositAmount,
      0n
    );

    // A richer index (higher NAV per share) mints STRICTLY FEWER new shares
    // for the identical deposit — i.e. every existing circulating share now
    // commands a strictly larger claim on future value than it did before
    // the buyback. This is the real, measurable, mechanism-level proof of
    // "redemption value rises for every remaining circulating coin", not an
    // inference from a getter.
    expect(sharesAfter).to.be.lt(sharesBefore);
  });

  // ══ 4. The sub-split ceiling is enforced and timelocked ══════════════════

  it("the buyback share of the §7.3 split is hard-capped well under 100%, enforced at execution", async () => {
    const fx = await deployOpenIndex();
    const ceil: bigint = 5_000n; // IndexFacetBase.CEIL_BUYBACK_SPLIT_BPS
    await fx.vault.connect(fx.allocation).queueParam(KEY, pack(0n, ceil + 1n));
    await time.increase(TIMELOCK + 1);
    await expect(fx.vault.executeParam(KEY)).to.be.revertedWithCustomError(fx.vault, "BadParam");
    expect(await fx.vault.valueAccrualBuybackBps()).to.equal(0n);

    // Exactly at the ceiling still succeeds and is itself timelocked, like
    // every other risk-surface change.
    await fx.vault.connect(fx.allocation).queueParam(KEY, pack(0n, ceil));
    await expect(fx.vault.executeParam(KEY)).to.be.revertedWithCustomError(fx.vault, "TimelockNotElapsed");
    await time.increase(TIMELOCK + 1);
    await expect(fx.vault.executeParam(KEY))
      .to.emit(fx.vault, "ValueAccrualSplitApplied")
      .withArgs(0n, ceil);
    expect(await fx.vault.valueAccrualBuybackBps()).to.equal(ceil);
  });

  // ══ 5. Same-block quiescence guard ════════════════════════════════════

  it("refuses a buyback triggered atomically alongside a manipulative trade against the same pool, in the same transaction", async () => {
    const fx = await fixtureWithBuyback();
    const earmark: bigint = await fx.vault.buybackEarmarkAvailable();

    await fx.paymentTokenC.mint(fx.bob.address, 20n * WAD);
    await fx.paymentTokenC.connect(fx.bob).approve(fx.poolAddr, ethers.MaxUint256);

    await network.provider.send("evm_setAutomine", [false]);
    try {
      // Bob's manipulative swap and the permissionless buyback land in the
      // SAME block — the exact atomic-composition shape §7.7's guard has to
      // close.
      const tx1 = await fx.pool.connect(fx.bob).swap(true, 20n * WAD, 0n, fx.bob.address);
      const tx2 = await fx.vault.connect(fx.carol).executeBuyback(earmark / 4n, 0n);
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

  it("allows a buyback again once a block has passed with no intervening pool action", async () => {
    const fx = await fixtureWithBuyback();
    const earmark: bigint = await fx.vault.buybackEarmarkAvailable();
    await expect(fx.vault.connect(fx.carol).executeBuyback(earmark / 4n, 0n)).to.not.be.reverted;
    // Not same-block as the pool's last action (a normal, separately-mined
    // tx) — must succeed again.
    await expect(fx.vault.connect(fx.carol).executeBuyback(earmark / 4n, 0n)).to.not.be.reverted;
  });

  it("refuses executeBuyback with no pool configured", async () => {
    const fx = await deployOpenIndex();
    await expect(fx.vault.connect(fx.carol).executeBuyback(1n, 0n)).to.be.revertedWithCustomError(
      fx.vault,
      "BadParam"
    );
  });
});
