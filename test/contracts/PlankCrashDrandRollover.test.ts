import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { hardeningFor } from "./helpers/crashHardening.js";

/**
 * The "whole field busted" case -- the single most important economic
 * edge case in a pari-mutuel crash game, and the one that used to strand
 * real ETH permanently.
 *
 * If NOBODY cashes out before the crash point, no player ever earns a
 * winning weight, so nobody can ever claim(). Before the fix that ETH
 * (~95.5% of the pool) simply sat in the contract forever with no sweep,
 * no rescue, and no rollover -- a real, permanent loss to the community
 * on every fully-busted round, which at low crash multipliers is common.
 *
 * The fix rolls it into the NEXT round's pool: busted money stays in the
 * game and seeds a visibly bigger pot, which is the lottery rollover
 * mechanic applied to the crash game.
 */
describe("PlankCrashDrand — busted-round rollover", () => {
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;
  const RAKE_BPS = 450n;
  const MAX_ELAPSED_BLOCKS = 40;
  const REGISTRATION_BLOCKS = 5;

  async function deploy() {
    const [deployer, treasury, alice, bob, keeper] = await ethers.getSigners();
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const crash: any = await (
      await ethers.getContractFactory("PlankCrashDrand")
    ).deploy({
      bettingDurationSeconds: 5,
      roundIntervalSeconds: 0,
      maxAwaitBlocks: 50,
      maxElapsedBlocks: MAX_ELAPSED_BLOCKS,
      registrationWindowBlocks: REGISTRATION_BLOCKS,
      rakeBps: RAKE_BPS,
      minParticipants: 2n,
      minPoolSize: ethers.parseEther("0.01"),
      maxStakePerWalletBps: 6000n,
      keeperRewardBps: 1n, // hardening (c): must be > 0
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
    return { crash, beacon, deployer, treasury, alice, bob, keeper };
  }

  /// Runs one full round in which NEITHER player cashes out.
  async function runFullyBustedRound(crash: any, beacon: any, alice: any, bob: any, seed: string) {
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("1") });
    await networkHelpers.time.increase(6);
    await crash.lockRound();

    const round = await crash.rounds(roundId);
    const dueAt = DRAND_GENESIS + BigInt(round.targetDrandRound) * DRAND_PERIOD;
    await networkHelpers.time.increaseTo(dueAt);
    await beacon.setRandomness(round.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes(seed)));
    await crash.revealEntropy(roundId);

    const r2 = await crash.rounds(roundId);
    const effective =
      r2.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED_BLOCKS) ? r2.trueCrashElapsedBlocks : BigInt(MAX_ELAPSED_BLOCKS);
    const cur = await ethers.provider.getBlockNumber();
    const target = Number(r2.lockBlock) + Number(effective);
    if (target - cur > 0) await networkHelpers.mine(target - cur);
    // Deliberately NO cashOut calls -- the whole field busts.
    await crash.settleRound(roundId);
    return roundId;
  }

  it("when the whole field busts, the distributable rolls into the next round's pool instead of being stranded forever", async () => {
    const { crash, beacon, alice, bob, keeper } = await deploy();
    const roundId = await runFullyBustedRound(crash, beacon, alice, bob, "all-bust");

    const settled = await crash.rounds(roundId);
    const distributable = settled.distributable;
    expect(distributable).to.be.gt(0n);
    expect(settled.totalWinningWeight).to.equal(0n); // nobody won

    // Registration window must actually close before a sweep is allowed --
    // otherwise a sweep could front-run a legitimate winner registering.
    await expect(crash.sweepBustedRound(roundId)).to.be.revertedWithCustomError(crash, "TooEarly");
    await networkHelpers.mine(REGISTRATION_BLOCKS + 1);

    await crash.connect(keeper).sweepBustedRound(roundId);

    // The whole busted pot is now in the Vault, not stranded.
    expect(await crash.reserve()).to.equal(distributable);
    const after = await crash.rounds(roundId);
    expect(after.distributable).to.equal(0n);
    expect(after.swept).to.equal(true);

    // One-shot.
    await expect(crash.sweepBustedRound(roundId)).to.be.revertedWithCustomError(crash, "AlreadySwept");
  });

  it("the swept pot really seeds the NEXT round -- players see a visibly bigger pool they didn't pay for", async () => {
    const { crash, beacon, alice, bob } = await deploy();
    const roundId = await runFullyBustedRound(crash, beacon, alice, bob, "seed-next");
    const distributable = (await crash.rounds(roundId)).distributable;

    await networkHelpers.mine(REGISTRATION_BLOCKS + 1);
    await crash.sweepBustedRound(roundId);

    // The round already open when we swept keeps its own (empty) pool --
    // the rollover lands on the NEXT round to start. Advancing the clock
    // for the settle above already expired that open round's betting
    // window, so close it out: with no bets it voids under-threshold,
    // which starts the fresh round that picks up the seed.
    const openRound = await crash.currentRoundId();
    await crash.lockRound(); // voids the empty stale round, starts the seeded one

    // With this config the Vault releases a STRICT FRACTION (1/2) per game,
    // so the new round is seeded with floor(reserve/2) and the Vault KEEPS
    // the rest -- it is never emptied. That retained balance is the whole
    // point: no game can ever start the forward carry at zero.
    const seed = distributable / 2n; // floor(reserve * 1/2)
    const seededId = await crash.currentRoundId();
    expect(seededId).to.be.gt(openRound);
    const seeded = await crash.rounds(seededId);
    expect(seeded.pool).to.equal(seed);
    expect(seeded.rolledOverFromPrevious).to.equal(seed);
    // The Vault retains the un-seeded remainder -- strictly positive, forever.
    expect(await crash.reserve()).to.equal(distributable - seed);
    expect(await crash.reserve()).to.be.gt(0n);

    // And the seed is a real, spendable pot: a fresh pair of bettors now play
    // for their own stakes PLUS the seeded money they never paid in.
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("1") });
    const funded = await crash.rounds(seededId);
    expect(funded.pool).to.equal(seed + ethers.parseEther("2"));
  });

  it("a round WITH a winner cannot be swept -- the sweep is only ever a rescue for a fully-busted pot", async () => {
    const { crash, beacon, alice, bob } = await deploy();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("1") });
    await networkHelpers.time.increase(6);
    await crash.lockRound();

    // Alice cashes out immediately -- a real winner exists.
    await crash.connect(alice).cashOut(roundId);

    const round = await crash.rounds(roundId);
    const dueAt = DRAND_GENESIS + BigInt(round.targetDrandRound) * DRAND_PERIOD;
    await networkHelpers.time.increaseTo(dueAt);
    await beacon.setRandomness(round.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes("has-winner")));
    await crash.revealEntropy(roundId);
    const r2 = await crash.rounds(roundId);
    const effective =
      r2.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED_BLOCKS) ? r2.trueCrashElapsedBlocks : BigInt(MAX_ELAPSED_BLOCKS);
    const cur = await ethers.provider.getBlockNumber();
    const target = Number(r2.lockBlock) + Number(effective);
    if (target - cur > 0) await networkHelpers.mine(target - cur);
    await crash.settleRound(roundId);

    await crash.registerResult(roundId, alice.address);
    await networkHelpers.mine(REGISTRATION_BLOCKS + 1);

    await expect(crash.sweepBustedRound(roundId)).to.be.revertedWithCustomError(crash, "RoundHasWinners");
  });

  it("AUTOMATION: a keeper can register a winner on that player's behalf -- an offline winner no longer forfeits", async () => {
    const { crash, beacon, alice, bob, keeper } = await deploy();
    const roundId = await crash.currentRoundId();
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("1") });
    await networkHelpers.time.increase(6);
    await crash.lockRound();
    await crash.connect(alice).cashOut(roundId);

    const round = await crash.rounds(roundId);
    const dueAt = DRAND_GENESIS + BigInt(round.targetDrandRound) * DRAND_PERIOD;
    await networkHelpers.time.increaseTo(dueAt);
    await beacon.setRandomness(round.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes("keeper-reg")));
    await crash.revealEntropy(roundId);
    const r2 = await crash.rounds(roundId);
    const effective =
      r2.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED_BLOCKS) ? r2.trueCrashElapsedBlocks : BigInt(MAX_ELAPSED_BLOCKS);
    const cur = await ethers.provider.getBlockNumber();
    const target = Number(r2.lockBlock) + Number(effective);
    if (target - cur > 0) await networkHelpers.mine(target - cur);
    await crash.settleRound(roundId);

    // Alice never sends a transaction here -- the KEEPER registers for her.
    await crash.connect(keeper).registerResult(roundId, alice.address);
    expect(await crash.registered(roundId, alice.address)).to.equal(true);

    await networkHelpers.mine(REGISTRATION_BLOCKS + 1);
    // She still claims her own funds (payout goes to the player, not the keeper).
    const before = await crash.payments(alice.address);
    await crash.connect(keeper).claim(roundId, alice.address);
    expect(await crash.payments(alice.address)).to.be.gt(before);
  });
});
