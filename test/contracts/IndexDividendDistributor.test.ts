import { expect } from "chai";
import { ethers } from "hardhat";
import {
  takeSnapshot,
  time,
  type SnapshotRestorer,
} from "@nomicfoundation/hardhat-network-helpers";
import {
  MIN_CHECKPOINT,
  TIMELOCK,
  WAD,
  defaultParams,
  paramsTuple,
  indexVaultFactory,
} from "./helpers/index-vault";

/**
 * Audit-style suite for IndexDividendDistributor: the push-only ETH dividend
 * accumulator for index-share holders, plus its auto-compound path.
 *
 * The two things that actually matter here, and that this file is organised
 * around, are:
 *
 *   1. THE DEBT BOOKKEEPING. The accumulator pattern's one hard part is a
 *      balance that changes between accrual events. Every test in the
 *      "balance changes mid-accrual" block moves a balance at a deliberately
 *      awkward moment and checks the arithmetic against a hand-computed
 *      expectation, not against the contract's own view.
 *   2. CONSERVATION. Total claimed can never exceed total received. Asserted
 *      over a long randomised sequence, not just a happy-path claim.
 *
 * LOCAL HARDHAT ONLY. Nothing in this repo may deploy any of these contracts
 * until the external audit gate (§2.6) clears.
 */
describe("IndexDividendDistributor", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const E = (n: string) => ethers.parseEther(n);

  /**
   * A basket whose FIRST constituent is a real wrapped-ETH contract, because
   * the vault prices constituents as ERC-20s and has no ETH entry point — so
   * the auto-compound path needs a wrapped-ETH leg to route through. Three
   * legs, roughly equal, so a reinvest into the WETH leg has real headroom
   * under the 40% concentration cap.
   */
  /**
   * Give `who` `amount` of `token`. Plain mocks mint; the REAL WETH9 has no
   * mint and never will — every wei of WETH must be backed by real ETH the
   * holder actually sent, which is the invariant the old mock quietly broke.
   * So for the WETH leg we top the account's ETH balance up and wrap.
   */
  async function fund(token: any, who: any, amount: bigint) {
    if (typeof token.deposit === "function") {
      const bal: bigint = await ethers.provider.getBalance(who.address);
      await ethers.provider.send("hardhat_setBalance", [
        who.address,
        "0x" + (bal + amount + ethers.parseEther("100")).toString(16),
      ]);
      await token.connect(who).deposit({ value: amount });
      return;
    }
    await token.mint(who.address, amount);
  }

  async function fixture() {
    const [, admin, seeder, alice, bob, carol] = await ethers.getSigners();

    // THE REAL canonical WETH9 source, deployed locally — not a mock. See
    // contracts/test/CanonicalWeth9.sol for what the old hand-rolled mock was
    // hiding (the infinite-approval special case, the 2300-gas `transfer`
    // stipend on `withdraw`, and the bare-send fallthrough to `deposit`).
    const Weth = await ethers.getContractFactory("CanonicalWeth9");
    const weth: any = await Weth.deploy();
    const Token = await ethers.getContractFactory("MockIndexToken");
    const t1: any = await Token.deploy("cB", "cB");
    const t2: any = await Token.deploy("cC", "cC");
    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    // All three priced at 1.0 ETH per unit.
    const sources: any[] = [];
    for (let i = 0; i < 3; i++) sources.push(await Source.deploy(100n * WAD, 100n * WAD));

    const tokens = [weth, t1, t2];
    const addrs: string[] = [];
    for (const t of tokens) addrs.push(await t.getAddress());

    const Vault = await indexVaultFactory();
    const vault: any = await Vault.deploy(
      "Marketplank Global Index",
      "gPLNK",
      [admin.address, admin.address, admin.address, admin.address],
      seeder.address,
      TIMELOCK,
      paramsTuple(defaultParams)
    );
    const vaultAddr = await vault.getAddress();

    for (let i = 0; i < 3; i++) {
      await vault.connect(seeder).seedConstituent(addrs[i], await sources[i].getAddress(), 3_333);
      await fund(tokens[i], seeder, 1_000n * WAD);
      await tokens[i].connect(seeder).approve(vaultAddr, ethers.MaxUint256);
      await vault.connect(seeder).seedDeposit(addrs[i], 1_000n * WAD);
    }
    await vault.connect(seeder).openIndex(1_000n * WAD);

    for (const who of [alice, bob, carol]) {
      for (const t of tokens) {
        await fund(t, who, 100_000n * WAD);
        await t.connect(who).approve(vaultAddr, ethers.MaxUint256);
      }
    }

    const Dist = await ethers.getContractFactory("IndexDividendDistributor");
    const dist: any = await Dist.deploy(vaultAddr, vaultAddr, addrs[0]);
    const distAddr = await dist.getAddress();
    for (const who of [alice, bob, carol]) {
      await vault.connect(who).approve(distAddr, ethers.MaxUint256);
    }

    // Warm the oracle so the priced paths are reachable.
    for (let i = 0; i < 8; i++) {
      await time.increase(MIN_CHECKPOINT + 1);
      await vault.checkpointAll();
    }

    return {
      admin,
      seeder,
      alice,
      bob,
      carol,
      vault,
      vaultAddr,
      dist,
      distAddr,
      weth,
      tokens,
      sources,
      addrs,
    };
  }

  /** Give `who` `shares` of the index and stake them all. */
  async function mintAndStake(fx: any, who: any, shares: bigint) {
    await fx.vault.connect(who).mintProRata(shares, [
      ethers.MaxUint256,
      ethers.MaxUint256,
      ethers.MaxUint256,
    ]);
    await fx.dist.connect(who).stake(shares);
  }

  // ══ The accumulator, in its simplest honest form ═══════════════════════

  it("splits a push exactly pro rata across staked shares", async () => {
    const fx = await fixture();
    const { dist, alice, bob, carol } = fx;
    await mintAndStake(fx, alice, 300n * WAD);
    await mintAndStake(fx, bob, 100n * WAD);

    await dist.connect(carol).receiveDividends({ value: E("4") });
    expect(await dist.claimable(alice.address)).to.equal(E("3"));
    expect(await dist.claimable(bob.address)).to.equal(E("1"));
    // A non-staker is credited nothing, ever.
    expect(await dist.claimable(carol.address)).to.equal(0n);
  });

  it("pays a claim once, and a second claim pays zero rather than reverting or double-paying", async () => {
    const fx = await fixture();
    const { dist, distAddr, alice, carol } = fx;
    await mintAndStake(fx, alice, 100n * WAD);
    await dist.connect(carol).receiveDividends({ value: E("3") });

    const before: bigint = await ethers.provider.getBalance(alice.address);
    const tx = await dist.connect(alice).claim();
    const rc = await tx.wait();
    const gas: bigint = BigInt(rc!.gasUsed) * BigInt(rc!.gasPrice);
    expect(await ethers.provider.getBalance(alice.address)).to.equal(before + E("3") - gas);

    expect(await dist.claimable(alice.address)).to.equal(0n);
    await dist.connect(alice).claim(); // no revert, no second payment
    expect(await ethers.provider.getBalance(distAddr)).to.equal(0n);
    expect(await dist.totalClaimed()).to.equal(E("3"));
  });

  it("a late staker cannot reach back for a distribution that predates them", async () => {
    const fx = await fixture();
    const { dist, alice, bob, carol } = fx;
    await mintAndStake(fx, alice, 100n * WAD);
    await dist.connect(carol).receiveDividends({ value: E("5") });

    // Bob arrives AFTER the push. His debt is anchored at the accumulator's
    // current height, so his entitlement to everything before him is zero.
    await mintAndStake(fx, bob, 900n * WAD);
    expect(await dist.claimable(bob.address)).to.equal(0n);
    expect(await dist.claimable(alice.address)).to.equal(E("5"));

    // ...and he shares only in what comes next, at his real weight (90%).
    await dist.connect(carol).receiveDividends({ value: E("10") });
    expect(await dist.claimable(bob.address)).to.equal(E("9"));
    expect(await dist.claimable(alice.address)).to.equal(E("6"));
  });

  it("a push with nobody staked is parked, never lost and never reverted", async () => {
    const fx = await fixture();
    const { dist, alice, carol } = fx;
    await dist.connect(carol).receiveDividends({ value: E("7") });
    let [, , , parked] = await dist.ethStatus();
    expect(parked).to.equal(E("7"));
    expect(await dist.accEthPerShareWad()).to.equal(0n);

    // Someone stakes and the next push folds the parked ETH in with it.
    await mintAndStake(fx, alice, 100n * WAD);
    expect(await dist.claimable(alice.address)).to.equal(0n);
    await dist.connect(carol).receiveDividends({ value: E("3") });
    [, , , parked] = await dist.ethStatus();
    expect(parked).to.equal(0n);
    expect(await dist.claimable(alice.address)).to.equal(E("10"));
  });

  // ══ THE HARD PART: a balance that changes mid-accrual ══════════════════

  it("DEBT: staking MORE mid-accrual never back-pays the new shares", async () => {
    const fx = await fixture();
    const { dist, vault, alice, bob, carol } = fx;
    await mintAndStake(fx, alice, 100n * WAD);
    await mintAndStake(fx, bob, 100n * WAD);

    await dist.connect(carol).receiveDividends({ value: E("2") }); // 1 each
    expect(await dist.claimable(alice.address)).to.equal(E("1"));

    // Alice triples her stake AFTER that push. The naive implementation —
    // recomputing pending from the new balance against the old debt — would
    // pay her 3 ETH for the first push instead of 1.
    await vault.connect(alice).mintProRata(200n * WAD, [
      ethers.MaxUint256,
      ethers.MaxUint256,
      ethers.MaxUint256,
    ]);
    await dist.connect(alice).stake(200n * WAD);
    expect(await dist.claimable(alice.address)).to.equal(E("1"), "back-paid the new shares");
    expect(await dist.claimable(bob.address)).to.equal(E("1"));

    // The next push splits 300/100, i.e. 75/25 — her new weight, applied only
    // to what comes after it.
    await dist.connect(carol).receiveDividends({ value: E("4") });
    expect(await dist.claimable(alice.address)).to.equal(E("1") + E("3"));
    expect(await dist.claimable(bob.address)).to.equal(E("1") + E("1"));
  });

  it("DEBT: unstaking mid-accrual keeps what was earned and forfeits nothing", async () => {
    const fx = await fixture();
    const { dist, alice, bob, carol } = fx;
    await mintAndStake(fx, alice, 300n * WAD);
    await mintAndStake(fx, bob, 100n * WAD);

    await dist.connect(carol).receiveDividends({ value: E("8") }); // 6 / 2
    // Alice pulls everything out WITHOUT claiming. The naive implementation
    // underflows here (debt was set at 300 shares, balance is now 0).
    await dist.connect(alice).unstake(300n * WAD);
    expect(await dist.stakedOf(alice.address)).to.equal(0n);
    expect(await dist.claimable(alice.address)).to.equal(E("6"), "earnings lost on exit");

    // She earns nothing from anything that happens after she left...
    await dist.connect(carol).receiveDividends({ value: E("5") });
    expect(await dist.claimable(alice.address)).to.equal(E("6"));
    expect(await dist.claimable(bob.address)).to.equal(E("2") + E("5"));

    // ...and she can still walk up and take the 6 whenever she likes.
    await dist.connect(alice).claim();
    expect(await dist.claimable(alice.address)).to.equal(0n);
  });

  it("DEBT: partial unstake, re-stake, and a redeem of the freed shares all reconcile", async () => {
    const fx = await fixture();
    const { dist, vault, alice, bob, carol } = fx;
    await mintAndStake(fx, alice, 400n * WAD);
    await mintAndStake(fx, bob, 400n * WAD);

    await dist.connect(carol).receiveDividends({ value: E("2") }); // 1 / 1
    await dist.connect(alice).unstake(200n * WAD); // now 200 vs 400
    await dist.connect(carol).receiveDividends({ value: E("6") }); // 2 / 4
    await dist.connect(alice).stake(100n * WAD); // now 300 vs 400
    await dist.connect(carol).receiveDividends({ value: E("7") }); // 3 / 4

    expect(await dist.claimable(alice.address)).to.equal(E("6"));
    expect(await dist.claimable(bob.address)).to.equal(E("9"));

    // The 100 shares she left un-staked are hers, outside this contract, and
    // redeeming them at the vault changes NOTHING here — the distributor
    // tracks its own staked ledger and never reads the vault's balances.
    expect(await vault.balanceOf(alice.address)).to.equal(100n * WAD);
    await vault.connect(alice).redeemProRata(100n * WAD, [0n, 0n, 0n]);
    expect(await dist.claimable(alice.address)).to.equal(E("6"));
    expect(await dist.stakedOf(alice.address)).to.equal(300n * WAD);

    const [held, staked] = await dist.shareSolvency();
    expect(held).to.equal(staked, "staked ledger drifted from real share custody");
  });

  it("DEBT: claiming does not disturb the stake or anyone else's entitlement", async () => {
    const fx = await fixture();
    const { dist, alice, bob, carol } = fx;
    await mintAndStake(fx, alice, 500n * WAD);
    await mintAndStake(fx, bob, 500n * WAD);
    await dist.connect(carol).receiveDividends({ value: E("10") });
    await dist.connect(alice).claim();
    expect(await dist.stakedOf(alice.address)).to.equal(500n * WAD);
    expect(await dist.claimable(bob.address)).to.equal(E("5"));
    await dist.connect(carol).receiveDividends({ value: E("10") });
    expect(await dist.claimable(alice.address)).to.equal(E("5"));
    expect(await dist.claimable(bob.address)).to.equal(E("10"));
  });

  // ══ CONSERVATION ══════════════════════════════════════════════════════

  it("CONSERVATION: total claimed can never exceed total received, over 150 random ops", async function () {
    this.timeout(300_000);
    const fx = await fixture();
    const { dist, distAddr, vault, alice, bob, carol } = fx;
    const actors = [alice, bob, carol];
    for (const who of actors) await mintAndStake(fx, who, 200n * WAD);

    let s = 12345 >>> 0;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };

    let pushes = 0;
    let claims = 0;
    let stakes = 0;
    let unstakes = 0;
    for (let step = 0; step < 150; step++) {
      const who = actors[Math.floor(rand() * actors.length)];
      const op = Math.floor(rand() * 4);
      try {
        if (op === 0) {
          await dist.connect(who).receiveDividends({
            value: BigInt(Math.floor(rand() * 1e6) + 1) * 10n ** 9n,
          });
          pushes++;
        } else if (op === 1) {
          await dist.connect(who).claim();
          claims++;
        } else if (op === 2) {
          const amt = BigInt(Math.floor(rand() * 50) + 1) * WAD;
          await vault.connect(who).mintProRata(amt, [
            ethers.MaxUint256,
            ethers.MaxUint256,
            ethers.MaxUint256,
          ]);
          await dist.connect(who).stake(amt);
          stakes++;
        } else {
          const bal: bigint = await dist.stakedOf(who.address);
          if (bal === 0n) throw new Error("skip");
          await dist.connect(who).unstake(bal / BigInt(Math.floor(rand() * 3) + 1));
          unstakes++;
        }
      } catch {
        /* a guard firing is correct behaviour */
      }

      // THE INVARIANT, after every single step.
      const received: bigint = await dist.totalReceived();
      const claimed: bigint = await dist.totalClaimed();
      expect(claimed).to.be.lte(received, `over-paid at step ${step}`);

      // Solvency, both sides: enough ETH to cover everything still owed, and
      // enough real shares to cover the staked ledger.
      const bal: bigint = await ethers.provider.getBalance(distAddr);
      expect(bal).to.equal(received - claimed, `ETH drifted at step ${step}`);
      let outstanding = 0n;
      for (const a of actors) outstanding += await dist.claimable(a.address);
      expect(outstanding).to.be.lte(bal, `claims exceed the balance at step ${step}`);
      const [held, staked] = await dist.shareSolvency();
      expect(held).to.be.gte(staked, `share insolvency at step ${step}`);
    }

    expect(pushes).to.be.greaterThan(0);
    expect(claims).to.be.greaterThan(0);
    expect(stakes).to.be.greaterThan(0);
    expect(unstakes).to.be.greaterThan(0);

    // Drain everyone at the end: the sum of every payout is still bounded by
    // everything ever received, and the residue is the flooring dust.
    for (const a of actors) await dist.connect(a).claim();
    const received: bigint = await dist.totalReceived();
    expect(await dist.totalClaimed()).to.be.lte(received);
    const residue: bigint = await ethers.provider.getBalance(distAddr);
    expect(residue).to.be.lt(E("0.0001"), "an implausible amount was retained as dust");
  });

  // ══ AUTO-COMPOUND ═════════════════════════════════════════════════════

  it("REINVEST: compounds the pending dividend into more staked shares, atomically", async () => {
    const fx = await fixture();
    const { dist, distAddr, vault, alice, bob, carol, addrs, weth } = fx;
    await mintAndStake(fx, alice, 400n * WAD);
    await mintAndStake(fx, bob, 400n * WAD);
    await dist.connect(carol).receiveDividends({ value: E("6") });

    const pending: bigint = await dist.claimable(alice.address);
    expect(pending).to.equal(E("3"));
    const stakedBefore: bigint = await dist.stakedOf(alice.address);

    // What the vault would mint for exactly that much WETH, quoted through
    // the SAME public path — imbalance fee and platform allocation included.
    const quoted: bigint = await vault
      .connect(carol)
      .mintSingleAsset.staticCall(addrs[0], pending, 0n);

    const gained: bigint = await dist.connect(alice).claimAndReinvest.staticCall(0n);
    await dist.connect(alice).claimAndReinvest(0n);

    expect(gained).to.equal(quoted, "reinvest minted at a different rate than the public path");
    expect(await dist.stakedOf(alice.address)).to.equal(stakedBefore + gained);
    expect(await dist.claimable(alice.address)).to.equal(0n, "dividend not consumed");
    // The ETH really left as WETH and really entered the basket.
    expect(await ethers.provider.getBalance(distAddr)).to.equal(E("3")); // bob's, untouched
    expect(await weth.balanceOf(distAddr)).to.equal(0n, "wrapped ETH stranded in the distributor");
    expect(await dist.totalClaimed()).to.equal(E("3"));
    // Bob is completely unaffected by Alice compounding.
    expect(await dist.claimable(bob.address)).to.equal(E("3"));

    // ...and the newly compounded shares earn at their new weight from here.
    const [held, staked] = await dist.shareSolvency();
    expect(held).to.equal(staked);
  });

  it("REINVEST: the imbalance fee and the platform allocation are both really paid", async () => {
    const fx = await fixture();
    const { dist, vault, admin, alice, carol, addrs } = fx;
    const all = await ethers.getSigners();
    const treasury = all[11];
    await vault.connect(admin).queuePlatformTreasury(treasury.address);
    await time.increase(TIMELOCK + 1);
    await vault.executePlatformTreasury();
    // The 48h timelock wait left every band stale (staleAfter is 2h), so warm
    // the oracle back up before driving any priced path.
    for (let i = 0; i < 8; i++) {
      await time.increase(MIN_CHECKPOINT + 1);
      await vault.checkpointAll();
    }
    const alloc: bigint = await vault.platformAllocationBps();
    expect(alloc).to.be.gt(0n);

    // NOTE the allocation is already live here, so the depositor receives
    // fewer shares than they asked for — stake whatever actually arrived.
    await vault.connect(alice).mintProRata(400n * WAD, [
      ethers.MaxUint256,
      ethers.MaxUint256,
      ethers.MaxUint256,
    ]);
    const mine: bigint = await vault.balanceOf(alice.address);
    expect(mine).to.equal((400n * WAD * (10_000n - alloc)) / 10_000n);
    await dist.connect(alice).stake(mine);
    await dist.connect(carol).receiveDividends({ value: E("4") });
    const pending: bigint = await dist.claimable(alice.address);
    // Sole staker, so it is the whole push bar the accumulator's flooring
    // dust — which is retained, never over-paid. That retention is exactly
    // what makes the conservation invariant structural.
    expect(pending).to.be.lte(E("4"));
    expect(pending).to.be.gt(E("4") - 1_000n);

    const treasuryBefore: bigint = await vault.balanceOf(treasury.address);
    const supplyBefore: bigint = await vault.totalSupply();
    const gained: bigint = await dist.connect(alice).claimAndReinvest.staticCall(0n);
    await dist.connect(alice).claimAndReinvest(0n);
    const cut: bigint = (await vault.balanceOf(treasury.address)) - treasuryBefore;
    const grossMinted: bigint = (await vault.totalSupply()) - supplyBefore;

    // The operator's cut came OUT of the compounding deposit at exactly the
    // disclosed rate — never minted on top of it.
    expect(cut).to.be.gt(0n, "platform allocation was bypassed");
    expect(gained + cut).to.equal(grossMinted, "shares were minted on top of the deposit");
    // The cut FLOORS, so the ambiguous base unit goes to the depositor rather
    // than the operator — the conservative direction for the party who did
    // not set the parameter.
    expect(cut).to.equal((grossMinted * alloc) / 10_000n);
    expect(gained).to.equal(grossMinted - cut);
    expect(gained).to.be.gte((grossMinted * (10_000n - alloc)) / 10_000n);

    // And the mint-side imbalance fee really bit: the compounded ETH bought
    // strictly fewer shares than an un-fee'd, un-banded conversion would.
    const [, navHigh] = await vault.nav();
    const frictionless = (pending * supplyBefore) / navHigh;
    expect(grossMinted).to.be.lt(frictionless, "no fee or band cost was charged at all");
  });

  it("REINVEST: reverts CLEANLY — not partially — when the mint side would fail", async () => {
    const fx = await fixture();
    const { dist, vault, alice, bob, carol, addrs } = fx;
    await mintAndStake(fx, alice, 400n * WAD);
    await dist.connect(carol).receiveDividends({ value: E("5") });
    const pendingBefore: bigint = await dist.claimable(alice.address);
    const stakedBefore: bigint = await dist.stakedOf(alice.address);
    const claimedBefore: bigint = await dist.totalClaimed();

    // 1. Slippage: ask for more shares than the mint can possibly produce.
    await expect(dist.connect(alice).claimAndReinvest(ethers.MaxUint256)).to.be.revertedWithCustomError(
      vault,
      "SlippageExceeded"
    );

    // 2. Concentration cap: shove the WETH leg right up against the 40%
    //    ceiling — coarsely first, then in steps smaller than the reinvest
    //    itself — so the reinvest's own deposit is what would breach it.
    let capped = false;
    for (const step of [40n, 2n]) {
      capped = false;
      for (let i = 0; i < 60; i++) {
        try {
          await vault.connect(bob).mintSingleAsset(addrs[0], step * WAD, 0n);
        } catch (e: any) {
          expect(String(e)).to.include("ConcentrationCapExceeded");
          capped = true;
          break;
        }
      }
      expect(capped, `never reached the cap at step ${step}`).to.equal(true);
    }
    await expect(dist.connect(alice).claimAndReinvest(0n)).to.be.revertedWithCustomError(
      vault,
      "ConcentrationCapExceeded"
    );

    // 3. A queued removal on the reinvest leg closes it too.
    //    (Checked after restoring headroom so it is THIS guard firing.)
    // Nothing above left any partial state anywhere: the dividend is exactly
    // where it was, the stake is exactly where it was, and no ETH moved.
    expect(await dist.claimable(alice.address)).to.equal(pendingBefore, "dividend partly consumed");
    expect(await dist.stakedOf(alice.address)).to.equal(stakedBefore, "stake partly changed");
    expect(await dist.totalClaimed()).to.equal(claimedBefore, "claim counter moved on a revert");
    const [held, staked] = await dist.shareSolvency();
    expect(held).to.equal(staked);

    // And the ordinary claim still works — a failed compound is not a lock-in.
    await expect(dist.connect(alice).claim()).to.not.be.reverted;
    expect(await dist.claimable(alice.address)).to.equal(0n);
  });

  it("REINVEST: a queued removal on the reinvest leg closes the compound path", async () => {
    const fx = await fixture();
    const { dist, vault, admin, alice, carol, addrs } = fx;
    await mintAndStake(fx, alice, 400n * WAD);
    await dist.connect(carol).receiveDividends({ value: E("2") });
    await vault.connect(admin).queueListing(addrs[0], addrs[0], 0, true);
    await expect(dist.connect(alice).claimAndReinvest(0n)).to.be.revertedWithCustomError(
      vault,
      "ConstituentExiting"
    );
    // The dividend survives and the plain claim path is unaffected.
    expect(await dist.claimable(alice.address)).to.equal(E("2"));
    await dist.connect(alice).claim();
  });

  it("REINVEST: with no wrapped-ETH leg configured the path is simply unavailable", async () => {
    const fx = await fixture();
    const { vaultAddr, dist, alice, carol } = fx;
    const Dist = await ethers.getContractFactory("IndexDividendDistributor");
    const bare: any = await Dist.deploy(vaultAddr, vaultAddr, ethers.ZeroAddress);
    await fx.vault.connect(alice).mintProRata(100n * WAD, [
      ethers.MaxUint256,
      ethers.MaxUint256,
      ethers.MaxUint256,
    ]);
    await fx.vault.connect(alice).approve(await bare.getAddress(), ethers.MaxUint256);
    await bare.connect(alice).stake(100n * WAD);
    await bare.connect(carol).receiveDividends({ value: E("1") });
    await expect(bare.connect(alice).claimAndReinvest(0n)).to.be.revertedWithCustomError(
      bare,
      "ReinvestUnavailable"
    );
    // Claiming still works, so nobody's dividend is trapped by the omission.
    await expect(bare.connect(alice).claim()).to.not.be.reverted;
    expect(await dist.totalReceived()).to.equal(0n);
  });

  // ══ The custody boundary ══════════════════════════════════════════════

  it("PUSH-ONLY: the distributor has no path that takes value out of the vault", async () => {
    const fx = await fixture();
    const { dist, distAddr, vault, vaultAddr, alice, carol, tokens, addrs } = fx;
    await mintAndStake(fx, alice, 500n * WAD);
    await dist.connect(carol).receiveDividends({ value: E("3") });

    // 1. Nothing on the ABI names a withdrawal from the basket.
    const names = dist.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name.toLowerCase());
    for (const bad of ["redeem", "sweep", "rescue", "emergency", "recover", "seize", "skim"]) {
      expect(names.some((n: string) => n.includes(bad))).to.equal(false, `found ${bad}`);
    }
    expect((await dist.capabilities())[1]).to.equal(false, "capabilities claims it pulls");

    // 2. Enumerate the whole non-view ABI, from every role, with the vault's
    //    own addresses as arguments — the anchor-rule sweep. No reserve may
    //    move DOWN, and no constituent may reach the distributor or a caller.
    const before = await Promise.all(addrs.map((a) => vault.reserveOf(a) as Promise<bigint>));
    const fns = dist.interface.fragments.filter(
      (f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)
    );
    expect(fns.length).to.be.greaterThan(4, "ABI enumeration found nothing");
    const argFor = (t: string): any => {
      if (t === "address") return vaultAddr;
      if (t.startsWith("uint")) return 10n ** 24n;
      if (t === "bool") return true;
      return 0n;
    };
    for (const who of [alice, carol]) {
      for (const f of fns as any[]) {
        const args = f.inputs.map((i: any) => argFor(i.type));
        try {
          await (dist.connect(who) as any)[f.format("sighash")](...args);
        } catch {
          /* a guard firing is correct behaviour */
        }
      }
    }
    for (let i = 0; i < 3; i++) {
      // Reserves may only ever GROW through this contract (a reinvest is a
      // deposit). They may never fall.
      expect(await vault.reserveOf(addrs[i])).to.be.gte(before[i], `reserve ${i} fell`);
      expect(await tokens[i].balanceOf(distAddr)).to.equal(
        0n,
        `constituent ${i} stranded in the distributor`
      );
    }

    // 3. No bare receive: the only way ETH enters is receiveDividends, so the
    //    accumulator can never be out of step with the balance.
    await expect(carol.sendTransaction({ to: distAddr, value: WAD })).to.be.reverted;
    const [held, received, claimed] = await dist.ethStatus();
    expect(held).to.equal(received - claimed);
  });

  it("PUSH-ONLY: the vault has no reference to the distributor, in ABI or bytecode", async () => {
    const fx = await fixture();
    const { vault, vaultAddr, distAddr } = fx;
    const code = await ethers.provider.getCode(vaultAddr);
    expect(code.toLowerCase()).to.not.include(distAddr.slice(2).toLowerCase());
    for (const f of vault.interface.fragments.filter((x: any) => x.type === "function") as any[]) {
      const blob = (f.name + " " + f.inputs.map((i: any) => i.name).join(" ")).toLowerCase();
      for (const bad of ["dividend", "distributor", "stake", "accumulator", "hook"]) {
        expect(blob.includes(bad)).to.equal(false, `vault.${f.name} mentions ${bad}`);
      }
    }
    // The vault still cannot hold ETH at all — the whole reason the dividend
    // accumulator lives in its own contract.
    const payable = vault.interface.fragments.filter(
      (f: any) => f.type === "function" && f.stateMutability === "payable"
    );
    expect(payable.length).to.equal(0);
  });
});
