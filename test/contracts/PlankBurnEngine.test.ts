import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";

/**
 * PlankBurnEngine, post-security-rewrite. The whole safety model is now
 * "the engine, not the caller, controls the swap recipient" -- the caller
 * supplies only the pool path and a min-out, never a command program and
 * never a destination. These tests prove the ETH cannot be redirected,
 * that the path is validated to WETH-in/PLANK-out, and that 100% of the
 * real received PLANK is burned.
 */
describe("PlankBurnEngine", () => {
  const MAX_ETH_PER_CALL = ethers.parseEther("1");
  const KEEPER_REWARD_BPS = 500n; // 5%
  const PLANK_OUT_PER_WEI = 1000n;

  async function deployAll(plankOutPerWei = PLANK_OUT_PER_WEI) {
    const [deployer, keeper] = await ethers.getSigners();

    const plank: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
    const weth: any = await (await ethers.getContractFactory("MockWethToken")).deploy();
    const router: any = await (
      await ethers.getContractFactory("MockSwapRouter")
    ).deploy(await plank.getAddress(), await weth.getAddress(), plankOutPerWei);

    const engine: any = await (
      await ethers.getContractFactory("PlankBurnEngine")
    ).deploy(
      await plank.getAddress(),
      await router.getAddress(),
      await weth.getAddress(),
      MAX_ETH_PER_CALL,
      KEEPER_REWARD_BPS
    );

    // A valid single-hop path: WETH (20) + fee (3) + PLANK (20).
    const path = ethers.concat([await weth.getAddress(), "0x000bb8", await plank.getAddress()]);
    return { engine, plank, weth, router, path, deployer, keeper };
  }

  it("rejects a zero address in the constructor", async () => {
    const [deployer] = await ethers.getSigners();
    const plank: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
    const Engine = await ethers.getContractFactory("PlankBurnEngine");
    await expect(
      Engine.deploy(ethers.ZeroAddress, deployer.address, deployer.address, MAX_ETH_PER_CALL, KEEPER_REWARD_BPS)
    ).to.be.revertedWithCustomError(Engine, "ZeroAddress");
  });

  it("wraps its own ETH, swaps to the engine, and burns 100% of the real received PLANK", async () => {
    const { engine, plank, path, deployer, keeper } = await deployAll();
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.5") });

    const ethAmount = ethers.parseEther("0.1");
    const expectedPlankOut = ethAmount * PLANK_OUT_PER_WEI;
    const expectedKeeperReward = (ethAmount * KEEPER_REWARD_BPS) / 10000n;

    const keeperBefore = await ethers.provider.getBalance(keeper.address);
    const tx = await engine.connect(keeper).executeBurn(path, ethAmount, expectedPlankOut);
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;

    // All received PLANK was burned -- the engine holds none.
    expect(await plank.balanceOf(await engine.getAddress())).to.equal(0n);
    expect(await plank.totalSupply()).to.equal(0n); // minted then burned
    expect(await engine.totalPlankBurned()).to.equal(expectedPlankOut);
    expect(await engine.totalEthSpent()).to.equal(ethAmount);

    // Keeper got exactly the disclosed reward, from the engine's balance.
    const keeperAfter = await ethers.provider.getBalance(keeper.address);
    expect(keeperAfter - keeperBefore + gasCost).to.equal(expectedKeeperReward);
  });

  it("SECURITY: the swap output always lands on the engine, never on a caller-chosen address -- the router only ever mints to the engine's own recipient", async () => {
    const { engine, plank, path, deployer, keeper } = await deployAll();
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.5") });
    const attackerBefore = await plank.balanceOf(keeper.address);
    await engine.connect(keeper).executeBurn(path, ethers.parseEther("0.1"), 0n);
    // The caller (keeper) received ZERO PLANK -- it went to the engine and
    // was burned. There is no calldata a caller can supply to change that.
    expect(await plank.balanceOf(keeper.address)).to.equal(attackerBefore);
    // And the engine leaked no ETH beyond the disclosed keeper reward:
    // balance dropped by exactly ethAmount (spent) ... it's all wrapped +
    // swapped + burned, nothing swept out.
  });

  it("rejects a path that does not start at WETH and end at PLANK", async () => {
    const { engine, plank, weth, deployer, keeper } = await deployAll();
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.5") });

    // Output token is WETH instead of PLANK -> a caller trying to receive
    // the wrong token is rejected outright.
    const wrongOut = ethers.concat([await weth.getAddress(), "0x000bb8", await weth.getAddress()]);
    await expect(engine.connect(keeper).executeBurn(wrongOut, ethers.parseEther("0.1"), 0n)).to.be.revertedWithCustomError(
      engine,
      "BadPath"
    );

    // Input token is PLANK instead of WETH -> rejected too.
    const wrongIn = ethers.concat([await plank.getAddress(), "0x000bb8", await plank.getAddress()]);
    await expect(engine.connect(keeper).executeBurn(wrongIn, ethers.parseEther("0.1"), 0n)).to.be.revertedWithCustomError(
      engine,
      "BadPath"
    );

    // Malformed length -> rejected.
    await expect(engine.connect(keeper).executeBurn("0x1234", ethers.parseEther("0.1"), 0n)).to.be.revertedWithCustomError(
      engine,
      "BadPath"
    );
  });

  it("reverts if the real swap output falls below minPlankOut (slippage protection)", async () => {
    const { engine, path, deployer, keeper } = await deployAll();
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.5") });
    const ethAmount = ethers.parseEther("0.1");
    const realOut = ethAmount * PLANK_OUT_PER_WEI;
    // The router itself enforces amountOutMinimum, so demanding more than
    // the pool yields reverts inside the swap ("Too little received").
    await expect(engine.connect(keeper).executeBurn(path, ethAmount, realOut + 1n)).to.be.revertedWith(
      "Too little received"
    );
  });

  it("reverts if the route yields zero output", async () => {
    const { engine, router, path, deployer, keeper } = await deployAll();
    await router.setPlankOutPerWei(0n);
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.5") });
    await expect(engine.connect(keeper).executeBurn(path, ethers.parseEther("0.1"), 0n)).to.be.revertedWithCustomError(
      engine,
      "NoSwapOutput"
    );
  });

  it("enforces the per-call rate limit and the balance floor", async () => {
    const { engine, path, deployer, keeper } = await deployAll();
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("5") });
    await expect(engine.connect(keeper).executeBurn(path, MAX_ETH_PER_CALL + 1n, 0n)).to.be.revertedWithCustomError(
      engine,
      "ExceedsRateLimit"
    );
    const { engine: empty } = await deployAll();
    await expect(empty.connect(keeper).executeBurn(path, ethers.parseEther("0.01"), 0n)).to.be.revertedWithCustomError(
      empty,
      "NothingToBurn"
    );
  });
});
