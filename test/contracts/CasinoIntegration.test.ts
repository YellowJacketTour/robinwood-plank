import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";

/**
 * End-to-end proof that the WHOLE unified plank.love economics loop
 * works when the REAL contracts are wired together (only the three
 * genuinely-external pieces -- the drand beacon, the $PLANK token, and
 * Uniswap's router -- are stood in for by their real interfaces' mocks;
 * every plank.love contract here is the real one, unchanged).
 *
 * The loop this drives, in one test, with real ETH moving the whole way:
 *   real bets -> crash rake -> RakeDistributor split -> BurnEngine burns
 *   real $PLANK  AND  AirdropPool funds a wager-weighted raffle whose
 *   tickets are read from the crash's own stakeOf, drawn by the shared
 *   beacon, and paid out. The per-contract suites prove each piece in
 *   isolation; this proves they compose.
 */
describe("Casino integration (rake -> burn + airdrop)", () => {
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;
  const RAKE_BPS = 250n;
  const KEEPER_REWARD_BPS = 1000n;
  const BURN_BPS = 4500n;
  const AIRDROP_BPS = 4500n;
  const MAX_ELAPSED_BLOCKS = 40;
  const REGISTRATION_BLOCKS = 20;
  const MAX_AWAIT_BLOCKS = 50;
  const EPOCH_SECONDS = 86400n;
  const MOCK_PLANK_PER_WEI = 1000n;

  async function deployCasino() {
    const [deployer, treasury, alice, bob, keeper] = await ethers.getSigners();

    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const plank: any = await (await ethers.getContractFactory("MockERC20Burnable")).deploy();
    const router: any = await (
      await ethers.getContractFactory("MockUniversalRouter")
    ).deploy(await plank.getAddress(), MOCK_PLANK_PER_WEI);

    const burnEngine: any = await (
      await ethers.getContractFactory("PlankBurnEngine")
    ).deploy(await plank.getAddress(), await router.getAddress(), deployer.address, ethers.parseEther("100"), 500n);

    // Resolve the immutable dependency cycle by predicting the crash
    // address (airdropPool[nonce] -> distributor[nonce+1] -> crash[nonce+2]).
    const nonce = await deployer.getNonce();
    const predictedCrash = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 2 });

    const airdropPool: any = await (
      await ethers.getContractFactory("PlankAirdropPool")
    ).deploy(await beacon.getAddress(), [predictedCrash], DRAND_GENESIS, EPOCH_SECONDS, 200n);

    const distributor: any = await (
      await ethers.getContractFactory("PlankRakeDistributor")
    ).deploy(await burnEngine.getAddress(), await airdropPool.getAddress(), treasury.address, BURN_BPS, AIRDROP_BPS);

    const crash: any = await (
      await ethers.getContractFactory("PlankCrashDrand")
    ).deploy({
      bettingDurationSeconds: 5,
      roundIntervalSeconds: 0,
      maxAwaitBlocks: MAX_AWAIT_BLOCKS,
      maxElapsedBlocks: MAX_ELAPSED_BLOCKS,
      registrationWindowBlocks: REGISTRATION_BLOCKS,
      rakeBps: RAKE_BPS,
      minParticipants: 2n,
      minPoolSize: ethers.parseEther("0.01"),
      maxStakePerWalletBps: 6000n,
      keeperRewardBps: KEEPER_REWARD_BPS,
      treasury: await distributor.getAddress(),
      beacon: await beacon.getAddress(),
    });

    expect((await crash.getAddress()).toLowerCase()).to.equal(predictedCrash.toLowerCase());
    return { beacon, plank, router, burnEngine, airdropPool, distributor, crash, deployer, treasury, alice, bob, keeper };
  }

  it("a full round's rake really flows into a real $PLANK burn AND a real wager-weighted airdrop", async () => {
    const { beacon, plank, burnEngine, airdropPool, distributor, crash, treasury, alice, bob, keeper } =
      await deployCasino();

    // ── Two real bets ──────────────────────────────────────────────
    await crash.connect(alice).placeBet({ value: ethers.parseEther("2") });
    await crash.connect(bob).placeBet({ value: ethers.parseEther("2") });
    const roundId = await crash.currentRoundId();
    const pool = ethers.parseEther("4");

    await networkHelpers.time.increase(6);
    await crash.connect(keeper).lockRound();

    // ── Reveal via the shared beacon, then settle ──────────────────
    const round = await crash.rounds(roundId);
    const dueAt = DRAND_GENESIS + BigInt(round.targetDrandRound) * DRAND_PERIOD;
    await networkHelpers.time.increaseTo(dueAt);
    await beacon.setRandomness(round.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes("integration")));
    await crash.revealEntropy(roundId);

    const settleRound = await crash.rounds(roundId);
    const effective =
      settleRound.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED_BLOCKS)
        ? settleRound.trueCrashElapsedBlocks
        : BigInt(MAX_ELAPSED_BLOCKS);
    const cur = await ethers.provider.getBlockNumber();
    const target = Number(settleRound.lockBlock) + Number(effective);
    if (target - cur > 0) await networkHelpers.mine(target - cur);
    await crash.connect(keeper).settleRound(roundId);

    // ── Rake accrued; push it through the distributor ──────────────
    const rake = (pool * RAKE_BPS) / 10000n;
    const keeperReward = (rake * KEEPER_REWARD_BPS) / 10000n;
    const rakeToDistribute = rake - keeperReward;
    expect(await crash.accumulatedRake()).to.equal(rakeToDistribute);

    await crash.claimRake(); // credits distributor in the crash's escrow
    // Anyone can push the escrowed rake to the distributor, whose
    // receive() splits it. This is the real "step 4" of the keeper loop.
    await crash.withdrawPayments(await distributor.getAddress());

    const expectedToBurn = (rakeToDistribute * BURN_BPS) / 10000n;
    const expectedToAirdrop = (rakeToDistribute * AIRDROP_BPS) / 10000n;
    const expectedToTreasury = rakeToDistribute - expectedToBurn - expectedToAirdrop;

    expect(await ethers.provider.getBalance(await burnEngine.getAddress())).to.equal(expectedToBurn);
    expect(await distributor.totalToAirdrop()).to.equal(expectedToAirdrop);
    expect(await distributor.totalToTreasury()).to.equal(expectedToTreasury);

    // ── The airdrop pool really received its slice, into an epoch ──
    const epoch = await airdropPool.currentEpoch();
    expect((await airdropPool.epochs(epoch)).pool).to.equal(expectedToAirdrop);

    // ── Real wager-weighted tickets, read from the crash's own state ─
    await airdropPool.claimTickets(await crash.getAddress(), roundId, alice.address);
    await airdropPool.claimTickets(await crash.getAddress(), roundId, bob.address);
    expect(await airdropPool.ticketsOf(epoch, alice.address)).to.equal(ethers.parseEther("2"));

    // ── A real $PLANK burn from the accrued ETH ────────────────────
    const ethToBurn = expectedToBurn;
    const before = await plank.totalSupply();
    await burnEngine
      .connect(keeper)
      .executeBurn("0x", [], ethToBurn, 0n, Math.floor(Date.now() / 1000) + 3600);
    // Mock mints then the engine burns -> net supply unchanged, but the
    // engine's counter proves a real burn of the real received amount ran.
    expect(await plank.totalSupply()).to.equal(before);
    expect(await burnEngine.totalPlankBurned()).to.equal(ethToBurn * MOCK_PLANK_PER_WEI);
    expect(await burnEngine.totalEthSpent()).to.equal(ethToBurn);

    // ── Close the epoch and draw the raffle winner ─────────────────
    await networkHelpers.time.increaseTo(DRAND_GENESIS + (epoch + 1n) * EPOCH_SECONDS);
    await airdropPool.requestDraw(epoch);
    const e = await airdropPool.epochs(epoch);
    const drawDueAt = DRAND_GENESIS + BigInt(e.targetDrandRound) * DRAND_PERIOD;
    await networkHelpers.time.increaseTo(drawDueAt);
    await beacon.setRandomness(e.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes("raffle")));
    await airdropPool.connect(keeper).drawWinner(epoch);

    const drawn = await airdropPool.epochs(epoch);
    expect(drawn.drawn).to.equal(true);
    expect([alice.address, bob.address]).to.include(drawn.winner);
    // The winner's payout is escrowed for pull-withdrawal, and it's the
    // pot minus the drawer's reward -- real ETH that came from real rake.
    const drawerReward = (expectedToAirdrop * 200n) / 10000n;
    expect(await airdropPool.payments(drawn.winner)).to.equal(expectedToAirdrop - drawerReward);
    void treasury;
  });
});
