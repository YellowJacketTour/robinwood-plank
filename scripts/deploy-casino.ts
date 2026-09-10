/**
 * MAINNET-CAPABLE deploy of the plank.love casino economics stack:
 *   PlankV2TwapOracle -> PlankBurnEngine, PlankLottery, PlankRakeRouter,
 *   PlankCrash, PlankBank -- wired so the crash's NET rake flows through the
 *   25/69/6 router into burn / lottery+Vault / founders.
 *
 *   npx hardhat run scripts/deploy-casino.ts --network robinhood
 *
 * The `robinhood` network only exists when DEPLOYER_PK + ROBINHOOD_RPC_URL
 * are set (see hardhat.config.ts) -- there is deliberately no accidental
 * one-command mainnet path. You run this with your own funded key; nobody
 * else can.
 *
 * STANDING GATE: no real value moves on these contracts before an
 * independent audit (RATIFICATION-ccs2l-2026-09-02.md s6). This script exists
 * to be reviewed and rehearsed; the owner-supplied CASINO_MAX_MULTIPLIER_BPS
 * and CASINO_TWAP_MIN_RESERVE_WEI have no defaults on purpose.
 *
 * ALL REAL ADDRESSES ARE REQUIRED ENV VARS -- nothing about live
 * infrastructure is guessed. Confirm each on-chain before you run this:
 *   CASINO_PLANK_TOKEN     the real $PLANK ERC20Burnable
 *   CASINO_WETH            the real WETH on the target chain
 *   CASINO_V2_PAIR         the CANONICAL, deepest PLANK/WETH Uniswap v2 pair
 *   CASINO_V2_ROUTER       the real Uniswap v2 router (swapExactETHForTokens)
 *   CASINO_DRAND_BEACON    the already-deployed shared DrandBeacon
 *   CASINO_TREASURY        the founder/ops sink (6% of net rake plus disclosed lottery fees)
 *
 * Economic parameters default to the RATIFIED values (lib/playtest-room-core.ts
 * DEFAULT_PLAYTEST_POLICY and DESIGN-vault-lottery-progressive-carve-2026-09-04.md
 * s6.1/s6.5), denominated in wei at 1 credit = 1e-6 ETH.
 */
import hardhat from "hardhat";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

const CREDIT = 10n ** 12n; // 1 test credit = 1e-6 ETH = 1e12 wei

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
  // Enforce the existing release requirements before any deployment transaction.
  // A failing or unreadable gate must abort; no environment bypass is provided.
  execFileSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./plankcrash-launch-gate.ts", import.meta.url))], { stdio: "inherit" });

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
  // Rake staircase: 450 -> floor 250, -25 bps per 25,000,000 credits of qualified volume.
  const RAKE_BPS = envBig("CASINO_RAKE_BPS", 450n);
  const RAKE_FLOOR_BPS = envBig("CASINO_RAKE_FLOOR_BPS", 250n);
  const RAKE_STEP_BPS = envBig("CASINO_RAKE_STEP_BPS", 25n);
  const RAKE_VOLUME_STEP_WEI = envBig("CASINO_RAKE_VOLUME_STEP_WEI", 25_000_000n * CREDIT);
  // Keeper bounty as bps of realised rake (lib default 0; bps-of-rake is farm-proof).
  const KEEPER_REWARD_BPS = envBig("CASINO_KEEPER_REWARD_BPS", 0n);
  // The router's 25/69/6 of NET is bytecode; only the community subdivision is configured.
  const COMMUNITY_LOTTERY_BPS = envBig("CASINO_COMMUNITY_LOTTERY_BPS", 6500n); // 65% lottery / 35% Vault
  // CCS-2L v1 variant A (ratified): survivor floor 75%, GLOBAL house cap 10% of reserveAtLock.
  const FLOOR_BPS = envBig("CASINO_CCS2L_FLOOR_BPS", 7500n);
  const HOUSE_CAP_BPS = envBig("CASINO_CCS2L_HOUSE_CAP_BPS", 1000n);
  // v2 actuarial identity (RESEARCH-game-theory-lottery-seed-resolution-2026-09-05):
  // the house risks at most this share of a round's OWN rake on that round.
  const HOUSE_RAKE_CAP_BPS = envBig("CASINO_CCS2L_HOUSE_RAKE_CAP_BPS", 0n);
  // The Vault (solvency floor): fixed seed 10,000 credits, buffer cap 1,000,000 credits,
  // 50% of the retained community leg becomes protected principal (the floor).
  const CRASH_SEED_WEI = envBig("CASINO_CRASH_SEED_WEI", 0n);
  const EMISSION_BUFFER_CAP_WEI = envBig("CASINO_EMISSION_BUFFER_CAP_WEI", 1_000_000n * CREDIT);
  const PROTECTED_PRINCIPAL_BPS = envBig("CASINO_PROTECTED_PRINCIPAL_BPS", 5000n);
  // Seed-income bootstrap: the only house money that can be seeded before any rake is earned.
  const SEED_BOOTSTRAP_BUDGET_WEI = envBig("CASINO_SEED_BOOTSTRAP_BUDGET_WEI", 200_000n * CREDIT); // PROPOSED
  // Outcome-independent liveness escape: 30 days after the drand emission time.
  const REFUND_TIMEOUT_SECONDS = envBig("CASINO_REFUND_TIMEOUT_SECONDS", 3600n);
  if(REFUND_TIMEOUT_SECONDS < 3600n || REFUND_TIMEOUT_SECONDS > 86400n) throw new Error("Refund timeout must be 1–24 hours for this release");
  const SAFETY_GUARDIAN = required("CASINO_SAFETY_GUARDIAN");
  const SAFETY_GOVERNANCE = required("CASINO_SAFETY_GOVERNANCE");
  const SAFETY_REOPEN_DELAY = envBig("CASINO_SAFETY_REOPEN_DELAY", 86400n);
  for(const role of [SAFETY_GUARDIAN,SAFETY_GOVERNANCE])if(await ethers.provider.getCode(role)==="0x")throw new Error("Production safety roles must be contract accounts; verify multisig ownership separately");
  // Max multiplier: OWNER MUST SUPPLY (explicitly not a Fable proposal). No default.
  const MAX_TARGET_BPS = (() => {
    const v = process.env.CASINO_MAX_MULTIPLIER_BPS?.trim();
    if (!v) {
      throw new Error(
        "CASINO_MAX_MULTIPLIER_BPS is unset. The max multiplier cap is an OWNER decision and has no default."
      );
    }
    return BigInt(v);
  })();

  const BETTING_SECONDS = envNum("CASINO_BETTING_SECONDS", 30);
  const ROUND_INTERVAL_SECONDS = envNum("CASINO_ROUND_INTERVAL_SECONDS", 0);
  const MIN_PARTICIPANTS = envBig("CASINO_MIN_PARTICIPANTS", 1n);
  const MIN_POOL = envBig("CASINO_MIN_POOL_WEI", 0n);
  const MIN_STAKE = envBig("CASINO_MIN_STAKE_WEI", CREDIT);
  const MAX_STAKE_BPS = envBig("CASINO_MAX_STAKE_BPS", 10000n);
  const MAX_SEATS = envBig("CASINO_MAX_SEATS", 128n);

  // Every bet participates pro rata. Numbered odds budget against the total
  // winner + retained-seed fee outflow, using funding net of both fresh fees.
  // Banked prizes are never charged on a miss. See FUNDED-CYCLE-FUNDING.md.
  // Funded-cycle release candidate; reviewed values are bound by the launch gate.
  const CYCLE_RETENTION_MAX_BPS = envBig("CASINO_CYCLE_RETENTION_MAX_BPS", 2000n);
  const LOTTERY_ROLLOVER_FEE_BPS = envBig("CASINO_LOTTERY_ROLLOVER_FEE_BPS", 1000n);
  const CYCLE_FUNDING_SCALE_WEI = envBig("CASINO_CYCLE_FUNDING_SCALE_WEI", 250_000n * CREDIT);
  const LOTTERY_FOUNDER_FEE_BPS = envBig("CASINO_LOTTERY_FOUNDER_FEE_BPS", 1000n);
  const LOTTERY_ODDS_ONE_IN = envBig("CASINO_LOTTERY_ODDS_ONE_IN", 16n);
  const LOTTERY_CONTRIBUTION_BPS = (6900n * COMMUNITY_LOTTERY_BPS) / 10_000n; // router bytecode: community 69%
  const LOTTERY_KAPPA_BPS = envBig("CASINO_LOTTERY_KAPPA_BPS", 20_000n);
  const CARVE_MIN_BPS = envBig("CASINO_CARVE_MIN_BPS", 1000n);
  const CARVE_MAX_BPS = envBig("CASINO_CARVE_MAX_BPS", 3000n);
  const CARVE_HALF_SATURATION_WEI = envBig("CASINO_CARVE_HALF_SATURATION_WEI", 250_000n * CREDIT);
  // Retired crash bonus slots remain ABI compatible and default to zero.
  // Capped-pool underwriting uses only the funded buffer fraction. The lottery
  // retains its separately committed carve progression.
  const CRASH_MAX_VAULT_BONUS_BPS = envBig("CASINO_MAX_VAULT_BONUS_BPS", 0n);
  const CRASH_VAULT_BONUS_DECAY_WAD = envBig("CASINO_VAULT_BONUS_DECAY_WAD", 0n);
  const LOTTERY_CARVE_DECAY_WAD = envBig("CASINO_LOTTERY_CARVE_DECAY_WAD", 999_000_000_000_000_000n);
  const LOTTERY_CARVE_HALF_SATURATION_CEILING_WEI = envBig(
    "CASINO_LOTTERY_CARVE_HALF_SATURATION_CEILING_WEI",
    2_500_000n * CREDIT,
  );

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
  //     lottery[nonce] -> rakeRouter[nonce+1] -> crash[nonce+2] -> bank[nonce+3]; consecutive.
  //     The crash pins the bank (placeBetFor / withdrawToBank are bank-only).
  const nonce = await deployer.getNonce();
  const predictedCrash = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 2 });
  const predictedBank = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 3 });

  const lottery = await (
    await ethers.getContractFactory("PlankCycleLottery")
  ).deploy({
    source: predictedCrash,
    founderSink: TREASURY,
    founderFeeBps: LOTTERY_FOUNDER_FEE_BPS,
    oddsOneIn: LOTTERY_ODDS_ONE_IN,
    contributionBps: LOTTERY_CONTRIBUTION_BPS,
    kappaBps: LOTTERY_KAPPA_BPS,
    carveMinBps: CARVE_MIN_BPS,
    carveMaxBps: CARVE_MAX_BPS,
    carveHalfSaturationWei: CARVE_HALF_SATURATION_WEI,
    carveDecayWad: LOTTERY_CARVE_DECAY_WAD,
    carveHalfSaturationCeilingWei: LOTTERY_CARVE_HALF_SATURATION_CEILING_WEI,
  }, CYCLE_RETENTION_MAX_BPS, CYCLE_FUNDING_SCALE_WEI, LOTTERY_ROLLOVER_FEE_BPS); // nonce
  await lottery.waitForDeployment();

  const rakeRouter = await (
    await ethers.getContractFactory("PlankRakeRouter")
  ).deploy(
    predictedCrash,
    await burnEngine.getAddress(),
    await lottery.getAddress(),
    predictedCrash,
    TREASURY,
    COMMUNITY_LOTTERY_BPS
  ); // nonce+1
  await rakeRouter.waitForDeployment();

  const crash = await (
    await ethers.getContractFactory("PlankGuardedCrash")
  ).deploy({
    beacon: BEACON,
    router: await rakeRouter.getAddress(),
    lottery: await lottery.getAddress(),
    bank: predictedBank,
    bettingDurationSeconds: BETTING_SECONDS,
    roundIntervalSeconds: ROUND_INTERVAL_SECONDS,
    rakeBps: RAKE_BPS,
    rakeFloorBps: RAKE_FLOOR_BPS,
    rakeStepBps: RAKE_STEP_BPS,
    rakeVolumeStepWei: RAKE_VOLUME_STEP_WEI,
    keeperRewardBps: KEEPER_REWARD_BPS,
    minParticipants: MIN_PARTICIPANTS,
    minPoolWei: MIN_POOL,
    minStakeWei: MIN_STAKE,
    maxStakePerWalletBps: MAX_STAKE_BPS,
    maxTargetBps: MAX_TARGET_BPS,
    maxSeats: MAX_SEATS,
    crashSeedWei: CRASH_SEED_WEI,
    emissionBufferCapWei: EMISSION_BUFFER_CAP_WEI,
    protectedPrincipalBps: PROTECTED_PRINCIPAL_BPS,
    floorBps: FLOOR_BPS,
    houseCapBps: HOUSE_CAP_BPS,
    houseRakeCapBps: HOUSE_RAKE_CAP_BPS,
    maxVaultBonusBps: CRASH_MAX_VAULT_BONUS_BPS,
    vaultBonusDecayWad: CRASH_VAULT_BONUS_DECAY_WAD,
    seedBootstrapBudgetWei: SEED_BOOTSTRAP_BUDGET_WEI,
    refundTimeoutSeconds: REFUND_TIMEOUT_SECONDS,
  }, SAFETY_GUARDIAN, SAFETY_GOVERNANCE, SAFETY_REOPEN_DELAY); // nonce+2
  await crash.waitForDeployment();

  const crashAddr = await crash.getAddress();
  if (crashAddr.toLowerCase() !== predictedCrash.toLowerCase()) {
    throw new Error(`Crash address prediction failed (predicted ${predictedCrash}, got ${crashAddr}). An intervening tx shifted the nonce.`);
  }

  // ── 4. PlankBank -- the deposit/instant-play/withdraw buffer. ──────
  const bank = await (await ethers.getContractFactory("PlankBank")).deploy([crashAddr]); // nonce+3
  await bank.waitForDeployment();
  if ((await bank.getAddress()).toLowerCase() !== predictedBank.toLowerCase()) {
    throw new Error(`Bank address prediction failed (predicted ${predictedBank}, got ${await bank.getAddress()}). The crash is pinned to the predicted bank; redeploy the whole set.`);
  }

  console.log("\n===================== DEPLOYED =====================");
  console.log("PlankV2TwapOracle :", await oracle.getAddress());
  console.log("PlankBurnEngine   :", await burnEngine.getAddress());
  console.log("PlankLottery      :", await lottery.getAddress());
  console.log("PlankRakeRouter   :", await rakeRouter.getAddress());
  console.log("PlankCrash        :", crashAddr);
  console.log("PlankBank         :", await bank.getAddress());
  console.log("====================================================");
  console.log(`\nrake ${Number(RAKE_BPS) / 100}% -> ${Number(RAKE_FLOOR_BPS) / 100}% floor; net rake split 25 burn / 69 community / 6 founders (bytecode);`);
  console.log(`community leg: ${Number(COMMUNITY_LOTTERY_BPS) / 100}% lottery / ${(10000 - Number(COMMUNITY_LOTTERY_BPS)) / 100}% Vault`);
  console.log("settlement rule:", await crash.settlementRuleId(), "params hash:", await crash.settlementParamsHash());
  console.log("\nPOST-DEPLOY (required before the game is fully live):");
  console.log("  1. Verify oracle.token0()/token1() are the real WETH/PLANK, and pair getReserves() is the deep pool.");
  console.log("  2. Prime the TWAP: call oracle.update() now, wait one TWAP window, call it again. Burns revert until primed.");
  console.log("  3. Fund the keeper wallet with gas and run scripts/casino-keeper.ts pointed at these addresses.");
  console.log("  4. Sanity-play one round on-chain and confirm settleRound/flushRake/router claims/withdraw all work before publicizing.");
  console.log("  5. (Instant UX) deposit() to PlankBank, grantSession(localKey, cap, expiry); the session key drives betVia.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
