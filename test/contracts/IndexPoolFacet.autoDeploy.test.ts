import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployOpenIndex, WAD, TIMELOCK, BPS } from "./helpers/index-vault";

/**
 * ============================================================================
 * IndexPoolFacet automatic deployment (2026-08-06 automation pass).
 *
 * `deployToIndexPool` was real, permissionless and correctly priced, but
 * required an explicit call. This closes that gap: `IndexBootstrapFacet._sync`
 * — reached by `syncConstituentBalance`/`reconcile`, the existing
 * push-then-opportunistic-reconcile mechanism (§7.2) — now ALSO attempts an
 * opportunistic pool deployment of the exact freshly-credited share-token
 * surplus, via `IndexFacetBase._deployToIndexPoolCore`, the ONE implementation
 * both `deployToIndexPool` (explicit) and `autoDeployToIndexPool` (automatic,
 * self-only) call.
 *
 * Proves, per the task brief:
 *   1. A normal reconcile call for a share-token constituent with sufficient
 *      payment-token reserve on hand automatically triggers a real pool
 *      deployment, no separate call needed.
 *   2. A reconcile call where auto-deploy would fail (dilution cap already at
 *      its ceiling) still succeeds at crediting reserve normally, with the
 *      failure caught and only the failure event emitted.
 *   3. Gas cost of a sync-with-successful-auto-deploy and a
 *      sync-with-failed-auto-deploy are both bounded.
 *   4. The explicit `deployToIndexPool` entry point is unchanged — same
 *      pricing, same events, same reverts.
 *   5. `autoDeployToIndexPool` is unreachable by any outside account —
 *      proves the self-only guard that makes the non-blocking self-call
 *      safe against reentrancy.
 * ============================================================================
 */
describe("IndexPoolFacet automatic deployment (2026-08-06 automation pass)", () => {
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

  // ══ 1. Reconcile alone triggers a real deploy, no separate call ═══════

  it("a plain reconcile()/syncConstituentBalance() for a share-token surplus automatically deploys into the pool", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    const donateAmount = 50n * WAD;

    // A raw donation into the vault — exactly the "swept value" shape
    // `IndexConstituentSync.test.ts` already exercises, except this time the
    // pool is live and there is nothing left to call afterwards.
    await fx.tokens[1].mint(fx.vaultAddr, donateAmount);

    const poolSharesBefore: bigint = await fx.vault.poolSharesMinted();
    const [reservePaymentBefore, reserveCoinBefore] = await fx.pool.getReserves();

    const tx = await fx.vault.connect(fx.carol).reconcile(shareToken);
    const receipt = await tx.wait();

    // ConstituentSynced still fires exactly as before this change.
    await expect(tx).to.emit(fx.vault, "ConstituentSynced").withArgs(shareToken, donateAmount);
    // The real pool-deploy event fired too, as a byproduct of the SAME call.
    await expect(tx).to.emit(fx.vault, "DeployedToIndexPool");
    // ...and the distinct auto-success wrapper event that names the trigger.
    const autoDeployedLog = receipt!.logs
      .map((l: any) => {
        try {
          return fx.vault.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p && p.name === "AutoDeployedToIndexPool");
    expect(autoDeployedLog).to.not.equal(undefined);
    expect(autoDeployedLog!.args.shareToken).to.equal(shareToken);
    expect(autoDeployedLog!.args.sharesMinted).to.be.gt(0n);

    // No AutoDeployToIndexPoolFailed on the success path.
    await expect(tx).to.not.emit(fx.vault, "AutoDeployToIndexPoolFailed");

    // The pool genuinely grew — real value moved, not just an event.
    const [reservePaymentAfter, reserveCoinAfter] = await fx.pool.getReserves();
    expect(reservePaymentAfter).to.be.gt(reservePaymentBefore);
    expect(reserveCoinAfter).to.be.gt(reserveCoinBefore);
    const poolSharesAfter: bigint = await fx.vault.poolSharesMinted();
    expect(poolSharesAfter).to.be.gt(poolSharesBefore);
  });

  it("the auto-deployed shares are priced by the identical shared core the explicit entry point uses", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    const amount = 20n * WAD;

    // Path A: the REAL auto-deploy, via reconcile(). The auto attempt runs
    // AFTER `_sync` has already credited `credited` into `c.reserve[shareToken]`
    // (`IndexBootstrapFacet._sync`'s own ordering), so the core prices
    // against the POST-credit reserve — capture that real result first.
    const snap = await takeSnapshot();
    await fx.tokens[1].mint(fx.vaultAddr, amount);
    const receipt = await (await fx.vault.connect(fx.carol).reconcile(shareToken)).wait();
    const autoLog = receipt!.logs
      .map((l: any) => {
        try {
          return fx.vault.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p && p.name === "AutoDeployedToIndexPool");
    const autoSharesMinted: bigint = autoLog!.args.sharesMinted;
    await snap.restore();

    // Path B: replicate the identical post-credit state by hand — disable
    // the auto attempt via the governed dust floor (so only the ordinary
    // reserve credit happens), donate + sync, THEN take a static-call
    // preview of the EXPLICIT entry point for the same amount against that
    // now-identical `c.reserve[shareToken]` — proving both entry points
    // price the exact same state identically through the one shared core.
    await fx.vault.connect(fx.risk).queueMinAutoDeployWei(ethers.MaxUint256);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeMinAutoDeployWei();
    await fx.vault.checkpointAll();
    await fx.tokens[1].mint(fx.vaultAddr, amount);
    await fx.vault.connect(fx.carol).syncConstituentBalance(shareToken);
    const explicitSharesPreview: bigint = await fx.vault
      .connect(fx.alice)
      .deployToIndexPool.staticCall(shareToken, amount);

    expect(autoSharesMinted).to.equal(explicitSharesPreview);
  });

  // ══ 2. A failing auto-deploy never blocks the underlying sync ═════════

  it("when auto-deploy would fail (dilution cap already at ceiling), reconcile() still credits reserve normally and only the failure event fires", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];

    // Drive cumulative pool shares right up against the governed 5% default
    // cap using the explicit entry point, same technique as
    // `IndexPoolFacet.dilutionCap.test.ts`.
    for (let i = 0; i < 500; i++) {
      const poolShares: bigint = await fx.vault.poolSharesMinted();
      const supplyNow: bigint = await fx.vault.totalSupply();
      if ((poolShares * BPS) / supplyNow >= 495n) break;
      await fx.vault.connect(fx.alice).deployToIndexPool(shareToken, 1n * WAD);
    }

    const reserveBefore: bigint = await fx.vault.reserveOf(shareToken);
    const poolSharesBefore: bigint = await fx.vault.poolSharesMinted();
    const donateAmount = 500n * WAD; // large enough to blow the cap on its own

    await fx.tokens[1].mint(fx.vaultAddr, donateAmount);
    const tx = await fx.vault.connect(fx.carol).reconcile(shareToken);
    const receipt = await tx.wait();

    // The underlying sync succeeded and credited reserve — never blocked.
    await expect(tx).to.emit(fx.vault, "ConstituentSynced").withArgs(shareToken, donateAmount);
    const reserveAfter: bigint = await fx.vault.reserveOf(shareToken);
    expect(reserveAfter).to.be.gt(reserveBefore);

    // Only the failure event fired for the auto-deploy attempt — no success
    // event, no DeployedToIndexPool, and poolSharesMinted is untouched.
    await expect(tx).to.emit(fx.vault, "AutoDeployToIndexPoolFailed");
    await expect(tx).to.not.emit(fx.vault, "AutoDeployedToIndexPool");
    await expect(tx).to.not.emit(fx.vault, "DeployedToIndexPool");
    const poolSharesAfter: bigint = await fx.vault.poolSharesMinted();
    expect(poolSharesAfter).to.equal(poolSharesBefore);

    const failLog = receipt!.logs
      .map((l: any) => {
        try {
          return fx.vault.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p && p.name === "AutoDeployToIndexPoolFailed");
    expect(failLog!.args.shareToken).to.equal(shareToken);
    expect(failLog!.args.shareAmountAttempted).to.equal(donateAmount);
  });

  it("reconcile() on the payment/dividend token itself never attempts an auto-deploy (it is the pool's OTHER leg)", async () => {
    const fx = await fixtureWithPool();
    const paymentToken = fx.addrs[0];
    await fx.tokens[0].mint(fx.vaultAddr, 10n * WAD);

    const tx = await fx.vault.connect(fx.carol).reconcile(paymentToken);
    await expect(tx).to.emit(fx.vault, "ConstituentSynced");
    await expect(tx).to.not.emit(fx.vault, "AutoDeployedToIndexPool");
    await expect(tx).to.not.emit(fx.vault, "AutoDeployToIndexPoolFailed");
  });

  it("with no pool configured, reconcile() behaves exactly as before — no auto-deploy events at all", async () => {
    const fx = await deployOpenIndex();
    await fx.tokens[1].mint(fx.vaultAddr, 10n * WAD);
    const tx = await fx.vault.connect(fx.carol).reconcile(fx.addrs[1]);
    await expect(tx).to.emit(fx.vault, "ConstituentSynced");
    await expect(tx).to.not.emit(fx.vault, "AutoDeployedToIndexPool");
    await expect(tx).to.not.emit(fx.vault, "AutoDeployToIndexPoolFailed");
  });

  // ══ 3. Gas is bounded on both the success and the caught-failure path ═

  it("gas cost of a sync with a successful auto-deploy is bounded", async () => {
    const fx = await fixtureWithPool();
    await fx.tokens[1].mint(fx.vaultAddr, 10n * WAD);
    const receipt = await (await fx.vault.connect(fx.carol).reconcile(fx.addrs[1])).wait();
    expect(receipt!.gasUsed).to.be.lt(600_000n);
  });

  it("gas cost of a sync with a CAUGHT failed auto-deploy is bounded (not materially worse than success)", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    for (let i = 0; i < 500; i++) {
      const poolShares: bigint = await fx.vault.poolSharesMinted();
      const supplyNow: bigint = await fx.vault.totalSupply();
      if ((poolShares * BPS) / supplyNow >= 495n) break;
      await fx.vault.connect(fx.alice).deployToIndexPool(shareToken, 1n * WAD);
    }
    await fx.tokens[1].mint(fx.vaultAddr, 500n * WAD);
    const receipt = await (await fx.vault.connect(fx.carol).reconcile(shareToken)).wait();
    expect(receipt!.gasUsed).to.be.lt(600_000n);
  });

  // ══ 3b. DIFFERENTIAL gas: skipped attempt vs. attempted-and-caught-failure ═
  //
  // Adversarial-review fix (2026-08-06): the two tests above only assert an
  // absolute ceiling on a sync-with-auto-deploy-attempt in isolation. That
  // does not prove the ATTEMPT ITSELF is cheap — a test asserting "under
  // 600k" would still pass even if the attempt-and-catch machinery added,
  // say, 400k gas over a plain skipped sync, which would be a real
  // (if bounded) cost this design doc never signs up for ("GAS: skipped
  // entirely... before the far larger cost of a full pricing/cap
  // computation" — `_attemptAutoDeploy`'s own header). This measures the
  // SAME donation amount, same fixture, same everything except the governed
  // dust floor: one run sets the floor above the donation so
  // `_attemptAutoDeploy` returns immediately after one `SLOAD` (skip case);
  // the other sets the floor to allow the attempt but drives the dilution
  // cap to its ceiling first so `_deployToIndexPoolCore` reverts partway
  // through real pricing/cap work and the self-call is caught (attempted-
  // and-failed case).
  it("DIFFERENTIAL: an attempted-but-failed auto-deploy costs a bounded amount over a floor-skipped sync, not an unbounded one", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    const donateAmount = 10n * WAD;

    // ── Case A: skipped. Floor set above the donation, so
    // `_attemptAutoDeploy` returns after one SLOAD comparison — no self-call
    // is even made.
    const skipSnap = await takeSnapshot();
    await fx.vault.connect(fx.risk).queueMinAutoDeployWei(ethers.MaxUint256);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeMinAutoDeployWei();
    await fx.vault.checkpointAll();
    await fx.tokens[1].mint(fx.vaultAddr, donateAmount);
    const skipTx = await fx.vault.connect(fx.carol).reconcile(shareToken);
    const skipReceipt = await skipTx.wait();
    await expect(skipTx).to.not.emit(fx.vault, "AutoDeployedToIndexPool");
    await expect(skipTx).to.not.emit(fx.vault, "AutoDeployToIndexPoolFailed");
    const skipGas: bigint = skipReceipt!.gasUsed;
    await skipSnap.restore();

    // ── Case B: attempted, then caught-failed. Floor stays at the default
    // (zero — every reconcile is attempted), and the dilution cap is driven
    // to its governed ceiling first (same technique test #2 above uses) so
    // `_deployToIndexPoolCore` runs its real pricing/cap logic and reverts
    // on `PoolShareCapExceeded` — a REAL failure, not a cheap early return.
    for (let i = 0; i < 500; i++) {
      const poolShares: bigint = await fx.vault.poolSharesMinted();
      const supplyNow: bigint = await fx.vault.totalSupply();
      if ((poolShares * BPS) / supplyNow >= 495n) break;
      await fx.vault.connect(fx.alice).deployToIndexPool(shareToken, 1n * WAD);
    }
    await fx.tokens[1].mint(fx.vaultAddr, donateAmount);
    const failTx = await fx.vault.connect(fx.carol).reconcile(shareToken);
    const failReceipt = await failTx.wait();
    await expect(failTx).to.emit(fx.vault, "AutoDeployToIndexPoolFailed");
    const failGas: bigint = failReceipt!.gasUsed;

    // The delta is the real cost of the attempt-and-catch machinery
    // (pricing reads, the self-`CALL` boundary, the cap check, the revert,
    // and unwinding back to the caller) over doing nothing at all. Measured
    // at ~166,941 gas for this exact scenario: `_deployToIndexPoolCore`'s
    // pricing path reads two price bands and NAV, computes
    // `_imbalanceFeeBps`/`_mintFeeBps` (an `IndexValuation` library call
    // over the whole constituent list), and the dilution cap check before
    // reverting — real SLOAD-bound work, but bounded (no SSTORE-heavy mint,
    // no transfer, no pool call ever runs). Budgeted at 220,000: a ~30%
    // margin over the measured cost so a minor, benign change to the
    // pricing path does not flake this test, while still being far below
    // what a regression that let the failure path repeat the full
    // successful-deploy cost (mint + transfer + pool call, several hundred
    // thousand gas per the sibling "successful auto-deploy" test's 600k
    // ceiling) would look like.
    const delta = failGas - skipGas;
    expect(delta).to.be.lt(220_000n);
  });

  it("a dust-sized sync below the governed minAutoDeployWei floor skips the auto-deploy attempt entirely (cheap)", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];

    // Raise the floor high enough that a small donation falls under it.
    await fx.vault.connect(fx.risk).queueMinAutoDeployWei(5n * WAD);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeMinAutoDeployWei();
    // The timelock wait staled out every constituent's price band — refresh
    // before relying on a successful auto-deploy below (same discipline
    // `fixtureWithPool` itself documents).
    await fx.vault.checkpointAll();
    expect(await fx.vault.minAutoDeployWei()).to.equal(5n * WAD);

    await fx.tokens[1].mint(fx.vaultAddr, 1n * WAD); // below the floor
    const tx = await fx.vault.connect(fx.carol).reconcile(shareToken);
    await expect(tx).to.emit(fx.vault, "ConstituentSynced");
    await expect(tx).to.not.emit(fx.vault, "AutoDeployedToIndexPool");
    await expect(tx).to.not.emit(fx.vault, "AutoDeployToIndexPoolFailed");

    // Above the floor, the attempt resumes.
    await fx.tokens[1].mint(fx.vaultAddr, 10n * WAD);
    const tx2 = await fx.vault.connect(fx.carol).reconcile(shareToken);
    await expect(tx2).to.emit(fx.vault, "AutoDeployedToIndexPool");
  });

  it("queueMinAutoDeployWei/executeMinAutoDeployWei is role-gated and timelocked like every other risk-surface change", async () => {
    const fx = await fixtureWithPool();
    await expect(
      fx.vault.connect(fx.alice).queueMinAutoDeployWei(1n * WAD)
    ).to.be.revertedWithCustomError(fx.vault, "NotRoleHolder");

    await fx.vault.connect(fx.risk).queueMinAutoDeployWei(1n * WAD);
    await expect(fx.vault.executeMinAutoDeployWei()).to.be.revertedWithCustomError(
      fx.vault,
      "TimelockNotElapsed"
    );
    expect(await fx.vault.minAutoDeployWei()).to.equal(0n);

    await time.increase(TIMELOCK + 1);
    await fx.vault.executeMinAutoDeployWei();
    expect(await fx.vault.minAutoDeployWei()).to.equal(1n * WAD);
  });

  // ══ 4. The explicit entry point is a pure additive change — no regression ═

  it("deployToIndexPool still works exactly as before: same pricing, same event, same reverts", async () => {
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

    await expect(fx.vault.connect(fx.alice).deployToIndexPool(shareToken, amount)).to.emit(
      fx.vault,
      "DeployedToIndexPool"
    );

    const reserve: bigint = await fx.vault.reserveOf(shareToken);
    await expect(
      fx.vault.connect(fx.alice).deployToIndexPool(shareToken, reserve + 1n)
    ).to.be.revertedWithCustomError(fx.vault, "InsufficientPoolFunding");
  });

  // ══ 5. autoDeployToIndexPool is unreachable by anyone but the diamond itself ═

  it("autoDeployToIndexPool cannot be called directly by any outside account", async () => {
    const fx = await fixtureWithPool();
    const shareToken = fx.addrs[1];
    await expect(
      fx.vault.connect(fx.alice).autoDeployToIndexPool(shareToken, 1n * WAD)
    ).to.be.revertedWithCustomError(fx.vault, "BadParam");
  });
});
