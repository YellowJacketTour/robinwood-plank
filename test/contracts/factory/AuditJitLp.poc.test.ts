import { expect } from "chai";
import { ethers } from "../helpers/hardhat.js";
import { mine, takeSnapshot, type SnapshotRestorer } from "../helpers/network-helpers.js";

/**
 * AUDIT C-3 — INVERTED. This file used to PROVE the bug; it now proves the fix,
 * running the identical attack against the identical setup and asserting the
 * opposite outcome.
 *
 * ORIGINAL FINDING: `addLiquidity`/`removeLiquidity` charged no fee and imposed
 * no lock, and `_compoundXToken`/`donateReserves` credited `paymentReserve`
 * instantly. The attacker took EXACTLY 5.0 of a 10.0 donation, share delta 0,
 * one block, zero risk.
 *
 * THE FIX, both halves (Spearbit's NFTX v3 evidence is that one alone is not
 * enough — see `CollectionVault`'s Phase-4 comment block):
 *   1. donations vest into `paymentReserve` over `DONATION_VEST_BLOCKS`;
 *   2. LP must dwell `LP_MIN_DWELL_BLOCKS` and pays an exit fee that decays
 *      over the same window.
 *
 * WHAT THIS TEST NOW ASSERTS, and why it can fail: the atomic version REVERTS
 * (delete the dwell check and it stops reverting), and the fastest legal
 * version — exit at the first block the dwell permits — leaves the attacker
 * with STRICTLY LESS payment token AND STRICTLY FEWER shares than they started
 * with (delete the exit fee, or credit the donation instantly, and the gain
 * turns positive again).
 */
describe("AUDIT C-3 FIXED: JIT LP can no longer sandwich paymentReserve donations", () => {
  let snap: SnapshotRestorer;
  before(async () => { snap = await takeSnapshot(); });
  after(async () => { await snap.restore(); });

  const TIMELOCK = 48 * 3600;
  const MIN_DWELL = 8;

  it("the attack is impossible atomically, and loss-making at the earliest legal exit", async () => {
    const [deployer, sink, treasury, alice, attacker] = await ethers.getSigners();
    const payment: any = await (await ethers.getContractFactory("MockIndexToken")).deploy("PAY", "PAY");
    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(sink.address, await payment.getAddress(), TIMELOCK);

    const vaultAddr = await factory.deployVault.staticCall(await nft.getAddress(), treasury.address, 810);
    await factory.deployVault(await nft.getAddress(), treasury.address, 810);
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);

    for (const who of [alice, attacker, treasury, deployer]) {
      await payment.mint(who.address, ethers.parseEther("100000"));
      await payment.connect(who).approve(vaultAddr, ethers.MaxUint256);
      await vault.connect(who).approve(vaultAddr, ethers.MaxUint256);
    }

    // alice mints 20 S by depositing 20 NFTs
    for (let i = 1; i <= 20; i++) {
      await nft.mint(alice.address, i);
      await nft.connect(alice).approve(vaultAddr, i);
      await vault.connect(alice).deposit(i);
    }
    // attacker mints 10 S
    for (let i = 101; i <= 110; i++) {
      await nft.mint(attacker.address, i);
      await nft.connect(attacker).approve(vaultAddr, i);
      await vault.connect(attacker).deposit(i);
    }

    // Bootstrap: 100 PAY / 10 S
    const seedPayment = ethers.parseEther("100");
    const seedShares = ethers.parseEther("10");
    await vault.connect(treasury).seedLiquidity(seedPayment);
    await vault.connect(alice).transfer(treasury.address, seedShares);
    await vault.connect(treasury).seedShares(seedShares);
    await vault.connect(treasury).openPool();

    const payBefore = await payment.balanceOf(attacker.address);
    const sBefore = await vault.balanceOf(attacker.address);

    // ── the sandwich, unchanged ─────────────────────────────────────────
    // 1. JIT add: 100 PAY (matched 10 S derived by the pool). Now attacker
    //    owns ~50% of all LP claims.
    const [lpOut] = await vault.connect(attacker).addLiquidity.staticCall(seedPayment, 0);
    await vault.connect(attacker).addLiquidity(seedPayment, 0);

    // 2. A 10 PAY donation lands (this is exactly what _compoundXToken /
    //    donateReserves do).
    await vault.connect(deployer).donateReserves(ethers.parseEther("10"));

    // 3. JIT remove, same instant — HALF 2 OF THE FIX: hard revert, no
    //    economic reasoning required. This is the assertion that would go red
    //    the moment the dwell requirement is removed.
    await expect(vault.connect(attacker).removeLiquidity(lpOut, 0, 0)).to.be.revertedWithCustomError(
      vault,
      "LpDwellNotMet"
    );

    // 4. The patient variant: wait exactly as long as the protocol forces,
    //    then exit. HALF 1 OF THE FIX caps what can have arrived in that time
    //    at dwell/300 of the donation; the decaying exit fee costs more.
    await mine(MIN_DWELL);
    await vault.connect(attacker).removeLiquidity(lpOut, 0, 0);

    const payAfter = await payment.balanceOf(attacker.address);
    const sAfter = await vault.balanceOf(attacker.address);

    const payGain = payAfter - payBefore;
    const sDelta = sAfter - sBefore;

    console.log("attacker PAY gain :", ethers.formatEther(payGain));
    console.log("attacker S delta  :", ethers.formatEther(sDelta));

    // INVERTED. The attacker is strictly worse off on BOTH legs — there is no
    // combination of the two that nets out positive, so no accounting trick
    // rescues the trade.
    expect(payGain < 0n, "attacker must LOSE payment token on the round trip").to.equal(true);
    expect(sDelta < 0n, "attacker must LOSE shares on the round trip").to.equal(true);

    // And quantitatively: the loss dwarfs the largest slice of the donation
    // that could possibly have vested during the dwell (50% of 10 PAY *
    // 9/300 = 0.15 PAY).
    const maxPossibleCapture = ethers.parseEther("0.15");
    expect(-payGain > maxPossibleCapture, "the exit fee must exceed the maximum capturable slice").to.equal(
      true
    );
  });
});
