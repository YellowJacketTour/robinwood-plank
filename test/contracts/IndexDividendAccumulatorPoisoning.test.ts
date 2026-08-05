import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployOpenIndex, warmCheckpoints, WAD, TIMELOCK, maxIn } from "./helpers/index-vault";

/**
 * ROUND 10, FIX 2 — THE DIVIDEND ACCUMULATOR CANNOT BE POISONED.
 *
 * The finding (AuditPoC IDX-01 / IDX-01b): `magnifiedDividendPerShare` is
 * monotonically non-decreasing with no reset anywhere, and its ceiling was
 * enforced by REVERTING the push. So one unprivileged actor could mint a
 * single base unit while the eligible supply was otherwise zero, push
 * `2**62` wei — about 4.6 whole tokens — and land the accumulator EXACTLY on
 * `2**126` in one transaction. They then claimed it all straight back, so
 * their net cost was gas. Afterwards every dividend push reverted forever, and
 * because `harvestEcosystemFees` routes through the same accumulator the
 * segregated ecosystem-fee ledger was permanently trapped with it.
 *
 * The fix caps the PER-PUSH delta at `room / 2**32` and CARRIES the remainder
 * instead of reverting. What this suite has to prove is four things, and the
 * last two are the ones that would be easy to get wrong:
 *
 *   1. the exact one-transaction attack no longer poisons anything;
 *   2. it is now economically self-destructive rather than free;
 *   3. exhaustion is not merely expensive but out of reach — the residual
 *      headroom after the attack is still overwhelmingly most of the ceiling;
 *   4. the fix does not brick ORDINARY use: a long, high-volume timeline of
 *      legitimate pushes distributes in full, loses nothing, and never defers.
 *
 * LOCAL HARDHAT ONLY.
 */
describe("Index dividends — the accumulator cannot be poisoned (round 10)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const MAGNITUDE = 2n ** 64n;
  const MAX_MAGNIFIED = 2n ** 126n;
  const DIVISOR = 2n ** 32n;
  const SEED_LOCK = "0x000000000000000000000000000000000000dEaD";

  /** The audit's exact opening move: become the ONLY eligible holder, at 1 unit. */
  async function soleHolderAtOneUnit() {
    const fx = await deployOpenIndex();
    const divAsset = fx.tokens[0]; // the vault's immutable dividendAsset
    await divAsset.connect(fx.alice).approve(fx.vaultAddr, ethers.MaxUint256);
    await fx.vault.connect(fx.alice).mintProRata(1n, maxIn(3));
    const eligible: bigint =
      (await fx.vault.totalSupply()) - (await fx.vault.balanceOf(SEED_LOCK));
    expect(eligible).to.equal(1n); // divisor == 1, exactly as in IDX-01
    return { fx, divAsset };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. The exact attack, refused
  // ══════════════════════════════════════════════════════════════════════════

  it("the IDX-01 one-transaction poisoning lands nowhere near the ceiling", async () => {
    const { fx } = await soleHolderAtOneUnit();

    // `pot * MAGNITUDE / eligible` = 2**62 * 2**64 / 1 = 2**126 — the exact
    // ceiling, in one transaction, before round 10.
    await fx.vault.connect(fx.alice).receiveDividendsWrapped(2n ** 62n);

    const acc: bigint = await fx.vault.magnifiedDividendPerShare();
    // Clamped to one step of headroom: 2**126 / 2**32 = 2**94.
    expect(acc).to.equal(MAX_MAGNIFIED / DIVISOR);
    expect(acc).to.be.lessThan(MAX_MAGNIFIED);

    // The unaccommodated remainder is HELD, not lost and not reverted.
    const carried: bigint = await fx.vault.undistributedDividends();
    expect(carried).to.be.greaterThan(0n);
    expect(carried + acc / MAGNITUDE).to.equal(2n ** 62n); // conservation

    // Headroom left: still 1 - 2**-32 of the ceiling. Four billion more
    // transactions would be needed to consume the rest, one step at a time.
    const remaining = MAX_MAGNIFIED - acc;
    expect(remaining * 100n) .to.be.greaterThan(MAX_MAGNIFIED * 99n);
  });

  it("the attack is now self-destructive: the attacker recovers a billionth of the push", async () => {
    const { fx, divAsset } = await soleHolderAtOneUnit();
    const pushed = 2n ** 62n;
    const before: bigint = await divAsset.balanceOf(fx.alice.address);

    await fx.vault.connect(fx.alice).receiveDividendsWrapped(pushed);
    await fx.vault.connect(fx.alice).claimDividend();

    const after: bigint = await divAsset.balanceOf(fx.alice.address);
    const netCost = before - after;
    // Before round 10 this was EXACTLY ZERO — full recovery, gas-only attack.
    expect(netCost).to.be.greaterThan(0n);
    // They get back only what one step of headroom distributes: 2**94 / 2**64.
    expect(pushed - netCost).to.equal(2n ** 30n);
    // i.e. they destroyed >99.99999% of what they spent, for 2**-32 of the
    // headroom. That is the whole economic inversion.
    expect(netCost * 1_000_000n).to.be.greaterThan(pushed * 999_999n);
  });

  it("every future push still works, and the mechanism keeps paying real holders", async () => {
    const { fx } = await soleHolderAtOneUnit();
    await fx.vault.connect(fx.alice).receiveDividendsWrapped(2n ** 62n);
    await fx.vault.connect(fx.alice).claimDividend();

    // An honest holder arrives at real size AFTER the attack.
    await fx.vault.connect(fx.bob).mintProRata(100n * WAD, maxIn(3));
    await fx.tokens[0].connect(fx.carol).approve(fx.vaultAddr, ethers.MaxUint256);

    // The push that reverted `DividendAccumulatorFull` forever now works...
    await fx.vault.connect(fx.carol).receiveDividendsWrapped(1n * WAD);
    // ...and pays Bob, which is the property the attack destroyed.
    expect(await fx.vault.withdrawableDividendOf(fx.bob.address)).to.be.greaterThan(0n);

    const held: bigint = await fx.tokens[0].balanceOf(fx.bob.address);
    await fx.vault.connect(fx.bob).claimDividend();
    expect(await fx.tokens[0].balanceOf(fx.bob.address)).to.be.greaterThan(held);
  });

  it("the carried remainder is not lost — it folds in once the supply is real", async () => {
    const { fx } = await soleHolderAtOneUnit();
    await fx.vault.connect(fx.alice).receiveDividendsWrapped(2n ** 62n);
    const carried: bigint = await fx.vault.undistributedDividends();
    expect(carried).to.be.greaterThan(0n);

    // A real supply arrives, so the same pot now implies an ordinary delta.
    await fx.vault.connect(fx.bob).mintProRata(1_000n * WAD, maxIn(3));
    await fx.tokens[0].connect(fx.carol).approve(fx.vaultAddr, ethers.MaxUint256);
    await fx.vault.connect(fx.carol).receiveDividendsWrapped(1n);

    // The whole backlog was distributed in that one ordinary push.
    expect(await fx.vault.undistributedDividends()).to.equal(0n);
    // Bob, who holds essentially the entire eligible supply, is owed
    // essentially the entire backlog.
    const owed: bigint = await fx.vault.withdrawableDividendOf(fx.bob.address);
    expect(owed * 100n).to.be.greaterThan(carried * 99n);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. The trapped ecosystem-fee ledger (IDX-01b)
  // ══════════════════════════════════════════════════════════════════════════

  it("the ecosystem-fee ledger can no longer be trapped behind a poisoned accumulator", async () => {
    const fx = await deployOpenIndex();
    await fx.tokens[0].connect(fx.alice).approve(fx.vaultAddr, ethers.MaxUint256);

    // Appoint the vault as its own sink, through the real timelock — the
    // production shape the header names.
    await fx.vault
      .connect(fx.allocation)
      .queueParam(ethers.encodeBytes32String("ecosystemSink"), BigInt(fx.vaultAddr));
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeParam(ethers.encodeBytes32String("ecosystemSink"));

    // Poison, exactly as in IDX-01b.
    await fx.vault.connect(fx.alice).mintProRata(1n, maxIn(3));
    await fx.vault.connect(fx.alice).receiveDividendsWrapped(2n ** 62n);
    await fx.vault.connect(fx.alice).claimDividend();

    await warmCheckpoints(fx, 4);
    await fx.vault.connect(fx.bob).mintSingleAsset(fx.addrs[0], 5n * WAD, 0n);
    const trapped: bigint = await fx.vault.ecosystemFeesWei(fx.addrs[0]);
    expect(trapped).to.be.greaterThan(0n);

    // THE FIX. The one and only exit from the ledger is open again, and it is
    // still permissionless with a fixed destination.
    await expect(fx.vault.connect(fx.carol).harvestEcosystemFees()).to.emit(
      fx.vault,
      "EcosystemFeesHarvested"
    );
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.equal(0n);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. Ordinary use is untouched — the half that is easy to break
  // ══════════════════════════════════════════════════════════════════════════

  it("a long, high-volume timeline of legitimate pushes never defers and never bricks", async () => {
    const fx = await deployOpenIndex();
    const divAsset = fx.tokens[0];
    for (const who of [fx.alice, fx.bob, fx.carol]) {
      await divAsset.connect(who).approve(fx.vaultAddr, ethers.MaxUint256);
    }
    // A realistic float: three holders at real size.
    await fx.vault.connect(fx.alice).mintProRata(1_000n * WAD, maxIn(3));
    await fx.vault.connect(fx.bob).mintProRata(2_500n * WAD, maxIn(3));

    let pushedTotal = 0n;
    const ROUNDS = 120;
    for (let i = 0; i < ROUNDS; i++) {
      // Pushes of wildly varying size, holders entering and leaving between
      // them — i.e. the accumulator is moving under real churn, not in a lab.
      const amount = WAD * BigInt(1 + (i % 17) * 37);
      await fx.vault.connect(fx.carol).receiveDividendsWrapped(amount);
      pushedTotal += amount;
      // Nothing is EVER deferred on this timeline. That is the claim.
      expect(await fx.vault.undistributedDividends()).to.equal(0n);

      if (i % 10 === 3) await fx.vault.connect(fx.alice).mintProRata(50n * WAD, maxIn(3));
      if (i % 10 === 7) {
        await fx.vault.connect(fx.bob).redeemProRata(25n * WAD, [0n, 0n, 0n]);
      }
      if (i % 25 === 11) await fx.vault.connect(fx.alice).claimDividend();
    }

    // The accumulator is still a rounding error away from zero relative to its
    // ceiling — 120 real pushes did not measurably consume the headroom.
    const acc: bigint = await fx.vault.magnifiedDividendPerShare();
    expect(acc).to.be.greaterThan(0n);
    expect(acc * 1_000_000_000n).to.be.lessThan(MAX_MAGNIFIED);

    // Everything that went in is claimable, and claims never exceed receipts.
    await fx.vault.connect(fx.alice).claimDividend();
    await fx.vault.connect(fx.bob).claimDividend();
    expect(await fx.vault.totalDividendsWithdrawn()).to.be.lessThanOrEqual(
      await fx.vault.totalDividendsReceived()
    );
    expect(await fx.vault.totalDividendsReceived()).to.equal(pushedTotal);
    // And the loss to flooring across 120 pushes is negligible, not systemic.
    const unpaid =
      (await fx.vault.totalDividendsReceived()) -
      (await fx.vault.totalDividendsWithdrawn());
    expect(unpaid * 1_000_000n).to.be.lessThan(pushedTotal);
  });

  it("the zero-denominator carry (round 9e) still behaves exactly as it did", async () => {
    const fx = await deployOpenIndex();
    await fx.tokens[0].connect(fx.alice).approve(fx.vaultAddr, ethers.MaxUint256);
    // No eligible supply at all — only the locked seed exists.
    expect(
      (await fx.vault.totalSupply()) - (await fx.vault.balanceOf(SEED_LOCK))
    ).to.equal(0n);

    await fx.vault.connect(fx.alice).receiveDividendsWrapped(5n * WAD);
    expect(await fx.vault.undistributedDividends()).to.equal(5n * WAD);
    expect(await fx.vault.magnifiedDividendPerShare()).to.equal(0n);

    // ...and it folds in, in full, on the first push that has holders.
    await fx.vault.connect(fx.bob).mintProRata(100n * WAD, maxIn(3));
    await fx.tokens[0].connect(fx.carol).approve(fx.vaultAddr, ethers.MaxUint256);
    await fx.vault.connect(fx.carol).receiveDividendsWrapped(1n * WAD);
    expect(await fx.vault.undistributedDividends()).to.equal(0n);
    const owed: bigint = await fx.vault.withdrawableDividendOf(fx.bob.address);
    expect(owed * 1_000n).to.be.greaterThan(6n * WAD * 999n);
  });

  it("no push, of any size, at any supply, can make the accumulator exceed its ceiling", async () => {
    // The property the transfer hook's overflow proof rests on. Hammer it with
    // the pathological cases rather than the plausible ones.
    const { fx } = await soleHolderAtOneUnit();
    for (const amount of [1n, 2n ** 32n, 2n ** 62n, 2n ** 70n, 2n ** 80n]) {
      await fx.tokens[0].mint(fx.alice.address, amount);
      await fx.vault.connect(fx.alice).receiveDividendsWrapped(amount);
      expect(await fx.vault.magnifiedDividendPerShare()).to.be.lessThanOrEqual(
        MAX_MAGNIFIED
      );
      // And a transfer of the share token still works, every single time —
      // which is the failure this mechanism is forbidden to have.
      await fx.vault.connect(fx.alice).transfer(fx.bob.address, 0n);
    }
  });
});
