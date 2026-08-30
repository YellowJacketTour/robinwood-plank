/**
 * PUBLIC TESTNET friend-testing deploy of the plank.love casino stack --
 * same contract graph as scripts/local-casino-setup.ts (see that file's
 * header for the full architecture diagram), adapted for a real chain with
 * exactly ONE funded signer instead of five pre-funded Hardhat accounts:
 *
 *   - No alice/bob/carol. treasury = the deployer address (this is a
 *     throwaway test deploy, not a real revenue split).
 *   - Uses DrandBeaconMock (see its header: "TEST ONLY. Never deploy [to
 *     mainnet]") -- setRandomness is fully permissionless by design, so
 *     ANYONE with the contract address can rig outcomes. That's the whole
 *     point here (a friend "playing admin"), but it also means this must
 *     never be presented as a fair, trustless game -- it is a private
 *     mechanics/UI test build, not a public beta of the real product.
 *   - ETH amounts are kept small (testnet faucets drip a little at a time,
 *     and it's genuinely worthless ETH either way).
 *   - Writes its manifest to deploy-addresses.testnet.json, NOT
 *     deploy-addresses.local.json, so a local `npx hardhat node` dev loop
 *     and this public deploy never clobber each other. The static bundle
 *     built for hosting copies this file over the filename crash.html/
 *     dev-panel.html actually fetch at runtime.
 *
 * Usage:
 *   DEPLOYER_PK=<funded burner key> \
 *   ROBINHOOD_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com \
 *   ROBINHOOD_TESTNET_CHAIN_ID=46630 \
 *   npx hardhat run scripts/testnet-casino-setup.ts --network robinhood-testnet
 */
import hardhat from "hardhat";
const { ethers } = await hardhat.network.create();

async function main() {
  const [deployer] = await ethers.getSigners();
  const treasury = deployer;

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer:", deployer.address, " balance:", ethers.formatEther(bal), "ETH");
  if (bal < ethers.parseEther("0.005")) {
    throw new Error(
      `Deployer only has ${ethers.formatEther(bal)} ETH -- fund it from the Robinhood Chain Testnet faucet ` +
        `(faucet.testnet.chain.robinhood.com) before running this script. Estimate ~0.03-0.05 ETH for the ` +
        `full deploy sequence at typical testnet gas prices.`
    );
  }

  // Same drand evmnet schedule constants as the local setup -- the mock
  // beacon mirrors the real one's round<->time math even though its
  // randomness is injected, not verified.
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;

  // Relaxed, TEST_RIG-style settings by default: this is two humans
  // manually testing, not a simulation of the real 60%-whale-cap /
  // 2-participant production rules. Set STRICT=1 to deploy with the real
  // production values instead.
  const STRICT = process.env.STRICT === "1";
  const BETTING_SECONDS = 20;
  const MAX_AWAIT_BLOCKS = 300;
  const MAX_ELAPSED_BLOCKS = 1800;
  const REGISTRATION_WINDOW_BLOCKS = 50;
  const RAKE_BPS = 450n;
  const MIN_PARTICIPANTS = STRICT ? 2n : 1n;
  const MIN_POOL = ethers.parseEther("0.001");
  const MAX_STAKE_BPS = STRICT ? 6000n : 10000n;
  const KEEPER_REWARD_BPS = 1n; // hardening (c): the constructor rejects 0; 1 bps keeps local rake math ~unchanged

  const BURN_BPS = 2000n;
  const AIRDROP_BPS = 4000n;
  const BURN_KEEPER_REWARD_BPS = 100n;
  const MAX_ETH_PER_BURN = ethers.parseEther("0.1");
  const AIRDROP_EPOCH_SECONDS = STRICT ? 86400n : 300n; // 5 min so a tester can actually walk an epoch
  const AIRDROP_DRAWER_REWARD_BPS = 200n;
  const BALL_RANGE = 26n;
  const JACKPOT_BALL = 8n;
  const CONSOLATION_BPS = 500n;
  const MUST_HIT_EPOCHS = 30n;
  const RESERVE_CAP = ethers.parseEther("0.2");
  const MOCK_PLANK_PER_WEI = 1000n;

  // Hardhat's automatic EIP-1559 fee guess ignores this chain's real
  // (near-zero, ~0.01 gwei) base fee and falls back to a much higher
  // default -- against a faucet-limited balance that made even the FIRST,
  // smallest contract's gas estimation fail with "insufficient funds"
  // despite the real cost being a tiny fraction of the balance (confirmed
  // via a raw eth_estimateGas call against this RPC directly). Overriding
  // with a small, explicit multiple of the real on-chain base fee fixes
  // this without needing more testnet ETH.
  const feeData = await ethers.provider.getFeeData();
  const baseFee = feeData.gasPrice ?? ethers.parseUnits("0.01", "gwei");
  const FEES = { maxFeePerGas: baseFee * 5n, maxPriorityFeePerGas: 0n };
  console.log("Using fee override:", ethers.formatUnits(FEES.maxFeePerGas, "gwei"), "gwei (real base fee:", ethers.formatUnits(baseFee, "gwei"), "gwei)");

  // ── Independent pieces first ────────────────────────────────────────
  const beacon = await (
    await ethers.getContractFactory("DrandBeaconMock")
  ).deploy(DRAND_PERIOD, DRAND_GENESIS, FEES);
  await beacon.waitForDeployment();

  const plank = await (await ethers.getContractFactory("MockERC20Burnable")).deploy(FEES);
  await plank.waitForDeployment();

  const weth = await (await ethers.getContractFactory("MockERC20Burnable")).deploy(FEES);
  await weth.waitForDeployment();

  const pair = await (
    await ethers.getContractFactory("MockV2Pair")
  ).deploy(await weth.getAddress(), await plank.getAddress(), ethers.parseEther("10"), ethers.parseEther("10000"), FEES);
  await pair.waitForDeployment();
  const TWAP_WINDOW = 60n;
  const TWAP_MAX_STALE = 300n;
  // Mock pool above is seeded with 10 WETH reserves -- 1 ETH is a safe,
  // well-under floor for this testnet mock (see PlankV2TwapOracle's own
  // constructor comment on why this floor exists at all).
  const TWAP_MIN_RESERVE_WEI = ethers.parseEther("1");
  const oracle = await (
    await ethers.getContractFactory("PlankV2TwapOracle")
  ).deploy(await pair.getAddress(), TWAP_WINDOW, TWAP_MAX_STALE, TWAP_MIN_RESERVE_WEI, FEES);
  await oracle.waitForDeployment();

  const router = await (
    await ethers.getContractFactory("MockV2Router")
  ).deploy(await plank.getAddress(), MOCK_PLANK_PER_WEI, FEES);
  await router.waitForDeployment();

  const BURN_MAX_SLIPPAGE_BPS = 500n;
  const burnEngine = await (
    await ethers.getContractFactory("PlankBurnEngine")
  ).deploy(
    await plank.getAddress(),
    await router.getAddress(),
    await weth.getAddress(),
    await oracle.getAddress(),
    MAX_ETH_PER_BURN,
    BURN_KEEPER_REWARD_BPS,
    BURN_MAX_SLIPPAGE_BPS,
    FEES
  );
  await burnEngine.waitForDeployment();

  // ── The crash/airdropPool/distributor circular dependency, resolved by
  // CREATE-address prediction -- same technique as local-casino-setup.ts.
  // These three deploys MUST be consecutive with no intervening tx.
  const nonce = await deployer.getNonce();
  const predictedCrash = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 2 });

  const airdropPool = await (
    await ethers.getContractFactory("PlankPowerboard")
  ).deploy({
    beacon: await beacon.getAddress(),
    allowedSources: [predictedCrash],
    genesisTimestamp: DRAND_GENESIS,
    epochDuration: AIRDROP_EPOCH_SECONDS,
    drawerRewardBps: AIRDROP_DRAWER_REWARD_BPS,
    ballRange: BALL_RANGE,
    jackpotBall: JACKPOT_BALL,
    consolationBps: CONSOLATION_BPS,
    mustHitByEpochs: MUST_HIT_EPOCHS,
  }, FEES);
  await airdropPool.waitForDeployment();

  const distributor = await (
    await ethers.getContractFactory("PlankRakeDistributor")
  ).deploy(await burnEngine.getAddress(), await airdropPool.getAddress(), treasury.address, BURN_BPS, AIRDROP_BPS, FEES);
  await distributor.waitForDeployment();

  const crash = await (
    await ethers.getContractFactory("PlankCrashDrand")
  ).deploy({
    bettingDurationSeconds: BETTING_SECONDS,
    roundIntervalSeconds: 0,
    maxAwaitBlocks: MAX_AWAIT_BLOCKS,
    maxElapsedBlocks: MAX_ELAPSED_BLOCKS,
    registrationWindowBlocks: REGISTRATION_WINDOW_BLOCKS,
    rakeBps: RAKE_BPS,
    minParticipants: MIN_PARTICIPANTS,
    minPoolSize: MIN_POOL,
    maxStakePerWalletBps: MAX_STAKE_BPS,
    keeperRewardBps: KEEPER_REWARD_BPS,
    seedNumerator: 1n,
    seedDenominator: 8n,
    reserveShareBps: 4000n,
    reserveFloorWei: 0n,
    reserveCap: RESERVE_CAP,
    jackpotSink: await airdropPool.getAddress(),
    treasury: await distributor.getAddress(),
    beacon: await beacon.getAddress(),
    // ── Phase 3 hardening fields (spec docs/marketplank/SPEC-CRASH-GO-LIVE-
    //    HARDENING.md). LOCAL/TEST values: circuits set so they cannot trip
    //    and the max multiplier equal to what MAX_ELAPSED_BLOCKS already
    //    implied. NOT the proposed production values (see deploy-casino.ts).
    keeperRevealBps: 0n,
    keeperLockBps: 0n,
    seedMaxBps: 5000n,
    singlePayoutCapBps: 10000n,
    dailyDrawdownBps: 10000n,
    hwmDrawdownBps: 10000n,
    maxMultiplierBps: 10000n + BigInt(MAX_ELAPSED_BLOCKS) * 40n + (BigInt(MAX_ELAPSED_BLOCKS) * BigInt(MAX_ELAPSED_BLOCKS)) / 5n,
    // Re-review NEW-1: seed-income budget bootstrap. LOCAL/TEST: reserveCap/10
    // (the constructor's own bound); production value is PROPOSED in deploy-casino.ts.
    seedBootstrapBudgetWei: RESERVE_CAP / 10n,
  }, FEES);
  await crash.waitForDeployment();

  const crashAddr = await crash.getAddress();
  if (crashAddr.toLowerCase() !== predictedCrash.toLowerCase()) {
    throw new Error(
      `Address prediction failed: predicted ${predictedCrash}, got ${crashAddr}. ` +
        `An intervening transaction must have shifted the nonce -- keep the three core deploys consecutive.`
    );
  }

  const bank = await (await ethers.getContractFactory("PlankBank")).deploy([crashAddr], FEES);
  await bank.waitForDeployment();

  const FUEL_MAX_PER_BURN = ethers.parseEther("0.01");
  const FUEL_MAX_PER_ROUND = ethers.parseEther("0.04");
  const fuelBooster = await (
    await ethers.getContractFactory("PlankFuelBooster")
  ).deploy(await plank.getAddress(), await oracle.getAddress(), crashAddr, FUEL_MAX_PER_BURN, FUEL_MAX_PER_ROUND, FEES);
  await fuelBooster.waitForDeployment();
  // Small seed -- real testnet ETH is faucet-limited, keep this modest.
  await (await fuelBooster.fund({ value: ethers.parseEther("0.005"), ...FEES })).wait();
  // $PLANK's mint() is fully permissionless (see MockERC20Burnable.sol) --
  // the deployer mints itself a starter balance to fuel with; a friend
  // connecting their own key can mint their own balance the same way,
  // via the dev panel or a direct contract call, with no deployer needed.
  await (await plank.mint(deployer.address, ethers.parseEther("5000"), FEES)).wait();

  const progression = await (
    await ethers.getContractFactory("PlankProgression")
  ).deploy(crashAddr, await fuelBooster.getAddress(), await airdropPool.getAddress(), FEES);
  await progression.waitForDeployment();
  const progressionAddr = await progression.getAddress();
  await (await crash.setProgression(progressionAddr, FEES)).wait();
  await (await fuelBooster.setProgression(progressionAddr, FEES)).wait();
  await (await airdropPool.setProgression(progressionAddr, FEES)).wait();

  const fs = await import("node:fs");
  const manifest = {
    generatedAt: new Date().toISOString(),
    network: "robinhood-testnet",
    chainId: 46630,
    // NOT the raw public RPC -- its CORS header is malformed ("*,*",
    // duplicated) and every browser fetch() rejects it outright, even
    // though non-browser checks (curl, node) never enforce CORS at all.
    // Point at this deploy's own /rpc Cloudflare Pages Function (see
    // functions/rpc.js) instead, which proxies to the real RPC and fixes
    // the header. Update this if the friend-test site's domain changes.
    rpcUrl: "https://plankcrash-friend-test.pages.dev/rpc",
    strict: STRICT,
    crash: crashAddr,
    bank: await bank.getAddress(),
    fuelBooster: await fuelBooster.getAddress(),
    plank: await plank.getAddress(),
    powerboard: await airdropPool.getAddress(),
    beacon: await beacon.getAddress(),
    distributor: await distributor.getAddress(),
    oracle: await oracle.getAddress(),
    burnEngine: await burnEngine.getAddress(),
    progression: progressionAddr,
    deployer: deployer.address,
    // crash.html's Simulate button uses this for a true one-click "just
    // play" experience on a hosted deploy (same idea as its hardcoded
    // local Hardhat account, just sourced from here) -- fine to include
    // since this manifest is gitignored (see .gitignore) and this is a
    // throwaway burner funded with worthless testnet ETH, never a real key.
    simulateKey: process.env.DEPLOYER_PK,
  };
  fs.writeFileSync(
    new URL("../public/arcade/deploy-addresses.testnet.json", import.meta.url),
    JSON.stringify(manifest, null, 2)
  );

  const remaining = await ethers.provider.getBalance(deployer.address);
  console.log("\n========================================================");
  console.log(" plank.love casino -- PUBLIC TESTNET friend-test deploy");
  console.log(" Robinhood Chain Testnet, chainId 46630");
  console.log(" *** DrandBeaconMock's setRandomness is PERMISSIONLESS -- anyone with the beacon");
  console.log("     address can rig outcomes. This is a private mechanics test, not a fair public game. ***");
  console.log("========================================================");
  console.log(" PlankCrashDrand      :", crashAddr);
  console.log(" PlankBank            :", await bank.getAddress());
  console.log(" PlankFuelBooster     :", await fuelBooster.getAddress());
  console.log(" PlankProgression     :", progressionAddr);
  console.log(" PlankPowerboard      :", await airdropPool.getAddress());
  console.log(" DrandBeacon (mock)   :", await beacon.getAddress());
  console.log(" $PLANK (mock)        :", await plank.getAddress());
  console.log(" Deployer remaining   :", ethers.formatEther(remaining), "ETH");
  console.log("\n Wrote public/arcade/deploy-addresses.testnet.json");
  console.log("========================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
