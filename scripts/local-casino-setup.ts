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
  if ((await ethers.provider.getNetwork()).chainId !== 31337n) throw new Error("Local setup requires chain 31337");
  const [deployer, treasury, alice, bob, carol] = await ethers.getSigners();

  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;

  const BETTING_SECONDS = 30;
  const RAKE_BPS = 450n;
  const MIN_PARTICIPANTS = TEST_RIG ? 1n : 2n;
  const MIN_POOL = TEST_RIG ? CREDIT : ethers.parseEther("0.01");
  const MAX_STAKE_BPS = TEST_RIG ? 10000n : 6000n;
  // The ratified 25/69/6 of net rake is router bytecode; the community leg
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
  ).deploy(await pair.getAddress(), 60n, 300n, ethers.parseEther("1"), {gasLimit: 1_000_000n});
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
    await ethers.getContractFactory("PlankCycleLottery")
  ).deploy({
    source: predictedCrash,
    founderSink: treasury.address,
    founderFeeBps: 1000n,
    oddsOneIn: TEST_RIG ? 4n : 16n, // flat ceiling; the actuarial rule prices each round by its contribution
    contributionBps: 6900n * COMMUNITY_LOTTERY_BPS / 10_000n, // 69% community, then lottery allocation
    kappaBps: 20_000n, // kappa = 2
    carveMinBps: 1000n,
    carveMaxBps: 3000n,
    carveHalfSaturationWei: 250_000n * CREDIT,
    carveDecayWad: 999_000_000_000_000_000n,
    carveHalfSaturationCeilingWei: 2_500_000n * CREDIT,
  },2000n,1000n*CREDIT,1000n);
  await lottery.waitForDeployment();

  const rakeRouter = await (
    await ethers.getContractFactory("PlankRakeRouter")
  ).deploy(predictedCrash, await burnEngine.getAddress(), await lottery.getAddress(), predictedCrash, treasury.address, COMMUNITY_LOTTERY_BPS);
  await rakeRouter.waitForDeployment();

  const crash = await (
    await ethers.getContractFactory("PlankTimedPracticeCrash")
  ).deploy({
    beacon: await beacon.getAddress(),
    router: await rakeRouter.getAddress(),
    lottery: await lottery.getAddress(),
    lotteryRule: "numbered",
    lotteryCycle: "funded-cycle-v1",
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
    minStakeWei: CREDIT,
    maxStakePerWalletBps: MAX_STAKE_BPS,
    maxTargetBps: 1_000_000n, // 100x local ceiling
    maxSeats: 128n,
    crashSeedWei: 10_000n * CREDIT,
    emissionBufferCapWei: 1_000_000n * CREDIT,
    protectedPrincipalBps: 5000n,
    floorBps: 7500n,
    houseCapBps: 1000n,
    houseRakeCapBps: 5000n,
    maxVaultBonusBps: 2500n,
    vaultBonusDecayWad: 999_000_000_000_000_000n,
    seedBootstrapBudgetWei: ethers.parseEther("0.2"),
    refundTimeoutSeconds: 3600n,
  }, deployer.address, treasury.address, 3600n);
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

  const communityFuel = await (await ethers.getContractFactory("PlankCommunityFuel")).deploy(
    await plank.getAddress(), crashAddr, 10n ** 12n, ethers.parseEther("0.005")
  );
  await communityFuel.waitForDeployment();
  await (await communityFuel.fund({ value: ethers.parseEther("0.05") })).wait();
  await (await plank.mint(deployer.address, ethers.parseEther("5000"))).wait();

  // Prime the Vault so the first rounds seed (bounded by the bootstrap budget).
  await (await crash.fundVault({ value: ethers.parseEther("0.2") })).wait();
  // A small real test-token jackpot makes the first played draw funded.
  await (await lottery.fund({value:100000000000n})).wait();
  await (await plank.mint(alice.address, ethers.parseEther("5000"))).wait();
  await (await plank.mint(bob.address, ethers.parseEther("5000"))).wait();
  await (await plank.mint(carol.address, ethers.parseEther("5000"))).wait();
  // Finish the empty construction round so the first playable round has its
  // underwriting escrow. This clock adjustment is confined to chain 31337.
  const constructionRound=await crash.currentRound();
  const latest=await ethers.provider.getBlock('latest');
  if(latest && latest.timestamp<Number(constructionRound.bettingEndsAt)){
    if(process.env.LOCAL_CASINO_REAL_TIME==='1')await new Promise(resolve=>setTimeout(resolve,(Number(constructionRound.bettingEndsAt)-latest.timestamp+1)*1000));
    else await ethers.provider.send('evm_setNextBlockTimestamp',[Number(constructionRound.bettingEndsAt)]);
  }
  await (await crash.lockRound()).wait();

  const fs = await import("node:fs");
  const manifest = {
    generatedAt: new Date().toISOString(),
    crash: crashAddr,
    communityFuel: await communityFuel.getAddress(),
    bank: await bank.getAddress(),
    plank: await plank.getAddress(),
    lottery: await lottery.getAddress(),
    lotteryRule: "numbered",
    lotteryCycle: "funded-cycle-v1",
    beacon: await beacon.getAddress(),
    rakeRouter: await rakeRouter.getAddress(),
    oracle: await oracle.getAddress(),
    burnEngine: await burnEngine.getAddress(),
    testRig: TEST_RIG,
    practiceTiming: '30-second-lottery-to-launch-local-mock',
    presentationLeadSeconds: 8,
  };
  fs.writeFileSync(
    process.env.LOCAL_CASINO_MANIFEST_PATH || new URL("../public/arcade/deploy-addresses.local.json", import.meta.url),
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
