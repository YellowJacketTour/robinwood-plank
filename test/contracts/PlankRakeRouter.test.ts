import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { BPS, assertConserved, bet, deployCasino, findRandomness, settleCurrent } from "./helpers/casino.js";
import { ratifiedRakeSplit } from "../../lib/casino/economics.js";

/**
 * PlankRakeRouter -- the ratified 25/69/6 of NET rake (revised 2026-09-05
 * from 40/40/20, SPEC-monotonic-vault-positive-sum §4) with escrowed-pull
 * legs, plus C.8 R-1 (accounting) and R-2 (burn floor) end to end through the
 * real PlankBurnEngine.
 */
describe("PlankRakeRouter -- 25/69/6 of net, escrowed pull, R-1/R-2", () => {
  const E = (x: string) => ethers.parseEther(x);

  it("splits exactly like lib ratifiedRakeSplit and subdivides the community leg 65/35; only the crash may route", async () => {
    const env = await deployCasino({ crash: { keeperRewardBps: 250n } });
    await env.crash.fundVault({ value: E("1") });
    await expect(env.rakeRouter.routeRake({ value: 1n })).to.be.revertedWithCustomError(env.rakeRouter, "UnauthorizedSource");
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    await bet(env, env.alice, "4", 15_000n);
    await bet(env, env.bob, "6", 20_000n);
    const rnd = await findRandomness(env, id, BigInt(r0.targetDrandRound), (c) => c >= 20_000n);
    await settleCurrent(env, rnd, env.keeper);
    const pool = E("10");
    const gross = pool - (pool * (BPS - 450n)) / BPS;
    const split = ratifiedRakeSplit(gross, 250n);
    expect(await env.crash.owed(env.keeper.address)).to.equal(split.keeper);
    await expect(env.crash.flushRake()).to.emit(env.rakeRouter, "RakeRouted");
    expect(await env.rakeRouter.totalNetRake()).to.equal(split.netRake);
    expect(await env.rakeRouter.burnEscrow()).to.equal(split.burn);
    expect(await env.rakeRouter.founderEscrow()).to.equal(split.founders);
    const lotteryLeg = (split.community * 6500n) / BPS;
    expect(await env.rakeRouter.lotteryEscrow()).to.equal(lotteryLeg);
    expect(await env.rakeRouter.vaultEscrow()).to.equal(split.community - lotteryLeg);
    expect(split.burn + split.community + split.founders).to.equal(split.netRake);
    expect(await env.rakeRouter.rulesHash()).to.equal(
      ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256", "uint256", "uint256"], [ethers.id("plank.rake-router.v1"), 2500n, 6900n, 6500n])),
    );
    await assertConserved(env, expect);
  });

  it("R-1: accountedBalance() <= balance always; each claim reduces both by the same amount and lands on its fixed sink", async () => {
    const env = await deployCasino();
    await env.crash.fundVault({ value: E("1") });
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    await bet(env, env.alice, "5", 15_000n);
    await bet(env, env.bob, "5", 20_000n);
    await settleCurrent(env, await findRandomness(env, id, BigInt(r0.targetDrandRound), (c) => c >= 20_000n));
    await env.crash.flushRake();
    const routerAddr = await env.rakeRouter.getAddress();
    const check = async () => {
      const bal = await ethers.provider.getBalance(routerAddr);
      const acc: bigint = await env.rakeRouter.accountedBalance();
      expect(acc <= bal).to.equal(true);
      return { bal, acc };
    };
    let { bal, acc } = await check();
    expect(bal).to.equal(acc);
    // burn leg -> engine
    const burn: bigint = await env.rakeRouter.burnEscrow();
    await env.rakeRouter.claimBurn();
    ({ bal: bal, acc: acc } = await check());
    expect(await ethers.provider.getBalance(await env.burnEngine.getAddress())).to.equal(burn);
    // lottery leg -> lottery.fund (fee applied there)
    const lot: bigint = await env.rakeRouter.lotteryEscrow();
    await env.rakeRouter.claimLottery();
    expect(await env.lottery.totalFunded()).to.equal(lot);
    expect(await env.lottery.pool()).to.equal(lot - (lot * 1000n) / BPS);
    // vault leg -> crash.fundCommunityReturn
    const vault: bigint = await env.rakeRouter.vaultEscrow();
    const principalBefore: bigint = await env.crash.protectedPrincipal();
    await env.rakeRouter.claimVault();
    expect((await env.crash.protectedPrincipal()) - principalBefore).to.equal((vault * 5000n) / BPS);
    // founders -> treasury EOA
    const founders: bigint = await env.rakeRouter.founderEscrow();
    const tBefore = await ethers.provider.getBalance(env.treasury.address);
    await env.rakeRouter.connect(env.alice).claimFounders();
    expect((await ethers.provider.getBalance(env.treasury.address)) - tBefore).to.equal(founders);
    ({ bal, acc } = await check());
    expect(bal).to.equal(0n);
    expect(acc).to.equal(0n);
    await expect(env.rakeRouter.claimBurn()).to.be.revertedWithCustomError(env.rakeRouter, "NothingToClaim");
    expect(await env.rakeRouter.unclassifiedSurplus()).to.equal(0n);
    await assertConserved(env, expect);
  });

  it("R-2: the burn leg executes only at or above the TWAP floor -- burned == received, spender is the engine", async () => {
    const env = await deployCasino();
    await env.crash.fundVault({ value: E("1") });
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    await bet(env, env.alice, "10", 15_000n);
    await bet(env, env.bob, "10", 20_000n);
    await settleCurrent(env, await findRandomness(env, id, BigInt(r0.targetDrandRound), (c) => c >= 20_000n));
    await env.crash.flushRake();
    await env.rakeRouter.claimBurn();
    const ethToBurn = await ethers.provider.getBalance(await env.burnEngine.getAddress());
    // Prime the TWAP (one full window), then burn.
    await networkHelpers.time.increase(61);
    await env.oracle.update();
    const fair: bigint = await env.oracle.consult(await env.weth.getAddress(), ethToBurn);
    const minOut = (fair * (BPS - 500n)) / BPS;
    const before: bigint = await env.plank.totalSupply();
    await env.burnEngine.connect(env.keeper).executeBurn(ethToBurn);
    const burned: bigint = await env.burnEngine.totalPlankBurned();
    expect(burned >= minOut, "output >= TWAP*(1-slip)").to.equal(true);
    expect(burned).to.equal(ethToBurn * 1000n); // the mock fills at 1000 PLANK/wei
    expect(await env.plank.totalSupply()).to.equal(before); // mock mints then engine burns: net unchanged
    expect(await env.burnEngine.totalEthSpent()).to.equal(ethToBurn);
    expect(await ethers.provider.getBalance(await env.burnEngine.getAddress())).to.equal(0n);
  });
});
