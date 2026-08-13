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
  const BETTING_SECONDS = 8;
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
  const MIN_PARTICIPANTS = 2n;
  const MIN_POOL = ethers.parseEther("0.01");
  const MAX_STAKE_BPS = 6000n;
  // 0 locally: the keeper is dev-run, so settlement costs come out of the
  // dev leg rather than skimming the split. Set this ABOVE zero on mainnet
  // if/when settlement is opened to third-party keepers -- it is carved
  // from the rake before the split below, so a nonzero value proportionally
  // reduces all three legs.
  const KEEPER_REWARD_BPS = 0n;

  // ── Split of that rake (bps of the rake, must sum to <= 10000) ─────
  // 1.8 / 1.8 / 0.9 points of the pool -> 40% / 40% / 20% of the rake.
  const BURN_BPS = 2000n; // 20% of rake = 0.9% of pool -> buys + burns $PLANK
  const AIRDROP_BPS = 4000n; // 40% of rake = 1.8% of pool -> the rolling community jackpot
  // remainder (40% of rake = 1.8% of pool) -> dev/ops treasury
  const BURN_KEEPER_REWARD_BPS = 500n; // 5% of ETH spent, to whoever executes a burn
  const MAX_ETH_PER_BURN = ethers.parseEther("1");
  const AIRDROP_EPOCH_SECONDS = 86400n; // daily draw -- fixed schedule, on purpose (see the contract)
  const AIRDROP_DRAWER_REWARD_BPS = 200n; // 2% of the pot, to whoever calls the draw
  const MOCK_PLANK_PER_WEI = 1000n; // arbitrary local exchange rate for the mock router

  // ── Independent pieces first (no dependency cycle) ─────────────────
  const beacon = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
  await beacon.waitForDeployment();

  const plank = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
  await plank.waitForDeployment();

  const router = await (
    await ethers.getContractFactory("MockUniversalRouter")
  ).deploy(await plank.getAddress(), MOCK_PLANK_PER_WEI);
  await router.waitForDeployment();

  const burnEngine = await (
    await ethers.getContractFactory("PlankBurnEngine")
  ).deploy(
    await plank.getAddress(),
    await router.getAddress(),
    deployer.address, // weth: only sanity-checked non-zero locally; real wrapping is inside the real router's commands
    MAX_ETH_PER_BURN,
    BURN_KEEPER_REWARD_BPS
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
    await ethers.getContractFactory("PlankAirdropPool")
  ).deploy(
    await beacon.getAddress(),
    [predictedCrash], // the crash game is the allowed wager source
    DRAND_GENESIS, // airdrop epochs anchor to the same genesis for a clean shared schedule
    AIRDROP_EPOCH_SECONDS,
    AIRDROP_DRAWER_REWARD_BPS
  ); // nonce
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

  console.log("\n========================================================");
  console.log(" plank.love unified casino -- LOCAL dev stack (chainId 31337)");
  console.log("========================================================");
  console.log(" PlankCrashDrand      :", crashAddr);
  console.log(" PlankRakeDistributor :", await distributor.getAddress(), `(treasury of the crash)`);
  // Points OF THE POOL each leg actually receives, after the keeper carve.
  const rakePct = Number(RAKE_BPS) / 100;
  const afterKeeper = rakePct * (1 - Number(KEEPER_REWARD_BPS) / 10000);
  const devPct = (afterKeeper * (10000 - Number(BURN_BPS) - Number(AIRDROP_BPS))) / 10000;
  const jackpotPct = (afterKeeper * Number(AIRDROP_BPS)) / 10000;
  const burnPct = (afterKeeper * Number(BURN_BPS)) / 10000;
  console.log(" PlankBurnEngine      :", await burnEngine.getAddress(), `(${burnPct.toFixed(2)}% of pool -> burn)`);
  console.log(" PlankAirdropPool     :", await airdropPool.getAddress(), `(${jackpotPct.toFixed(2)}% of pool -> jackpot)`);
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
  console.log(" Airdrop epoch        :", Number(AIRDROP_EPOCH_SECONDS) / 3600, "hours (FIXED schedule -- see the contract header)");
  console.log("\n Test accounts: alice/bob/carol (#2/#3/#4) each hold 10000 ETH.");
  console.log("\n Keeper loop each round (all permissionless):");
  console.log("   1. crash.lockRound()        once betting closes");
  console.log("   2. beacon.setRandomness(round, value) + crash.revealEntropy(roundId)   once the drand round is due");
  console.log("   3. crash.settleRound(roundId)         -> pays keeper + accrues rake");
  console.log("   4. crash.withdrawPayments(distributor) -> splits rake into burn/airdrop/treasury");
  console.log("   5. airdropPool.claimTickets(crash, roundId, player) for each bettor");
  console.log("   6. burnEngine.executeBurn(route, ethAmount, minPlankOut, deadline)   when ETH has accrued");
  console.log("   7. once a day: airdropPool.requestDraw(epoch) -> ... -> airdropPool.drawWinner(epoch)");
  console.log("========================================================\n");

  void [alice, bob, carol];
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
