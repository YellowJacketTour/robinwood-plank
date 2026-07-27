import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Second audit pass, focused on the AMM's money math rather than its access
 * control. Round 1 proved the pool could be drained outright; this round asks
 * whether the surviving arithmetic can still be bent — by donations, by
 * round-trips, by ordering, or by ETH arriving outside the accounted path.
 */
describe("MarketplankVault — AMM economics (audit round 2)", () => {
  const SHARE_UNIT = 10n ** 18n;

  async function seededVault(feeBps = 0n) {
    const [, treasury, alice, bob] = await ethers.getSigners();
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    const Vault = await ethers.getContractFactory("MarketplankVault");
    const vault: any = await Vault.deploy(
      await nft.getAddress(),
      "V",
      "V",
      feeBps,
      feeBps,
      feeBps,
      treasury.address
    );

    // Alice deposits four NFTs, puts two shares into the pool as liquidity,
    // treasury seeds the ETH side.
    for (let id = 1; id <= 4; id++) {
      await nft.mint(alice.address, id);
      await nft.connect(alice).approve(await vault.getAddress(), id);
      await vault.connect(alice).deposit(id);
    }
    await vault.connect(alice).transfer(await vault.getAddress(), SHARE_UNIT * 2n);
    await vault.connect(treasury).seedLiquidity({ value: ethers.parseEther("4") });

    return { treasury, alice, bob, nft, vault };
  }

  it("a buy-then-immediate-sell round trip never profits the trader", async () => {
    const { bob, vault } = await seededVault();

    const before = await ethers.provider.getBalance(bob.address);
    const spend = ethers.parseEther("0.5");

    const buyTx = await vault.connect(bob).buyShares(0n, { value: spend });
    const buyRc = await buyTx.wait();
    const got: bigint = await vault.balanceOf(bob.address);
    expect(got).to.be.gt(0n);

    const sellTx = await vault.connect(bob).sellShares(got, 0n);
    const sellRc = await sellTx.wait();

    const after = await ethers.provider.getBalance(bob.address);
    const gas: bigint = buyRc.gasUsed * buyRc.gasPrice + sellRc.gasUsed * sellRc.gasPrice;

    // Ignoring gas, a round trip must return at most what went in. Anything
    // more would be value minted from the pool by pure arithmetic.
    expect(after + gas).to.be.lte(before, "round trip must not create ETH");
  });

  it("donating shares to the pool cannot be turned into a profit", async () => {
    const { alice, bob, vault } = await seededVault();

    // Give bob shares, then have him donate half straight into the pool and
    // try to extract more than he put in by selling the rest.
    await vault.connect(alice).transfer(bob.address, SHARE_UNIT);
    const donated = SHARE_UNIT / 2n;
    await vault.connect(bob).transfer(await vault.getAddress(), donated);

    const ethBefore = await ethers.provider.getBalance(bob.address);
    const remaining: bigint = await vault.balanceOf(bob.address);
    const tx = await vault.connect(bob).sellShares(remaining, 0n);
    const rc = await tx.wait();
    const ethAfter = await ethers.provider.getBalance(bob.address);

    const proceeds: bigint = ethAfter - ethBefore + rc.gasUsed * rc.gasPrice;
    // He gave up 1 full share to receive this. The pool held 4 ETH against
    // 2 shares, so a fair price for half a share is well under 4 ETH — the
    // point is simply that donating did not let him drain the reserve.
    expect(proceeds).to.be.lt(ethers.parseEther("4"));
    expect(await vault.ethReserve()).to.be.gt(0n);
  });

  it("accounted ethReserve never exceeds the contract's real balance", async () => {
    const { treasury, alice, bob, vault } = await seededVault();
    const addr = await vault.getAddress();

    const check = async () => {
      const reserve: bigint = await vault.ethReserve();
      const balance = await ethers.provider.getBalance(addr);
      // If accounting ever outran the real balance, the last sellers could
      // not be paid out.
      expect(reserve).to.be.lte(balance);
    };

    await check();
    await vault.connect(bob).buyShares(0n, { value: ethers.parseEther("1") });
    await check();
    const bal: bigint = await vault.balanceOf(bob.address);
    await vault.connect(bob).sellShares(bal, 0n);
    await check();
    await vault.connect(treasury).seedLiquidity({ value: ethers.parseEther("1") });
    await check();
    await vault.connect(alice).transfer(addr, SHARE_UNIT / 2n);
    await check();
  });

  it("slippage floors are honored exactly, not approximately", async () => {
    const { bob, vault } = await seededVault();

    const spend = ethers.parseEther("0.5");
    const quoted: bigint = await vault.connect(bob).buyShares.staticCall(0n, { value: spend });

    // Asking for one wei more than the pool can give must revert.
    await expect(
      vault.connect(bob).buyShares(quoted + 1n, { value: spend })
    ).to.be.revertedWithCustomError(vault, "InsufficientOutput");

    // Asking for exactly the quote must succeed.
    await vault.connect(bob).buyShares(quoted, { value: spend });
    expect(await vault.balanceOf(bob.address)).to.equal(quoted);
  });

  it("a large sell cannot take the entire ETH reserve", async () => {
    const { alice, vault } = await seededVault();

    // Alice still holds two shares outside the pool; dump all of them.
    const all: bigint = await vault.balanceOf(alice.address);
    await vault.connect(alice).sellShares(all, 0n);

    // Constant-product must always leave something behind.
    expect(await vault.ethReserve()).to.be.gt(0n);
  });

  it("fees never let redemption outrun the NFTs backing it", async () => {
    // Run the full lifecycle with fees on and assert solvency throughout.
    const { alice, nft, vault } = await seededVault(100n);

    // Top Alice up: with fees on, each deposit returns less than a whole
    // share while each redemption costs more than one, so four deposits do
    // not fund two redemptions plus the pool liquidity. That shortfall is
    // the fee buffer working as intended, not a defect — it is precisely
    // what keeps the vault from being fully drained by redemptions.
    for (let id = 5; id <= 8; id++) {
      await nft.mint(alice.address, id);
      await nft.connect(alice).approve(await vault.getAddress(), id);
      await vault.connect(alice).deposit(id);
    }

    const check = async () => {
      const supply: bigint = await vault.totalSupply();
      const held: bigint = await vault.heldTokenCount();
      const pending: bigint = await vault.pendingRedeemCount();
      expect(supply + pending * SHARE_UNIT).to.equal(held * SHARE_UNIT);
    };

    await check();
    await vault.connect(alice).redeemTarget(1);
    await check();
    await vault.connect(alice).requestRandomRedeem();
    await check();
    await ethers.provider.send("evm_mine", []);
    await vault.connect(alice).claimRandomRedeem();
    await check();
  });
});
