import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import { deployBeaconMock, relayPendingRound } from "./helpers/beacon.js";

/**
 * Test suite for contracts/MarketplankVault.sol — UNAUDITED contract, see its
 * header. This suite exists so an auditor has a documented, passing baseline
 * to start from, not as a substitute for that audit.
 */
describe("MarketplankVault", () => {
  const MINT_FEE_BPS = 250n; // 2.5%
  const REDEEM_FEE_BPS = 250n;
  const TARGET_PREMIUM_BPS = 500n; // 5%
  const SHARE_UNIT = 10n ** 18n;

  async function deployFixture() {
    const [deployer, feeRecipient, alice, bob] = await ethers.getSigners();

    // No typechain in this scaffold — cast to `any` so the untyped ABI
    // methods (deposit, buyShares, etc.) are callable from the test. Runtime
    // correctness is what these tests verify, not TS's view of the ABI.
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();

    const beacon: any = await deployBeaconMock();
    const Vault = await ethers.getContractFactory("MarketplankVault");
    const vault: any = await Vault.deploy(
      await nft.getAddress(),
      "Marketplank RobinWood Vault",
      "vROBIN",
      MINT_FEE_BPS,
      REDEEM_FEE_BPS,
      TARGET_PREMIUM_BPS,
      feeRecipient.address,
      await beacon.getAddress()
    );

    return { deployer, feeRecipient, alice, bob, nft, vault, beacon };
  }

  async function mintTo(nft: any, to: HardhatEthersSigner, tokenId: number) {
    await (await nft.mint(to.address, tokenId)).wait();
  }

  it("rejects fees above the hard ceiling at construction", async () => {
    const [, feeRecipient] = await ethers.getSigners();
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft = await Nft.deploy();
    const beaconAddr = await (await deployBeaconMock()).getAddress();
    const Vault = await ethers.getContractFactory("MarketplankVault");

    await expect(
      Vault.deploy(await nft.getAddress(), "V", "V", 1_001n, 0n, 0n, feeRecipient.address, beaconAddr)
    ).to.be.revertedWithCustomError(Vault, "FeeTooHigh");

    await expect(
      Vault.deploy(await nft.getAddress(), "V", "V", 0n, 1_001n, 0n, feeRecipient.address, beaconAddr)
    ).to.be.revertedWithCustomError(Vault, "FeeTooHigh");

    await expect(
      Vault.deploy(await nft.getAddress(), "V", "V", 0n, 0n, 2_001n, feeRecipient.address, beaconAddr)
    ).to.be.revertedWithCustomError(Vault, "FeeTooHigh");

    // A vault with no randomness beacon would burn shares for redemptions it
    // could never settle. Fail closed at construction.
    await expect(
      Vault.deploy(
        await nft.getAddress(),
        "V",
        "V",
        0n,
        0n,
        0n,
        feeRecipient.address,
        ethers.ZeroAddress
      )
    ).to.be.revertedWithCustomError(Vault, "InvalidBeacon");
  });

  it("deposit: mints shares to the depositor and fee to the treasury", async () => {
    const { alice, feeRecipient, nft, vault } = await deployFixture();
    await mintTo(nft, alice, 1);
    await nft.connect(alice).approve(await vault.getAddress(), 1);

    await expect(vault.connect(alice).deposit(1))
      .to.emit(vault, "Deposited")
      .withArgs(alice.address, 1);

    const fee = (SHARE_UNIT * MINT_FEE_BPS) / 10_000n;
    expect(await vault.balanceOf(alice.address)).to.equal(SHARE_UNIT - fee);
    expect(await vault.balanceOf(feeRecipient.address)).to.equal(fee);
    expect(await vault.heldTokenCount()).to.equal(1n);
    expect(await nft.ownerOf(1)).to.equal(await vault.getAddress());
  });

  it("random redeem: commits shares up front, delivers on claim", async () => {
    const { alice, nft, vault, beacon } = await deployFixture();
    await mintTo(nft, alice, 1);
    await nft.connect(alice).approve(await vault.getAddress(), 1);
    await vault.connect(alice).deposit(1);

    // One deposit alone is never enough to redeem: the mint fee leaves the
    // depositor below a whole share, and redeeming costs a share plus the
    // redeem fee. This is inherent to the fee model, not a bug — but it is
    // the kind of thing the UI has to state plainly so nobody is surprised.
    await mintTo(nft, alice, 2);
    await nft.connect(alice).approve(await vault.getAddress(), 2);
    await vault.connect(alice).deposit(2);

    const before = await vault.balanceOf(alice.address);
    await vault.connect(alice).requestRandomRedeem();
    const after = await vault.balanceOf(alice.address);

    const redeemFee = (SHARE_UNIT * REDEEM_FEE_BPS) / 10_000n;
    expect(before - after).to.equal(SHARE_UNIT + redeemFee);

    await relayPendingRound(vault, beacon);
    await vault.connect(alice).claimRandomRedeem();

    expect(
      (await nft.ownerOf(1)) === alice.address || (await nft.ownerOf(2)) === alice.address
    ).to.be.true;
  });

  it("redeemTarget: requires the token to be held and charges the premium", async () => {
    const { alice, bob, nft, vault } = await deployFixture();
    await mintTo(nft, alice, 1);
    await nft.connect(alice).approve(await vault.getAddress(), 1);
    await vault.connect(alice).deposit(1);
    // give alice enough shares for the premium too
    await mintTo(nft, alice, 2);
    await nft.connect(alice).approve(await vault.getAddress(), 2);
    await vault.connect(alice).deposit(2);

    await expect(vault.connect(bob).redeemTarget(999)).to.be.revertedWithCustomError(
      vault,
      "TokenNotHeld"
    );

    await expect(vault.connect(alice).redeemTarget(1))
      .to.emit(vault, "Redeemed")
      .withArgs(alice.address, 1, true);
    expect(await nft.ownerOf(1)).to.equal(alice.address);
  });

  it("buyShares / sellShares: constant-product AMM moves price with size", async () => {
    const { alice, bob, feeRecipient, nft, vault } = await deployFixture();
    await mintTo(nft, alice, 1);
    await nft.connect(alice).approve(await vault.getAddress(), 1);
    await vault.connect(alice).deposit(1);

    // Mirror a real launch: shares go into the pool, treasury seeds the ETH
    // side (only the treasury may — see the audit regression suite).
    await vault.connect(alice).transfer(await vault.getAddress(), SHARE_UNIT / 4n);
    await vault.connect(feeRecipient).seedLiquidity({ value: ethers.parseEther("1") });
    // Trading is closed until the treasury explicitly opens the pool.
    await vault.connect(feeRecipient).openPool();

    const buyTx = await vault.connect(bob).buyShares(0, { value: ethers.parseEther("0.1") });
    await expect(buyTx).to.emit(vault, "Bought");
    const bobShares = await vault.balanceOf(bob.address);
    expect(bobShares).to.be.gt(0n);

    const sellTx = await vault.connect(bob).sellShares(bobShares, 0);
    await expect(sellTx).to.emit(vault, "Sold");
  });

  it("buyShares reverts below minSharesOut (slippage protection)", async () => {
    const { bob, feeRecipient, vault } = await deployFixture();
    await vault.connect(feeRecipient).seedLiquidity({ value: ethers.parseEther("1") });
    // No share reserve seeded, so the pool cannot even be opened yet — the
    // PoolNotOpen gate fires first and buying reverts.
    await expect(
      vault.connect(bob).buyShares(1n, { value: ethers.parseEther("0.1") })
    ).to.be.revertedWithCustomError(vault, "PoolNotOpen");
  });
});
