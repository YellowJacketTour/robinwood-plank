/**
 * LOCAL-ONLY unified plank.love casino dev stack. Deploys the WHOLE
 * community-economics system wired together exactly as it is meant to be
 * on mainnet, so the full positive-sum loop can be exercised end-to-end
 * without any real chain, real $PLANK, or real DEX:
 *
 *   PlankCrash ──net rake──▶ PlankRakeRouter ──┬──▶ PlankBurnEngine ──swaps+burns──▶ $PLANK
 *        │                                     ├──▶ PlankLottery (round-only draw, progressive carve)
 *        │                                     ├──▶ PlankCrash.fundCommunityReturn (the Vault floor/buffer)
 *        │                                     └──▶ founder treasury
 *        └──every settled round──▶ PlankLottery.recordRound (the round's seats ARE the tickets)
 *
 * Local stand-ins for the three real external pieces (everything else is
 * the REAL contract, unchanged): DrandBeaconMock, MockERC20Burnable ($PLANK),
 * MockV2Pair/MockV2Router (Uniswap v2).
 *
 * Usage (two terminals):
 *   1)  npx hardhat node
 *   2)  npx hardhat run scripts/local-casino-setup.ts --network localhost
 */
import hardhat from "hardhat";
const { ethers } = await hardhat.network.create();

// TEST_RIG=1 relaxes the whale-dominance cap and the second-participant
// requirement so a single tester can exercise UI/flow.
const TEST_RIG = process.env.TEST_RIG === "1";
const CREDIT = 10n ** 12n; // 1 test credit = 1e-6 ETH

async function main() {
  const [deployer, treasury, alice, bob, carol] = await ethers.getSigners();

  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;

  const BETTING_SECONDS = 20;
  const RAKE_BPS = 450n;
  const MIN_PARTICIPANTS = TEST_RIG ? 1n : 2n;
  const MIN_POOL = ethers.parseEther("0.01");
  const MAX_STAKE_BPS = TEST_RIG ? 10000n : 6000n;
  // The ratified 40/40/20 of net rake is router bytecode; the community leg
  // is subdivided 65% lottery / 35% Vault (DEFAULT_PLAYTEST_POLICY).
  const COMMUNITY_LOTTERY_BPS = 6500n;
  const BURN_KEEPER_REWARD_BPS = 100n;
  const MAX_ETH_PER_BURN = ethers.parseEther("1");
  const MOCK_PLANK_PER_WEI = 1000n;

  const beacon = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
  await beacon.waitForDeployment();
  const plank = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
  await plank.waitForDeployment();
  const weth = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
  await weth.waitForDeployment();
  const pair = await (
    await ethers.getContractFactory("MockV2Pair")
  ).deploy(await weth.getAddress(), await plank.getAddress(), ethers.parseEther("100"), ethers.parseEther("100000"));
  await pair.waitForDeployment();
  const oracle = await (
    await ethers.getContractFactory("PlankV2TwapOracle")
  ).deploy(await pair.getAddress(), 60n, 300n, ethers.parseEther("1"));
  await oracle.waitForDeployment();
  const v2Router = await (await ethers.getContractFactory("MockV2Router")).deploy(await plank.getAddress(), MOCK_PLANK_PER_WEI);
  await v2Router.waitForDeployment();
  const burnEngine = await (
    await ethers.getContractFactory("PlankBurnEngine")
  ).deploy(
    await plank.getAddress(),
    await v2Router.getAddress(),
    await weth.getAddress(),
    await oracle.getAddress(),
    MAX_ETH_PER_BURN,
    BURN_KEEPER_REWARD_BPS,
    500n
  );
  await burnEngine.waitForDeployment();

  // ── 3-way immutable cycle resolved by CREATE-address prediction ─────
  //    lottery[nonce] -> rakeRouter[nonce+1] -> crash[nonce+2] -> bank[nonce+3], consecutive.
  const nonce = await deployer.getNonce();
  const predictedCrash = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 2 });
  const predictedBank = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 3 });

  const lottery = await (
    await ethers.getContractFactory("PlankLottery")
  ).deploy({
    source: predictedCrash,
    founderSink: treasury.address,
    founderFeeBps: 1000n,
    oddsOneIn: TEST_RIG ? 4n : 16n, // local: frequent draws (mainnet D1 = 256)
    mustHitByRounds: TEST_RIG ? 8n : 96n, // 6 x E[R]
    carveMinBps: 1000n,
    carveMaxBps: 3000n,
    carveHalfSaturationWei: 250_000n * CREDIT,
  });
  await lottery.waitForDeployment();

  const rakeRouter = await (
    await ethers.getContractFactory("PlankRakeRouter")
  ).deploy(predictedCrash, await burnEngine.getAddress(), await lottery.getAddress(), predictedCrash, treasury.address, COMMUNITY_LOTTERY_BPS);
  await rakeRouter.waitForDeployment();

  const crash = await (
    await ethers.getContractFactory("PlankCrash")
  ).deploy({
    beacon: await beacon.getAddress(),
    router: await rakeRouter.getAddress(),
    lottery: await lottery.getAddress(),
    bank: predictedBank,
    bettingDurationSeconds: BETTING_SECONDS,
    roundIntervalSeconds: 0,
    rakeBps: RAKE_BPS,
    rakeFloorBps: 250n,
    rakeStepBps: 25n,
    rakeVolumeStepWei: 25_000_000n * CREDIT,
    keeperRewardBps: 0n,
    minParticipants: MIN_PARTICIPANTS,
    minPoolWei: MIN_POOL,
    minStakeWei: 500n * CREDIT,
    maxStakePerWalletBps: MAX_STAKE_BPS,
    maxTargetBps: 1_000_000n, // 100x local ceiling
    maxSeats: 128n,
    crashSeedWei: 10_000n * CREDIT,
    emissionBufferCapWei: 1_000_000n * CREDIT,
    protectedPrincipalBps: 5000n,
    floorBps: 7500n,
    houseCapBps: 1000n,
    seedBootstrapBudgetWei: ethers.parseEther("0.2"),
    refundTimeoutSeconds: 30n * 86400n,
  });
  await crash.waitForDeployment();
  const crashAddr = await crash.getAddress();
  if (crashAddr.toLowerCase() !== predictedCrash.toLowerCase()) {
    throw new Error(`Address prediction failed: predicted ${predictedCrash}, got ${crashAddr}.`);
  }

  const bank = await (await ethers.getContractFactory("PlankBank")).deploy([crashAddr]);
  await bank.waitForDeployment();
  if ((await bank.getAddress()).toLowerCase() !== predictedBank.toLowerCase()) {
    throw new Error(`Bank address prediction failed: predicted ${predictedBank}, got ${await bank.getAddress()}.`);
  }

  // Prime the Vault so the first rounds seed (bounded by the bootstrap budget).
  await (await crash.fundVault({ value: ethers.parseEther("0.2") })).wait();
  await (await plank.mint(alice.address, ethers.parseEther("5000"))).wait();
  await (await plank.mint(bob.address, ethers.parseEther("5000"))).wait();
  await (await plank.mint(carol.address, ethers.parseEther("5000"))).wait();

  const fs = await import("node:fs");
  const manifest = {
    generatedAt: new Date().toISOString(),
    crash: crashAddr,
    bank: await bank.getAddress(),
    plank: await plank.getAddress(),
    lottery: await lottery.getAddress(),
    beacon: await beacon.getAddress(),
    rakeRouter: await rakeRouter.getAddress(),
    oracle: await oracle.getAddress(),
    burnEngine: await burnEngine.getAddress(),
    testRig: TEST_RIG,
  };
  fs.writeFileSync(
    new URL("../public/arcade/deploy-addresses.local.json", import.meta.url),
    JSON.stringify(manifest, null, 2)
  );

  console.log("\n========================================================");
  console.log(" plank.love unified casino -- LOCAL dev stack (chainId 31337)");
  if (TEST_RIG) console.log(" *** TEST_RIG MODE -- whale-cap disabled, solo betting allowed. NOT production settings. ***");
  console.log("========================================================");
  console.log(" PlankCrash      :", crashAddr);
  console.log(" PlankBank       :", await bank.getAddress());
  console.log(" PlankLottery    :", await lottery.getAddress());
  console.log(" PlankRakeRouter :", await rakeRouter.getAddress());
  console.log(" PlankBurnEngine :", await burnEngine.getAddress());
  console.log(" Treasury        :", treasury.address);
  console.log(" DrandBeacon mock:", await beacon.getAddress());
  console.log(" $PLANK (mock)   :", await plank.getAddress());
  console.log("\n Keeper loop each round (all permissionless): lockRound -> beacon.setRandomness -> settleRound");
  console.log(" -> flushRake -> router.claim{Burn,Lottery,Vault,Founders} -> oracle.update + executeBurn.");
  console.log(
    `   CRASH_ADDRESS=${crashAddr} LOTTERY_ADDRESS=${await lottery.getAddress()} BEACON_ADDRESS=${await beacon.getAddress()} ROUTER_ADDRESS=${await rakeRouter.getAddress()} \\`
  );
  console.log(`   ORACLE_ADDRESS=${await oracle.getAddress()} BURN_ENGINE_ADDRESS=${await burnEngine.getAddress()} \\`);
  console.log("   KEEPER_RPC_URL=http://127.0.0.1:8545 KEEPER_PK=<a funded local test key> KEEPER_MOCK_BEACON=1 npx hardhat run scripts/casino-keeper.ts --network localhost");
  console.log("========================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
