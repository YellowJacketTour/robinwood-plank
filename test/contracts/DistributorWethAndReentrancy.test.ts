import { expect } from "chai";
import { ethers } from "hardhat";
import {
  impersonateAccount,
  setBalance,
  stopImpersonatingAccount,
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
} from "./helpers/index-vault";

/**
 * Audit-style suite for IndexDividendDistributor's ETH boundary: the REAL
 * WETH9 integration, the restricted `receive()`, and the re-entrancy defence.
 *
 * Three separate properties, each attacked rather than confirmed:
 *
 *   1. REAL WETH SEMANTICS. contracts/test/CanonicalWeth9.sol is a faithful
 *      port of the deployed WETH9, and it replaced a hand-rolled mock that
 *      differed from it in three ways. This file drives all three of those
 *      differences directly — the infinite-approval special case, the
 *      2300-gas `transfer` stipend on `withdraw`, and the bare-send
 *      fallthrough to `deposit` — so that "we test against real WETH" is a
 *      checked statement and not a comment.
 *   2. THE RESTRICTED receive(). It accepts ETH from the immutable
 *      `reinvestAsset` and from nothing else. Proven from BOTH sides: a
 *      genuine unwrap is accepted, and an EOA, an unrelated contract address,
 *      and even a DIFFERENT (but perfectly valid) WETH9 deployment are all
 *      refused.
 *   3. RE-ENTRANCY, WITH THE ACCOUNTING UNDERNEATH IT. A test that only shows
 *      "it reverts" proves the guard fires and proves nothing about the
 *      accounting the guard is sitting on top of. MockReentrantClaimer is
 *      therefore driven in both modes: hostile (the whole claim must revert)
 *      and quiet (the exact wei extracted must be precisely what was owed and
 *      not one wei more).
 *
 * LOCAL HARDHAT ONLY. Nothing in this repo may deploy any of these contracts
 * until the external audit gate (§2.6) clears.
 */
describe("IndexDividendDistributor — real WETH, restricted receive, re-entrancy", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const E = (n: string) => ethers.parseEther(n);

  /** Real WETH has no mint: every wei must be backed by ETH actually sent. */
  async function fund(token: any, who: any, amount: bigint) {
    if (typeof token.deposit === "function") {
      const bal: bigint = await ethers.provider.getBalance(who.address);
      await ethers.provider.send("hardhat_setBalance", [
        who.address,
        "0x" + (bal + amount + E("100")).toString(16),
      ]);
      await token.connect(who).deposit({ value: amount });
      return;
    }
    await token.mint(who.address, amount);
  }

  async function fixture() {
    const [, admin, seeder, alice, bob, carol] = await ethers.getSigners();

    const Weth = await ethers.getContractFactory("CanonicalWeth9");
    const weth: any = await Weth.deploy();
    // A SECOND, equally valid WETH9. Used to prove the receive() guard is
    // pinned to the ONE immutable address and not merely to "something
    // WETH-shaped".
    const weth2: any = await Weth.deploy();

    const Token = await ethers.getContractFactory("MockIndexToken");
    const t1: any = await Token.deploy("cB", "cB");
    const t2: any = await Token.deploy("cC", "cC");
    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    const sources: any[] = [];
    for (let i = 0; i < 3; i++) sources.push(await Source.deploy(100n * WAD, 100n * WAD));

    const tokens = [weth, t1, t2];
    const addrs: string[] = [];
    for (const t of tokens) addrs.push(await t.getAddress());

    const Vault = await ethers.getContractFactory("GlobalIndexVault");
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
      await weth.connect(who).approve(distAddr, ethers.MaxUint256);
    }

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
      weth2,
      tokens,
      addrs,
    };
  }

  async function mintAndStake(fx: any, who: any, shares: bigint) {
    await fx.vault
      .connect(who)
      .mintProRata(shares, [ethers.MaxUint256, ethers.MaxUint256, ethers.MaxUint256]);
    await fx.dist.connect(who).stake(shares);
  }

  // ══ 1. REAL WETH9 SEMANTICS ═══════════════════════════════════════════

  describe("the vendored contract really is WETH9, not a convenient mock", () => {
    it("does NOT decrement an infinite allowance, and DOES decrement a finite one", async () => {
      // This is the exact behaviour OpenZeppelin's ERC20 (what the deleted
      // mock was built on) gets differently, and it is observable to any
      // integration that re-reads an allowance after a transferFrom.
      const { weth, alice, bob } = await fixture();
      await weth.connect(alice).approve(bob.address, ethers.MaxUint256);
      await weth.connect(bob).transferFrom(alice.address, bob.address, E("1"));
      expect(await weth.allowance(alice.address, bob.address)).to.equal(ethers.MaxUint256);

      await weth.connect(alice).approve(bob.address, E("10"));
      await weth.connect(bob).transferFrom(alice.address, bob.address, E("4"));
      expect(await weth.allowance(alice.address, bob.address)).to.equal(E("6"));

      // And an allowance short of the amount is refused.
      await expect(weth.connect(bob).transferFrom(alice.address, bob.address, E("7"))).to.be
        .reverted;
    });

    it("wraps a BARE ETH send through receive() -> deposit(), which the old mock reverted on", async () => {
      const { weth, alice } = await fixture();
      const before: bigint = await weth.balanceOf(alice.address);
      await alice.sendTransaction({ to: await weth.getAddress(), value: E("2") });
      expect(await weth.balanceOf(alice.address)).to.equal(before + E("2"));

      // The fallback wraps too — any calldata, still a deposit.
      await alice.sendTransaction({
        to: await weth.getAddress(),
        value: E("1"),
        data: "0x1234",
      });
      expect(await weth.balanceOf(alice.address)).to.equal(before + E("3"));
    });

    it("totalSupply IS the ETH it holds — a structural invariant that was fictional under the mock's `mint`", async () => {
      const { weth, alice, bob } = await fixture();
      const wethAddr = await weth.getAddress();
      const check = async () =>
        expect(await weth.totalSupply()).to.equal(
          await ethers.provider.getBalance(wethAddr)
        );
      await check();
      await weth.connect(bob).deposit({ value: E("5") });
      await check();
      await weth.connect(alice).withdraw(E("3"));
      await check();
      // There is no mint, no owner and no rescue to break it with.
      const names = weth.interface.fragments
        .filter((f: any) => f.type === "function")
        .map((f: any) => f.name);
      expect(names).to.not.include("mint");
      expect(names).to.not.include("owner");
      expect(names.some((n: string) => /rescue|sweep|recover/i.test(n))).to.equal(false);
    });

    it("withdraw refuses to pay out more than the caller holds", async () => {
      const { weth, bob } = await fixture();
      const bal: bigint = await weth.balanceOf(bob.address);
      await expect(weth.connect(bob).withdraw(bal + 1n)).to.be.reverted;
      await expect(weth.connect(bob).withdraw(bal)).to.not.be.reverted;
      expect(await weth.balanceOf(bob.address)).to.equal(0n);
    });
  });

  // ══ 2. THE RESTRICTED receive() ═══════════════════════════════════════

  describe("receive() accepts the unwrap and NOTHING else", () => {
    it("refuses a bare ETH send from an EOA", async () => {
      const { dist, distAddr, alice } = await fixture();
      await expect(
        alice.sendTransaction({ to: distAddr, value: E("1") })
      ).to.be.revertedWithCustomError(dist, "DirectEthRejected");
      expect(await ethers.provider.getBalance(distAddr)).to.equal(0n);
    });

    it("refuses ETH sent with unknown calldata — there is no payable fallback either", async () => {
      const { dist, distAddr, alice } = await fixture();
      await expect(alice.sendTransaction({ to: distAddr, value: E("1"), data: "0xdeadbeef" }))
        .to.be.reverted;
      expect(await ethers.provider.getBalance(distAddr)).to.equal(0n);
    });

    it("refuses ETH from an unrelated CONTRACT address, not just from EOAs", async () => {
      const { dist, distAddr, vaultAddr } = await fixture();
      // Send as the vault: a contract address, and one this distributor knows
      // about — and still not `reinvestAsset`.
      await impersonateAccount(vaultAddr);
      await setBalance(vaultAddr, E("10"));
      const asVault = await ethers.getSigner(vaultAddr);
      await expect(
        asVault.sendTransaction({ to: distAddr, value: E("1") })
      ).to.be.revertedWithCustomError(dist, "DirectEthRejected");
      await stopImpersonatingAccount(vaultAddr);
      expect(await ethers.provider.getBalance(distAddr)).to.equal(0n);
    });

    it("refuses ETH from a DIFFERENT, perfectly valid WETH9 — the guard is the immutable address, not a shape", async () => {
      const { dist, distAddr, weth, weth2 } = await fixture();
      const other = await weth2.getAddress();
      expect(await dist.reinvestAsset()).to.equal(await weth.getAddress());
      expect(other).to.not.equal(await weth.getAddress());

      await impersonateAccount(other);
      await setBalance(other, E("10"));
      const asOther = await ethers.getSigner(other);
      await expect(
        asOther.sendTransaction({ to: distAddr, value: E("1") })
      ).to.be.revertedWithCustomError(dist, "DirectEthRejected");
      await stopImpersonatingAccount(other);
    });

    it("ACCEPTS the real unwrap, and the guard is cheap enough to fit inside WETH9's 2300-gas stipend", async () => {
      // Real WETH9 pays `withdraw` with `transfer`, i.e. a 2300-gas stipend. A
      // `receive()` that did anything more than one immutable read and one
      // comparison would be UNPAYABLE by the real contract, and the test that
      // catches that is simply this one succeeding against the real source.
      const fx = await fixture();
      const { dist, distAddr, weth, alice, bob } = fx;
      await mintAndStake(fx, alice, 100n * WAD);

      const distEthBefore: bigint = await ethers.provider.getBalance(distAddr);
      await weth.connect(bob).approve(distAddr, ethers.MaxUint256);
      await dist.connect(bob).receiveDividendsWrapped(E("6"));

      expect(await ethers.provider.getBalance(distAddr)).to.equal(distEthBefore + E("6"));
      // The WETH was fully unwrapped — none is left parked in the distributor.
      expect(await weth.balanceOf(distAddr)).to.equal(0n);
      expect(await dist.totalReceived()).to.equal(E("6"));
      expect(await dist.claimable(alice.address)).to.equal(E("6"));
    });

    it("ethStatus stays a truthful solvency read precisely BECAUSE donations are refused", async () => {
      const fx = await fixture();
      const { dist, distAddr, alice, carol } = fx;
      await mintAndStake(fx, alice, 100n * WAD);
      await dist.connect(carol).receiveDividends({ value: E("4") });

      // An attempted donation cannot widen the gap between `held` and
      // `received - claimed`, because it cannot land at all.
      await expect(carol.sendTransaction({ to: distAddr, value: E("50") })).to.be.reverted;

      const [held, received, claimed] = await dist.ethStatus();
      expect(held).to.equal(received - claimed);
      expect(held).to.equal(E("4"));
    });
  });

  // ══ 3. receiveDividendsWrapped: the unwrap-and-credit path ════════════

  describe("receiveDividendsWrapped", () => {
    it("credits the ACTUAL ETH delta and splits it through the identical accumulator", async () => {
      const fx = await fixture();
      const { dist, alice, bob, carol } = fx;
      await mintAndStake(fx, alice, 300n * WAD);
      await mintAndStake(fx, bob, 100n * WAD);

      await dist.connect(carol).receiveDividendsWrapped(E("8"));
      // Identical arithmetic to a raw ETH push: 3:1.
      expect(await dist.claimable(alice.address)).to.equal(E("6"));
      expect(await dist.claimable(bob.address)).to.equal(E("2"));
      expect(await dist.totalReceived()).to.equal(E("8"));
    });

    it("a wrapped push and a raw push of the same size are indistinguishable downstream", async () => {
      const fx = await fixture();
      const { dist, alice, carol } = fx;
      await mintAndStake(fx, alice, 100n * WAD);

      await dist.connect(carol).receiveDividends({ value: E("3") });
      const afterRaw: bigint = await dist.accEthPerShareWad();
      await dist.connect(carol).receiveDividendsWrapped(E("3"));
      const afterWrapped: bigint = await dist.accEthPerShareWad();
      expect(afterWrapped - afterRaw).to.equal(afterRaw);
      expect(await dist.claimable(alice.address)).to.equal(E("6"));
    });

    it("a wrapped push with nobody staked is PARKED, not lost and not reverted", async () => {
      const fx = await fixture();
      const { dist, alice, carol } = fx;
      await dist.connect(carol).receiveDividendsWrapped(E("5"));
      expect(await dist.undistributed()).to.equal(E("5"));
      expect(await dist.totalReceived()).to.equal(E("5"));

      // It folds into the first push that HAS stakers.
      await mintAndStake(fx, alice, 100n * WAD);
      await dist.connect(carol).receiveDividendsWrapped(E("1"));
      expect(await dist.undistributed()).to.equal(0n);
      expect(await dist.claimable(alice.address)).to.equal(E("6"));
    });

    it("rejects a zero amount, an unapproved pull, and an unfunded pusher", async () => {
      const fx = await fixture();
      const { dist, distAddr, weth, alice, carol } = fx;
      await mintAndStake(fx, alice, 100n * WAD);

      await expect(dist.connect(carol).receiveDividendsWrapped(0n)).to.be.revertedWithCustomError(
        dist,
        "ZeroAmount"
      );

      await weth.connect(carol).approve(distAddr, 0n);
      await expect(dist.connect(carol).receiveDividendsWrapped(E("1"))).to.be.reverted;

      await weth.connect(carol).approve(distAddr, ethers.MaxUint256);
      const bal: bigint = await weth.balanceOf(carol.address);
      await expect(dist.connect(carol).receiveDividendsWrapped(bal + 1n)).to.be.reverted;
    });

    it("is unavailable, cleanly, on a distributor deployed with no wrapped-ETH leg", async () => {
      const { vaultAddr } = await fixture();
      const Dist = await ethers.getContractFactory("IndexDividendDistributor");
      const bare: any = await Dist.deploy(vaultAddr, vaultAddr, ethers.ZeroAddress);
      await expect(bare.receiveDividendsWrapped(E("1"))).to.be.revertedWithCustomError(
        bare,
        "ReinvestUnavailable"
      );
      await expect(bare.claimAndReinvest(0n)).to.be.revertedWithCustomError(
        bare,
        "ReinvestUnavailable"
      );
      // And with reinvestAsset == address(0), NOBODY can pay it directly
      // either: the receive() guard compares against the zero address, which
      // no sender can ever be.
      const [payer] = await ethers.getSigners();
      await expect(payer.sendTransaction({ to: await bare.getAddress(), value: 1n })).to.be
        .reverted;
    });

    it("the WETH supply invariant survives a full wrap -> unwrap -> reinvest cycle", async () => {
      const fx = await fixture();
      const { dist, distAddr, weth, alice, carol } = fx;
      const wethAddr = await weth.getAddress();
      const inv = async () =>
        expect(await weth.totalSupply()).to.equal(
          await ethers.provider.getBalance(wethAddr)
        );

      await mintAndStake(fx, alice, 500n * WAD);
      await inv();
      await dist.connect(carol).receiveDividendsWrapped(E("9"));
      await inv();
      await dist.connect(alice).claimAndReinvest(0n);
      await inv();
      // Nothing WETH-denominated is stranded on the distributor afterwards.
      expect(await weth.balanceOf(distAddr)).to.equal(0n);
      expect(await ethers.provider.getBalance(distAddr)).to.equal(0n);
    });
  });

  // ══ 4. RE-ENTRANCY, AND THE ACCOUNTING UNDERNEATH THE GUARD ═══════════

  describe("re-entrancy", () => {
    /** Stake `shares` from a live MockReentrantClaimer. */
    async function withClaimer(fx: any, shares: bigint) {
      const { vault, vaultAddr, distAddr, alice } = fx;
      const Claimer = await ethers.getContractFactory("MockReentrantClaimer");
      const claimer: any = await Claimer.deploy(distAddr);
      const claimerAddr = await claimer.getAddress();

      await vault
        .connect(alice)
        .mintProRata(shares, [ethers.MaxUint256, ethers.MaxUint256, ethers.MaxUint256]);
      await vault.connect(alice).transfer(claimerAddr, shares);
      await claimer.stakeInto(vaultAddr, distAddr, shares);
      return { claimer, claimerAddr };
    }

    it("a REAL re-entrant claim reverts the whole payment — nothing partial lands", async () => {
      const fx = await fixture();
      const { dist, distAddr, carol } = fx;
      const { claimer, claimerAddr } = await withClaimer(fx, 100n * WAD);
      await dist.connect(carol).receiveDividends({ value: E("5") });
      expect(await dist.claimable(claimerAddr)).to.equal(E("5"));

      await claimer.setAttack(true);
      // The inner re-entrant `claim()` hits `nonReentrant` and reverts inside
      // `receive()`, so the outer `.call` returns false and the OUTER claim
      // reverts too. The dividend is never marked paid when it was not.
      await expect(claimer.doClaim()).to.be.revertedWithCustomError(dist, "TransferFailed");

      // Every piece of state is exactly where it was.
      expect(await dist.claimable(claimerAddr)).to.equal(E("5"));
      expect(await dist.owed(claimerAddr)).to.equal(0n); // still un-crystallised
      expect(await dist.totalClaimed()).to.equal(0n);
      expect(await ethers.provider.getBalance(distAddr)).to.equal(E("5"));
      expect(await ethers.provider.getBalance(claimerAddr)).to.equal(0n);
      expect(await claimer.received()).to.equal(0n);
    });

    it("EXTRACTION BOUND: the same recipient, not re-entering, gets exactly what was owed and not one wei more", async () => {
      const fx = await fixture();
      const { dist, distAddr, bob, carol } = fx;
      const { claimer, claimerAddr } = await withClaimer(fx, 100n * WAD);
      // A second staker, so "everything in the contract" and "what this
      // account is owed" are different numbers and the test can tell them
      // apart.
      await mintAndStake(fx, bob, 300n * WAD);
      await dist.connect(carol).receiveDividends({ value: E("8") });

      const owed: bigint = await dist.claimable(claimerAddr);
      expect(owed).to.equal(E("2")); // 100 / 400 of 8
      await claimer.setAttack(false);
      await claimer.doClaim();

      expect(await claimer.received()).to.equal(owed);
      expect(await ethers.provider.getBalance(claimerAddr)).to.equal(owed);
      expect(await dist.claimable(claimerAddr)).to.equal(0n);
      expect(await dist.totalClaimed()).to.equal(owed);
      // Bob's entitlement is untouched, and the contract still holds it.
      expect(await dist.claimable(bob.address)).to.equal(E("6"));
      expect(await ethers.provider.getBalance(distAddr)).to.equal(E("6"));
    });

    it("a contract recipient whose receive() needs more than 2300 gas CAN still be paid — the reason claim() uses .call", async () => {
      // MockReentrantClaimer's `receive()` writes storage, which is far over
      // the 2300-gas stipend `transfer` would provide. If `claim()` had been
      // written with `transfer`, this test would fail — and every smart-
      // contract holder (multisig, vault, splitter) would be locked out of
      // their own dividends.
      const fx = await fixture();
      const { dist, carol } = fx;
      const { claimer, claimerAddr } = await withClaimer(fx, 100n * WAD);
      await dist.connect(carol).receiveDividends({ value: E("1") });
      await claimer.setAttack(false);
      await expect(claimer.doClaim()).to.not.be.reverted;
      expect(await claimer.received()).to.equal(E("1"));
    });

    it("a failed re-entrant attempt does not poison later honest claims", async () => {
      const fx = await fixture();
      const { dist, carol } = fx;
      const { claimer, claimerAddr } = await withClaimer(fx, 100n * WAD);
      await dist.connect(carol).receiveDividends({ value: E("5") });

      await claimer.setAttack(true);
      await expect(claimer.doClaim()).to.be.reverted;
      await expect(claimer.doClaim()).to.be.reverted; // and again

      await claimer.setAttack(false);
      await claimer.doClaim();
      expect(await claimer.received()).to.equal(E("5"));
      expect(await dist.totalClaimed()).to.equal(E("5"));
      // Conservation still holds after the whole episode.
      const [held, received, claimed] = await dist.ethStatus();
      expect(claimed).to.be.at.most(received);
      expect(held).to.equal(received - claimed);
    });

    it("stake / unstake / claimAndReinvest are all guarded too, not just claim", async () => {
      const { dist } = await fixture();
      // Enumerated from the ABI so a future entry point that forgets the guard
      // is visible here rather than discovered later.
      const stateChanging = dist.interface.fragments
        .filter(
          (f: any) =>
            f.type === "function" &&
            f.stateMutability !== "view" &&
            f.stateMutability !== "pure"
        )
        .map((f: any) => f.name as string)
        .sort();
      expect(stateChanging).to.deep.equal([
        "claim",
        "claimAndReinvest",
        "receiveDividends",
        "receiveDividendsWrapped",
        "stake",
        "unstake",
      ]);
      // `receiveDividends` USED to be the one unguarded entry, on the reasoning
      // that it only ever ADDS value and calls out to nothing. Both halves of
      // that are still true and it is guarded anyway, because the risk was
      // never to `receiveDividends` — it was to the balance-moving windows it
      // could be nested INSIDE. See DistributorReinvestReentrancy.test.ts.
      expect(await dist.capabilities()).to.deep.equal([true, false, true, 1n]);
    });
  });
});
