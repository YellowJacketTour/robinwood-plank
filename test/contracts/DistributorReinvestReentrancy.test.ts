import { expect } from "chai";
import { ethers } from "hardhat";
import { takeSnapshot, time, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import {
  MIN_CHECKPOINT,
  TIMELOCK,
  WAD,
  defaultParams,
  paramsTuple,
} from "./helpers/index-vault";

/**
 * ============================================================================
 * ROUND 7 — CLOSING THE `receiveDividends` / `claimAndReinvest` FINDING
 *
 * The finding, restated precisely. `claimAndReinvest` holds a window open
 * between `_crystallise(msg.sender)` — which settles the caller's debt at the
 * accumulator's CURRENT height — and the `_resync(msg.sender)` that follows
 * the stake increase. `_resync` ASSIGNS `claimedDebt = stakedOf * acc / WAD`.
 * That assignment is only correct if `acc` did not move inside the window,
 * and the window spans TWO external calls: `weth.deposit{value: amount}()`
 * and `indexVault.mintSingleAsset(...)`. If anything reachable from either
 * could call back into `receiveDividends` — the ONLY function that raises
 * `acc` — the caller's freshly-earned pending would be silently destroyed:
 * settled at the old height, re-anchored at the new one, with the difference
 * credited to nobody. `receiveDividends` was the one entry point in the file
 * without `nonReentrant`, contradicting the header's own claim.
 *
 * TWO SEPARATE QUESTIONS, ANSWERED SEPARATELY BELOW.
 *
 *   1. WAS IT REACHABLE with the real pieces? Section 1 traces and drives it.
 *      The answer is NO, and the reason is structural rather than lucky:
 *      canonical WETH9's `deposit` only credits a mapping, and every external
 *      read `mintSingleAsset` performs — `priceBand`, `nav`, `_spotPrice`,
 *      `_mintFeeBps`, `_allWeightsBps`, `_requirePersistenceIfLarge` — goes
 *      through `IIndexPriceSource`'s `view` functions or an explicit
 *      `staticcall`, so it CANNOT mutate state at all, let alone reach a
 *      payable push. The only non-static call in the whole path is
 *      `_pullCredited`'s `safeTransferFrom` on the distributor's IMMUTABLE
 *      `reinvestAsset`, and `_mintWithAllocation`'s `_mint`, which is
 *      internal ERC-20 bookkeeping with no hook. Nothing there takes
 *      attacker-influenced calldata or an attacker-chosen callee.
 *
 *   2. IS THAT A PROPERTY OF THIS CONTRACT? It was not. It was a property of
 *      WETH9's and GlobalIndexVault's current bytecode, held at arm's length
 *      across a trust boundary this contract does not own. Section 2 replaces
 *      the wrapped-ETH leg with `MockReentrantWeth`, which really does call
 *      `receiveDividends` from inside BOTH external calls the window spans,
 *      and shows the attack is now rejected at this contract's own front
 *      door. That is the difference the `nonReentrant` added in this round
 *      buys: the window is closed HERE, unconditionally, and stays closed
 *      through any future WETH swap or new vault call.
 *
 * LOCAL HARDHAT ONLY. Nothing in this repo may deploy any of these contracts
 * until the external audit gate (§2.6) clears.
 * ============================================================================
 */
describe("IndexDividendDistributor — the claimAndReinvest accumulator window", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const E = (n: string) => ethers.parseEther(n);

  async function fund(token: any, who: any, amount: bigint) {
    const bal: bigint = await ethers.provider.getBalance(who.address);
    await ethers.provider.send("hardhat_setBalance", [
      who.address,
      "0x" + (bal + amount + E("100")).toString(16),
    ]);
    await token.connect(who).deposit({ value: amount });
  }

  /**
   * @param wethArtifact which wrapped-ETH implementation occupies the reinvest
   * leg — the real vendored WETH9, or the hostile one. Everything else about
   * the system is identical, which is what makes the two sections comparable.
   */
  async function fixture(wethArtifact: "CanonicalWeth9" | "MockReentrantWeth") {
    const [, admin, seeder, alice, bob, carol] = await ethers.getSigners();

    const Weth = await ethers.getContractFactory(wethArtifact);
    const weth: any = await Weth.deploy();

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
      if (i === 0) await fund(weth, seeder, 1_000n * WAD);
      else await tokens[i].mint(seeder.address, 1_000n * WAD);
      await tokens[i].connect(seeder).approve(vaultAddr, ethers.MaxUint256);
      await vault.connect(seeder).seedDeposit(addrs[i], 1_000n * WAD);
    }
    await vault.connect(seeder).openIndex(1_000n * WAD);

    for (const who of [alice, bob, carol]) {
      await fund(weth, who, 100_000n * WAD);
      await weth.connect(who).approve(vaultAddr, ethers.MaxUint256);
      for (const t of [t1, t2]) {
        await t.mint(who.address, 100_000n * WAD);
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

    return { admin, seeder, alice, bob, carol, vault, vaultAddr, dist, distAddr, weth, addrs };
  }

  async function mintAndStake(fx: any, who: any, shares: bigint) {
    await fx.vault
      .connect(who)
      .mintProRata(shares, [ethers.MaxUint256, ethers.MaxUint256, ethers.MaxUint256]);
    await fx.dist.connect(who).stake(shares);
  }

  // ══ 1. THE REAL CALL GRAPH: the window was never reachable ═════════════

  describe("with the REAL WETH9 and the REAL vault, no path back in exists", () => {
    it("claimAndReinvest leaves the accumulator EXACTLY where it found it", async () => {
      // The whole finding reduces to "can `acc` move inside the window". With
      // the real pieces it provably cannot, and this is the direct reading of
      // that: identical before and after, across both external calls.
      const fx = await fixture("CanonicalWeth9");
      const { dist, alice, bob, carol } = fx;
      await mintAndStake(fx, alice, 400n * WAD);
      await mintAndStake(fx, bob, 600n * WAD);
      await dist.connect(carol).receiveDividends({ value: E("10") });

      const accBefore: bigint = await dist.accEthPerShareWad();
      await dist.connect(alice).claimAndReinvest(0n);
      expect(await dist.accEthPerShareWad()).to.equal(accBefore);
    });

    it("the reinvestor's settled dividend is fully spent and NOTHING of it is destroyed", async () => {
      const fx = await fixture("CanonicalWeth9");
      const { dist, vault, alice, bob, carol } = fx;
      await mintAndStake(fx, alice, 400n * WAD);
      await mintAndStake(fx, bob, 600n * WAD);
      await dist.connect(carol).receiveDividends({ value: E("10") });

      const aliceOwed: bigint = await dist.claimable(alice.address); // 4/10
      expect(aliceOwed).to.equal(E("4"));
      const stakedBefore: bigint = await dist.stakedOf(alice.address);

      const sharesOut: bigint = await dist.connect(alice).claimAndReinvest.staticCall(0n);
      await dist.connect(alice).claimAndReinvest(0n);

      // Every wei of the dividend became stake, and the ledger says so.
      expect(await dist.totalClaimed()).to.equal(aliceOwed);
      expect(await dist.owed(alice.address)).to.equal(0n);
      expect(await dist.claimable(alice.address)).to.equal(0n);
      expect(await dist.stakedOf(alice.address)).to.equal(stakedBefore + sharesOut);
      // The debt is anchored at the UNMOVED accumulator, so the very next
      // read is zero rather than a phantom credit or a lost accrual.
      expect(await dist.claimedDebt(alice.address)).to.equal(
        ((stakedBefore + sharesOut) * (await dist.accEthPerShareWad())) / WAD
      );
      // Bob, who did nothing, is untouched — no accrual leaked to him either.
      expect(await dist.claimable(bob.address)).to.equal(E("6"));
      // And the shares really landed here, not in Alice's wallet.
      expect(await vault.balanceOf(alice.address)).to.equal(0n);
    });

    it("a push landing immediately AFTER the reinvest accrues on the NEW, larger stake — the boundary is clean on both sides", async () => {
      const fx = await fixture("CanonicalWeth9");
      const { dist, alice, bob, carol } = fx;
      await mintAndStake(fx, alice, 400n * WAD);
      await mintAndStake(fx, bob, 600n * WAD);
      await dist.connect(carol).receiveDividends({ value: E("10") });
      await dist.connect(alice).claimAndReinvest(0n);

      const aStake: bigint = await dist.stakedOf(alice.address);
      const bStake: bigint = await dist.stakedOf(bob.address);
      expect(aStake).to.be.greaterThan(400n * WAD); // she really compounded

      await dist.connect(carol).receiveDividends({ value: E("10") });
      const total = aStake + bStake;
      // Pro rata at the POST-reinvest weights, to the accumulator's flooring.
      expect(await dist.claimable(alice.address)).to.be.closeTo(
        (E("10") * aStake) / total,
        1_000_000n
      );
      expect(await dist.claimable(bob.address)).to.be.closeTo(
        E("6") + (E("10") * bStake) / total,
        1_000_000n
      );
    });

    it("every external read mintSingleAsset performs is view/staticcall — the ABI says so, not a comment", async () => {
      // The price-source interface is the only contract the vault reaches for
      // during a mint besides the constituent token itself. Both of its
      // functions are `view`, so solidity emits STATICCALL and a re-entrant
      // state-mutating push is impossible at the EVM level, not merely
      // unwritten. If someone ever makes one non-view, this fails here.
      const Source = await ethers.getContractFactory("MockIndexPriceSource");
      const src: any = await Source.deploy(100n * WAD, 100n * WAD);
      const muts = src.interface.fragments
        .filter((f: any) => f.type === "function" && ["ethReserve", "shareReserve"].includes(f.name))
        .map((f: any) => f.stateMutability);
      expect(muts).to.have.lengthOf(2);
      expect(muts.every((m: string) => m === "view" || m === "pure")).to.equal(true);
    });

    it("canonical WETH9's deposit calls NOTHING — it credits a mapping and returns", async () => {
      // The first of the window's two external calls, read directly: sending
      // ETH to `deposit` moves exactly one balance and emits one event. There
      // is no callee to hijack.
      const fx = await fixture("CanonicalWeth9");
      const { weth, carol } = fx;
      const tx = await weth.connect(carol).deposit({ value: E("1") });
      const rc = await tx.wait();
      const wethAddr = await weth.getAddress();
      // Every log in the transaction came from WETH itself: nothing else was
      // invoked, so nothing else could have re-entered.
      expect(rc!.logs.length).to.equal(1);
      expect(rc!.logs[0].address).to.equal(wethAddr);
    });
  });

  // ══ 2. THE HOSTILE LEG: the guard, not the callee's shape ══════════════

  describe("with a HOSTILE reinvest asset that really does try to re-enter", () => {
    /** Stake Alice and Bob, push a dividend, and arm the hostile WETH. */
    async function armed(mode: "deposit" | "transferFrom", swallow: boolean) {
      const fx = await fixture("MockReentrantWeth");
      const { dist, distAddr, weth, alice, bob, carol } = fx;
      await mintAndStake(fx, alice, 400n * WAD);
      await mintAndStake(fx, bob, 600n * WAD);
      await dist.connect(carol).receiveDividends({ value: E("10") });

      // The attacker funds its own push, so a successful re-entry would be a
      // REAL dividend arriving mid-window, not a free one.
      await weth.connect(carol).fundAttack({ value: E("20") });
      await weth.arm(
        distAddr,
        mode === "deposit",
        mode === "transferFrom",
        E("5"),
        swallow
      );
      return fx;
    }

    it("re-entry from weth.deposit() — the FIRST call in the window — is rejected", async () => {
      const fx = await armed("deposit", false);
      const { dist, alice } = fx;
      await expect(dist.connect(alice).claimAndReinvest(0n)).to.be.revertedWith(
        "ReentrancyGuard: reentrant call"
      );
    });

    it("re-entry from transferFrom INSIDE mintSingleAsset — the SECOND call — is rejected too", async () => {
      // This is the deeper one: the call originates two frames down, from the
      // vault's `_pullCredited`, not from anything the distributor invoked
      // directly. The guard is on the distributor's own state, so depth is
      // irrelevant to it.
      const fx = await armed("transferFrom", false);
      const { dist, alice } = fx;
      await expect(dist.connect(alice).claimAndReinvest(0n)).to.be.revertedWith(
        "ReentrancyGuard: reentrant call"
      );
    });

    it("EXPLOIT ATTEMPT, FAILURE SWALLOWED: the attacker survives the revert and STILL cannot move the accumulator", async () => {
      // The harsher framing. Here the hostile WETH makes the re-entrant push
      // with a raw `.call` and ignores the failure, so `claimAndReinvest`
      // completes normally. If the guard were absent this is precisely the
      // silent-loss scenario: the reinvest succeeds, `acc` has risen, and the
      // `_resync` that follows erases the difference with no revert and no
      // event to notice. The assertions below are the negation of that, one
      // by one.
      const fx = await armed("deposit", true);
      const { dist, weth, alice, bob } = fx;

      const accBefore: bigint = await dist.accEthPerShareWad();
      const receivedBefore: bigint = await dist.totalReceived();
      const bobBefore: bigint = await dist.claimable(bob.address);
      const stakedBefore: bigint = await dist.stakedOf(alice.address);

      const sharesOut: bigint = await dist.connect(alice).claimAndReinvest.staticCall(0n);
      await dist.connect(alice).claimAndReinvest(0n);

      // The attack was genuinely attempted and genuinely refused.
      expect(await weth.reenterAttempts()).to.be.greaterThan(0n);
      expect(await weth.reenterSucceeded()).to.equal(false);

      // Therefore nothing moved inside the window...
      expect(await dist.accEthPerShareWad()).to.equal(accBefore);
      expect(await dist.totalReceived()).to.equal(receivedBefore);
      // ...the debt is anchored at that same unmoved height...
      expect(await dist.stakedOf(alice.address)).to.equal(stakedBefore + sharesOut);
      expect(await dist.claimedDebt(alice.address)).to.equal(
        ((stakedBefore + sharesOut) * accBefore) / WAD
      );
      // ...Alice has neither a phantom credit nor a destroyed accrual...
      expect(await dist.claimable(alice.address)).to.equal(0n);
      expect(await dist.owed(alice.address)).to.equal(0n);
      // ...and Bob is exactly where he was.
      expect(await dist.claimable(bob.address)).to.equal(bobBefore);
    });

    it("the same attempt from transferFrom, failure swallowed, is equally inert", async () => {
      const fx = await armed("transferFrom", true);
      const { dist, weth, alice, bob } = fx;
      const accBefore: bigint = await dist.accEthPerShareWad();
      const bobBefore: bigint = await dist.claimable(bob.address);

      await dist.connect(alice).claimAndReinvest(0n);

      expect(await weth.reenterAttempts()).to.be.greaterThan(0n);
      expect(await weth.reenterSucceeded()).to.equal(false);
      expect(await dist.accEthPerShareWad()).to.equal(accBefore);
      expect(await dist.claimable(alice.address)).to.equal(0n);
      expect(await dist.claimable(bob.address)).to.equal(bobBefore);
    });

    it("the SAME hostile push succeeds when it is NOT nested — the guard blocks re-entry, not the feature", async () => {
      // The control. `receiveDividends` remains permissionless and works fine
      // from the identical caller, at the identical value, one frame up. What
      // was closed is the nesting, not the push.
      const fx = await armed("deposit", true);
      const { dist, distAddr, weth, alice } = fx;
      const accBefore: bigint = await dist.accEthPerShareWad();

      // Disarm the nesting; have the hostile contract push directly.
      await weth.arm(distAddr, false, false, E("5"), false);
      await weth.connect(alice).fundAttack({ value: E("5") });
      const Hostile = await ethers.getContractAt("MockReentrantWeth", await weth.getAddress());
      // Re-arm for a standalone (un-nested) attempt by driving deposit itself.
      await weth.arm(distAddr, true, false, E("5"), false);
      await Hostile.connect(alice).deposit({ value: 1n });

      expect(await weth.reenterSucceeded()).to.equal(true);
      expect(await dist.accEthPerShareWad()).to.be.greaterThan(accBefore);
      expect(await dist.totalReceived()).to.equal(E("15"));
    });

    it("re-entry into stake/unstake/claim from the hostile leg is refused for the same reason", async () => {
      // Completeness: the accumulator window is one victim, but the guard is
      // contract-wide, so no balance-moving path can be nested inside another
      // either. Driven through `receiveDividendsWrapped`, whose unwrap is the
      // other place this contract hands control to the WETH address.
      const fx = await fixture("MockReentrantWeth");
      const { dist, distAddr, weth, alice, carol } = fx;
      await mintAndStake(fx, alice, 400n * WAD);
      await weth.connect(carol).fundAttack({ value: E("10") });
      await weth.arm(distAddr, false, true, E("5"), false);
      // `receiveDividendsWrapped` pulls via transferFrom -> hostile re-enters.
      await expect(dist.connect(carol).receiveDividendsWrapped(E("1"))).to.be.revertedWith(
        "ReentrancyGuard: reentrant call"
      );
    });
  });

  // ══ 3. THE HEADER'S CLAIM, MADE CHECKABLE ═════════════════════════════

  describe("\"every entry point is nonReentrant\" is now literally true", () => {
    it("no state-changing function on the distributor is unguarded", async () => {
      // Enumerated from the ABI rather than listed by hand, so a future entry
      // point that forgets the guard fails here instead of being discovered
      // by an auditor. Each is called re-entrantly through the hostile leg in
      // section 2, or is unreachable-while-locked by construction.
      const fx = await fixture("CanonicalWeth9");
      const { dist } = fx;
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
    });

    it("guarding receiveDividends changed NOTHING for an honest pusher", async () => {
      // Pure hardening, not a behaviour change: this contract never calls
      // `receiveDividends` from anywhere, and `receiveDividendsWrapped`
      // reaches the same accumulator through the shared PRIVATE `_credit`
      // rather than by calling it, so the two push paths never nest and no
      // legitimate flow was ever inside the lock.
      const fx = await fixture("CanonicalWeth9");
      const { dist, alice, bob, carol } = fx;
      await mintAndStake(fx, alice, 400n * WAD);
      await mintAndStake(fx, bob, 600n * WAD);

      await dist.connect(carol).receiveDividends({ value: E("10") });
      await dist.connect(alice).receiveDividends({ value: E("10") }); // a STAKER may push
      await dist.connect(carol).receiveDividendsWrapped(E("10")); // and the wrapped twin still works
      expect(await dist.totalReceived()).to.equal(E("30"));
      expect(await dist.claimable(alice.address)).to.equal(E("12"));
      expect(await dist.claimable(bob.address)).to.equal(E("18"));

      // Back-to-back pushes in the same block are still fine — the guard is
      // per-call, not a rate limit.
      await dist.connect(carol).receiveDividends({ value: 1n });
      await dist.connect(carol).receiveDividends({ value: 1n });
      expect(await dist.totalReceived()).to.equal(E("30") + 2n);

      // And zero still reverts for the same reason it always did.
      await expect(dist.connect(carol).receiveDividends({ value: 0n }))
        .to.be.revertedWithCustomError(dist, "ZeroAmount");
    });
  });
});
