import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import {
  loadFixture,
  time,
  takeSnapshot,
  type SnapshotRestorer,
} from "./helpers/network-helpers.js";

import { deployOpenIndex, maxIn, zeroOut, WAD } from "./helpers/index-vault.js";

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  AUDIT F-3 — "the exit door touches no external code", proved BEHAVIOURALLY.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS REPLACES. `Hooks.exitDoorFree.test.ts:53-59` proved this property
 * by GREPPING THE SOURCE TEXT of `IndexCoreFacet.sol` for the strings
 * `HooksStorage` and `_fireHook`. That check is structurally incapable of
 * seeing the path the hook actually fired through:
 *
 *   redeemProRata
 *     -> _attemptOpportunisticReconcile        (IndexCoreFacet.sol:234)
 *       -> address(this).call("autoReconcile") (a CROSS-FACET self-call,
 *                                               dispatched by the diamond's
 *                                               fallback — invisible to any
 *                                               grep of this file)
 *         -> _reconcileCore
 *           -> _fireHook(HOOK_AFTER_SYNC_)     (IndexFacetBase.sol:1283)
 *
 * A green grep therefore certified a false claim for as long as it existed.
 * The source-level assertions are still worth keeping as a first line — they
 * are retained in `Hooks.exitDoorFree.test.ts` — but they are NOT the proof,
 * and this file is.
 *
 * THE CONTROL IS THE POINT. Test 1 asserts a counter does not move, which is
 * exactly the shape of assertion that passes when nothing is wired up at all.
 * Test 0 therefore proves, in the same fixture and against the same hook
 * instance, that the counter DOES move on a path that legitimately fires it.
 * Without that control, test 1 would be a fourth vacuous proof.
 *
 * LOCAL HARDHAT ONLY.
 */
describe("AUDIT F-3 — the exit door invokes no external hook (behavioural)", () => {
  const fixture = () => deployOpenIndex();

  // Registering a hook advances the shared Hardhat clock by a full timelock
  // delay per call, and Mocha shares one network across files — without
  // restoring afterwards the fixed-endTime Seaport orders in later suites
  // silently expire. Same guard, same reasoning, as
  // `Hooks.exitDoorFree.test.ts` and `ScopedRoles.isolation.test.ts`.
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  /** Register a RECORD-mode MockHook at AFTER_SYNC through the real timelock. */
  async function armSyncHook(fx: any) {
    const hook: any = await (await ethers.getContractFactory("MockHook")).deploy(0);
    const point = await fx.vault.AFTER_SYNC();
    await fx.vault.connect(fx.risk).queueHook(point, await hook.getAddress(), 0);
    await time.increase(48 * 3600 + 1);
    await fx.vault.executeHook(point);
    return hook;
  }

  /** Leave an unreconciled surplus, so any reconcile that runs really credits. */
  async function strandSurplus(fx: any, amount: bigint) {
    await fx.tokens[1].mint(fx.alice.address, amount);
    await fx.tokens[1].connect(fx.alice).transfer(fx.vaultAddr, amount);
  }

  it("0. CONTROL: the very same hook DOES fire on a path that reconciles (so a zero below means something)", async () => {
    const fx = await loadFixture(fixture);
    const hook = await armSyncHook(fx);

    await strandSurplus(fx, 50n * WAD);
    const before: bigint = await hook.calls();

    // `mintProRata` still reconciles opportunistically — deliberately, per
    // §7.2. Only the EXIT door was removed from that list.
    await fx.vault.connect(fx.alice).mintProRata(100n * WAD, maxIn(3));

    expect(await hook.calls()).to.be.greaterThan(
      before,
      "the hook never fires anywhere — the control is broken, so test 1 proves nothing"
    );
  });

  it("1. redeemProRata fires NO hook, even with a real surplus waiting to be reconciled", async () => {
    const fx = await loadFixture(fixture);
    const hook = await armSyncHook(fx);

    await fx.vault.connect(fx.alice).mintProRata(100n * WAD, maxIn(3));

    // The exact setup the audit PoC used: a surplus sitting on the diamond, so
    // an opportunistic reconcile on the exit path would genuinely credit and
    // therefore genuinely fire AFTER_SYNC.
    await strandSurplus(fx, 50n * WAD);

    const before: bigint = await hook.calls();
    await fx.vault.connect(fx.alice).redeemProRata(10n * WAD, zeroOut(3));
    expect(await hook.calls()).to.equal(
      before,
      "an external hook was invoked during redeemProRata — the exit door is not sacred"
    );
  });

  it("2. claimPending fires no hook either", async () => {
    const fx = await loadFixture(fixture);
    const hook = await armSyncHook(fx);
    await fx.vault.connect(fx.alice).mintProRata(100n * WAD, maxIn(3));
    await strandSurplus(fx, 50n * WAD);

    const before: bigint = await hook.calls();
    // Nothing is deferred, so this reverts — but it must revert on ZeroAmount,
    // having consulted no hook, rather than reaching any external code first.
    await expect(fx.vault.connect(fx.alice).claimPending(fx.addrs[1])).to.be.revertedWithCustomError(
      fx.vault,
      "ZeroAmount"
    );
    expect(await hook.calls()).to.equal(before);
  });

  it("3. a surplus stranded during an exit is NOT lost — the next mint still reconciles it", async () => {
    // Removing the reconcile from the exit door must not silently strand
    // value. It is picked up by the next non-exit interaction.
    const fx = await loadFixture(fixture);
    const { vault, alice, addrs } = fx;

    await vault.connect(alice).mintProRata(100n * WAD, maxIn(3));
    await strandSurplus(fx, 50n * WAD);
    await vault.connect(alice).redeemProRata(10n * WAD, zeroOut(3));

    const before: bigint = await vault.reserveOf(addrs[1]);
    const [, required] = await vault.previewMintProRata(10n * WAD);
    await vault.connect(alice).mintProRata(10n * WAD, maxIn(3));
    const after: bigint = await vault.reserveOf(addrs[1]);

    // The reserve grew by the deposit AND by the stranded surplus. Comparing
    // against the deposit alone is what makes this able to fail: if the
    // surplus were genuinely lost, the delta would equal `required`.
    expect(after - before).to.be.greaterThan(
      (required[1] as bigint) + 40n * WAD,
      "the surplus stranded by the exit was never reconciled afterwards"
    );
  });
});
