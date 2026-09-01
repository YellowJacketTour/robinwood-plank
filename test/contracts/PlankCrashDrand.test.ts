import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { HARDENING_TEST_DEFAULTS, hardeningFor } from "./helpers/crashHardening.js";

/**
 * PlankCrashDrand's real delta from PlankCrashV2 (its header is required
 * reading first): drand evmnet entropy read from the SHARED DrandBeacon
 * cache MarketplankVaultV3.sol already depends on, instead of blockhash.
 * This suite uses DrandBeaconMock -- the same real, pre-existing test
 * double the vault's own suites use, not a bespoke one -- to exercise
 * the surrounding GAME LOGIC (round targeting, cashOut gating,
 * settlement, keeper reward, voidStaleRound, curve parity) without
 * needing a real relayed signature in every test. The real BLS
 * cryptography this deliberately bypasses is proven independently, for
 * real, in test/contracts/DrandBeacon.bls.test.ts -- not re-proven here.
 */
describe("PlankCrashDrand", () => {
  const BETTING_SECONDS = 5;
  const ROUND_INTERVAL_SECONDS = 0;
  const MAX_AWAIT_BLOCKS = 50;
  const MAX_ELAPSED_BLOCKS = 40;
  const REGISTRATION_BLOCKS = 20;
  const RAKE_BPS = 250n;
  const KEEPER_REWARD_BPS = 1000n;
  const MIN_PARTICIPANTS = 2n;
  const MIN_POOL = ethers.parseEther("0.01");
  const MAX_STAKE_BPS = 5000n;
  // Real drand evmnet genesis/period -- fed into DrandBeaconMock's own
  // constructor below, matching what a real DrandBeacon deploy would use.
  const DRAND_GENESIS_TIME = 1727521075n;
  const DRAND_PERIOD = 3n;
  const TARGET_ROUND_SAFETY_PERIODS = 20n;

  async function deployAll() {
    const [deployer, treasury, alice, bob, carol] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("DrandBeaconMock");
    const beacon: any = await Mock.deploy(DRAND_PERIOD, DRAND_GENESIS_TIME);

    const Crash = await ethers.getContractFactory("PlankCrashDrand");
    const crash: any = await Crash.deploy({
      bettingDurationSeconds: BETTING_SECONDS,
      roundIntervalSeconds: ROUND_INTERVAL_SECONDS,
      maxAwaitBlocks: MAX_AWAIT_BLOCKS,
      maxElapsedBlocks: MAX_ELAPSED_BLOCKS,
      registrationWindowBlocks: REGISTRATION_BLOCKS,
      rakeBps: RAKE_BPS,
      minParticipants: MIN_PARTICIPANTS,
      minPoolSize: MIN_POOL,
      maxStakePerWalletBps: MAX_STAKE_BPS,
      keeperRewardBps: KEEPER_REWARD_BPS,
      seedNumerator: 1n,
      seedDenominator: 2n,
      reserveShareBps: 0n,
      reserveFloorWei: 0n,
      reserveCap: 0n,
      jackpotSink: ethers.ZeroAddress,
      treasury: treasury.address,
      beacon: await beacon.getAddress(),
      ...hardeningFor(MAX_ELAPSED_BLOCKS), // Phase 3 hardening fields (test defaults)
    });

    return { crash, beacon, deployer, treasury, alice, bob, carol };
  }

  async function closeBettingAndLock(crash: any) {
    await networkHelpers.time.increase(BETTING_SECONDS + 1);
    await crash.lockRound();
  }

  /// Waits until the round's own targetDrandRound is actually due, injects
  /// a deterministic randomness value into the mock beacon (standing in
  /// for a real relayed+verified signature), then reveals.
  async function waitForDueAndReveal(crash: any, beacon: any, roundId: bigint, seedStr = "seed") {
    const round = await crash.rounds(roundId);
    const dueAt = DRAND_GENESIS_TIME + BigInt(round.targetDrandRound) * DRAND_PERIOD;
    const now = BigInt(await networkHelpers.time.latest());
    if (dueAt > now) await networkHelpers.time.increaseTo(dueAt);
    await beacon.setRandomness(round.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes(seedStr)));
    await crash.revealEntropy(roundId);
  }

  async function mineToCrashAndSettle(crash: any, roundId: bigint) {
    const round = await crash.rounds(roundId);
    const effective =
      round.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED_BLOCKS) ? round.trueCrashElapsedBlocks : BigInt(MAX_ELAPSED_BLOCKS);
    const current = await ethers.provider.getBlockNumber();
    const targetBlock = Number(round.lockBlock) + Number(effective);
    const toMine = targetBlock - current;
    if (toMine > 0) await networkHelpers.mine(toMine);
    await crash.settleRound(roundId);
  }

  it("WHALE-CAP BYPASS (audit finding, fixed): a wallet can't defeat maxStakePerWalletBps just by betting first into a zero-seeded pool", async () => {
    const { crash, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();

    // The per-bet check is `r.pool != 0 && ...`, a no-op for whoever bets
    // FIRST into an unseeded pool (poolAfter == their own stake, so the
    // ratio check is vacuous) -- Alice can still place an oversized first
    // bet with no revert here, exactly as before the fix.
    const whaleStake = ethers.parseEther("10");
    await crash.connect(alice).placeBet(0n, { value: whaleStake });
    expect(await crash.largestStakeInRound(roundId)).to.equal(whaleStake);

    // Bob bets a small, ordinary amount as the second participant.
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("0.1") });

    // THE FIX: lockRound() retroactively checks the FINAL pool. Alice's
    // 10 ETH is ~99% of the ~10.1 ETH pool, far past the 50% cap
    // (MAX_STAKE_BPS=5000) -- the round voids instead of proceeding with a
    // whale-dominated pot, regardless of bet order.
    await networkHelpers.time.increase(BETTING_SECONDS + 1);
    await expect(crash.lockRound())
      .to.emit(crash, "RoundVoided")
      .withArgs(roundId, whaleStake + ethers.parseEther("0.1"), "whale-dominated");

    const round = await crash.rounds(roundId);
    expect(Number(round.phase)).to.equal(3); // SETTLED (voided)
    expect(await crash.voided(roundId)).to.equal(true);

    // Nothing is lost: both stakes carry forward to the fresh round exactly
    // like an ordinary under-threshold void.
    const freshRoundId = await crash.currentRoundId();
    expect(freshRoundId).to.be.gt(roundId);
    await crash.connect(alice).carryForwardStake(roundId);
    await crash.connect(bob).carryForwardStake(roundId);
    expect(await crash.stakeOf(freshRoundId, alice.address)).to.equal(whaleStake);
    expect(await crash.stakeOf(freshRoundId, bob.address)).to.equal(ethers.parseEther("0.1"));
  });

  it("a normal, reasonably-sized first bet is NOT penalized by the whale-dominance check", async () => {
    const { crash, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    // Alice bets first, but a size that stays under the 50% cap once Bob's
    // comparable bet joins -- the round should lock normally, not void.
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("1") });
    await networkHelpers.time.increase(BETTING_SECONDS + 1);
    await expect(crash.lockRound()).to.emit(crash, "RoundLocked");
    const round = await crash.rounds(roundId);
    expect(Number(round.phase)).to.equal(1); // LIVE, not voided
  });

  it("THIN-VAULT-SEED BUG (found live, fixed): a tiny Vault seed must never block an ordinary bet", async () => {
    const { crash, alice, bob } = await deployAll();

    // Fund the Vault with a small amount, then void the currently-open
    // (unseeded) round so a FRESH round starts and picks up a small seed
    // from it -- reproducing exactly what happened live: after a long
    // session the Vault had drawn down to a thin reserve, so the next
    // round's seed was a few thousandths of an ETH.
    await crash.connect(alice).fundVault({ value: ethers.parseEther("0.001") });
    await networkHelpers.time.increase(BETTING_SECONDS + 1);
    await crash.lockRound(); // voids the empty round (0 participants), starts a new one seeded from the Vault

    const roundId = await crash.currentRoundId();
    const seeded = await crash.rounds(roundId);
    expect(seeded.pool).to.be.gt(0n);
    expect(seeded.pool).to.be.lt(ethers.parseEther("0.001")); // genuinely tiny -- 1/8 of 0.001 ETH

    // An ORDINARY bet (the UI's own smallest quick-bet chip) must NOT
    // revert just because it dwarfs a house-funded seed that isn't another
    // player's money. Under the bug this reverted with StakeExceedsCap --
    // a real success (no throw) is the assertion here.
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("0.01") });

    // And the round proceeds to lock normally -- not voided as whale-dominated.
    await networkHelpers.time.increase(BETTING_SECONDS + 1);
    await expect(crash.lockRound()).to.emit(crash, "RoundLocked");
    expect(Number((await crash.rounds(roundId)).phase)).to.equal(1); // LIVE
  });

  it("lockRound commits to a target drand round strictly after now, with the real safety margin applied", async () => {
    const { crash, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("0.01") });
    await networkHelpers.time.increase(BETTING_SECONDS + 1);
    const committedBeforeBettingClosed = await crash.rounds(roundId);
    await crash.lockRound();

    const round = await crash.rounds(roundId);
    // The envelope is committed when the round starts, before any bet, so a
    // locker cannot choose a randomness target after observing the field.
    expect(round.targetDrandRound).to.equal(committedBeforeBettingClosed.targetDrandRound);
    expect(round.revealNotBefore).to.equal(committedBeforeBettingClosed.revealNotBefore);
    const dueAt = DRAND_GENESIS_TIME + BigInt(round.targetDrandRound) * DRAND_PERIOD;
    expect(dueAt).to.be.gt(BigInt(await networkHelpers.time.latest()));
  });

  it("revealEntropy rejects a round whose randomness hasn't been relayed to the beacon yet", async () => {
    const { crash, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    await expect(crash.revealEntropy(roundId)).to.be.revertedWithCustomError(crash, "RandomnessNotYetAvailable");
  });

  it("a real end-to-end round: lock targets a future drand round, revealEntropy reads it once relayed, and settlement pays out exactly like PlankCrashV2's blockhash-based flow", async () => {
    const { crash, beacon, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("1") });
    await closeBettingAndLock(crash);

    const roundAfterLock = await crash.rounds(roundId);
    expect(roundAfterLock.targetDrandRound).to.be.gt(0n);
    expect(roundAfterLock.entropyRevealed).to.equal(false);

    // Real cash-out before the (not yet knowable) crash point.
    await crash.connect(alice).cashOut(roundId);

    await waitForDueAndReveal(crash, beacon, roundId, "plank-drand-1");
    const revealed = await crash.rounds(roundId);
    expect(revealed.entropyRevealed).to.equal(true);

    await mineToCrashAndSettle(crash, roundId);
    const settled = await crash.rounds(roundId);
    expect(settled.phase).to.equal(2n); // CRASHED

    await crash.connect(alice).registerResult(roundId, alice.address);
    await crash.connect(bob).registerResult(roundId, bob.address);
    await networkHelpers.mine(REGISTRATION_BLOCKS + 1);

    const estimate = await crash.estimatedPayout(roundId, alice.address);
    if (estimate > 0n) {
      const tx = await crash.connect(alice).claim(roundId, alice.address);
      const receipt = await tx.wait();
      const claimedEvent = receipt.logs
        .map((log: any) => {
          try {
            return crash.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed: any) => parsed?.name === "Claimed");
      expect(claimedEvent.args.payout).to.equal(estimate);
    }
  });

  it("cashOut() is refused once the target drand round is due (block.timestamp >= revealNotBefore), revealed or not -- hardening (a) supersedes the old PastCrashPoint gate", async () => {
    // Pre-hardening this test expected PastCrashPoint after reveal. Under
    // hardening (a) a manual cash-out is a bytecode-time-gated action: the
    // instant the target round's signature can exist anywhere, NO manual
    // cash-out is accepted, so the crash-point race can never be reached.
    const { crash, beacon, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    await waitForDueAndReveal(crash, beacon, roundId, "seed-42");
    await expect(crash.connect(alice).cashOut(roundId)).to.be.revertedWithCustomError(crash, "CashOutWindowClosed");
  });

  it("SECURITY REGRESSION (hardening (a)): no cash-out can be chosen once the target drand round is due, even if revealEntropy() has NOT been called on-chain yet", async () => {
    // Same exploit class the 2026-08-18 fix closed for presetCashOut (a
    // drand round's signature is publicly fetchable the instant its due
    // time passes, whether or not anyone relayed it). presetCashOut no
    // longer exists; the only post-lock action is manual cashOut(), and it
    // is gated purely on the stored revealNotBefore -- never on the
    // on-chain reveal flag.
    const { crash, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    const round = await crash.rounds(roundId);
    // Review MED-1: the window closes CASHOUT_CLOSE_MARGIN_PERIODS (2) before the target round's emission, chain-clock relative.
    expect(round.revealNotBefore).to.equal(DRAND_GENESIS_TIME + (BigInt(round.targetDrandRound) - 1n) * DRAND_PERIOD - 2n * DRAND_PERIOD);
    await networkHelpers.time.increaseTo(round.revealNotBefore);
    expect((await crash.rounds(roundId)).entropyRevealed).to.equal(false); // deliberately never revealed or relayed

    await expect(crash.connect(alice).cashOut(roundId)).to.be.revertedWithCustomError(crash, "CashOutWindowClosed");
    expect(await crash.effectiveCashOutBlock(roundId, alice.address)).to.equal(0n);
  });

  it("an auto target committed WITH the bet replaces presetCashOut: it is the effective cash-out unless a manual cashOut fires EARLIER", async () => {
    const { crash, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    const targetBps = await crash._multiplierAt(5);
    await crash.connect(alice).placeBet(targetBps, { value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("0.01") });
    expect(await crash.autoCashOutBps(roundId, alice.address)).to.equal(targetBps);
    await closeBettingAndLock(crash);

    const round = await crash.rounds(roundId);
    expect(await crash.effectiveCashOutBlock(roundId, alice.address)).to.equal(round.lockBlock + 5n);
    expect(await crash.cashOutBlockOf(roundId, alice.address)).to.equal(0n); // no manual action yet

    // A manual cash-out in the valid window (still not due) at block lock+1
    // is EARLIER than the auto target, so it becomes the effective one.
    expect(round.revealNotBefore).to.be.gt(BigInt(await networkHelpers.time.latest()));
    await crash.connect(alice).cashOut(roundId);
    const manual = await crash.cashOutBlockOf(roundId, alice.address);
    expect(manual).to.be.gt(0n).and.lt(round.lockBlock + 5n);
    expect(await crash.effectiveCashOutBlock(roundId, alice.address)).to.equal(manual);
    // The committed target itself is untouched.
    expect(await crash.autoCashOutBps(roundId, alice.address)).to.equal(targetBps);
  });

  it("a manual cashOut AFTER the committed auto target already fired is rejected -- the target is a ceiling that cannot be raised", async () => {
    const { crash, alice, bob } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet(10001n, { value: ethers.parseEther("0.01") }); // fires at lock+1
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);
    await networkHelpers.mine(2);
    await expect(crash.connect(alice).cashOut(roundId)).to.be.revertedWithCustomError(crash, "AlreadyCashedOut");
  });

  it("a delayed drand round cannot be voided and remains permissionlessly revealable and settleable", async () => {
    const { crash, beacon, alice, bob, carol } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("0.01") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("0.01") });
    await closeBettingAndLock(crash);

    await expect(crash.voidStaleRound(roundId)).to.be.revertedWithCustomError(crash, "ProductionRoundCannotVoid");
    await networkHelpers.mine(MAX_AWAIT_BLOCKS + 1);
    await expect(crash.connect(carol).voidStaleRound(roundId)).to.be.revertedWithCustomError(crash, "ProductionRoundCannotVoid");
    const r = await crash.rounds(roundId);
    const now = BigInt(await networkHelpers.time.latest());
    if (r.revealNotBefore > now) await networkHelpers.time.increaseTo(r.revealNotBefore);
    await beacon.setRandomness(r.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes("late-but-permanent")));
    await crash.connect(carol).revealEntropy(roundId);
    const revealed = await crash.rounds(roundId);
    const target = revealed.lockBlock + revealed.trueCrashElapsedBlocks;
    const current = BigInt(await ethers.provider.getBlockNumber());
    if (target > current) await networkHelpers.mine(Number(target - current));
    await crash.connect(carol).settleRound(roundId);
    expect((await crash.rounds(roundId)).phase).to.equal(2n);
    expect(await crash.voided(roundId)).to.equal(false);
  });

  it("settleRound splits the rake and pays the keeper reward, exactly like PlankCrashV2", async () => {
    const { crash, beacon, treasury, alice, bob, carol } = await deployAll();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("1") });
    await closeBettingAndLock(crash);
    await waitForDueAndReveal(crash, beacon, roundId, "seed-settle");

    const roundBeforeSettle = await crash.rounds(roundId);
    const effective =
      roundBeforeSettle.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED_BLOCKS)
        ? roundBeforeSettle.trueCrashElapsedBlocks
        : BigInt(MAX_ELAPSED_BLOCKS);
    const current = await ethers.provider.getBlockNumber();
    const targetBlock = Number(roundBeforeSettle.lockBlock) + Number(effective);
    if (targetBlock - current > 0) await networkHelpers.mine(targetBlock - current);

    const pool = ethers.parseEther("2");
    const expectedRake = (pool * RAKE_BPS) / 10000n;
    const expectedKeeperReward = (expectedRake * KEEPER_REWARD_BPS) / 10000n;

    // Hardening (c) under the PROPOSED fixture defaults: the locker and the
    // revealer are bountied 1% of the rake each, on top of the settler.
    const expectedLockReveal =
      (expectedRake * HARDENING_TEST_DEFAULTS.keeperLockBps) / 10000n + (expectedRake * HARDENING_TEST_DEFAULTS.keeperRevealBps) / 10000n;
    await crash.connect(carol).settleRound(roundId);
    expect(await crash.payments(carol.address)).to.equal(expectedKeeperReward);
    expect(await crash.accumulatedRake()).to.equal(expectedRake - expectedKeeperReward - expectedLockReveal);

    await crash.claimRake();
    expect(await crash.payments(treasury.address)).to.equal(expectedRake - expectedKeeperReward - expectedLockReveal);
  });

  it("the same _multiplierAt/_deriveCrash curve as PlankCrashV2 -- both contracts pay out identically for the same entropy, proving the drand swap changed nothing about game math", async () => {
    const { crash, treasury } = await deployAll();
    const V2 = await ethers.getContractFactory("PlankCrashV2");
    const v2: any = await V2.deploy({
      bettingDurationSeconds: BETTING_SECONDS,
      roundIntervalSeconds: 0,
      entropyDelayBlocks: 2,
      maxElapsedBlocks: MAX_ELAPSED_BLOCKS,
      registrationWindowBlocks: REGISTRATION_BLOCKS,
      rakeBps: RAKE_BPS,
      minParticipants: MIN_PARTICIPANTS,
      minPoolSize: MIN_POOL,
      maxStakePerWalletBps: MAX_STAKE_BPS,
      keeperRewardBps: KEEPER_REWARD_BPS,
      treasury: treasury.address,
    });
    for (const seedStr of ["a", "b", "c", "42", "plank"]) {
      const seed = ethers.keccak256(ethers.toUtf8Bytes(seedStr));
      const [m1, e1] = await crash._deriveCrash(seed);
      const [m2, e2] = await v2._deriveCrash(seed);
      expect(m1).to.equal(m2);
      expect(e1).to.equal(e2);
    }
  });
});
