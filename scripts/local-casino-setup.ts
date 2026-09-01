/**
 * LOCAL-ONLY unified plank.love casino dev stack. Deploys the WHOLE
 * community-economics system wired together exactly as it is meant to be
 * on mainnet, so the full positive-sum loop can be exercised end-to-end
 * without any real chain, real $PLANK, or real DEX:
 *
 *   PlankCrashDrand ──rake──▶ PlankRakeDistributor ──┬──▶ PlankBurnEngine ──swaps+burns──▶ $PLANK
 *        │                                            ├──▶ PlankAirdropPool (wager-weighted ETH raffle)
 *        │                                            └──▶ protocol treasury
 *        └──stakeOf(round, player)──read by──▶ PlankAirdropPool.claimTickets
 *
 * Local stand-ins for the three real external pieces (everything else is
 * the REAL contract, unchanged):
 *   - DrandBeaconMock  for the shared DrandBeacon (real one needs the real
 *     League-of-Entropy key + network; the mock lets a keeper inject a
 *     round's randomness directly -- same interface the real vault/crash
 *     read).
 *   - MockERC20Burnable for $PLANK (the real token is already deployed at
 *     0x69420...2DDc and is genuinely ERC20Burnable; the mock matches its
 *     balanceOf+burn surface).
 *   - MockUniversalRouter for Uniswap's real Universal Router (real one is
 *     external, already used by this repo's frontend; the mock simulates a
 *     real ETH->PLANK fill so the burn path is exercisable locally).
 *
 * Usage (two terminals):
 *   1)  npx hardhat node
 *   2)  npx hardhat run scripts/local-casino-setup.ts --network localhost
 */
import hardhat from "hardhat";
const { ethers } = await hardhat.network.create();

// TEST_RIG=1 relaxes the two settings that exist specifically to model
// realistic production constraints (the whale-dominance cap and requiring
// a second real participant) -- neither is a game-math bug, they're
// deliberate anti-abuse/anti-empty-round design. A tester who needs to
// freely place any bet size without a competing bettor first (to exercise
// UI/flow, not to validate the cap itself) wants them OFF; anyone
// validating the REAL production cap behavior wants the default (unset).
// See scripts/test-rig.ts for the companion CLI (fund-vault, fund-jackpot,
// competitor bets, rigged crash/jackpot outcomes) built to run against
// EITHER mode.
const TEST_RIG = process.env.TEST_RIG === "1";

async function main() {
  const [deployer, treasury, alice, bob, carol] = await ethers.getSigners();
  // Block cadence + timestamp behavior come from the "node" network config
  // in hardhat.config.ts (mining.interval 100 + allowBlocksWithSameTimestamp).
  // We intentionally do NOT call evm_setIntervalMining -- the runtime RPC
  // ignores the same-timestamp flag and races chain-time ~10x, breaking the
  // countdown/pacing. See local-crash-v2-setup.ts for the full writeup.

  // ── drand evmnet's real timing constants (the mock uses the same
  // schedule the real beacon would) ──────────────────────────────────
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;

  // ── Crash game config (fast, playable local timings) ───────────────
  // Was 8s -- read as rushed for a local demo, especially the 0->1.00x
  // "fueling" ramp (which IS the betting window, by design -- see
  // crash.html's frame()). Mainnet's own deploy-casino.ts default is
  // already 30s (CASINO_BETTING_SECONDS); this just brings local dev in
  // line with that real pacing instead of a compressed test-speed value.
  const BETTING_SECONDS = 20;
  const MAX_AWAIT_BLOCKS = 300; // ~30s at 100ms/block before a stuck round can be voided
  const MAX_ELAPSED_BLOCKS = 1800; // ~180s real; honestly-advertisable ~73x ceiling (see the contract)
  const REGISTRATION_WINDOW_BLOCKS = 50;
  // RATIFIED RAKE: 4.5% total, memetically anchored to the 8.1% NFT
  // royalty -- the dev/ops take is 1.8% of the pool, matched 1:1 by 1.8%
  // straight back to the community jackpot, plus 0.9% to the burn. So of
  // every 4.5 points taken, 2.7 (60%) returns to players as jackpot + token
  // burn, and 1.8 covers real dev bills. Low total rake is deliberate: it
  // is the single biggest driver of how long a bankroll survives, and
  // therefore of lifetime plays (the low-rake poker-room lesson).
  const RAKE_BPS = 450n; // 4.5% of the pool
  const MIN_PARTICIPANTS = TEST_RIG ? 1n : 2n;
  const MIN_POOL = ethers.parseEther("0.01");
  // 10000 bps = 100% = the whale-dominance cap can never trigger (your own
  // stake can never exceed 100% of the pool including itself). This is a
  // TEST-ONLY relaxation -- 6000 (60%) is the real, deliberate production
  // value and stays the default whenever TEST_RIG isn't set.
  const MAX_STAKE_BPS = TEST_RIG ? 10000n : 6000n;
  // 0 locally: the keeper is dev-run, so settlement costs come out of the
  // dev leg rather than skimming the split. Set this ABOVE zero on mainnet
  // if/when settlement is opened to third-party keepers -- it is carved
  // from the rake before the split below, so a nonzero value proportionally
  // reduces all three legs.
  const KEEPER_REWARD_BPS = 0n;

  // ── Split of that rake (bps of the rake, must sum to <= 10000) ─────
  // 1.8 / 1.8 / 0.9 points of the pool -> 40% / 40% / 20% of the rake.
  const BURN_BPS = 4000n; // 40% burn / 40% community / 20% founder
  const AIRDROP_BPS = 4000n; // 40% of rake = 1.8% of pool -> the rolling community jackpot
  // remainder (40% of rake = 1.8% of pool) -> dev/ops treasury
  const BURN_KEEPER_REWARD_BPS = 100n; // 1% (<= the 2% engine ceiling)
  const MAX_ETH_PER_BURN = ethers.parseEther("1");
  // 24h is the real, deliberate production cadence; under TEST_RIG this is
  // dropped to 2 minutes so a tester can actually walk multiple epochs
  // (including the "must be won" forced-payout path, which only matters
  // over MANY epochs) without waiting real days for genuinely new,
  // undrawn epochs to reach. scripts/test-rig.ts's rig-jackpot can only
  // rig an epoch that hasn't been drawn yet -- at a 24h cadence there's
  // effectively only ever one such epoch available to test against.
  const AIRDROP_EPOCH_SECONDS = TEST_RIG ? 120n : 86400n;
  const AIRDROP_DRAWER_REWARD_BPS = 200n; // 2% of the prize, to whoever calls the draw
  // POWERBOARD rollover engine: each daily draw picks a Plank Ball in
  // [1, BALL_RANGE]. Land on JACKPOT_BALL (1-in-26, so roughly monthly)
  // and the whole rolling pot pays out; miss and the winner still takes
  // CONSOLATION_BPS of it while the rest compounds into the next day.
  // JACKPOT_BALL = 8 is memetic (the 8 in the 8.1% NFT royalty / 1.8% rake).
  const BALL_RANGE = 26n;
  const JACKPOT_BALL = 8n;
  const CONSOLATION_BPS = 500n; // 5% paid on a miss, 95% rolls over
  // "Must be won": the full jackpot is guaranteed to pay out at least this
  // often (in daily epochs) even if the ball never naturally hits.
  const MUST_HIT_EPOCHS = 30n;
  // The Vault caps here; overflow cascades into the Powerboard jackpot, so
  // the crash's compounding growth feeds the daily lottery once it's full.
  const RESERVE_CAP = ethers.parseEther("2");
  const MOCK_PLANK_PER_WEI = 1000n; // arbitrary local exchange rate for the mock router

  // ── Independent pieces first (no dependency cycle) ─────────────────
  const beacon = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
  await beacon.waitForDeployment();

  const plank = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
  await plank.waitForDeployment();

  const weth = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
  await weth.waitForDeployment();

  // Canonical V2 pair (the DEEP pool) + its TWAP oracle. Locally we seed a
  // 100 WETH : 100000 PLANK pool (1000 PLANK/WETH). On mainnet these are the
  // real deep PLANK/WETH v2 pair and a real V2 router.
  const pair = await (
    await ethers.getContractFactory("MockV2Pair")
  ).deploy(await weth.getAddress(), await plank.getAddress(), ethers.parseEther("100"), ethers.parseEther("100000"));
  await pair.waitForDeployment();
  const TWAP_WINDOW = 60n; // short locally so the keeper primes it fast
  const TWAP_MAX_STALE = 300n;
  // Local mock pool is seeded with 100 WETH reserves above -- 1 ETH is a
  // safe, well-under floor for local dev (see PlankV2TwapOracle's own
  // constructor comment on why this floor exists at all).
  const TWAP_MIN_RESERVE_WEI = ethers.parseEther("1");
  const oracle = await (
    await ethers.getContractFactory("PlankV2TwapOracle")
  ).deploy(await pair.getAddress(), TWAP_WINDOW, TWAP_MAX_STALE, TWAP_MIN_RESERVE_WEI);
  await oracle.waitForDeployment();

  const router = await (
    await ethers.getContractFactory("MockV2Router")
  ).deploy(await plank.getAddress(), MOCK_PLANK_PER_WEI);
  await router.waitForDeployment();

  const BURN_MAX_SLIPPAGE_BPS = 500n; // 5%
  const burnEngine = await (
    await ethers.getContractFactory("PlankBurnEngine")
  ).deploy(
    await plank.getAddress(),
    await router.getAddress(),
    await weth.getAddress(),
    await oracle.getAddress(),
    MAX_ETH_PER_BURN,
    BURN_KEEPER_REWARD_BPS,
    BURN_MAX_SLIPPAGE_BPS
  );
  await burnEngine.waitForDeployment();

  // ── Resolve the 3-way immutable dependency cycle by prediction ─────
  // airdropPool's allowlist (immutable) must contain the crash address;
  // the crash's treasury (immutable) must be the distributor; the
  // distributor (immutable) must know the airdropPool. Rather than add a
  // mutable admin setter anywhere (against this protocol's no-admin
  // ethos), we predict the crash's deploy address from the deployer's
  // nonce and pass it into the airdropPool up front. The three deploys
  // below MUST be consecutive with no intervening transactions, or the
  // predicted nonce is wrong -- all mints/funding happen AFTER.
  const nonce = await deployer.getNonce();
  const predictedCrash = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 2 });

  const airdropPool = await (
    await ethers.getContractFactory("PlankPowerboard")
  ).deploy({
    beacon: await beacon.getAddress(),
    allowedSources: [predictedCrash], // the crash game is the allowed wager source
    genesisTimestamp: DRAND_GENESIS, // epochs anchor to the same genesis for a clean shared schedule
    epochDuration: AIRDROP_EPOCH_SECONDS,
    drawerRewardBps: AIRDROP_DRAWER_REWARD_BPS,
    ballRange: BALL_RANGE,
    jackpotBall: JACKPOT_BALL,
    consolationBps: CONSOLATION_BPS,
    mustHitByEpochs: MUST_HIT_EPOCHS,
  }); // nonce
  await airdropPool.waitForDeployment();

  const distributor = await (
    await ethers.getContractFactory("PlankRakeDistributor")
  ).deploy(
    await burnEngine.getAddress(),
    await airdropPool.getAddress(),
    treasury.address, // real protocol treasury (the residual after burn+airdrop)
    BURN_BPS,
    AIRDROP_BPS
  ); // nonce + 1
  await distributor.waitForDeployment();

  const crash = await (
    await ethers.getContractFactory("PlankCrashDrand")
  ).deploy({
    bettingDurationSeconds: BETTING_SECONDS,
    roundIntervalSeconds: 0, // local: reopen immediately
    maxAwaitBlocks: MAX_AWAIT_BLOCKS,
    maxElapsedBlocks: MAX_ELAPSED_BLOCKS,
    registrationWindowBlocks: REGISTRATION_WINDOW_BLOCKS,
    rakeBps: RAKE_BPS,
    minParticipants: MIN_PARTICIPANTS,
    minPoolSize: MIN_POOL,
    maxStakePerWalletBps: MAX_STAKE_BPS,
    keeperRewardBps: KEEPER_REWARD_BPS,
    // The Vault: seed each game with 1/8 of the reserve (never zero), grow it
    // by 40% of every round's rake plus the whole pot of busted rounds.
    seedNumerator: 1n,
    seedDenominator: 8n,
    reserveShareBps: 4000n,
    reserveFloorWei: 0n,
    reserveCap: RESERVE_CAP,
    jackpotSink: await airdropPool.getAddress(), // cascade Vault overflow -> jackpot
    treasury: await distributor.getAddress(), // rake flows into the community-economics splitter
    beacon: await beacon.getAddress(),
  }); // nonce + 2
  await crash.waitForDeployment();

  const crashAddr = await crash.getAddress();
  if (crashAddr.toLowerCase() !== predictedCrash.toLowerCase()) {
    throw new Error(
      `Address prediction failed: predicted ${predictedCrash}, got ${crashAddr}. ` +
        `An intervening transaction must have shifted the nonce -- keep the three core deploys consecutive.`
    );
  }

  // PlankBank -- instant-UX deposit/play/withdraw buffer (whitelists the crash).
  const bank = await (await ethers.getContractFactory("PlankBank")).deploy([crashAddr]);
  await bank.waitForDeployment();

  // PlankFuelBooster -- burn $PLANK on the launchpad to boost the shared
  // Vault (never the burner's own odds). Priced off the same TWAP oracle the
  // burn engine trusts; capped per-burn and per-round so no whale can either
  // dominate a single burn or drain a whole round's boost alone.
  const FUEL_MAX_PER_BURN = ethers.parseEther("0.05");
  const FUEL_MAX_PER_ROUND = ethers.parseEther("0.2");
  const fuelBooster = await (
    await ethers.getContractFactory("PlankFuelBooster")
  ).deploy(await plank.getAddress(), await oracle.getAddress(), crashAddr, FUEL_MAX_PER_BURN, FUEL_MAX_PER_ROUND);
  await fuelBooster.waitForDeployment();
  // Seed its boost pool + hand test accounts some $PLANK to burn, purely for
  // local playability -- mainnet funding is a real deploy-time decision.
  await (await fuelBooster.fund({ value: ethers.parseEther("2") })).wait();
  await (await plank.mint(alice.address, ethers.parseEther("5000"))).wait();
  await (await plank.mint(bob.address, ethers.parseEther("5000"))).wait();
  await (await plank.mint(carol.address, ethers.parseEther("5000"))).wait();

  // PlankProgression -- Sapling -> Stick -> Board -> Plank -> Big Beam ->
  // Wooden Whale. Optional; deployed and wired here so local dev always
  // exercises the real, full stack. Unlike the crash/distributor/airdropPool
  // cycle above, this needs no address prediction: it's deployed AFTER the
  // three contracts it references, using their real (now-known) addresses,
  // then wired into each via their own one-time setProgression() -- see
  // PlankCrashDrand.setProgression's own comment for why that's a deployer-
  // gated call rather than a constructor parameter or a fully open one.
  const progression = await (
    await ethers.getContractFactory("PlankProgression")
  ).deploy(crashAddr, await fuelBooster.getAddress(), await airdropPool.getAddress());
  await progression.waitForDeployment();
  const progressionAddr = await progression.getAddress();
  await (await crash.setProgression(progressionAddr)).wait();
  await (await fuelBooster.setProgression(progressionAddr)).wait();
  await (await airdropPool.setProgression(progressionAddr)).wait();

  // Real bug this closes: crash.html hardcodes contract addresses as JS
  // constants, and every fresh redeploy (a new node, or just re-running
  // this script) can hand out DIFFERENT addresses even with an identical
  // deploy sequence (CREATE address depends on the deployer's nonce, which
  // isn't perfectly pinned to "0" across every environment this script
  // runs in) -- so a stale hardcoded address silently pointed the frontend
  // at contracts that no longer exist, or worse, at a DIFFERENT stack from
  // an earlier session, producing exactly the "reverts for no reason"
  // symptom that looks like a game bug but is actually just address drift.
  // Writing the addresses this run actually used, every run, and having
  // the frontend fetch+override its hardcoded fallbacks from this file on
  // load (see crash.html's loadDeployAddresses()) means a redeploy can
  // never again leave the UI silently talking to the wrong contracts.
  const fs = await import("node:fs");
  const manifest = {
    generatedAt: new Date().toISOString(),
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
    testRig: TEST_RIG,
  };
  fs.writeFileSync(
    new URL("../public/arcade/deploy-addresses.local.json", import.meta.url),
    JSON.stringify(manifest, null, 2)
  );
  console.log("\n(wrote public/arcade/deploy-addresses.local.json -- the frontend auto-syncs to it on load)");

  console.log("\n========================================================");
  console.log(" plank.love unified casino -- LOCAL dev stack (chainId 31337)");
  if (TEST_RIG) {
    console.log(" *** TEST_RIG MODE -- whale-cap disabled (100%), solo betting allowed (minParticipants=1) ***");
    console.log(" *** NOT production settings. Redeploy without TEST_RIG=1 to test the real 60%/2-participant rules. ***");
    console.log(" *** Companion CLI: npx hardhat run scripts/test-rig.ts --network localhost -- <command> ... ***");
  }
  console.log("========================================================");
  console.log(" PlankCrashDrand      :", crashAddr);
  console.log(" PlankBank            :", await bank.getAddress(), "(deposit -> instant session-key play -> withdraw)");
  console.log(" PlankFuelBooster     :", await fuelBooster.getAddress(), "(burn $PLANK -> boosts the shared Vault, never your own odds)");
  console.log(" PlankProgression     :", progressionAddr, "(Sapling -> Stick -> Board -> Plank -> Big Beam -> Wooden Whale)");
  console.log(" PlankRakeDistributor :", await distributor.getAddress(), `(treasury of the crash)`);
  // Points OF THE POOL each leg actually receives, after the keeper carve.
  const rakePct = Number(RAKE_BPS) / 100;
  const afterKeeper = rakePct * (1 - Number(KEEPER_REWARD_BPS) / 10000);
  const devPct = (afterKeeper * (10000 - Number(BURN_BPS) - Number(AIRDROP_BPS))) / 10000;
  const jackpotPct = (afterKeeper * Number(AIRDROP_BPS)) / 10000;
  const burnPct = (afterKeeper * Number(BURN_BPS)) / 10000;
  console.log(" PlankBurnEngine      :", await burnEngine.getAddress(), `(${burnPct.toFixed(2)}% of pool -> burn)`);
  console.log(" PlankPowerboard      :", await airdropPool.getAddress(), `(${jackpotPct.toFixed(2)}% of pool -> rolling jackpot)`);
  console.log(" Dev/ops treasury     :", treasury.address, `(${devPct.toFixed(2)}% of pool)`);
  console.log(" DrandBeacon (mock)   :", await beacon.getAddress());
  console.log(" $PLANK (mock)        :", await plank.getAddress());
  console.log(" Universal Router mock:", await router.getAddress());
  console.log(
    `\n Rake ${rakePct.toFixed(2)}% of pool  =  dev ${devPct.toFixed(2)}%  +  jackpot ${jackpotPct.toFixed(
      2
    )}%  +  burn ${burnPct.toFixed(2)}%`
  );
  console.log(
    ` -> ${(((jackpotPct + burnPct) / rakePct) * 100).toFixed(0)}% of every take returns to players (jackpot + burn).`
  );
  console.log(" Powerboard draw      :", Number(AIRDROP_EPOCH_SECONDS) / 3600, "h cadence, Plank Ball 1-in-" + BALL_RANGE + " for the full pot, " + Number(CONSOLATION_BPS)/100 + "% consolation on a miss (rest rolls over), guaranteed by epoch " + MUST_HIT_EPOCHS + " if it never naturally hits");
  console.log(" Vault (never-zero)   : seeds every round with 1/8 of the reserve, grows 40% of net rake + busted pots; caps at", ethers.formatEther(RESERVE_CAP), "ETH then overflow cascades into the Powerboard jackpot");
  console.log("\n Test accounts: alice/bob/carol (#2/#3/#4) each hold 10000 ETH + 5000 mock $PLANK to burn as fuel.");
  console.log("\n Keeper loop each round (all permissionless):");
  console.log("   1. crash.lockRound()        once betting closes");
  console.log("   2. beacon.setRandomness(round, value) + crash.revealEntropy(roundId)   once the drand round is due");
  console.log("   3. crash.settleRound(roundId)         -> pays keeper + accrues rake");
  console.log("   4. crash.withdrawPayments(distributor) -> splits rake into burn/airdrop/treasury");
  console.log("   5. powerboard.claimTickets(crash, roundId, player) for each bettor");
  console.log("   5b. crash.registerResult(roundId, player) + crash.claim(roundId, player) for each winner (keeper CAN do this on their behalf)");
  console.log("   5c. crash.sweepBustedRound(roundId) if the whole field busted -> rolls the pot into the next round");
  console.log("   6. oracle.update() every window, then burnEngine.executeBurn(ethAmount)   (floor comes from the TWAP, not the caller)");
  console.log("   7. once a day: powerboard.requestDraw(epoch) -> ... -> powerboard.drawWinner(epoch)");
  console.log("\n Players (optional, anyone): plank.approve(fuelBooster, amount) then fuelBooster.burnFuel(amount)");
  console.log("   -- burns real $PLANK, boosts the shared Vault by its fair TWAP value. Never touches your own stake/odds.");
  console.log("\n IMPORTANT for fuel burns to work: the TWAP oracle starts UNPRIMED (consult()");
  console.log(" reverts NotInitialized until update() is called at least once, and update()");
  console.log(" itself reverts PeriodNotElapsed until a full window has passed since deploy).");
  console.log(" Run the keeper with ORACLE_ADDRESS + BURN_ENGINE_ADDRESS set so it primes this");
  console.log(" for you -- without them, every burnFuel() call reverts, forever:");
  console.log(
    `   ORACLE_ADDRESS=${await oracle.getAddress()} BURN_ENGINE_ADDRESS=${await burnEngine.getAddress()} \\`
  );
  console.log("   KEEPER_RPC_URL=http://127.0.0.1:8545 KEEPER_PK=<a funded local test key> \\");
  console.log(
    `   CRASH_ADDRESS=${crashAddr} POWERBOARD_ADDRESS=${await airdropPool.getAddress()} BEACON_ADDRESS=${await beacon.getAddress()} DISTRIBUTOR_ADDRESS=${await distributor.getAddress()} \\`
  );
  console.log("   KEEPER_MOCK_BEACON=1 npx hardhat run scripts/casino-keeper.ts --network localhost");
  console.log("========================================================\n");

  void [alice, bob, carol];
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
