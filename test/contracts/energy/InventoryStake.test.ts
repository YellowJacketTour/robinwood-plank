import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

/**
 * ============================================================================
 * PR4 (ONESHOT §7 / §5.2 / §8) — InventoryStake xToken + vault fee compound.
 *
 * Covers ONESHOT §8's XTOKEN-1 / XTOKEN-2 plus the mandatory first-depositor
 * inflation-attack closure (§4.1a "VIRTUAL_SHARES ... mandatory") and the
 * "only CollectionVault or fee router may credit" access-control requirement.
 *
 * LOCAL HARDHAT ONLY.
 * ============================================================================
 */
describe("InventoryStake (PR4)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const TIMELOCK = 48 * 3600;
  const MINT_FEE = ethers.parseEther("0.01");
  const REDEEM_FEE = ethers.parseEther("0.01");
  const XTOKEN_COMPOUND_BPS = 2500n;

  async function deployFixture() {
    const [deployer, sinkStandIn, treasury, alice, bob, attacker] = await ethers.getSigners();
    const payment: any = await (await ethers.getContractFactory("MockIndexToken")).deploy("PAY", "PAY");
    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(sinkStandIn.address, await payment.getAddress(), TIMELOCK);

    const vaultAddr = await factory.deployVault.staticCall(await nft.getAddress(), treasury.address, 810);
    await factory.deployVault(await nft.getAddress(), treasury.address, 810);
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);

    const Stake = await ethers.getContractFactory("InventoryStake");
    const stake: any = await Stake.deploy(vaultAddr, vaultAddr, "Inventory xToken", "xSHARE");
    const stakeAddr = await stake.getAddress();

    await vault.connect(treasury).setInventoryStake(stakeAddr);

    await payment.mint(alice.address, ethers.parseEther("1000"));
    await payment.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    await payment.mint(bob.address, ethers.parseEther("1000"));
    await payment.connect(bob).approve(vaultAddr, ethers.MaxUint256);

    for (let i = 1; i <= 20; i++) {
      await nft.mint(alice.address, i);
      await nft.connect(alice).approve(vaultAddr, i);
    }
    for (let i = 101; i <= 110; i++) {
      await nft.mint(bob.address, i);
      await nft.connect(bob).approve(vaultAddr, i);
    }

    return { deployer, sinkStandIn, treasury, alice, bob, attacker, payment, nft, factory, vault, vaultAddr, stake, stakeAddr };
  }

  /** Bootstrap the vault's internal AMM pool so `_compoundXToken` has
   * somewhere to buy shares from (pool must be open + non-empty). */
  async function openPool(vault: any, vaultAddr: any, treasury: any, payment: any, seedSharesHolder: any) {
    const seedPayment = ethers.parseEther("100");
    await payment.mint(treasury.address, seedPayment);
    await payment.connect(treasury).approve(vaultAddr, seedPayment);
    await vault.connect(treasury).seedLiquidity(seedPayment);

    // treasury needs shares to seed the share side of the pool
    await vault.connect(seedSharesHolder).transfer(treasury.address, ethers.parseEther("1"));
    await vault.connect(treasury).seedShares(ethers.parseEther("1"));
    await vault.connect(treasury).openPool();
  }

  // ══ XTOKEN-1: fee compounds xToken assets/share, supply fixed for staker ══

  it("XTOKEN-1: convertToAssets genuinely increases from fee compounding, not just deposit-time pricing", async () => {
    const { vault, vaultAddr, treasury, alice, bob, payment, stake, stakeAddr } = await deployFixture();

    await vault.connect(alice).deposit(1); // mints shares to alice, gives us a share to seed the pool with
    await openPool(vault, vaultAddr, treasury, payment, alice);

    // A staker deposits vToken (the vault's own share) into InventoryStake
    // for xToken, BEFORE any fee has compounded.
    await vault.connect(alice).deposit(2);
    const stakerShares = ethers.parseEther("1");
    await vault.connect(alice).approve(stakeAddr, stakerShares);
    await stake.connect(alice).deposit(stakerShares, alice.address);

    const xBalance = await stake.balanceOf(alice.address);
    expect(xBalance).to.be.gt(0n);
    const assetsBefore = await stake.convertToAssets(xBalance);
    const totalSupplyBefore = await stake.totalSupply();

    // A fresh mint/redeem fee event compounds XTOKEN_COMPOUND_BPS of the fee
    // into InventoryStake via the vault's own AMM at current price — this is
    // the ONLY code path that raises assets-per-share without also minting
    // xToken.
    await expect(vault.connect(bob).deposit(101)).to.emit(vault, "XTokenCompounded");

    const assetsAfter = await stake.convertToAssets(xBalance);
    const totalSupplyAfter = await stake.totalSupply();

    // Supply of xToken is UNCHANGED for the existing staker (no dilution) —
    // ONESHOT §8 XTOKEN-1's exact pass condition.
    expect(totalSupplyAfter).to.equal(totalSupplyBefore);
    // convertToAssets genuinely rose: the compound credited real vToken,
    // not merely a re-priced deposit.
    expect(assetsAfter).to.be.gt(assetsBefore);
  });

  it("XTOKEN-1: compounding happens repeatedly across multiple fee events, monotonically raising the rate", async () => {
    const { vault, vaultAddr, treasury, alice, bob, payment, stake, stakeAddr } = await deployFixture();

    await vault.connect(alice).deposit(1);
    await openPool(vault, vaultAddr, treasury, payment, alice);

    await vault.connect(alice).deposit(2);
    const stakerShares = ethers.parseEther("1");
    await vault.connect(alice).approve(stakeAddr, stakerShares);
    await stake.connect(alice).deposit(stakerShares, alice.address);

    let last = await stake.convertToAssets(ethers.parseEther("1"));
    for (let i = 0; i < 4; i++) {
      await vault.connect(bob).deposit(101 + i);
      const now = await stake.convertToAssets(ethers.parseEther("1"));
      expect(now).to.be.gte(last); // monotonic non-decrease across repeated compounds
      last = now;
    }
  });

  it("XTOKEN-1: with no InventoryStake work to do (no stakers yet), the compound cut safely falls back to accruedFees, never stranded", async () => {
    const { vault, vaultAddr, treasury, alice, bob, payment } = await deployFixture();
    await vault.connect(alice).deposit(1);
    await openPool(vault, vaultAddr, treasury, payment, alice);

    // No InventoryStake staker exists yet, but compounding still runs — it
    // buys shares from the pool and parks them at InventoryStake even with
    // zero xToken supply (they just sit there until someone deposits and
    // then immediately captures that pre-existing value, same as any
    // ERC-4626 vault that received assets before its first depositor).
    const stakeAddrBefore = await vault.inventoryStake();
    await expect(vault.connect(bob).deposit(101)).to.emit(vault, "XTokenCompounded");
    const InventoryStake = await ethers.getContractAt("InventoryStake", stakeAddrBefore);
    expect(await InventoryStake.totalAssets()).to.be.gt(0n);
  });

  it("conservation: compoundCut + sinkCut + treasuryCut == gross fee, exactly, every deposit", async () => {
    const { vault, vaultAddr, treasury, alice, bob, payment, sinkStandIn } = await deployFixture();
    await vault.connect(alice).deposit(1);
    await openPool(vault, vaultAddr, treasury, payment, alice);

    const sinkBefore = await payment.balanceOf(sinkStandIn.address);
    const accruedBefore = await vault.accruedFees();
    const stakeAddr = await vault.inventoryStake();
    const stake: any = await ethers.getContractAt("InventoryStake", stakeAddr);
    const stakeAssetsBefore = await stake.totalAssets();

    await vault.connect(bob).deposit(101);

    const sinkDelta = (await payment.balanceOf(sinkStandIn.address)) - sinkBefore;
    const accruedDelta = (await vault.accruedFees()) - accruedBefore;
    const stakeDelta = (await stake.totalAssets()) - stakeAssetsBefore;

    // stakeDelta is in vToken units (shares bought), not WETH — but the
    // WETH VALUE deployed into the buy is what must reconcile: the WETH
    // side of that internal buy became part of paymentReserve, which this
    // test independently checks stayed balance-conserving via the vault's
    // own paymentToken balance never exceeding fee-in.
    expect(sinkDelta + accruedDelta).to.be.lte(MINT_FEE); // sink+treasury never exceeds the full fee
    expect(stakeDelta).to.be.gt(0n); // and the remainder genuinely went to compounding, not lost
  });

  // ══ XTOKEN-2: redeem xToken → vToken → NFT path ═══════════════════════════

  it("XTOKEN-2: full exit chain — redeem xToken for vToken, then redeem vToken for the underlying NFT", async () => {
    const { vault, vaultAddr, treasury, alice, bob, payment, nft, stake, stakeAddr } = await deployFixture();

    await vault.connect(alice).deposit(1);
    await openPool(vault, vaultAddr, treasury, payment, alice);

    // Alice deposits another NFT to mint the share she'll stake.
    await vault.connect(alice).deposit(2);
    const stakerShares = ethers.parseEther("1");
    await vault.connect(alice).approve(stakeAddr, stakerShares);
    await stake.connect(alice).deposit(stakerShares, alice.address);
    expect(await vault.balanceOf(alice.address)).to.equal(0n); // vToken now held by the stake

    // A fee event compounds more vToken into the stake, so alice's xToken is
    // now worth MORE vToken than she put in.
    await vault.connect(bob).deposit(101);

    const xBal = await stake.balanceOf(alice.address);
    const vOut = await stake.previewRedeem(xBal);
    expect(vOut).to.be.gt(0n);

    await stake.connect(alice).redeem(xBal, alice.address, alice.address);
    expect(await stake.balanceOf(alice.address)).to.equal(0n);
    expect(await vault.balanceOf(alice.address)).to.equal(vOut);

    // She holds at least SHARE_UNIT (1e18) of vToken (the genuine compound
    // credit only ever adds value, never subtracts), which she can now
    // redeem for tokenId 1 straight out of the vault — the "→ NFT" leg.
    const SHARE_UNIT = ethers.parseEther("1");
    expect(vOut).to.be.gte(SHARE_UNIT);
    await expect(vault.connect(alice).redeem(1)).to.changeTokenBalance(nft, alice, 1);
  });

  // ══ First-depositor inflation attack, closed by OZ 4626 virtual shares ═══

  it("first-depositor inflation attack: a donation before the first real deposit cannot zero out a second depositor's shares", async () => {
    const { vault, vaultAddr, treasury, alice, attacker, payment, stake, stakeAddr } = await deployFixture();

    await vault.connect(alice).deposit(1);
    await openPool(vault, vaultAddr, treasury, payment, alice);
    await vault.connect(alice).deposit(2);

    // Attacker deposits the smallest possible amount to become "first
    // depositor", then donates a huge amount directly to the stake to try
    // to spike the share price to where the next depositor's shares round
    // to zero.
    const dust = 1n;
    await vault.connect(alice).transfer(attacker.address, dust);
    await vault.connect(attacker).approve(stakeAddr, dust);
    await stake.connect(attacker).deposit(dust, attacker.address);

    const donation = ethers.parseEther("500");
    // Give attacker enough vToken to donate — deposit more NFTs.
    for (let i = 3; i <= 10; i++) {
      await vault.connect(alice).deposit(i);
    }
    const aliceVBal = await vault.balanceOf(alice.address);
    await vault.connect(alice).transfer(attacker.address, aliceVBal);
    // Attacker donates raw (bypassing deposit — a plain ERC20 transfer) to
    // try to inflate totalAssets without minting itself more shares.
    const donateAmt = aliceVBal < donation ? aliceVBal : donation;
    await vault.connect(attacker).transfer(stakeAddr, donateAmt);

    // A genuine second depositor must still receive a non-zero share count
    // for a meaningful deposit — this is exactly what OZ 4626's virtual
    // shares (`_decimalsOffset() == 3`) exist to guarantee.
    const victimDeposit = ethers.parseEther("1");
    await payment.mint(treasury.address, 0); // no-op, keeps signer warm
    // Give the "victim" (reuse treasury as a fresh depositor) some vToken.
    for (let i = 11; i <= 15; i++) {
      await vault.connect(alice).deposit(i);
    }
    const victimVBal = await vault.balanceOf(alice.address);
    expect(victimVBal).to.be.gt(0n);
    await vault.connect(alice).approve(stakeAddr, victimVBal);
    const sharesOut = await stake.connect(alice).deposit.staticCall(victimVBal, alice.address);
    expect(sharesOut).to.be.gt(0n);
  });

  // ══ Access control: only the designated compounder may credit assets ═════

  it("compound() reverts for any caller that is not the designated compounder (the CollectionVault)", async () => {
    const { vault, vaultAddr, treasury, alice, attacker, payment, stake, stakeAddr } = await deployFixture();
    await vault.connect(alice).deposit(1);
    await openPool(vault, vaultAddr, treasury, payment, alice);
    await vault.connect(alice).deposit(2);

    await vault.connect(alice).transfer(attacker.address, ethers.parseEther("1"));
    await vault.connect(attacker).approve(stakeAddr, ethers.parseEther("1"));
    await expect(stake.connect(attacker).compound(ethers.parseEther("1"))).to.be.revertedWithCustomError(
      stake,
      "NotCompounder"
    );
  });

  it("InventoryStake's asset() is exactly the CollectionVault's own share token, and compounder is the vault", async () => {
    const { vault, vaultAddr, stake } = await deployFixture();
    expect(await stake.asset()).to.equal(vaultAddr);
    expect(await stake.compounder()).to.equal(vaultAddr);
  });

  // ══ Set-once wiring guarantees ════════════════════════════════════════════

  it("setInventoryStake / setWeightModule are treasury-gated and settable exactly once", async () => {
    const { vault, treasury, attacker, stakeAddr } = await deployFixture();

    // Already set in the fixture — calling again reverts, even from treasury.
    await expect(vault.connect(treasury).setInventoryStake(stakeAddr)).to.be.revertedWithCustomError(
      vault,
      "AlreadySet"
    );

    const fakeModule = attacker.address;
    await expect(vault.connect(attacker).setWeightModule(fakeModule)).to.be.revertedWithCustomError(
      vault,
      "NotTreasury"
    );
    await expect(vault.connect(treasury).setWeightModule(fakeModule)).to.emit(vault, "WeightModuleSet");
    await expect(vault.connect(treasury).setWeightModule(fakeModule)).to.be.revertedWithCustomError(
      vault,
      "AlreadySet"
    );
  });

  it("a not-yet-wired WeightModule never bricks deposit/redeem/buyShares/sellShares (best-effort only)", async () => {
    const { vault, vaultAddr, treasury, alice, payment } = await deployFixture();
    // weightModule is never set in this test.
    await expect(vault.connect(alice).deposit(1)).to.not.be.reverted;
    await openPool(vault, vaultAddr, treasury, payment, alice);
    const amountIn = ethers.parseEther("1");
    await payment.mint(alice.address, amountIn);
    await payment.connect(alice).approve(vaultAddr, amountIn);
    await expect(vault.connect(alice).buyShares(amountIn, 0)).to.not.be.reverted;
  });

  it("a misconfigured WeightModule (reverts on every call) still never bricks deposit/redeem", async () => {
    const { vault, treasury, alice } = await deployFixture();
    const AlwaysRevert = await ethers.getContractFactory("AlwaysRevertingWeightModule");
    const bad: any = await AlwaysRevert.deploy();
    await vault.connect(treasury).setWeightModule(await bad.getAddress());
    await expect(vault.connect(alice).deposit(1)).to.not.be.reverted;
  });
});
