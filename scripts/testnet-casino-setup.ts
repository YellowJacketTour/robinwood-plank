/**
 * PUBLIC TESTNET friend-testing deploy of the plank.love casino stack --
 * same contract graph as scripts/local-casino-setup.ts, adapted for a real
 * chain with exactly ONE funded signer:
 *
 *   - treasury = the deployer address (throwaway test deploy).
 *   - Uses DrandBeaconMock -- setRandomness is fully permissionless, so
 *     ANYONE with the beacon address can rig outcomes. This is a private
 *     mechanics/UI test build, never a fair public game.
 *   - Writes its manifest to deploy-addresses.testnet.json.
 *
 * Usage:
 *   DEPLOYER_PK=<funded burner key> \
 *   ROBINHOOD_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com \
 *   ROBINHOOD_TESTNET_CHAIN_ID=46630 \
 *   npx hardhat run scripts/testnet-casino-setup.ts --network robinhood-testnet
 */
import hardhat from "hardhat";
const { ethers } = await hardhat.network.create();

const CREDIT = 10n ** 12n;

async function main() {
  const [deployer] = await ethers.getSigners();
  const treasury = deployer;
  const guardian = process.env.TESTNET_SAFETY_GUARDIAN;
  const governance = process.env.TESTNET_SAFETY_GOVERNANCE;
  if (!guardian || !governance || !ethers.isAddress(guardian) || !ethers.isAddress(governance)
    || guardian === ethers.ZeroAddress || governance === ethers.ZeroAddress
    || guardian.toLowerCase() === governance.toLowerCase()) {
    throw new Error("Set distinct nonzero TESTNET_SAFETY_GUARDIAN and TESTNET_SAFETY_GOVERNANCE addresses before deployment.");
  }

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer:", deployer.address, " balance:", ethers.formatEther(bal), "ETH");
  if (bal < ethers.parseEther("0.005")) {
    throw new Error(`Deployer only has ${ethers.formatEther(bal)} ETH -- fund it from the testnet faucet first.`);
  }

  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;
  const STRICT = process.env.STRICT === "1";
  const BETTING_SECONDS = 30;
  const MIN_PARTICIPANTS = 1n;
  const MIN_POOL = 0n;
  const MAX_STAKE_BPS = 10000n;
  const COMMUNITY_LOTTERY_BPS = 6500n;
  const MOCK_PLANK_PER_WEI = 1000n;

  // Explicit fee override: hardhat's EIP-1559 guess overshoots this chain's
  // near-zero base fee against a faucet-limited balance.
  const feeData = await ethers.provider.getFeeData();
  const baseFee = feeData.gasPrice ?? ethers.parseUnits("0.01", "gwei");
  const FEES = { maxFeePerGas: baseFee * 5n, maxPriorityFeePerGas: 0n };

  const beacon = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS, FEES);
  await beacon.waitForDeployment();
  const plank = await (await ethers.getContractFactory("MockERC20Burnable")).deploy(FEES);
  await plank.waitForDeployment();
  const weth = await (await ethers.getContractFactory("MockERC20Burnable")).deploy(FEES);
  await weth.waitForDeployment();
  const pair = await (
    await ethers.getContractFactory("MockV2Pair")
  ).deploy(await weth.getAddress(), await plank.getAddress(), ethers.parseEther("10"), ethers.parseEther("10000"), FEES);
  await pair.waitForDeployment();
  const oracle = await (
    await ethers.getContractFactory("PlankV2TwapOracle")
  ).deploy(await pair.getAddress(), 60n, 300n, ethers.parseEther("1"), FEES);
  await oracle.waitForDeployment();
  const v2Router = await (await ethers.getContractFactory("MockV2Router")).deploy(await plank.getAddress(), MOCK_PLANK_PER_WEI, FEES);
  await v2Router.waitForDeployment();
  const burnEngine = await (
    await ethers.getContractFactory("PlankBurnEngine")
  ).deploy(
    await plank.getAddress(),
    await v2Router.getAddress(),
    await weth.getAddress(),
    await oracle.getAddress(),
    ethers.parseEther("0.1"),
    100n,
    500n,
    FEES
  );
  await burnEngine.waitForDeployment();

  const nonce = await deployer.getNonce();
  const predictedCrash = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 2 });
  const predictedBank = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 3 });

  const lottery = await (
    await ethers.getContractFactory("PlankCycleLottery")
  ).deploy({
    source: predictedCrash,
    founderSink: treasury.address,
    founderFeeBps: 1000n,
    oddsOneIn: STRICT ? 16n : 8n, // flat ceiling; the actuarial rule prices each round by its contribution
    contributionBps: 6900n * COMMUNITY_LOTTERY_BPS / 10_000n, // 69% community, then lottery allocation
    kappaBps: 20_000n, // kappa = 2
    carveMinBps: 1000n,
    carveMaxBps: 3000n,
    carveHalfSaturationWei: 250_000n * CREDIT,
    carveDecayWad: 999_000_000_000_000_000n,
    carveHalfSaturationCeilingWei: 2_500_000n * CREDIT,
  }, 2000n, 1000n * CREDIT, 1000n, FEES);
  await lottery.waitForDeployment();

  const rakeRouter = await (
    await ethers.getContractFactory("PlankRakeRouter")
  ).deploy(predictedCrash, await burnEngine.getAddress(), await lottery.getAddress(), predictedCrash, treasury.address, COMMUNITY_LOTTERY_BPS, FEES);
  await rakeRouter.waitForDeployment();

  const crash = await (
    await ethers.getContractFactory("PlankGuardedCrash")
  ).deploy({
    beacon: await beacon.getAddress(),
    router: await rakeRouter.getAddress(),
    lottery: await lottery.getAddress(),
    lotteryRule: "numbered",
    bank: predictedBank,
    bettingDurationSeconds: BETTING_SECONDS,
    roundIntervalSeconds: 0,
    rakeBps: 450n,
    rakeFloorBps: 250n,
    rakeStepBps: 25n,
    rakeVolumeStepWei: 25_000_000n * CREDIT,
    keeperRewardBps: 0n,
    minParticipants: MIN_PARTICIPANTS,
    minPoolWei: MIN_POOL,
    minStakeWei: CREDIT,
    maxStakePerWalletBps: MAX_STAKE_BPS,
    maxTargetBps: 1_000_000n,
    maxSeats: 128n,
    crashSeedWei: 1_000n * CREDIT,
    emissionBufferCapWei: 100_000n * CREDIT,
    protectedPrincipalBps: 5000n,
    floorBps: 7500n,
    houseCapBps: 1000n,
    houseRakeCapBps: 5000n,
    maxVaultBonusBps: 2500n,
    vaultBonusDecayWad: 999_000_000_000_000_000n,
    seedBootstrapBudgetWei: ethers.parseEther("0.005"),
    refundTimeoutSeconds: 3600n,
  }, guardian, governance, 3600n, FEES);
  await crash.waitForDeployment();
  const crashAddr = await crash.getAddress();
  if (crashAddr.toLowerCase() !== predictedCrash.toLowerCase()) {
    throw new Error(`Address prediction failed: predicted ${predictedCrash}, got ${crashAddr}.`);
  }

  const bank = await (await ethers.getContractFactory("PlankBank")).deploy([crashAddr], FEES);
  await bank.waitForDeployment();
  if ((await bank.getAddress()).toLowerCase() !== predictedBank.toLowerCase()) {
    throw new Error(`Bank address prediction failed: predicted ${predictedBank}, got ${await bank.getAddress()}.`);
  }
  await (await plank.mint(deployer.address, ethers.parseEther("5000"), FEES)).wait();

  const fs = await import("node:fs");
  const manifest = {
    generatedAt: new Date().toISOString(),
    network: "robinhood-testnet",
    chainId: 46630,
    rpcUrl: "https://plankcrash-friend-test.pages.dev/rpc",
    strict: STRICT,
    crash: crashAddr,
    bank: await bank.getAddress(),
    plank: await plank.getAddress(),
    lottery: await lottery.getAddress(),
    lotteryRule: "numbered",
    beacon: await beacon.getAddress(),
    rakeRouter: await rakeRouter.getAddress(),
    oracle: await oracle.getAddress(),
    burnEngine: await burnEngine.getAddress(),
    deployer: deployer.address,
    // Never publish the deployment key. Remote testers connect their own wallet.
  };
  fs.writeFileSync(
    new URL("../public/arcade/deploy-addresses.testnet.json", import.meta.url),
    JSON.stringify(manifest, null, 2)
  );

  console.log("\n========================================================");
  console.log(" plank.love casino -- PUBLIC TESTNET friend-test deploy (chainId 46630)");
  console.log(" *** DrandBeaconMock's setRandomness is PERMISSIONLESS -- not a fair public game. ***");
  console.log("========================================================");
  console.log(" PlankCrash      :", crashAddr);
  console.log(" PlankBank       :", await bank.getAddress());
  console.log(" PlankLottery    :", await lottery.getAddress());
  console.log(" PlankRakeRouter :", await rakeRouter.getAddress());
  console.log(" DrandBeacon mock:", await beacon.getAddress());
  console.log(" $PLANK (mock)   :", await plank.getAddress());
  console.log(" Deployer remaining:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  console.log("\n Wrote public/arcade/deploy-addresses.testnet.json");
  console.log("========================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
