import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployOpenIndex, TIMELOCK } from "./helpers/index-vault";

/**
 * Proves design doc §7.2's two mandatory fee-routing streams, the
 * treasury-only timelocked mutation, the 8.1% floor, and the
 * push-then-opportunistic-reconcile mechanism against a REAL Diamond
 * (IndexBootstrapFacet.reconcile / syncConstituentBalance).
 *
 * LOCAL HARDHAT ONLY.
 */
describe("CollectionVault fee routing (design doc §7.2)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const MINT_FEE = ethers.parseEther("0.01");
  const REDEEM_FEE = ethers.parseEther("0.01");

  async function deployFixture() {
    const [deployer, sinkStandIn, treasury, alice, attacker] = await ethers.getSigners();
    const payment: any = await (await ethers.getContractFactory("MockIndexToken")).deploy("PAY", "PAY");
    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(sinkStandIn.address, await payment.getAddress(), TIMELOCK);

    const vaultAddr = await factory.deployVault.staticCall(await nft.getAddress(), treasury.address, 810);
    await factory.deployVault(await nft.getAddress(), treasury.address, 810);
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);

    await payment.mint(alice.address, ethers.parseEther("1000"));
    await payment.connect(alice).approve(vaultAddr, ethers.MaxUint256);
    await nft.mint(alice.address, 1);
    await nft.connect(alice).approve(vaultAddr, 1);

    return { deployer, sinkStandIn, treasury, alice, attacker, payment, factory, nft, vault, vaultAddr };
  }

  // ══ Stream A: mint/redeem fee split, floor, treasury-only timelock ══════

  it("Stream A: default 8.1% of the mint fee routes to the sink, remainder accrues to treasury", async () => {
    const { vault, vaultAddr, alice, sinkStandIn, payment } = await deployFixture();
    const sinkBefore = await payment.balanceOf(sinkStandIn.address);

    await expect(vault.connect(alice).deposit(1))
      .to.emit(vault, "Deposited");

    // PR4 (ONESHOT §4.4): XTOKEN_COMPOUND_BPS=2500 is carved out of the fee
    // BEFORE the Stream A split. No InventoryStake is wired in this fixture
    // (pool isn't open either), so `_compoundXToken` falls back to
    // `accruedFees` exactly like pre-PR4 treasury accrual — see
    // "XTOKEN_COMPOUND_BPS" describing-tests further down this file for the
    // case where InventoryStake IS wired and genuinely compounds.
    const XTOKEN_COMPOUND_BPS = 2500n;
    const compoundCut = (MINT_FEE * XTOKEN_COMPOUND_BPS) / 10_000n;
    const residual = MINT_FEE - compoundCut;
    const expectedSink = (residual * 810n) / 10_000n;
    const expectedTreasury = MINT_FEE - expectedSink; // compoundCut fallback + residual's treasury cut

    expect(await payment.balanceOf(sinkStandIn.address)).to.equal(sinkBefore + expectedSink);
    expect(await vault.accruedFees()).to.equal(expectedTreasury);
    expect(await payment.balanceOf(vaultAddr)).to.equal(expectedTreasury); // sink cut already pushed out
  });

  it("Stream A: 8.1% floor cannot be set below by the artist/treasury, even via the timelock", async () => {
    const { vault, treasury } = await deployFixture();
    await expect(vault.connect(treasury).queueMintRedeemSinkBps(809)).to.be.revertedWithCustomError(
      vault,
      "SplitOutOfRange"
    );
  });

  it("Stream A: 8.1% floor cannot be set below by a non-treasury caller either", async () => {
    const { vault, attacker } = await deployFixture();
    await expect(vault.connect(attacker).queueMintRedeemSinkBps(1000)).to.be.revertedWithCustomError(
      vault,
      "NotTreasury"
    );
  });

  it("Stream A: an artist-selected split above the floor is honored, timelocked, and re-checked at execution", async () => {
    const { vault, treasury } = await deployFixture();
    await vault.connect(treasury).queueMintRedeemSinkBps(1500);
    await expect(vault.connect(treasury).executeMintRedeemSinkBps()).to.be.revertedWithCustomError(
      vault,
      "TimelockNotElapsed"
    );
    await time.increase(TIMELOCK + 1);
    await expect(vault.executeMintRedeemSinkBps()).to.emit(vault, "MintRedeemSinkBpsApplied");
    expect(await vault.mintRedeemSinkBps()).to.equal(1500n);
  });

  it("treasury address changes ONLY through queue-then-execute, never immediately, never by a non-treasury caller", async () => {
    const { vault, treasury, attacker, alice } = await deployFixture();

    // Non-treasury cannot even queue.
    await expect(vault.connect(attacker).queueTreasury(attacker.address)).to.be.revertedWithCustomError(
      vault,
      "NotTreasury"
    );

    // No immediate-effect setter exists in the ABI at all.
    const abi = vault.interface.fragments.filter((f: any) => f.type === "function").map((f: any) => f.name);
    expect(abi).to.not.include("setTreasury");

    // Queue, then attempt to execute early — reverts.
    await vault.connect(treasury).queueTreasury(alice.address);
    await expect(vault.executeTreasury()).to.be.revertedWithCustomError(vault, "TimelockNotElapsed");
    expect(await vault.treasury()).to.equal(treasury.address); // unchanged mid-delay

    // After the delay, permissionlessly executable, and applies.
    await time.increase(TIMELOCK + 1);
    await expect(vault.connect(attacker).executeTreasury()).to.emit(vault, "TreasuryApplied");
    expect(await vault.treasury()).to.equal(alice.address);
  });

  // ══ Stream B: swap fee 50/50 split ═══════════════════════════════════════

  it("Stream B: swap-fee split lands exactly 50% in local reserve growth and 50% toward the sink", async () => {
    const { vault, vaultAddr, treasury, alice, sinkStandIn, payment } = await deployFixture();

    // Bootstrap the pool.
    const seedPayment = ethers.parseEther("100");
    const seedShares = ethers.parseEther("100");
    await payment.mint(treasury.address, seedPayment);
    await payment.connect(treasury).approve(vaultAddr, seedPayment);
    await vault.connect(treasury).seedLiquidity(seedPayment);
    // Treasury needs shares to seed — mint one via deposit as alice? Treasury
    // has none; use vault's own accrued... simplest: have alice deposit to
    // mint shares, then alice sends shares to treasury for seeding.
    await vault.connect(alice).deposit(1);
    await vault.connect(alice).transfer(treasury.address, ethers.parseEther("1"));
    await vault.connect(treasury).seedShares(ethers.parseEther("1"));
    await vault.connect(treasury).openPool();

    const sinkBefore = await payment.balanceOf(sinkStandIn.address);
    const reserveBefore = await vault.paymentReserve();

    const amountIn = ethers.parseEther("10");
    await payment.mint(alice.address, amountIn);
    await payment.connect(alice).approve(vaultAddr, amountIn);

    const totalFee = (amountIn * 100n) / 10_000n; // swapFeeBps = 100 = 1%
    const expectedSinkCut = totalFee / 2n; // SWAP_SINK_SPLIT_BPS = 5000 = 50%

    const tx = await vault.connect(alice).buyShares(amountIn, 0);
    const receipt = await tx.wait();
    const boughtEvent = receipt!.logs
      .map((l: any) => {
        try {
          return vault.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "Bought");
    expect(boughtEvent!.args.sinkCut).to.equal(expectedSinkCut);

    expect(await payment.balanceOf(sinkStandIn.address)).to.equal(sinkBefore + expectedSinkCut);

    const reserveAfter = await vault.paymentReserve();
    // netIn = amountIn - sinkCut; reserve grows by netIn (the local half of
    // the fee is embedded in the constant-product pricing, standard AMM
    // fee-compounding — see CollectionVault.sol's buyShares comment).
    const netIn = amountIn - expectedSinkCut;
    expect(reserveAfter - reserveBefore).to.equal(netIn);
  });

  // ══ Push-then-opportunistic-reconcile against the REAL Diamond ══════════

  it("push-then-reconcile: a real Diamond credits ONLY the observed balance delta from a vault's push, never a self-reported amount", async () => {
    const fx = await deployOpenIndex();
    // Use the Diamond's own constituent token as the payment token, so a
    // vault's sink push is directly reconcilable (design doc §7.2's stated
    // requirement: paymentToken should be a token the Diamond already
    // tracks).
    const paymentToken = fx.tokens[0];
    const paymentAddr = fx.addrs[0];

    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(fx.vaultAddr, paymentAddr, TIMELOCK);

    const [, , , , , , , , , treasuryHolder] = await ethers.getSigners();
    const vaultAddr = await factory.deployVault.staticCall(await nft.getAddress(), treasuryHolder.address, 810);
    await factory.deployVault(await nft.getAddress(), treasuryHolder.address, 810);
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);

    await paymentToken.mint(fx.alice.address, MINT_FEE);
    await paymentToken.connect(fx.alice).approve(vaultAddr, MINT_FEE);
    await nft.mint(fx.alice.address, 1);
    await nft.connect(fx.alice).approve(vaultAddr, 1);

    // Reconcile called with nothing pending: credits zero, does nothing harmful.
    const noopCredited = await fx.vault.reconcile.staticCall(paymentAddr);
    expect(noopCredited).to.equal(0n);

    const [before] = await getReserve(fx, paymentAddr);

    await vault.connect(fx.alice).deposit(1); // pushes 810 bps of the post-XTOKEN-carve-out residual to fx.vaultAddr

    // PR4 carve-out: no InventoryStake wired here either, so it's the same
    // fallback-to-accruedFees path as the "Stream A: default 8.1%" test
    // above — only the SINK cut (never routed to accruedFees) is affected by
    // computing off the residual instead of the gross fee.
    const compoundCut = (MINT_FEE * 2500n) / 10_000n;
    const residual = MINT_FEE - compoundCut;
    const expectedSinkCut = (residual * 810n) / 10_000n;
    // The Diamond has NOT reconciled yet — its own accounted reserve is
    // unchanged even though the real ERC-20 balance already grew, which is
    // exactly the "opportunistic" half: nothing forces the credit before
    // someone calls in.
    const [midReserve] = await getReserve(fx, paymentAddr);
    expect(midReserve).to.equal(before);

    // Now the permissionless backstop: anyone may call reconcile.
    const credited = await fx.vault.reconcile.staticCall(paymentAddr);
    expect(credited).to.equal(expectedSinkCut);
    await expect(fx.vault.connect(fx.bob).reconcile(paymentAddr)).to.emit(fx.vault, "ConstituentSynced");

    const [afterReserve] = await getReserve(fx, paymentAddr);
    expect(afterReserve).to.equal(before + expectedSinkCut);

    // Calling reconcile again with nothing new pending credits zero.
    expect(await fx.vault.reconcile.staticCall(paymentAddr)).to.equal(0n);
  });

  async function getReserve(fx: any, token: string): Promise<[bigint]> {
    const r: bigint = await fx.vault.reserveOf(token);
    return [r];
  }
});
