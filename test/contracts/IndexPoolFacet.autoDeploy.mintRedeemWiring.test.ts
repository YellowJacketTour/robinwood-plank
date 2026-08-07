import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployOpenIndex, WAD, TIMELOCK, BPS, maxIn, zeroOut } from "./helpers/index-vault";

/**
 * ============================================================================
 * Adversarial-review fix (2026-08-06, gap 1): reconciliation (and therefore
 * auto-deploy) is now wired into the mint/redeem hot paths themselves —
 * `IndexCoreFacet.mintProRata`/`redeemProRata` and `IndexTradeFacet.
 * mintSingleAsset`/`redeemSingleAsset` — not just the standalone
 * `syncConstituentBalance`/`reconcile` entry points `IndexPoolFacet.
 * autoDeploy.test.ts` already covers.
 *
 * Before this fix, a raw donation sitting at the vault's own address (the
 * push-then-opportunistic-reconcile shape design doc §7.2 describes) would
 * NOT be credited, and pool growth would NOT compound, unless someone
 * separately called `sync`/`reconcile` — contradicting §7.2's own words:
 * "every normal interaction with that constituent (the next mint or redeem
 * touching it) opportunistically reconciles any surplus".
 *
 * Proves, per the task brief:
 *   1. A `mintSingleAsset` call touching a constituent with a pending fresh
 *      surplus, with sufficient conditions for a real deploy, correctly
 *      triggers a real pool deployment — no separate sync/reconcile call.
 *   2. The same for `redeemProRata` (redeem side, all-constituents loop).
 *   3. A mint/redeem where the opportunistic auto-deploy attempt would fail
 *      (dilution cap at ceiling) still succeeds normally — the failure is
 *      caught, exactly the non-blocking pattern already proven on the
 *      sync/reconcile side.
 *   4. `autoReconcile` — the new self-only entry point the mint/redeem hot
 *      paths route through — is unreachable by any outside account, the
 *      same reentrancy-safety shape `autoDeployToIndexPool` already proves.
 * ============================================================================
 */
describe("IndexCoreFacet/IndexTradeFacet — mint/redeem hot-path reconciliation wiring (gap 1 fix, 2026-08-06)", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
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
    await fx.vault.checkpointAll();
    return { ...fx, pool, poolAddr, paymentToken };
  }

  function findLog(receipt: any, iface: any, name: string) {
    return receipt!.logs
      .map((l: any) => {
        try {
          return iface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p && p.name === name);
  }

  // ══ 1. mintSingleAsset alone triggers a real deploy, no separate call ═══

  it("mintSingleAsset on a constituent with a pending fresh surplus automatically deploys into the pool, with NO separate sync/reconcile call", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    const donateAmount = 50n * WAD;

    // A raw donation, exactly the push-then-opportunistic-reconcile shape —
    // and, critically, NOBODY calls `syncConstituentBalance`/`reconcile`
    // anywhere in this test.
    await fx.tokens[1].mint(fx.vaultAddr, donateAmount);

    const poolSharesBefore: bigint = await fx.vault.poolSharesMinted();
    const [reservePaymentBefore, reserveCoinBefore] = await fx.pool.getReserves();

    const tx = await fx.vault.connect(fx.alice).mintSingleAsset(shareToken, 5n * WAD, 0n);
    const receipt = await tx.wait();

    // The ordinary mint happened.
    await expect(tx).to.emit(fx.vault, "MintedSingle");
    // The donation was reconciled (ConstituentSynced) and the real pool
    // deploy fired, entirely as a byproduct of THIS mint call.
    await expect(tx).to.emit(fx.vault, "ConstituentSynced").withArgs(shareToken, donateAmount);
    await expect(tx).to.emit(fx.vault, "DeployedToIndexPool");
    const autoLog = findLog(receipt, fx.vault.interface, "AutoDeployedToIndexPool");
    expect(autoLog).to.not.equal(undefined);
    expect(autoLog!.args.shareToken).to.equal(shareToken);
    expect(autoLog!.args.sharesMinted).to.be.gt(0n);
    await expect(tx).to.not.emit(fx.vault, "AutoDeployToIndexPoolFailed");
    await expect(tx).to.not.emit(fx.vault, "OpportunisticReconcileFailed");

    // Real value moved into the pool, not just an event.
    const [reservePaymentAfter, reserveCoinAfter] = await fx.pool.getReserves();
    expect(reservePaymentAfter).to.be.gt(reservePaymentBefore);
    expect(reserveCoinAfter).to.be.gt(reserveCoinBefore);
    const poolSharesAfter: bigint = await fx.vault.poolSharesMinted();
    expect(poolSharesAfter).to.be.gt(poolSharesBefore);
  });

  // ══ 2. redeemProRata (the all-constituents loop) triggers a real deploy ═

  it("redeemProRata touching a constituent with a pending fresh surplus automatically deploys into the pool, with NO separate sync/reconcile call", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    const donateAmount = 50n * WAD;

    // Give alice a real position to redeem from — `deployOpenIndex` funds
    // her with constituent tokens but mints her no shares.
    await fx.vault.connect(fx.alice).mintProRata(100n * WAD, maxIn(3));

    await fx.tokens[1].mint(fx.vaultAddr, donateAmount);

    const poolSharesBefore: bigint = await fx.vault.poolSharesMinted();
    const bal: bigint = await fx.vault.balanceOf(fx.alice.address);
    const tx = await fx.vault.connect(fx.alice).redeemProRata(bal / 10n, zeroOut(3));
    const receipt = await tx.wait();

    await expect(tx).to.emit(fx.vault, "RedeemedProRata");
    await expect(tx).to.emit(fx.vault, "ConstituentSynced").withArgs(shareToken, donateAmount);
    await expect(tx).to.emit(fx.vault, "DeployedToIndexPool");
    const autoLog = findLog(receipt, fx.vault.interface, "AutoDeployedToIndexPool");
    expect(autoLog).to.not.equal(undefined);
    expect(autoLog!.args.shareToken).to.equal(shareToken);

    const poolSharesAfter: bigint = await fx.vault.poolSharesMinted();
    expect(poolSharesAfter).to.be.gt(poolSharesBefore);
  });

  // ══ 3. A failing opportunistic auto-deploy never blocks the mint/redeem ═

  it("mintSingleAsset still succeeds normally when its opportunistic auto-deploy attempt would fail (dilution cap at ceiling) — the failure is caught", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];

    // Drive cumulative pool shares up to the governed 5% default ceiling
    // using the explicit entry point (same technique as
    // IndexPoolFacet.autoDeploy.test.ts and IndexPoolFacet.dilutionCap.test.ts).
    for (let i = 0; i < 500; i++) {
      const poolShares: bigint = await fx.vault.poolSharesMinted();
      const supplyNow: bigint = await fx.vault.totalSupply();
      if ((poolShares * BPS) / supplyNow >= 495n) break;
      await fx.vault.connect(fx.alice).deployToIndexPool(shareToken, 1n * WAD);
    }

    const poolSharesBefore: bigint = await fx.vault.poolSharesMinted();
    const reserveBefore: bigint = await fx.vault.reserveOf(shareToken);
    const donateAmount = 500n * WAD; // large enough to blow the cap on its own
    await fx.tokens[1].mint(fx.vaultAddr, donateAmount);

    const sharesPreview: bigint = await fx.vault
      .connect(fx.alice)
      .mintSingleAsset.staticCall(shareToken, 5n * WAD, 0n);
    expect(sharesPreview).to.be.gt(0n);

    const tx = await fx.vault.connect(fx.alice).mintSingleAsset(shareToken, 5n * WAD, 0n);
    const receipt = await tx.wait();

    // The mint itself is NEVER blocked or degraded by the failed attempt.
    await expect(tx).to.emit(fx.vault, "MintedSingle");
    // The underlying reconcile still succeeded and credited reserve.
    await expect(tx).to.emit(fx.vault, "ConstituentSynced").withArgs(shareToken, donateAmount);
    const reserveAfterDonation: bigint = await fx.vault.reserveOf(shareToken);
    expect(reserveAfterDonation).to.be.gt(reserveBefore);
    // Only the auto-deploy failure event fired — no success event, no real
    // deploy, poolSharesMinted untouched.
    await expect(tx).to.emit(fx.vault, "AutoDeployToIndexPoolFailed");
    await expect(tx).to.not.emit(fx.vault, "AutoDeployedToIndexPool");
    await expect(tx).to.not.emit(fx.vault, "DeployedToIndexPool");
    await expect(tx).to.not.emit(fx.vault, "OpportunisticReconcileFailed");
    const poolSharesAfter: bigint = await fx.vault.poolSharesMinted();
    expect(poolSharesAfter).to.equal(poolSharesBefore);

    const failLog = findLog(receipt, fx.vault.interface, "AutoDeployToIndexPoolFailed");
    expect(failLog!.args.shareToken).to.equal(shareToken);
    expect(failLog!.args.shareAmountAttempted).to.equal(donateAmount);
  });

  it("redeemSingleAsset still succeeds normally when its opportunistic auto-deploy attempt would fail (dilution cap at ceiling) — the failure is caught", async () => {
    const fx = await fixtureWithPool();
    // `deployOpenIndex`'s three constituents are priced 1.0 / 0.5 / 2.0 ETH
    // over EQUAL raw-token reserves, so by NAV value leg 2 (`addrs[2]`) is
    // already ~57% of the basket — over the 40% default concentration cap
    // before this test does anything. Redeeming addrs[2] itself SHRINKS the
    // already-over-cap leg (moving it toward compliance, never away), so it
    // is the one leg a redeem can safely target here without tripping
    // `redeemSingleAsset`'s own (unrelated, pre-existing) cap guard —
    // redeeming addrs[1] instead would mechanically raise leg 2's already-
    // over-cap share further and revert before ever reaching the
    // auto-deploy attempt this test is actually about.
    const shareToken = fx.addrs[2];

    // Give bob a real position to redeem from — `deployOpenIndex` funds him
    // with constituent tokens but mints him no shares.
    await fx.vault.connect(fx.bob).mintProRata(100n * WAD, maxIn(3));

    // The governed dilution cap is lowered to 0.01% BEFORE any deploy ever
    // happens, so the very first deploy attempt — no matter how small —
    // trivially exceeds it and is refused by `PoolShareCapExceeded`. This
    // reaches the exact same real failure mode the sync-side test drives via
    // a 500-iteration loop, without touching `shareToken`'s own reserve at
    // all — so it cannot also trip the (unrelated, pre-existing)
    // concentration-cap guard `redeemSingleAsset` itself already carries at
    // the end of its own body.
    await fx.vault.connect(fx.risk).queueMaxPoolShareBps(1n);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeMaxPoolShareBps();
    await fx.vault.checkpointAll();

    const poolSharesBefore: bigint = await fx.vault.poolSharesMinted();
    await fx.tokens[2].mint(fx.vaultAddr, 5n * WAD);

    const bal: bigint = await fx.vault.balanceOf(fx.bob.address);
    const tx = await fx.vault.connect(fx.bob).redeemSingleAsset(bal / 500n, shareToken, 0n);
    const receipt = await tx.wait();

    await expect(tx).to.emit(fx.vault, "RedeemedSingle");
    await expect(tx).to.emit(fx.vault, "AutoDeployToIndexPoolFailed");
    await expect(tx).to.not.emit(fx.vault, "AutoDeployedToIndexPool");
    await expect(tx).to.not.emit(fx.vault, "DeployedToIndexPool");
    const poolSharesAfter: bigint = await fx.vault.poolSharesMinted();
    expect(poolSharesAfter).to.equal(poolSharesBefore);
    const failLog = findLog(receipt, fx.vault.interface, "AutoDeployToIndexPoolFailed");
    expect(failLog).to.not.equal(undefined);
  });

  // ══ 4. autoReconcile is unreachable by anyone but the diamond itself ═══

  it("autoReconcile cannot be called directly by any outside account", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    await expect(
      fx.vault.connect(fx.alice).autoReconcile(shareToken)
    ).to.be.revertedWithCustomError(fx.vault, "BadParam");
  });

  it("mintProRata with no pool configured still opportunistically credits a pending donation on every constituent it touches", async () => {
    const fx = await deployOpenIndex();
    await fx.tokens[1].mint(fx.vaultAddr, 10n * WAD);
    const reserveBefore: bigint = await fx.vault.reserveOf(fx.addrs[1]);

    const tx = await fx.vault.connect(fx.alice).mintProRata(10n * WAD, maxIn(3));
    await expect(tx).to.emit(fx.vault, "MintedProRata");
    await expect(tx).to.emit(fx.vault, "ConstituentSynced").withArgs(fx.addrs[1], 10n * WAD);
    // No pool configured — no auto-deploy events at all, exactly like the
    // sync-side "with no pool configured" case.
    await expect(tx).to.not.emit(fx.vault, "AutoDeployedToIndexPool");
    await expect(tx).to.not.emit(fx.vault, "AutoDeployToIndexPoolFailed");

    const reserveAfter: bigint = await fx.vault.reserveOf(fx.addrs[1]);
    expect(reserveAfter).to.be.gt(reserveBefore + 10n * WAD - 1n); // credited donation + alice's own deposit
  });
});
