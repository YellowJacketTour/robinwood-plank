import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";

/**
 * PlankBurnEngine, Tier-2 design. The caller supplies ONLY the ETH amount;
 * the engine fixes the recipient (itself), the route ([WETH,PLANK]), and
 * the minimum output (a TWAP-derived fair floor). These tests prove the
 * two attacks are both closed on-chain:
 *   - REDIRECTION: output always lands on the engine and is burned.
 *   - BAD PRICE: an execution below the oracle's fair floor is REJECTED,
 *     even though the caller would love to accept it.
 */
describe("PlankBurnEngine (Tier-2, oracle-floored)", () => {
  const WINDOW = 1800n;
  const MAX_STALE = 3600n;
  const R_WETH = ethers.parseEther("100");
  const R_PLANK = ethers.parseEther("100000"); // 1000 PLANK per WETH
  const FAIR_RATE = 1000n; // plankOutPerWei that matches the pool's fair price
  const MAX_ETH_PER_CALL = ethers.parseEther("1");
  const KEEPER_REWARD_BPS = 500n; // 5%
  const MAX_SLIPPAGE_BPS = 500n; // 5%

  async function deployAll(routerRate = FAIR_RATE) {
    const [deployer, keeper] = await ethers.getSigners();

    const weth: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
    const plank: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
    const pair: any = await (
      await ethers.getContractFactory("MockV2Pair")
    ).deploy(await weth.getAddress(), await plank.getAddress(), R_WETH, R_PLANK);
    const oracle: any = await (
      await ethers.getContractFactory("PlankV2TwapOracle")
    ).deploy(await pair.getAddress(), WINDOW, MAX_STALE);
    const router: any = await (
      await ethers.getContractFactory("MockV2Router")
    ).deploy(await plank.getAddress(), routerRate);

    const engine: any = await (
      await ethers.getContractFactory("PlankBurnEngine")
    ).deploy(
      await plank.getAddress(),
      await router.getAddress(),
      await weth.getAddress(),
      await oracle.getAddress(),
      MAX_ETH_PER_CALL,
      KEEPER_REWARD_BPS,
      MAX_SLIPPAGE_BPS
    );
    return { engine, oracle, pair, router, plank, weth, deployer, keeper };
  }

  async function prime(oracle: any) {
    await networkHelpers.time.increase(Number(WINDOW) + 1);
    await oracle.update();
  }

  it("rejects zero addresses and an over-loose slippage in the constructor", async () => {
    const [d] = await ethers.getSigners();
    const Engine = await ethers.getContractFactory("PlankBurnEngine");
    await expect(
      Engine.deploy(ethers.ZeroAddress, d.address, d.address, d.address, 1n, 0n, 100n)
    ).to.be.revertedWithCustomError(Engine, "ZeroAddress");
    await expect(
      Engine.deploy(d.address, d.address, d.address, d.address, 1n, 0n, 2000n)
    ).to.be.revertedWithCustomError(Engine, "BadConfig"); // slippage > 10% ceiling
  });

  it("burns fair-priced PLANK: caller supplies only the amount, output lands on the engine and is destroyed", async () => {
    const { engine, oracle, plank, deployer, keeper } = await deployAll();
    await prime(oracle);
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.5") });

    const ethAmount = ethers.parseEther("0.1");
    const expectedPlank = ethAmount * FAIR_RATE; // 100 PLANK
    const expectedKeeperReward = (ethAmount * KEEPER_REWARD_BPS) / 10000n;

    const keeperBefore = await ethers.provider.getBalance(keeper.address);
    const tx = await engine.connect(keeper).executeBurn(ethAmount);
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;

    expect(await plank.balanceOf(await engine.getAddress())).to.equal(0n); // nothing retained
    expect(await plank.balanceOf(keeper.address)).to.equal(0n); // caller got nothing
    expect(await engine.totalPlankBurned()).to.equal(expectedPlank);
    expect(await engine.totalEthSpent()).to.equal(ethAmount);

    const keeperAfter = await ethers.provider.getBalance(keeper.address);
    expect(keeperAfter - keeperBefore + gasCost).to.equal(expectedKeeperReward);
  });

  it("SECURITY (the whole point): an execution BELOW the TWAP fair floor is rejected -- a rigged/sandwiched price cannot be forced through", async () => {
    // Router is rigged to pay HALF the fair rate (a sandwiched/manipulated
    // execution). The oracle's TWAP still says the fair rate is ~1000, so
    // the engine's floor (fair - 5%) is far above what this execution
    // yields -> the swap is rejected. The caller cannot lower the floor.
    const { engine, oracle, deployer, keeper } = await deployAll(FAIR_RATE / 2n);
    await prime(oracle);
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.5") });

    await expect(engine.connect(keeper).executeBurn(ethers.parseEther("0.1"))).to.be.revertedWith(
      "INSUFFICIENT_OUTPUT_AMOUNT"
    );
    // Nothing was spent or burned -- the community's ETH is untouched.
    expect(await engine.totalEthSpent()).to.equal(0n);
  });

  it("accepts an execution within the allowed slippage band, rejects just outside it", async () => {
    // Just inside: pay 96% of fair (slippage 4% < 5% allowed) -> ok.
    {
      const { engine, oracle, deployer, keeper } = await deployAll((FAIR_RATE * 96n) / 100n);
      await prime(oracle);
      await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.5") });
      await engine.connect(keeper).executeBurn(ethers.parseEther("0.1"));
      expect(await engine.totalEthSpent()).to.equal(ethers.parseEther("0.1"));
    }
    // Just outside: pay 94% of fair (slippage 6% > 5% allowed) -> rejected.
    {
      const { engine, oracle, deployer, keeper } = await deployAll((FAIR_RATE * 94n) / 100n);
      await prime(oracle);
      await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.5") });
      await expect(engine.connect(keeper).executeBurn(ethers.parseEther("0.1"))).to.be.revertedWith(
        "INSUFFICIENT_OUTPUT_AMOUNT"
      );
    }
  });

  it("a spot sandwich right before the burn does NOT lower the floor -- the TWAP is unmoved, so a bad fill still reverts", async () => {
    const { engine, oracle, pair, router, deployer, keeper } = await deployAll(FAIR_RATE);
    await prime(oracle);
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.5") });

    // Attacker front-runs: crash the spot price AND rig the router to match
    // the new (bad) spot. If the engine used spot, this would let the burn
    // through at the rigged rate.
    await pair.setReserves(R_WETH, R_PLANK / 10n); // spot ~100
    await router.setPlankOutPerWei(FAIR_RATE / 10n); // execution ~100

    // But the floor comes from the TWAP (~1000), so the rigged fill is far
    // below it and reverts. The sandwich is neutralized.
    await expect(engine.connect(keeper).executeBurn(ethers.parseEther("0.1"))).to.be.revertedWith(
      "INSUFFICIENT_OUTPUT_AMOUNT"
    );
  });

  it("reverts a burn while the oracle is unprimed or stale (funds wait, never move)", async () => {
    const { engine, oracle, deployer, keeper } = await deployAll();
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("0.5") });
    // Unprimed:
    await expect(engine.connect(keeper).executeBurn(ethers.parseEther("0.1"))).to.be.revertedWithCustomError(
      oracle,
      "NotInitialized"
    );
    // Prime then let it go stale:
    await prime(oracle);
    await networkHelpers.time.increase(Number(MAX_STALE) + 10);
    await expect(engine.connect(keeper).executeBurn(ethers.parseEther("0.1"))).to.be.revertedWithCustomError(
      oracle,
      "StaleOracle"
    );
  });

  it("enforces the per-call rate limit and the balance floor", async () => {
    const { engine, oracle, deployer, keeper } = await deployAll();
    await prime(oracle);
    await deployer.sendTransaction({ to: await engine.getAddress(), value: ethers.parseEther("5") });
    await expect(engine.connect(keeper).executeBurn(MAX_ETH_PER_CALL + 1n)).to.be.revertedWithCustomError(
      engine,
      "ExceedsRateLimit"
    );
    const { engine: empty, oracle: o2 } = await deployAll();
    await prime(o2);
    await expect(empty.connect(keeper).executeBurn(ethers.parseEther("0.01"))).to.be.revertedWithCustomError(
      empty,
      "NothingToBurn"
    );
  });
});
