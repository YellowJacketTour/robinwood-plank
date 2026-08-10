import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { takeSnapshot, time, type SnapshotRestorer } from "./helpers/network-helpers.js";
import {
  MIN_CHECKPOINT,
  TIMELOCK,
  WAD,
  deployOpenIndex,
  indexVaultFactory,
  defaultParams,
  paramsTuple,
} from "./helpers/index-vault.js";

/**
 * ============================================================================
 * ROUND 9b — ON-CHAIN DIVIDEND ACCRUAL WITH NO STAKING, NO SNAPSHOT, NO ROOT
 *
 * The mechanism under test is the magnified-dividend-per-share accumulator
 * (EIP-2222 FundsDistributionToken lineage) folded into GlobalIndexVault
 * itself. Holders hold the freely-tradeable share ERC-20 in their own wallet
 * and their claimable entitlement is always already correct.
 *
 * This file is written to BREAK it, not to demonstrate it. The five things
 * that would each be a real bug, and which each get a test that would catch
 * them:
 *
 *   1. A buyer reaching back for a distribution that predates them. The
 *      correction term is the only thing preventing it, and the test is built
 *      so that a broken correction term produces a visibly wrong number rather
 *      than a rounding difference: Alice and Bob end up with the IDENTICAL
 *      `balanceOf` history shape at different times, so any mechanism that
 *      keys off the balance alone gives them the same answer — and the right
 *      answer is that they get disjoint halves.
 *
 *   2. A redeemer losing their accrued dividend at burn time. `redeemProRata`
 *      burns to zero; the entitlement is for value already earned and must
 *      survive the balance going to zero.
 *
 *   3. `redeemProRata` itself changing — in payout or in reachability. This is
 *      the single highest-priority regression check in the file, because that
 *      function backs real user redemption and the hook now runs inside it.
 *
 *   4. Total claimable exceeding total received. Asserted over a long
 *      randomised sequence of mints, burns, transfers, pushes and claims.
 *
 *   5. The hook bricking transferability. A dividend-bookkeeping bug must
 *      never be able to stop a share from moving, for the same reason it must
 *      never be able to stop a redemption.
 * ============================================================================
 */
describe("GlobalIndexVault — on-chain dividend accrual (no staking)", () => {
  // This file advances the clock by multiple timelock periods. Other suites in
  // this run (the Seaport ones) pin orders to ABSOLUTE expiry timestamps, so
  // leaking that advancement out of this describe expires them. Snapshot on the
  // way in, restore on the way out — the same discipline the other
  // time-advancing suites here use.
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const E = (n: string) => ethers.parseEther(n);
  const maxIn = (n: number) => new Array(n).fill(ethers.MaxUint256);

  /** An opened basket whose dividend asset is constituent 0. */
  async function fixture() {
    const fx = await deployOpenIndex();
    // Everyone can push dividends: the asset is a plain ERC-20 they hold.
    for (const who of [fx.alice, fx.bob, fx.carol]) {
      await fx.tokens[0].connect(who).approve(fx.vaultAddr, ethers.MaxUint256);
    }
    return fx;
  }

  /** Push `amount` of the dividend asset from `who`. */
  async function push(fx: any, who: any, amount: bigint) {
    return fx.vault.connect(who).receiveDividendsWrapped(amount);
  }

  /** Mint `shares` pro-rata to `who`. */
  async function mint(fx: any, who: any, shares: bigint) {
    return fx.vault.connect(who).mintProRata(shares, maxIn(3));
  }

  // ══ 1. The accrual survives every shape a balance change can take ═══════

  it("credits a holder who does nothing but HOLD — no stake, no proof, no snapshot", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("100"));

    expect(await fx.vault.withdrawableDividendOf(fx.alice.address)).to.equal(0n);
    await push(fx, fx.carol, E("10"));

    // Alice never touched the vault between the mint and this read.
    const owed: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);
    expect(owed).to.be.greaterThan(0n);

    const before: bigint = await fx.tokens[0].balanceOf(fx.alice.address);
    await fx.vault.connect(fx.alice).claimDividend();
    expect((await fx.tokens[0].balanceOf(fx.alice.address)) - before).to.equal(owed);
    expect(await fx.vault.withdrawableDividendOf(fx.alice.address)).to.equal(0n);
  });

  it("a MINT after the push earns nothing from it — new money cannot buy old dividends", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("100"));
    await push(fx, fx.carol, E("10"));
    const aliceOwed: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);

    // Bob mints AFTER the distribution, at ten times Alice's size.
    await mint(fx, fx.bob, E("1000"));
    expect(await fx.vault.withdrawableDividendOf(fx.bob.address)).to.equal(0n);
    // ...and Alice's entitlement did not move either.
    expect(await fx.vault.withdrawableDividendOf(fx.alice.address)).to.equal(aliceOwed);
  });

  it("a BURN does not destroy an accrued dividend — the entitlement is for value already earned", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("100"));
    await push(fx, fx.carol, E("10"));
    const owed: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);
    expect(owed).to.be.greaterThan(0n);

    // Burn EVERY share Alice holds, through the real redemption path.
    const all: bigint = await fx.vault.balanceOf(fx.alice.address);
    await fx.vault.connect(fx.alice).redeemProRata(all, [0n, 0n, 0n]);
    expect(await fx.vault.balanceOf(fx.alice.address)).to.equal(0n);

    // Balance zero, entitlement intact — and really payable.
    expect(await fx.vault.withdrawableDividendOf(fx.alice.address)).to.equal(owed);
    const before: bigint = await fx.tokens[0].balanceOf(fx.alice.address);
    await fx.vault.connect(fx.alice).claimDividend();
    expect((await fx.tokens[0].balanceOf(fx.alice.address)) - before).to.equal(owed);
  });

  it("a plain third-party TRANSFER moves future accrual and never past accrual", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("100"));
    await push(fx, fx.carol, E("10"));
    const aliceOwed: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);

    await fx.vault.connect(fx.alice).transfer(fx.bob.address, E("100"));

    // The shares moved. The already-earned dividend did not.
    expect(await fx.vault.balanceOf(fx.bob.address)).to.equal(E("100"));
    expect(await fx.vault.withdrawableDividendOf(fx.alice.address)).to.equal(aliceOwed);
    expect(await fx.vault.withdrawableDividendOf(fx.bob.address)).to.equal(0n);
  });

  it("transferFrom behaves identically — the hook is on the balance change, not the entry point", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("100"));
    await push(fx, fx.carol, E("10"));
    const aliceOwed: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);

    await fx.vault.connect(fx.alice).approve(fx.carol.address, ethers.MaxUint256);
    await fx.vault.connect(fx.carol).transferFrom(fx.alice.address, fx.bob.address, E("60"));

    expect(await fx.vault.withdrawableDividendOf(fx.alice.address)).to.equal(aliceOwed);
    expect(await fx.vault.withdrawableDividendOf(fx.bob.address)).to.equal(0n);
    // The party who EXECUTED the transfer is credited nothing for doing so.
    expect(await fx.vault.withdrawableDividendOf(fx.carol.address)).to.equal(0n);
  });

  // ══ 2. THE CORRECTION-TERM TEST — the one that catches a broken term ════

  it("SELL ACROSS A PUSH: Alice gets push #1 only, Bob gets push #2 only, with identical balance shapes", async () => {
    const fx = await fixture();

    // Alice is the ONLY non-seed holder, so she is entitled to the whole
    // eligible share of push #1 and the arithmetic is exact rather than
    // approximate — which is what makes a wrong answer unmistakable.
    await mint(fx, fx.alice, E("100"));
    await push(fx, fx.carol, E("10"));
    const afterFirst: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);
    expect(afterFirst).to.be.greaterThan(0n);

    // Alice sells the ENTIRE position to Bob. From here Bob's balance history
    // has exactly the shape Alice's had before push #1: 100 shares, held
    // across one distribution. Any mechanism that reads the balance alone —
    // i.e. any mechanism with a broken or missing correction term — must give
    // them the same answer. The right answer is that they are disjoint.
    await fx.vault.connect(fx.alice).transfer(fx.bob.address, E("100"));
    await push(fx, fx.carol, E("10"));

    const aliceFinal: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);
    const bobFinal: bigint = await fx.vault.withdrawableDividendOf(fx.bob.address);

    // Alice: EXACTLY her first-push share, and not one wei of the second.
    expect(aliceFinal).to.equal(afterFirst);
    // Bob: EXACTLY his second-push share, and nothing of the first. The two
    // pushes were the same size against the same eligible supply, so Bob's
    // entitlement must equal Alice's to the wei.
    expect(bobFinal).to.equal(afterFirst);
    // And neither of them got both.
    expect(aliceFinal + bobFinal).to.be.lessThanOrEqual(E("20"));

    // Both are really payable, simultaneously, from a pot that holds both.
    await expect(fx.vault.connect(fx.alice).claimDividend()).to.not.be.revert(ethers);
    await expect(fx.vault.connect(fx.bob).claimDividend()).to.not.be.revert(ethers);
    expect(await fx.vault.withdrawableDividendOf(fx.alice.address)).to.equal(0n);
    expect(await fx.vault.withdrawableDividendOf(fx.bob.address)).to.equal(0n);
  });

  it("a PARTIAL sale splits the next push and leaves the previous one where it was", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("100"));
    await push(fx, fx.carol, E("10"));
    const first: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);

    await fx.vault.connect(fx.alice).transfer(fx.bob.address, E("25"));
    await push(fx, fx.carol, E("10"));

    const aliceGain = (await fx.vault.withdrawableDividendOf(fx.alice.address)) - first;
    const bobGain: bigint = await fx.vault.withdrawableDividendOf(fx.bob.address);
    // 75/25 of the second push, to within flooring dust.
    expect(aliceGain).to.be.greaterThan(bobGain * 2n);
    expect(aliceGain).to.be.lessThan(bobGain * 4n);
  });

  it("claiming twice pays once — `withdrawnDividends` is a high-water mark, not a flag", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("100"));
    await push(fx, fx.carol, E("10"));

    await fx.vault.connect(fx.alice).claimDividend();
    const mid: bigint = await fx.tokens[0].balanceOf(fx.alice.address);
    // A second claim pays zero and does NOT revert — paying zero is a
    // successful transaction, not an error.
    await expect(fx.vault.connect(fx.alice).claimDividend()).to.not.be.revert(ethers);
    expect(await fx.tokens[0].balanceOf(fx.alice.address)).to.equal(mid);

    // A later push is still earned normally on top of the claimed amount.
    await push(fx, fx.carol, E("10"));
    expect(await fx.vault.withdrawableDividendOf(fx.alice.address)).to.be.greaterThan(0n);
  });

  // ══ 3. redeemProRata: the highest-priority regression ═══════════════════

  it("REGRESSION: redeemProRata pays BIT-FOR-BIT the same with a fat dividend pot as with none", async () => {
    // Differential execution: the identical script, once with dividends never
    // pushed and once with a large pot accumulated, asserting the redeemer's
    // per-constituent amounts are equal to the wei.
    async function run(withDividends: boolean) {
      const fx = await fixture();
      await mint(fx, fx.alice, E("100"));
      await mint(fx, fx.bob, E("250"));
      if (withDividends) {
        await push(fx, fx.carol, E("500"));
        await push(fx, fx.carol, E("500"));
      }
      const before = await Promise.all(
        fx.tokens.map((t: any) => t.balanceOf(fx.alice.address))
      );
      await fx.vault.connect(fx.alice).redeemProRata(E("60"), [0n, 0n, 0n]);
      const after = await Promise.all(
        fx.tokens.map((t: any) => t.balanceOf(fx.alice.address))
      );
      return after.map((a: bigint, i: number) => a - before[i]);
    }
    const off = await run(false);
    const on = await run(true);
    for (let i = 0; i < 3; i++) {
      expect(on[i]).to.equal(off[i], `constituent ${i} payout moved with the dividend pot`);
    }
    // ...and the dividend pot is in the SAME token as constituent 0, so this
    // is the hard case, not the easy one: the vault's balance of that token
    // covers both ledgers and the redeemer is still paid from `reserve` alone.
    expect(off[0]).to.be.greaterThan(0n);
  });

  it("REGRESSION: redeemProRata is UNBLOCKABLE — an unclaimed, un-claimable dividend never stands in its way", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("100"));
    await push(fx, fx.carol, E("50"));
    // Alice never claims. She simply exits, in full, and then in full again
    // after a second push she is entitled to nothing from.
    await expect(
      fx.vault.connect(fx.alice).redeemProRata(await fx.vault.balanceOf(fx.alice.address), [0n, 0n, 0n])
    ).to.not.be.revert(ethers);
    await push(fx, fx.carol, E("50"));
    await mint(fx, fx.alice, E("10"));
    await expect(
      fx.vault.connect(fx.alice).redeemProRata(await fx.vault.balanceOf(fx.alice.address), [0n, 0n, 0n])
    ).to.not.be.revert(ethers);
  });

  it("REGRESSION: the hook's gas cost on redeemProRata is a disclosed, bounded number", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("100"));
    const cold = await (
      await fx.vault.connect(fx.alice).redeemProRata(E("10"), [0n, 0n, 0n])
    ).wait();
    await push(fx, fx.carol, E("10"));
    const warm = await (
      await fx.vault.connect(fx.alice).redeemProRata(E("10"), [0n, 0n, 0n])
    ).wait();
    // A redemption is a multi-constituent transfer loop costing >100k gas; the
    // burn-side correction is one SSTORE on top of it. Assert the ratio, not a
    // magic number, so this stays meaningful if the surrounding code changes.
    expect(Number(warm!.gasUsed)).to.be.lessThan(Number(cold!.gasUsed) * 1.25);
    // eslint-disable-next-line no-console
    console.log(
      `        redeemProRata gas: ${cold!.gasUsed} (zero accumulator) -> ${warm!.gasUsed} (live accumulator)`
    );
  });

  // ══ 4. The ceiling, and the seed ════════════════════════════════════════

  it("the permanently-locked seed accrues NOTHING — no slice of a distribution is stranded", async () => {
    const fx = await fixture();
    const seedLock: string = await fx.vault.SEED_LOCK();
    expect(await fx.vault.balanceOf(seedLock)).to.be.greaterThan(0n);

    await mint(fx, fx.alice, E("100"));
    await push(fx, fx.carol, E("10"));

    expect(await fx.vault.withdrawableDividendOf(seedLock)).to.equal(0n);
    expect(await fx.vault.accumulativeDividendOf(seedLock)).to.equal(0n);
    // Alice, the only eligible holder, gets essentially the whole push — which
    // she would NOT if the locked seed (10x her size) were in the denominator.
    const owed: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);
    expect(owed).to.be.greaterThan((E("10") * 99n) / 100n);
  });

  it("a push with no eligible holder is PARKED, never lost and never reverted", async () => {
    const fx = await fixture();
    // Only the locked seed exists, so eligible supply is zero.
    await push(fx, fx.carol, E("5"));
    expect(await fx.vault.undistributedDividends()).to.equal(E("5"));
    expect(await fx.vault.totalDividendsReceived()).to.equal(E("5"));
    expect(await fx.vault.magnifiedDividendPerShare()).to.equal(0n);

    // It folds into the accumulator on the first push that HAS holders.
    await mint(fx, fx.alice, E("100"));
    await push(fx, fx.carol, E("5"));
    expect(await fx.vault.undistributedDividends()).to.equal(0n);
    expect(await fx.vault.withdrawableDividendOf(fx.alice.address)).to.be.greaterThan(
      (E("10") * 99n) / 100n
    );
  });

  it("CEILING: total withdrawable never exceeds total received, over a long randomised sequence", async () => {
    const fx = await fixture();
    const actors = [fx.alice, fx.bob, fx.carol];
    // Deterministic LCG — same style as this repo's other randomised suites.
    let seed = 1234567n;
    const rnd = (n: number) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      return Number(seed % BigInt(n));
    };

    let claimedTotal = 0n;
    for (let step = 0; step < 180; step++) {
      const who = actors[rnd(3)];
      const op = rnd(5);
      try {
        if (op === 0) {
          await mint(fx, who, BigInt(rnd(50) + 1) * WAD);
        } else if (op === 1) {
          const bal: bigint = await fx.vault.balanceOf(who.address);
          if (bal > WAD) await fx.vault.connect(who).redeemProRata(bal / 2n, [0n, 0n, 0n]);
        } else if (op === 2) {
          const bal: bigint = await fx.vault.balanceOf(who.address);
          const to = actors[rnd(3)];
          if (bal > WAD && to.address !== who.address) {
            await fx.vault.connect(who).transfer(to.address, bal / 3n);
          }
        } else if (op === 3) {
          await push(fx, fx.carol, BigInt(rnd(20) + 1) * WAD);
        } else {
          const owed: bigint = await fx.vault.withdrawableDividendOf(who.address);
          await fx.vault.connect(who).claimDividend();
          claimedTotal += owed;
        }
      } catch {
        // A revert from an unrelated guard (slippage, cap, persistence) is
        // fine and expected; what must never happen is the invariant breaking.
      }

      // THE INVARIANT, checked every single step.
      const received: bigint = await fx.vault.totalDividendsReceived();
      const withdrawn: bigint = await fx.vault.totalDividendsWithdrawn();
      let outstanding = 0n;
      for (const a of [...actors, { address: await fx.vault.SEED_LOCK() }]) {
        outstanding += await fx.vault.withdrawableDividendOf(a.address);
      }
      expect(withdrawn + outstanding).to.be.lessThanOrEqual(
        received,
        `step ${step}: claimable exceeded received`
      );
      expect(withdrawn).to.equal(claimedTotal);
    }
    // The sequence actually drove the mechanism rather than reverting through.
    expect(await fx.vault.totalDividendsReceived()).to.be.greaterThan(0n);
    expect(await fx.vault.totalDividendsWithdrawn()).to.be.greaterThan(0n);
  });

  it("SOLVENCY: the vault always holds at least reserve + undrawn dividends of the dividend asset", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("100"));
    await mint(fx, fx.bob, E("100"));
    await push(fx, fx.carol, E("40"));
    await fx.vault.connect(fx.alice).claimDividend();

    const held: bigint = await fx.tokens[0].balanceOf(fx.vaultAddr);
    const reserve: bigint = await fx.vault.reserveOf(fx.addrs[0]);
    const received: bigint = await fx.vault.totalDividendsReceived();
    const withdrawn: bigint = await fx.vault.totalDividendsWithdrawn();
    expect(held).to.be.greaterThanOrEqual(reserve + (received - withdrawn));
  });

  // ══ 5. Transferability can never be bricked ════════════════════════════

  it("the hook cannot brick a transfer — it makes no call, and there is no parameter that can fail it", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("100"));
    await push(fx, fx.carol, E("100"));

    // There is no admin surface over any of this. Enumerate the ABI and prove
    // there is no setter that could ever be pointed at anything.
    const names = (fx.vault.interface.fragments as any[])
      .filter((f) => f.type === "function")
      .map((f) => f.name);
    for (const n of names) {
      expect(/^set[A-Z]/.test(n)).to.equal(false, `${n} is a direct setter`);
    }
    // `dividendAsset` has no queue key at all — it is immutable.
    await expect(
      fx.vault.connect(fx.allocation).queueParam(
        ethers.encodeBytes32String("dividendAsset"),
        fx.addrs[1]
      )
    ).to.be.revert(ethers);

    // And transfers keep working under every shape, including to and from
    // addresses that have never interacted with the vault.
    const stranger = ethers.Wallet.createRandom().address;
    await expect(fx.vault.connect(fx.alice).transfer(stranger, E("1"))).to.not.be.revert(ethers);
    await expect(fx.vault.connect(fx.alice).transfer(fx.bob.address, E("1"))).to.not.be
      .revert(ethers);
    await expect(fx.vault.connect(fx.bob).transfer(fx.alice.address, E("1"))).to.not.be
      .revert(ethers);
  });

  it("GAS: the hook's overhead on a plain share transfer is measured and disclosed", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("1000"));
    await fx.vault.connect(fx.alice).transfer(fx.bob.address, E("1")); // warm both slots

    // Zero accumulator: the correction written is zero, but the SSTOREs still
    // happen — this is the floor of the overhead, not an exemption from it.
    const zeroAcc = await (
      await fx.vault.connect(fx.alice).transfer(fx.bob.address, E("1"))
    ).wait();

    await push(fx, fx.carol, E("10"));
    await fx.vault.connect(fx.alice).transfer(fx.bob.address, E("1")); // warm the new slots
    const liveAcc = await (
      await fx.vault.connect(fx.alice).transfer(fx.bob.address, E("1"))
    ).wait();

    // eslint-disable-next-line no-console
    console.log(
      `        share transfer gas: ${zeroAcc!.gasUsed} (zero accumulator) -> ${liveAcc!.gasUsed} (live accumulator)`
    );
    // The hook is two warm SSTOREs and one SLOAD. Anything materially above
    // that means something started calling out, which is the thing this design
    // exists to not do.
    expect(Number(liveAcc!.gasUsed)).to.be.lessThan(80_000);
  });

  // ══ 6. The custody boundary the collapse had to preserve ════════════════

  it("the vault STILL cannot hold ETH — dividends are ERC-20, not ETH, and there is no payable path", async () => {
    const fx = await fixture();
    const payable = fx.vault.interface.fragments.filter(
      (f: any) => f.type === "function" && f.stateMutability === "payable"
    );
    expect(payable.length).to.equal(0);
    expect(
      fx.vault.interface.fragments.some((f: any) => f.type === "receive" || f.type === "fallback")
    ).to.equal(false);
    await expect(
      fx.alice.sendTransaction({ to: fx.vaultAddr, value: E("1") })
    ).to.be.revert(ethers);
  });

  it("dividends are INERT when no dividend asset was set at construction", async () => {
    const [, a, seeder, b, c, d, alice] = await ethers.getSigners();
    const Vault = await indexVaultFactory();
    const vault: any = await Vault.deploy(
      "x",
      "x",
      [a.address, b.address, c.address, d.address],
      seeder.address,
      TIMELOCK,
      paramsTuple(defaultParams),
      ethers.ZeroAddress
    );
    expect(await vault.dividendAsset()).to.equal(ethers.ZeroAddress);
    expect(await vault.reinvestAsset()).to.equal(ethers.ZeroAddress);
    await expect(vault.receiveDividendsWrapped(1n)).to.be.revertedWithCustomError(
      vault,
      "BadParam"
    );
    // Claiming is still a successful no-op rather than a revert.
    await expect(vault.connect(alice).claimDividend()).to.not.be.revert(ethers);
  });

  it("pushing zero is refused, and the credited amount is the ACTUAL delta", async () => {
    const fx = await fixture();
    await mint(fx, fx.alice, E("100"));
    await expect(push(fx, fx.carol, 0n)).to.be.revertedWithCustomError(fx.vault, "ZeroAmount");
    await push(fx, fx.carol, E("7"));
    expect(await fx.vault.totalDividendsReceived()).to.equal(E("7"));
  });

  // ══ 7. The harvest integration point ═══════════════════════════════════

  it("harvestEcosystemFees funds the accumulator directly, with the vault as its own sink", async () => {
    const fx = await fixture();

    // Appoint the VAULT as its own ecosystem sink, through the unchanged
    // timelocked key. It qualifies because it implements the whole
    // two-function IEcosystemFeeSink surface.
    await fx.vault
      .connect(fx.allocation)
      .queueParam(ethers.encodeBytes32String("ecosystemSink"), fx.vaultAddr);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeParam(ethers.encodeBytes32String("ecosystemSink"));
    expect(await fx.vault.ecosystemSink()).to.equal(fx.vaultAddr);
    expect(await fx.vault.ecosystemAsset()).to.equal(fx.addrs[0]);

    for (let i = 0; i < 8; i++) {
      await time.increase(MIN_CHECKPOINT + 1);
      await fx.vault.checkpointAll();
    }

    await mint(fx, fx.alice, E("100"));
    // Generate a real imbalance fee on the dividend leg.
    await fx.vault.connect(fx.bob).mintSingleAsset(fx.addrs[0], E("5"), 0);
    const ledger: bigint = await fx.vault.ecosystemFeesWei(fx.addrs[0]);
    expect(ledger).to.be.greaterThan(0n);

    const heldBefore: bigint = await fx.tokens[0].balanceOf(fx.vaultAddr);
    await fx.vault.connect(fx.carol).harvestEcosystemFees();

    // Ledger emptied into the accumulator; not one token left the contract.
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.equal(0n);
    expect(await fx.vault.totalDividendsReceived()).to.equal(ledger);
    expect(await fx.tokens[0].balanceOf(fx.vaultAddr)).to.equal(heldBefore);
    expect(await fx.vault.withdrawableDividendOf(fx.alice.address)).to.be.greaterThan(0n);
  });
});
