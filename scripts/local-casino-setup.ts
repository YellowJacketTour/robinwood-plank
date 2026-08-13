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
  await ethers.provider.send("evm_setIntervalMining", [100]);

  // ── drand evmnet's real timing constants (the mock uses the same
  // schedule the real beacon would) ──────────────────────────────────
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;

  // ── Crash game config (fast, playable local timings) ───────────────
  const BETTING_SECONDS = 8;
  const MAX_AWAIT_BLOCKS = 300; // ~30s at 100ms/block before a stuck round can be voided
  const MAX_ELAPSED_BLOCKS = 1800; // ~180s real; honestly-advertisable ~73x ceiling (see the contract)
  const REGISTRATION_WINDOW_BLOCKS = 50;
  const RAKE_BPS = 250n; // 2.5% -- the whole community-economics budget comes from this
  const MIN_PARTICIPANTS = 2n;
  const MIN_POOL = ethers.parseEther("0.01");
  const MAX_STAKE_BPS = 6000n;
  const KEEPER_REWARD_BPS = 1000n; // 10% of the rake, to whoever settles

  // ── Community-economics split of the rake (the other 90% of it) ────
  // Example values ONLY -- these are the real business knobs, exercised
  // here so the wiring is proven, not a recommendation. 45% buys+burns
  // $PLANK, 45% funds the wager-weighted airdrop, 10% to protocol
  // treasury.
  const BURN_BPS = 4500n;
  const AIRDROP_BPS = 4500n;
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
  console.log(" PlankBurnEngine      :", await burnEngine.getAddress(), `(${Number(BURN_BPS) / 100}% of rake)`);
  console.log(" PlankAirdropPool     :", await airdropPool.getAddress(), `(${Number(AIRDROP_BPS) / 100}% of rake)`);
  console.log(" Protocol treasury    :", treasury.address, `(${(10000 - Number(BURN_BPS) - Number(AIRDROP_BPS)) / 100}% of rake)`);
  console.log(" DrandBeacon (mock)   :", await beacon.getAddress());
  console.log(" $PLANK (mock)        :", await plank.getAddress());
  console.log(" Universal Router mock:", await router.getAddress());
  console.log("\n Rake budget: crash rake", Number(RAKE_BPS) / 100, "% -> keeper", Number(KEEPER_REWARD_BPS) / 100,
    "% of rake, remainder split burn/airdrop/treasury", `${Number(BURN_BPS) / 100}/${Number(AIRDROP_BPS) / 100}/${(10000 - Number(BURN_BPS) - Number(AIRDROP_BPS)) / 100}%`);
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
