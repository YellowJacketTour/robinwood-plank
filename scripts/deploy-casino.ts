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
 *   CASINO_TREASURY        the founder/ops treasury (receives 20% of routed rake)
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
  if (net.chainId !== 4663n) {
    throw new Error(`Production casino deploy is pinned to Robinhood mainnet chainId 4663; got ${net.chainId}`);
  }

  // ── Real infrastructure (all required) ─────────────────────────────
  const PLANK = required("CASINO_PLANK_TOKEN");
  const WETH = required("CASINO_WETH");
  const V2_PAIR = required("CASINO_V2_PAIR");
  const V2_ROUTER = required("CASINO_V2_ROUTER");
  const BEACON = required("CASINO_DRAND_BEACON");
  const TREASURY = required("CASINO_TREASURY");

  // Fail closed before deploying value-moving contracts. Addresses alone are
  // insufficient: a typo, counterfeit pair, or router from another factory
  // would invalidate both the TWAP floor and the intended burn route.
  for (const [label, address] of Object.entries({ PLANK, WETH, V2_PAIR, V2_ROUTER, BEACON })) {
    if ((await ethers.provider.getCode(address)) === "0x") {
      throw new Error(`${label} has no contract code at ${address}`);
    }
  }
  const pair = new ethers.Contract(
    V2_PAIR,
    [
      "function token0() view returns (address)",
      "function token1() view returns (address)",
      "function factory() view returns (address)",
    ],
    ethers.provider
  );
  const router = new ethers.Contract(
    V2_ROUTER,
    ["function factory() view returns (address)", "function WETH() view returns (address)"],
    ethers.provider
  );
  const [token0, token1, pairFactory, routerFactory, routerWeth] = await Promise.all([
    pair.token0() as Promise<string>,
    pair.token1() as Promise<string>,
    pair.factory() as Promise<string>,
    router.factory() as Promise<string>,
    router.WETH() as Promise<string>,
  ]);
  const canonical = (address: string) => ethers.getAddress(address);
  const pairTokens = new Set([canonical(token0), canonical(token1)]);
  if (pairTokens.size !== 2 || !pairTokens.has(canonical(PLANK)) || !pairTokens.has(canonical(WETH))) {
    throw new Error(`CASINO_V2_PAIR is not exactly PLANK/WETH (token0=${token0}, token1=${token1})`);
  }
  if (canonical(pairFactory) !== canonical(routerFactory)) {
    throw new Error(`Pair/router factory mismatch (${pairFactory} != ${routerFactory})`);
  }
  if (canonical(routerWeth) !== canonical(WETH)) {
    throw new Error(`Router WETH mismatch (${routerWeth} != ${WETH})`);
  }

  // ── Ratified economics (overridable) ───────────────────────────────
  const RAKE_BPS = envBig("CASINO_RAKE_BPS", 450n); // 4.5% total
  // ── Phase 3 hardening constants ──────────────────────────────────
  // PROPOSED — not ratified; do not deploy. These defaults are the spec's
  // §6 PROPOSED values (docs/marketplank/SPEC-CRASH-GO-LIVE-HARDENING.md)
  // and require owner ratification before any real-network deploy. The
  // crash family is NOT deployed; this script exists to be reviewed, not
  // run, until §6 is ratified and the §7 gauntlet is green.
  const KEEPER_REWARD_BPS = envBig("CASINO_KEEPER_REWARD_BPS", 500n); // (c) 5% of rake to the settler -- PROPOSED, must be > 0
  const KEEPER_REVEAL_BPS = envBig("CASINO_KEEPER_REVEAL_BPS", 100n); // (c) 1% of rake to the revealer -- PROPOSED
  const KEEPER_LOCK_BPS = envBig("CASINO_KEEPER_LOCK_BPS", 100n); // (c) 1% of rake to the locker -- PROPOSED
  const SEED_MAX_BPS = envBig("CASINO_SEED_MAX_BPS", 500n); // (b) <=5% of bankroll per round -- PROPOSED
  const SINGLE_PAYOUT_CAP_BPS = envBig("CASINO_SINGLE_PAYOUT_CAP_BPS", 200n); // (b) 2% of reserveAtLock house-side per player -- PROPOSED
  const DAILY_DRAWDOWN_BPS = envBig("CASINO_DAILY_DRAWDOWN_BPS", 1500n); // (b) 15%/24h halts subsidy -- PROPOSED
  const HWM_DRAWDOWN_BPS = envBig("CASINO_HWM_DRAWDOWN_BPS", 5000n); // (b) 50% from high-water halts subsidy -- PROPOSED
  // Keeper liveness gas floor (workstream 1): OFF by default (pure bps = the farm-proof
  // permissionless / off-chain-reimburse posture). Set CASINO_DESIGNATED_KEEPER to a
  // real address to enable the designated-keeper floor; floor+budget must then be > 0.
  const DESIGNATED_KEEPER = (process.env.CASINO_DESIGNATED_KEEPER || "0x0000000000000000000000000000000000000000").trim();
  const KEEPER_FLOOR_WEI = envBig("CASINO_KEEPER_FLOOR_WEI", 0n); // PROPOSED — from measured testnet gas (B14)
  const KEEPER_EPOCH_BUDGET_WEI = envBig("CASINO_KEEPER_EPOCH_BUDGET_WEI", 0n); // PROPOSED — per 24h epoch
  // (b) Max multiplier: OWNER MUST SUPPLY (spec §6 -- explicitly "not a
  // Fable proposal"). There is deliberately NO default: the constructor
  // needs 10000 < x <= _multiplierAt(maxElapsedBlocks), and this script
  // REVERTS unless CASINO_MAX_MULTIPLIER_BPS is set.
  const MAX_MULTIPLIER_BPS = (() => {
    const v = process.env.CASINO_MAX_MULTIPLIER_BPS?.trim();
    if (!v) {
      throw new Error(
        "CASINO_MAX_MULTIPLIER_BPS is unset. PROPOSED — not ratified; do not deploy. The max multiplier cap is an OWNER decision (spec §6) and has no default."
      );
    }
    return BigInt(v);
  })();
  const BURN_BPS = envBig("CASINO_BURN_BPS", 4000n); // 40% of routed rake
  const AIRDROP_BPS = envBig("CASINO_AIRDROP_BPS", 4000n); // 40% to Powerboard
  // remainder (20% of routed rake) -> founder/operations treasury

  const BETTING_SECONDS = envNum("CASINO_BETTING_SECONDS", 30);
  const ROUND_INTERVAL_SECONDS = envNum("CASINO_ROUND_INTERVAL_SECONDS", 0);
  const MAX_AWAIT_BLOCKS = envNum("CASINO_MAX_AWAIT_BLOCKS", 3000);
  const MAX_ELAPSED_BLOCKS = envNum("CASINO_MAX_ELAPSED_BLOCKS", 1800);
  const REGISTRATION_WINDOW_BLOCKS = envNum("CASINO_REGISTRATION_WINDOW_BLOCKS", 50);
  const MIN_PARTICIPANTS = envBig("CASINO_MIN_PARTICIPANTS", 2n);
  const MIN_POOL = envBig("CASINO_MIN_POOL_WEI", ethers.parseEther("0.005"));
  const MAX_STAKE_BPS = envBig("CASINO_MAX_STAKE_BPS", 6000n);

  // ── The Vault: the perpetual, never-zero, always-compounding prize pot.
  // Each game is seeded with SEED_NUM/SEED_DEN of the Vault (a strict
  // fraction, so it can never be drawn to zero), the Vault grows by
  // RESERVE_SHARE_BPS of every round's rake (compounds on wins too) plus the
  // whole pot of every busted round, and RESERVE_FLOOR_WEI is an optional
  // hard floor. Defaults: release 1/8 (12.5%) per game, compound 40% of the
  // rake -- a big, visibly-growing progressive pot that never resets.
  const SEED_NUM = envBig("CASINO_SEED_NUMERATOR", 1n);
  const SEED_DEN = envBig("CASINO_SEED_DENOMINATOR", 8n);
  const RESERVE_SHARE_BPS = envBig("CASINO_RESERVE_SHARE_BPS", 4000n);
  const RESERVE_FLOOR_WEI = envBig("CASINO_RESERVE_FLOOR_WEI", 0n);
  // Cascade: the Vault caps here and spills its overflow into the Powerboard
  // jackpot, unifying the crash's growth with the daily lottery. Default cap
  // 2 ETH. mustHitByEpochs guarantees the full jackpot pays out at least that
  // often (in epochs) even if the ball never naturally hits.
  const RESERVE_CAP = envBig("CASINO_RESERVE_CAP_WEI", ethers.parseEther("2"));
  const SEED_BOOTSTRAP_BUDGET_WEI = envBig("CASINO_SEED_BOOTSTRAP_BUDGET_WEI", RESERVE_CAP / 10n); // NEW-1 -- PROPOSED (<= reserveCap/10)
  const MUST_HIT_EPOCHS = envBig("CASINO_MUST_HIT_EPOCHS", 30n);

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
  // The reserve threshold is intentionally mandatory: it must be ratified
  // from measured canonical-pool depth, not inherited from a generic default.
  const TWAP_MIN_RESERVE_WEI = (() => {
    const v = process.env.CASINO_TWAP_MIN_RESERVE_WEI?.trim();
    if (!v) {
      throw new Error(
        "CASINO_TWAP_MIN_RESERVE_WEI is required and must be ratified from measured canonical-pool depth"
      );
    }
    const parsed = BigInt(v);
    if (parsed <= 0n) throw new Error("CASINO_TWAP_MIN_RESERVE_WEI must be positive");
    return parsed;
  })();

  // ── 1. TWAP oracle over the canonical deep pair ────────────────────
  const oracle = await (
    await ethers.getContractFactory("PlankV2TwapOracle")
  ).deploy(V2_PAIR, TWAP_WINDOW, TWAP_MAX_STALE, TWAP_MIN_RESERVE_WEI);
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
    mustHitByEpochs: MUST_HIT_EPOCHS,
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
    seedNumerator: SEED_NUM,
    seedDenominator: SEED_DEN,
    reserveShareBps: RESERVE_SHARE_BPS,
    reserveFloorWei: RESERVE_FLOOR_WEI,
    reserveCap: RESERVE_CAP,
    jackpotSink: await powerboard.getAddress(), // cascade Vault overflow -> jackpot
    treasury: await distributor.getAddress(),
    beacon: BEACON,
    // Phase 3 hardening -- PROPOSED — not ratified; do not deploy.
    keeperRevealBps: KEEPER_REVEAL_BPS,
    keeperLockBps: KEEPER_LOCK_BPS,
    // Keeper liveness floor (workstream 1) — OFF by default; see the env vars above.
    designatedKeeper: DESIGNATED_KEEPER,
    keeperFloorWei: KEEPER_FLOOR_WEI,
    keeperEpochBudgetWei: KEEPER_EPOCH_BUDGET_WEI,
    seedMaxBps: SEED_MAX_BPS,
    singlePayoutCapBps: SINGLE_PAYOUT_CAP_BPS,
    dailyDrawdownBps: DAILY_DRAWDOWN_BPS,
    hwmDrawdownBps: HWM_DRAWDOWN_BPS,
    maxMultiplierBps: MAX_MULTIPLIER_BPS,
    // Re-review NEW-1: seed-income budget bootstrap -- PROPOSED reserveCap/10;
    // the constructor rejects anything larger on a capped Vault. After it is
    // spent, every wei of seed is <= 100% of net rake earned (bytecode
    // SEED_INCOME_MULTIPLE_BPS = 10000).
    seedBootstrapBudgetWei: SEED_BOOTSTRAP_BUDGET_WEI,
  }); // nonce+2
  await crash.waitForDeployment();

  const crashAddr = await crash.getAddress();
  if (crashAddr.toLowerCase() !== predictedCrash.toLowerCase()) {
    throw new Error(`Crash address prediction failed (predicted ${predictedCrash}, got ${crashAddr}). An intervening tx shifted the nonce.`);
  }

  // ── 4. PlankBank -- the deposit/instant-play/withdraw buffer. Whitelists
  //     the crash both as a bet target and as the sole address allowed to
  //     recycle winnings via creditFor. No dependency cycle: it only needs
  //     the crash's final address.
  const bank = await (await ethers.getContractFactory("PlankBank")).deploy([crashAddr]);
  await bank.waitForDeployment();

  // ── 5. PlankFuelBooster -- burn $PLANK on the launchpad to boost the
  //     shared Vault (never the burner's own odds). Priced off the SAME
  //     TWAP oracle the burn engine already trusts. No dependency cycle:
  //     only needs the crash's final address + the oracle.
  const FUEL_MAX_PER_BURN_WEI = envBig("CASINO_FUEL_MAX_PER_BURN_WEI", ethers.parseEther("0.1"));
  const FUEL_MAX_PER_ROUND_WEI = envBig("CASINO_FUEL_MAX_PER_ROUND_WEI", ethers.parseEther("0.5"));
  const fuelBooster = await (
    await ethers.getContractFactory("PlankFuelBooster")
  ).deploy(PLANK, await oracle.getAddress(), crashAddr, FUEL_MAX_PER_BURN_WEI, FUEL_MAX_PER_ROUND_WEI);
  await fuelBooster.waitForDeployment();

  console.log("\n===================== DEPLOYED =====================");
  console.log("PlankV2TwapOracle   :", await oracle.getAddress());
  console.log("PlankBurnEngine     :", await burnEngine.getAddress());
  console.log("PlankPowerboard     :", await powerboard.getAddress());
  console.log("PlankRakeDistributor:", await distributor.getAddress());
  console.log("PlankCrashDrand     :", crashAddr);
  console.log("PlankBank           :", await bank.getAddress());
  console.log("PlankFuelBooster    :", await fuelBooster.getAddress());
  console.log("====================================================");
  console.log("\nrake", Number(RAKE_BPS) / 100 + "% -> dev/jackpot/burn split",
    `${(10000 - Number(BURN_BPS) - Number(AIRDROP_BPS)) / 100}/${Number(AIRDROP_BPS) / 100}/${Number(BURN_BPS) / 100}% of rake`);
  console.log("\nPOST-DEPLOY (required before the game is fully live):");
  console.log("  1. Verify oracle.token0()/token1() are the real WETH/PLANK, and pair getReserves() is the deep pool.");
  console.log("  2. Prime the TWAP: call oracle.update() now, wait one TWAP window, call it again. Burns revert until primed.");
  console.log("  3. Fund the keeper wallet with gas and run scripts/casino-keeper.ts pointed at these addresses.");
  console.log("  4. Sanity-play one round on-chain and confirm settle/register/claim/draw all work before publicizing.");
  console.log("  5. (Instant UX) In the frontend: on 'enter', have the player deposit() to PlankBank,");
  console.log("     grantSession(localKey, cap, expiry), and crash.setPayoutRedirect(bank) so wins recycle.");
  console.log("     The local session key then drives betVia/cashOutVia with no per-bet popup.");
  console.log("  6. (Fuel) Send ETH to fuelBooster.fund() to seed its boost pool. Players then");
  console.log("     plank.approve(fuelBooster, amount) + fuelBooster.burnFuel(amount) to burn $PLANK");
  console.log("     for a fair-value boost to the shared Vault -- never their own odds.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
