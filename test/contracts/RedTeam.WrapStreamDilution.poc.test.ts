import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployOpenIndex, maxIn } from "./helpers/index-vault";

/**
 * RED TEAM PoC — ATOMIC STREAM-BACKING EXTRACTION ON WrappedIndexShare.
 *
 * The header of WrappedIndexShare.sol discloses that `deposit` does not charge
 * a proportional side on stream legs, and quantifies the resulting dilution as
 *   "bounded by deposit size relative to the pool and is symmetric — the same
 *    depositor is diluted in turn by everyone after them."
 *
 * Both halves of that mitigation assume the depositor STAYS. This file drives
 * the case where they do not: deposit and withdraw in ONE transaction. The raw
 * leg is priced on R alone and the dividend leg is charged proportionally, so
 * both round-trip to ~zero. The stream legs are charged NOTHING on the way in
 * and paid pro rata on the way out, so the entire round trip is a free,
 * risk-free, zero-duration transfer of stream backing from existing holders.
 *
 * ── ROUND 9f: THE SAME ATTACK, NOW A REGRESSION TEST ────────────────────────
 * The attack scenario below is UNCHANGED, bit for bit — same fixture, same
 * bribe, same flash-sized position, same single-transaction round trip through
 * the same `MockFlashWrapAttacker`. What changed is the contract: `deposit`
 * now displaces stream backing into a linear re-vest to offset the dilution it
 * just imposed (`_revestOnMint`), so the round trip captures ~nothing.
 *
 * The assertions are inverted to pin the FIX rather than the bug. Measured on
 * this fixture:
 *      before   99.00% of the 100,000-unit bribe, in one transaction
 *      after     0.00%
 * and the honest holder's claim, which previously collapsed by >9x, is now
 * fully intact.
 */
describe("RED TEAM — atomic stream-backing extraction (wrapper), now closed", () => {
  let __snap: SnapshotRestorer;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  const E = (n: string) => ethers.parseEther(n);
  const DELAY = 48 * 3600;

  async function fixture() {
    const fx = await deployOpenIndex();
    const signers = await ethers.getSigners();
    const lister = signers[9];
    const briber = signers[10];

    const W = await ethers.getContractFactory("WrappedIndexShare");
    const wrapper: any = await W.deploy(
      fx.vaultAddr,
      "Wrapped Global Index",
      "wIDX",
      fx.roleAdmin.address,
      lister.address,
      DELAY
    );
    const wrapperAddr = await wrapper.getAddress();
    for (const who of [fx.alice, fx.bob, fx.carol]) {
      await fx.vault.connect(who).approve(wrapperAddr, ethers.MaxUint256);
      await fx.tokens[0].connect(who).approve(wrapperAddr, ethers.MaxUint256);
    }
    return { ...fx, wrapper, wrapperAddr, lister, briber };
  }

  async function listAndFund(fx: any, amount: bigint) {
    const T = await ethers.getContractFactory("MockIndexToken");
    const bribe: any = await T.deploy("BRIBE", "BRIBE");
    const addr = await bribe.getAddress();
    await fx.wrapper.connect(fx.lister).queueStream(addr);
    await time.increase(DELAY + 1);
    await fx.wrapper.executeStream(addr);
    await bribe.mint(fx.briber.address, amount);
    await bribe.connect(fx.briber).approve(fx.wrapperAddr, amount);
    await fx.wrapper.connect(fx.briber).depositStream(addr, amount);
    return { bribe, addr };
  }

  it("PoC-A (fixed): a same-transaction deposit→withdraw captures ~nothing of the stream backing", async () => {
    const fx = await fixture();

    // Honest holder establishes the wrapped supply.
    await fx.vault.connect(fx.alice).mintProRata(E("3000"), maxIn(3));
    await fx.wrapper.connect(fx.alice).deposit(E("3000"));

    // A briber permissionlessly funds a reward stream for those holders.
    const BRIBE_TOTAL = E("100000");
    const { bribe, addr } = await listAndFund(fx, BRIBE_TOTAL);

    const aliceClaimBefore = (
      await fx.wrapper.previewWithdraw(await fx.wrapper.balanceOf(fx.alice.address))
    )[1];

    // Attacker: borrow-sized raw shares, one atomic wrap/unwrap.
    await fx.vault.connect(fx.bob).mintProRata(E("300000"), maxIn(3));
    const A = await ethers.getContractFactory("MockFlashWrapAttacker");
    const atk: any = await A.deploy();
    const atkAddr = await atk.getAddress();
    await fx.vault.connect(fx.bob).approve(atkAddr, ethers.MaxUint256);

    const rawBefore = await fx.vault.balanceOf(fx.bob.address);
    await atk.connect(fx.bob).attack(fx.wrapperAddr, fx.vaultAddr, E("300000"));
    await atk.sweep(fx.vaultAddr, fx.bob.address);
    await atk.sweep(addr, fx.bob.address);

    const rawAfter = await fx.vault.balanceOf(fx.bob.address);
    const bribeStolen = await bribe.balanceOf(fx.bob.address);
    const rawCost = rawBefore - rawAfter;

    const aliceClaimAfter = (
      await fx.wrapper.previewWithdraw(await fx.wrapper.balanceOf(fx.alice.address))
    )[1];

    console.log("\n  --- ATOMIC ROUND TRIP, ONE TRANSACTION ---");
    console.log("  stream funded by briber (BRIBE) :", ethers.formatEther(BRIBE_TOTAL));
    console.log("  attacker raw-share cost         :", ethers.formatEther(rawCost));
    console.log("  attacker BRIBE extracted        :", ethers.formatEther(bribeStolen));
    console.log(
      "  => % of the briber's reward captured:",
      (Number((bribeStolen * 10000n) / BRIBE_TOTAL) / 100).toFixed(2) + "%"
    );
    console.log(
      "  honest holder BRIBE claim before/after:",
      ethers.formatEther(aliceClaimBefore[2]),
      "->",
      ethers.formatEther(aliceClaimAfter[2])
    );

    // The raw leg still round-trips to dust — nothing about the attacker's
    // COST changed, and nothing was locked, staked or blocked. The attack is
    // still perfectly executable; it simply no longer pays.
    expect(rawCost).to.be.lt(E("0.0001"));

    // THE FIX. Previously > 90,000 of 100,000. The bound proved in the header
    // is Vst/(4*M) = 1% as the worst case over ALL attacker sizes; this
    // attacker is far past f = 1/M and so captures the clamped case, ~0.
    expect(bribeStolen).to.be.lt(E("1000")); // < 1% of the bribe
    expect(bribeStolen).to.be.lt(BRIBE_TOTAL / 100n);

    // And the honest holder, who did nothing, is NOT robbed. Note what the
    // quote reads IMMEDIATELY after the attack: it is low, because the attack
    // displaced the whole stream pool into the re-vest — but the value never
    // left the wrapper, and the attacker did not get it. Alice simply waits.
    expect(await bribe.balanceOf(fx.wrapperAddr)).to.be.gt((BRIBE_TOTAL * 99n) / 100n);
    await network.provider.send("hardhat_mine", [
      "0x" + ((await fx.wrapper.STREAM_VEST_BLOCKS()) + 1n).toString(16),
    ]);
    const aliceClaimVested = (
      await fx.wrapper.previewWithdraw(await fx.wrapper.balanceOf(fx.alice.address))
    )[1];
    console.log(
      "  honest holder BRIBE claim after the vest window:",
      ethers.formatEther(aliceClaimVested[2])
    );
    // Fully restored: previously her claim collapsed by >9x and never came back
    // because the attacker had walked off with it.
    expect(aliceClaimVested[2]).to.be.gt((aliceClaimBefore[2] * 99n) / 100n);

    // NOT A LOCK: the wrapper still let the attacker in and out in one
    // transaction, with every other leg paid in full. Nothing was trapped.
    expect(await fx.wrapper.balanceOf(atkAddr)).to.equal(0n);
  });

  it("PoC-B (fixed): capture no longer scales with attacker size — it is bounded at every size", async () => {
    for (const size of ["3000", "30000", "300000"]) {
      const fx = await fixture();
      await fx.vault.connect(fx.alice).mintProRata(E("3000"), maxIn(3));
      await fx.wrapper.connect(fx.alice).deposit(E("3000"));
      const { bribe, addr } = await listAndFund(fx, E("100000"));

      await fx.vault.connect(fx.bob).mintProRata(E(size), maxIn(3));
      const A = await ethers.getContractFactory("MockFlashWrapAttacker");
      const atk: any = await A.deploy();
      await fx.vault.connect(fx.bob).approve(await atk.getAddress(), ethers.MaxUint256);
      await atk.connect(fx.bob).attack(fx.wrapperAddr, fx.vaultAddr, E(size));
      await atk.sweep(addr, fx.bob.address);
      const got = await bribe.balanceOf(fx.bob.address);
      console.log(
        `  size ${size.padStart(8)} raw shares -> captured ${ethers.formatEther(got)} of 100000 BRIBE` +
          `  (${((Number(got) / Number(E("100000"))) * 100).toFixed(3)}%)`
      );
      // The header's proved worst case over ALL f is Vst/(4*M) = 1%. Assert it
      // at every size, including the one that previously took ~99%.
      expect(got).to.be.lt(E("1000"));
    }
  });
});
