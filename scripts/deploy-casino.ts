/**
 * MAINNET-CAPABLE deploy of the plank.love casino economics stack:
 * PlankV2TwapOracle -> PlankBurnEngine, PlankPowerboard,
 * PlankRakeDistributor, and PlankCrashDrand, all wired so the crash game's
 * rake flows into the community mechanics.
 *
 *   npx hardhat run scripts/deploy-casino.ts --network robinhood
 *
 * The `robinhood` network only exists when DEPLOYER_PK + ROBINHOOD_RPC_URL
 * are set (see hardhat.config.ts) -- there is deliberately no accidental
 * one-command mainnet path. You run this with your own funded key; nobody
 * else can.
 *
 * ALL REAL ADDRESSES ARE REQUIRED ENV VARS -- nothing about live
 * infrastructure is guessed. Confirm each on-chain before you run this:
 *   CASINO_PLANK_TOKEN     the real $PLANK ERC20Burnable
 *   CASINO_WETH            the real WETH on the target chain
 *   CASINO_V2_PAIR         the CANONICAL, deepest PLANK/WETH Uniswap v2 pair
 *                          (this is both the burn venue and the TWAP source;
 *                          a thin pair weakens the price floor -- see
 *                          PlankV2TwapOracle's header)
 *   CASINO_V2_ROUTER       the real Uniswap v2 router (swapExactETHForTokens)
 *   CASINO_DRAND_BEACON    the already-deployed shared DrandBeacon (reuse the
 *                          same one MarketplankVault uses -- one audited
 *                          randomness surface for the whole protocol)
 *   CASINO_TREASURY        the dev/ops treasury (receives the 1.8% dev leg)
 *
 * Tunable params (sane ratified defaults if unset) are read from env too --
 * see below.
 */
import hardhat from "hardhat";
const { ethers } = await hardhat.network.create();

/**
 * CONFIRMED Robinhood Chain mainnet addresses (verified on-chain
 * 2026-08-14). Env vars override these; unset falls back to the confirmed
 * value so the only thing you MUST still supply is CASINO_V2_ROUTER (the
 * Uniswap v2 Router02 for factory 0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f
 * -- confirm it before deploying; swapExactETHForTokens must route against
 * the pair below).
 */
const CONFIRMED: Record<string, string> = {
  // $PLANK ERC20Burnable.
  CASINO_PLANK_TOKEN: "0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc",
  // WETH (verified proxy over Arbitrum aeWETH; see lib/constants.ts).
  CASINO_WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  // The DEEP PLANK/WETH v2 pair: token0=WETH, token1=PLANK, factory
  // 0x8bceaa40...937f. Both the burn venue and the TWAP price source.
  CASINO_V2_PAIR: "0x01b1BEf6fBA02c846eA5c4Ff59193988B5f86F73",
  // The shared DrandBeacon ALREADY deployed and already relayed for the
  // vault (see docs/marketplank/DEPLOY-V3-RUNBOOK.md + relay-drand.yml) --
  // reused here, so the casino gets verified randomness from infrastructure
  // that is already running. No new beacon, no new relay.
  CASINO_DRAND_BEACON: "0x87d584df130FED0Fe540954eD48CE2691A18D619",
};

function required(name: string): string {
  const v = (process.env[name]?.trim() || CONFIRMED[name] || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`Missing/invalid required address env var ${name} (got: ${v || "unset"})`);
  }
  return v;
}
function envBig(name: string, dflt: bigint): bigint {
  const v = process.env[name]?.trim();
  return v ? BigInt(v) : dflt;
}
function envNum(name: string, dflt: number): number {
  const v = process.env[name]?.trim();
  return v ? Number(v) : dflt;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`Deploying casino from ${deployer.address} on chainId ${net.chainId}`);

  // ── Real infrastructure (all required) ─────────────────────────────
  const PLANK = required("CASINO_PLANK_TOKEN");
  const WETH = required("CASINO_WETH");
  const V2_PAIR = required("CASINO_V2_PAIR");
  const V2_ROUTER = required("CASINO_V2_ROUTER");
  const BEACON = required("CASINO_DRAND_BEACON");
  const TREASURY = required("CASINO_TREASURY");

  // ── Ratified economics (overridable) ───────────────────────────────
  const RAKE_BPS = envBig("CASINO_RAKE_BPS", 450n); // 4.5% total
  const KEEPER_REWARD_BPS = envBig("CASINO_KEEPER_REWARD_BPS", 0n); // dev-run keeper
  const BURN_BPS = envBig("CASINO_BURN_BPS", 2000n); // 20% of rake = 0.9% of pool
  const AIRDROP_BPS = envBig("CASINO_AIRDROP_BPS", 4000n); // 40% of rake = 1.8% of pool
  // remainder (40% of rake = 1.8% of pool) -> dev/ops treasury

  const BETTING_SECONDS = envNum("CASINO_BETTING_SECONDS", 30);
  const ROUND_INTERVAL_SECONDS = envNum("CASINO_ROUND_INTERVAL_SECONDS", 0);
  const MAX_AWAIT_BLOCKS = envNum("CASINO_MAX_AWAIT_BLOCKS", 3000);
  const MAX_ELAPSED_BLOCKS = envNum("CASINO_MAX_ELAPSED_BLOCKS", 1800);
  const REGISTRATION_WINDOW_BLOCKS = envNum("CASINO_REGISTRATION_WINDOW_BLOCKS", 50);
  const MIN_PARTICIPANTS = envBig("CASINO_MIN_PARTICIPANTS", 2n);
  const MIN_POOL = envBig("CASINO_MIN_POOL_WEI", ethers.parseEther("0.005"));
  const MAX_STAKE_BPS = envBig("CASINO_MAX_STAKE_BPS", 6000n);

  // Powerboard
  const EPOCH_SECONDS = envBig("CASINO_EPOCH_SECONDS", 86400n); // daily
  const EPOCH_GENESIS = envBig("CASINO_EPOCH_GENESIS", BigInt(Math.floor(Date.now() / 1000)));
  const DRAWER_REWARD_BPS = envBig("CASINO_DRAWER_REWARD_BPS", 200n); // 2%
  const BALL_RANGE = envBig("CASINO_BALL_RANGE", 26n);
  const JACKPOT_BALL = envBig("CASINO_JACKPOT_BALL", 8n);
  const CONSOLATION_BPS = envBig("CASINO_CONSOLATION_BPS", 500n); // 5% on a miss

  // Burn engine + TWAP
  const MAX_ETH_PER_BURN = envBig("CASINO_MAX_ETH_PER_BURN_WEI", ethers.parseEther("0.25"));
  const BURN_KEEPER_REWARD_BPS = envBig("CASINO_BURN_KEEPER_REWARD_BPS", 0n);
  const BURN_MAX_SLIPPAGE_BPS = envBig("CASINO_BURN_MAX_SLIPPAGE_BPS", 300n); // 3%
  const TWAP_WINDOW = envBig("CASINO_TWAP_WINDOW_SECONDS", 1800n); // 30 min
  const TWAP_MAX_STALE = envBig("CASINO_TWAP_MAX_STALE_SECONDS", 7200n); // 2 h

  // ── 1. TWAP oracle over the canonical deep pair ────────────────────
  const oracle = await (await ethers.getContractFactory("PlankV2TwapOracle")).deploy(V2_PAIR, TWAP_WINDOW, TWAP_MAX_STALE);
  await oracle.waitForDeployment();

  // ── 2. Burn engine (no dependency cycle) ───────────────────────────
  const burnEngine = await (
    await ethers.getContractFactory("PlankBurnEngine")
  ).deploy(PLANK, V2_ROUTER, WETH, await oracle.getAddress(), MAX_ETH_PER_BURN, BURN_KEEPER_REWARD_BPS, BURN_MAX_SLIPPAGE_BPS);
  await burnEngine.waitForDeployment();

  // ── 3. Resolve the immutable 3-way cycle by predicting the crash addr.
  //     The next three deploys MUST be consecutive (no tx between them).
  const nonce = await deployer.getNonce();
  const predictedCrash = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 2 });

  const powerboard = await (
    await ethers.getContractFactory("PlankPowerboard")
  ).deploy({
    beacon: BEACON,
    allowedSources: [predictedCrash],
    genesisTimestamp: EPOCH_GENESIS,
    epochDuration: EPOCH_SECONDS,
    drawerRewardBps: DRAWER_REWARD_BPS,
    ballRange: BALL_RANGE,
    jackpotBall: JACKPOT_BALL,
    consolationBps: CONSOLATION_BPS,
  }); // nonce
  await powerboard.waitForDeployment();

  const distributor = await (
    await ethers.getContractFactory("PlankRakeDistributor")
  ).deploy(await burnEngine.getAddress(), await powerboard.getAddress(), TREASURY, BURN_BPS, AIRDROP_BPS); // nonce+1
  await distributor.waitForDeployment();

  const crash = await (
    await ethers.getContractFactory("PlankCrashDrand")
  ).deploy({
    bettingDurationSeconds: BETTING_SECONDS,
    roundIntervalSeconds: ROUND_INTERVAL_SECONDS,
    maxAwaitBlocks: MAX_AWAIT_BLOCKS,
    maxElapsedBlocks: MAX_ELAPSED_BLOCKS,
    registrationWindowBlocks: REGISTRATION_WINDOW_BLOCKS,
    rakeBps: RAKE_BPS,
    minParticipants: MIN_PARTICIPANTS,
    minPoolSize: MIN_POOL,
    maxStakePerWalletBps: MAX_STAKE_BPS,
    keeperRewardBps: KEEPER_REWARD_BPS,
    treasury: await distributor.getAddress(),
    beacon: BEACON,
  }); // nonce+2
  await crash.waitForDeployment();

  const crashAddr = await crash.getAddress();
  if (crashAddr.toLowerCase() !== predictedCrash.toLowerCase()) {
    throw new Error(`Crash address prediction failed (predicted ${predictedCrash}, got ${crashAddr}). An intervening tx shifted the nonce.`);
  }

  console.log("\n===================== DEPLOYED =====================");
  console.log("PlankV2TwapOracle   :", await oracle.getAddress());
  console.log("PlankBurnEngine     :", await burnEngine.getAddress());
  console.log("PlankPowerboard     :", await powerboard.getAddress());
  console.log("PlankRakeDistributor:", await distributor.getAddress());
  console.log("PlankCrashDrand     :", crashAddr);
  console.log("====================================================");
  console.log("\nrake", Number(RAKE_BPS) / 100 + "% -> dev/jackpot/burn split",
    `${(10000 - Number(BURN_BPS) - Number(AIRDROP_BPS)) / 100}/${Number(AIRDROP_BPS) / 100}/${Number(BURN_BPS) / 100}% of rake`);
  console.log("\nPOST-DEPLOY (required before the game is fully live):");
  console.log("  1. Verify oracle.token0()/token1() are the real WETH/PLANK, and pair getReserves() is the deep pool.");
  console.log("  2. Prime the TWAP: call oracle.update() now, wait one TWAP window, call it again. Burns revert until primed.");
  console.log("  3. Fund the keeper wallet with gas and run scripts/casino-keeper.ts pointed at these addresses.");
  console.log("  4. Sanity-play one round on-chain and confirm settle/register/claim/draw all work before publicizing.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
