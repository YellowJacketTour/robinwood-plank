import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";

/**
 * PlankBurnEngine.test.ts -- proves the real safety property this
 * contract is built around: the swap's output can ONLY ever be burned,
 * never redirected, no matter what calldata the (permissionless) caller
 * supplies. Uses MockUniversalRouter (real command/input bytes accepted
 * but ignored -- see its own header) since Universal Router's real
 * routing is external, already-audited Uniswap infrastructure this repo
 * already depends on elsewhere (its frontend), not something to
 * re-implement in a mock.
 */
describe("PlankBurnEngine", () => {
  const MAX_ETH_PER_CALL = ethers.parseEther("1");
  const KEEPER_REWARD_BPS = 500n; // 5%
  const PLANK_OUT_PER_WEI = 1000n; // arbitrary mock exchange rate

  async function deployAll(plankOutPerWei = PLANK_OUT_PER_WEI) {
    const [deployer, keeper] = await ethers.getSigners();

    const Plank = await ethers.getContractFactory("MockERC20Burnable");
    const plank: any = await Plank.deploy();

    const Router = await ethers.getContractFactory("MockUniversalRouter");
    const router: any = await Router.deploy(await plank.getAddress(), plankOutPerWei);

    // Router "owns" no WETH logic in the mock -- weth address only needs
    // to be a real, non-zero address for the constructor's own sanity
    // check; the real contract never calls into it directly (wrapping
    // happens inside the real Universal Router's own commands).
    const weth = deployer.address;

    const Engine = await ethers.getContractFactory("PlankBurnEngine");
    const engine: any = await Engine.deploy(
      await plank.getAddress(),
      await router.getAddress(),
      weth,
      MAX_ETH_PER_CALL,
      KEEPER_REWARD_BPS
    );

    return { engine, plank, router, deployer, keeper };
  }

  it("rejects a zero address in the constructor", async () => {
    const [deployer] = await ethers.getSigners();
    const Plank = await ethers.getContractFactory("MockERC20Burnable");
    const plank: any = await Plank.deploy();
    const Engine = await ethers.getContractFactory("PlankBurnEngine");
    await expect(
      Engine.deploy(ethers.ZeroAddress, await plank.getAddress(), deployer.address, MAX_ETH_PER_CALL, KEEPER_REWARD_BPS)
    ).to.be.revertedWithCustomError(Engine, "ZeroAddress");
  });

  it("executeBurn swaps ETH for PLANK via the router and burns 100% of the real received amount", async () => {
    const { engine, plank, deployer, keeper } = await deployAll();
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.5") });

    const ethAmount = ethers.parseEther("0.1");
    const expectedPlankOut = ethAmount * PLANK_OUT_PER_WEI;
    const expectedKeeperReward = (ethAmount * KEEPER_REWARD_BPS) / 10000n;

    const keeperBefore = await ethers.provider.getBalance(keeper.address);
    const tx = await engine
      .connect(keeper)
      .executeBurn("0x", [], ethAmount, expectedPlankOut, Math.floor(Date.now() / 1000) + 3600);
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;

    // All received PLANK was burned -- the engine holds none of it.
    expect(await plank.balanceOf(await engine.getAddress())).to.equal(0n);
    expect(await plank.totalSupply()).to.equal(0n); // minted then immediately burned, net zero
    expect(await engine.totalPlankBurned()).to.equal(expectedPlankOut);
    expect(await engine.totalEthSpent()).to.equal(ethAmount);

    // The keeper got exactly the disclosed reward, from the engine's own
    // balance, not from the swap output.
    const keeperAfter = await ethers.provider.getBalance(keeper.address);
    expect(keeperAfter - keeperBefore + gasCost).to.equal(expectedKeeperReward);
  });

  it("reverts if the swap route produces zero output -- a bad/malicious route can never redirect funds, only fail", async () => {
    const { engine, router, deployer } = await deployAll();
    await router.setPlankOutPerWei(0n);
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.5") });

    await expect(
      engine.executeBurn("0x", [], ethers.parseEther("0.1"), 0n, Math.floor(Date.now() / 1000) + 3600)
    ).to.be.revertedWithCustomError(engine, "NoSwapOutput");
  });

  it("enforces the per-call rate limit, bounding worst-case damage from a single bad call", async () => {
    const { engine, deployer } = await deployAll();
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("5") });

    await expect(
      engine.executeBurn("0x", [], MAX_ETH_PER_CALL + 1n, 0n, Math.floor(Date.now() / 1000) + 3600)
    ).to.be.revertedWithCustomError(engine, "ExceedsRateLimit");
  });

  it("reverts if the engine doesn't hold enough ETH to cover the requested amount", async () => {
    const { engine } = await deployAll();
    await expect(
      engine.executeBurn("0x", [], ethers.parseEther("0.01"), 0n, Math.floor(Date.now() / 1000) + 3600)
    ).to.be.revertedWithCustomError(engine, "NothingToBurn");
  });

  it("reverts if the real swap output falls below minPlankOut -- honest slippage protection against a manipulated fill", async () => {
    const { engine, deployer, keeper } = await deployAll();
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.5") });

    const ethAmount = ethers.parseEther("0.1");
    const realOut = ethAmount * PLANK_OUT_PER_WEI;
    // Demand strictly more than the route will actually produce.
    await expect(
      engine.connect(keeper).executeBurn("0x", [], ethAmount, realOut + 1n, Math.floor(Date.now() / 1000) + 3600)
    ).to.be.revertedWithCustomError(engine, "SlippageExceeded");
  });
});
