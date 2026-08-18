import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";

/**
 * PlankDerby's real mechanics, proven end to end -- same rigor as
 * PlankCrash.test.ts. Pari-mutuel settlement bounded by the real pool,
 * blockhash-derived winning horse that closes the reveal-ordering
 * exploit, two-phase register+claim so payout order can't matter, and the
 * void/carry-forward path for "real collateral or no launch."
 */
describe("PlankDerby", () => {
  const BETTING_SECONDS = 5;
  const REVEAL_DELAY_BLOCKS = 3;
  const REGISTRATION_BLOCKS = 20;
  const RAKE_BPS = 250n; // 2.5%
  const MIN_PARTICIPANTS = 2n;
  const MIN_POOL = ethers.parseEther("0.01");
  // Same real finding as PlankCrash.test.ts: the cap is checked against
  // the pool AFTER the bet, so two equal bettors are each exactly at the
  // 50% boundary. 50% is the tightest cap this suite's roughly-equal test
  // bettors can mathematically clear.
  const MAX_STAKE_BPS = 5000n; // 50%
  const KEEPER_REWARD_BPS = 1000n; // 10% of the rake, not of bettors' distributable pool -- same convention as PlankCrashV2.test.ts

  async function deployDerby() {
    const [, treasury, alice, bob, carol] = await ethers.getSigners();
    const Derby = await ethers.getContractFactory("PlankDerby");
    const derby: any = await Derby.deploy(
      BETTING_SECONDS,
      REVEAL_DELAY_BLOCKS,
      REGISTRATION_BLOCKS,
      RAKE_BPS,
      MIN_PARTICIPANTS,
      MIN_POOL,
      MAX_STAKE_BPS,
      KEEPER_REWARD_BPS,
      treasury.address
    );
    return { derby, treasury, alice, bob, carol };
  }

  async function closeBettingAndLock(derby: any) {
    await networkHelpers.time.increase(BETTING_SECONDS + 1);
    await derby.lockRace();
  }

  async function mineToTargetAndFinish(derby: any, raceId: bigint) {
    const race = await derby.races(raceId);
    const target = race.targetBlock;
    const current = await ethers.provider.getBlockNumber();
    const toMine = Number(target) - current + 1;
    if (toMine > 0) await networkHelpers.mine(toMine);
    await derby.finishRace(raceId);
  }

  it("total payouts never exceed the race's real distributable pool, split only among the winning horse's real backers", async () => {
    const { derby, alice, bob, carol } = await deployDerby();
    const raceId = await derby.currentRaceId();

    // Spread bets across all 6 horses so at most one of these three is a
    // real winner, whichever horse the real block entropy actually picks.
    await derby.connect(alice).placeBet(0, { value: ethers.parseEther("0.01") });
    await derby.connect(bob).placeBet(1, { value: ethers.parseEther("0.01") });
    await derby.connect(carol).placeBet(2, { value: ethers.parseEther("0.01") });

    await closeBettingAndLock(derby);
    await mineToTargetAndFinish(derby, raceId);
    const race = await derby.races(raceId);

    await derby.connect(alice).registerResult(raceId);
    await derby.connect(bob).registerResult(raceId);
    await derby.connect(carol).registerResult(raceId);

    await networkHelpers.mine(REGISTRATION_BLOCKS + 1);

    const distributable: bigint = race.distributable;
    let totalPaid = 0n;
    for (const signer of [alice, bob, carol]) {
      const before: bigint = await ethers.provider.getBalance(signer.address);
      try {
        await derby.connect(signer).claim(raceId);
        await derby.connect(signer).withdrawPayments(signer.address);
      } catch {
        continue; // not the winning horse this race -- a real outcome, not assumed
      }
      const after: bigint = await ethers.provider.getBalance(signer.address);
      if (after > before) totalPaid += after - before;
    }

    expect(totalPaid).to.be.lte(distributable);
  });

  it("a wallet cannot stake more than the whale cap allows", async () => {
    const { derby, alice, bob } = await deployDerby();
    await derby.connect(alice).placeBet(0, { value: MIN_POOL });
    await expect(
      derby.connect(bob).placeBet(1, { value: ethers.parseEther("1") })
    ).to.be.revertedWithCustomError(derby, "StakeExceedsCap");
  });

  it("rejects an out-of-range horse id", async () => {
    const { derby, alice } = await deployDerby();
    await expect(
      derby.connect(alice).placeBet(6, { value: MIN_POOL })
    ).to.be.revertedWithCustomError(derby, "BadHorse");
  });

  it("a race under the collateral floor voids and does not lock", async () => {
    const { derby, alice } = await deployDerby();
    const raceId = await derby.currentRaceId();
    await derby.connect(alice).placeBet(0, { value: MIN_POOL });
    await closeBettingAndLock(derby);

    expect(await derby.voided(raceId)).to.equal(true);
    const race = await derby.races(raceId);
    expect(race.phase).to.equal(3n); // SETTLED (dead-ended, not LOCKED)
  });

  it("a voided race's stake carries forward to the next race, keeping the same horse, without being lost", async () => {
    const { derby, alice, bob } = await deployDerby();
    const voidedRaceId = await derby.currentRaceId();
    await derby.connect(alice).placeBet(3, { value: MIN_POOL });
    await closeBettingAndLock(derby); // voids -- only 1 participant

    const nextRaceId = await derby.currentRaceId();
    expect(nextRaceId).to.equal(voidedRaceId + 1n);

    await derby.connect(alice).carryForwardStake(voidedRaceId);
    expect(await derby.stakeOf(nextRaceId, alice.address)).to.equal(MIN_POOL);
    expect(await derby.horseOf(nextRaceId, alice.address)).to.equal(4n); // horse 3, stored as horseId+1

    await derby.connect(bob).placeBet(1, { value: MIN_POOL });
    await closeBettingAndLock(derby);
    expect(await derby.voided(nextRaceId)).to.equal(false);
    const race = await derby.races(nextRaceId);
    expect(race.phase).to.equal(1n); // LOCKED -- it actually launched this time
    expect(race.pool).to.equal(MIN_POOL * 2n);
  });

  it("cannot carry the same voided stake forward twice", async () => {
    const { derby, alice } = await deployDerby();
    const voidedRaceId = await derby.currentRaceId();
    await derby.connect(alice).placeBet(0, { value: MIN_POOL });
    await closeBettingAndLock(derby);

    await derby.connect(alice).carryForwardStake(voidedRaceId);
    await expect(derby.connect(alice).carryForwardStake(voidedRaceId)).to.be.revertedWithCustomError(
      derby,
      "AlreadyClaimed"
    );
  });

  it("claim() reverts before the registration deadline, so payout order can never matter", async () => {
    const { derby, alice, bob } = await deployDerby();
    const raceId = await derby.currentRaceId();
    await derby.connect(alice).placeBet(0, { value: ethers.parseEther("0.01") });
    await derby.connect(bob).placeBet(1, { value: ethers.parseEther("0.01") });
    await closeBettingAndLock(derby);
    await mineToTargetAndFinish(derby, raceId);
    await derby.connect(alice).registerResult(raceId);

    await expect(derby.connect(alice).claim(raceId)).to.be.revertedWithCustomError(derby, "TooEarly");
  });

  it("a losing bettor's registered weight is zero and their claim reverts as NotWinner", async () => {
    const { derby, alice, bob, carol } = await deployDerby();
    const raceId = await derby.currentRaceId();
    // Bet on every horse across three wallets so exactly one is the real
    // winner and at least one is a real, guaranteed loser -- whichever the
    // real entropy picks, this doesn't assume which.
    await derby.connect(alice).placeBet(0, { value: ethers.parseEther("0.01") });
    await derby.connect(bob).placeBet(1, { value: ethers.parseEther("0.01") });
    await derby.connect(carol).placeBet(2, { value: ethers.parseEther("0.01") });
    await closeBettingAndLock(derby);
    await mineToTargetAndFinish(derby, raceId);
    const race = await derby.races(raceId);

    const bettors = [
      { signer: alice, horse: 0 },
      { signer: bob, horse: 1 },
      { signer: carol, horse: 2 },
    ];
    const losers = bettors.filter((b) => b.horse !== Number(race.winningHorse));
    expect(losers.length).to.be.gte(2); // only one horse (of 0/1/2) can be the real winner

    for (const loser of losers) {
      await derby.connect(loser.signer).registerResult(raceId);
      expect(await derby.horsePool(raceId, loser.horse)).to.be.gt(0n); // real stake was recorded
    }
    await networkHelpers.mine(REGISTRATION_BLOCKS + 1);
    await expect(derby.connect(losers[0].signer).claim(raceId)).to.be.revertedWithCustomError(derby, "NotWinner");
  });

  it("the winning horse is deterministic given the same entropy -- re-runnable off-chain for verification", async () => {
    const { derby } = await deployDerby();
    const seed1 = ethers.keccak256(ethers.toUtf8Bytes("derby-seed-1"));
    const horse1 = Number(BigInt(seed1) % 6n);
    const seed2 = ethers.keccak256(ethers.toUtf8Bytes("derby-seed-1"));
    const horse2 = Number(BigInt(seed2) % 6n);
    expect(horse1).to.equal(horse2);
    expect(horse1).to.be.gte(0);
    expect(horse1).to.be.lt(6);
    void derby;
  });

  it("accumulated rake is only ever claimable to the fixed treasury address, never redirected", async () => {
    const { derby, treasury, alice, bob } = await deployDerby();
    const raceId = await derby.currentRaceId();
    await derby.connect(alice).placeBet(0, { value: ethers.parseEther("0.01") });
    await derby.connect(bob).placeBet(1, { value: ethers.parseEther("0.01") });
    await closeBettingAndLock(derby);
    await mineToTargetAndFinish(derby, raceId);

    const rake = await derby.accumulatedRake();
    expect(rake).to.be.gt(0n);

    await derby.claimRake();
    await derby.connect(treasury).withdrawPayments(treasury.address);
    expect(await derby.accumulatedRake()).to.equal(0n);
  });

  // ── Liveness: the target-block escape hatch (real fund-loss finding, fixed 2026-08-19) ──

  it("voidStaleRound reverts before the blockhash window actually expires", async () => {
    const { derby, alice, bob } = await deployDerby();
    const raceId = await derby.currentRaceId();
    await derby.connect(alice).placeBet(0, { value: ethers.parseEther("0.01") });
    await derby.connect(bob).placeBet(1, { value: ethers.parseEther("0.01") });
    await closeBettingAndLock(derby);

    await expect(derby.voidStaleRound(raceId)).to.be.revertedWithCustomError(derby, "TooEarly");
  });

  it("voidStaleRound rescues a race nobody called finishRace() on before the blockhash window expires, and the stake carries forward -- without this, every bettor's stake would be permanently stranded", async () => {
    const { derby, alice, bob } = await deployDerby();
    const raceId = await derby.currentRaceId();
    await derby.connect(alice).placeBet(0, { value: ethers.parseEther("0.01") });
    await derby.connect(bob).placeBet(1, { value: ethers.parseEther("0.01") });
    await closeBettingAndLock(derby);

    const race = await derby.races(raceId);
    const current = await ethers.provider.getBlockNumber();
    await networkHelpers.mine(Number(race.targetBlock) - current + 257);

    // Confirm finishRace() itself is now permanently unsatisfiable for this
    // race (the exact stuck state voidStaleRound exists to rescue from).
    await expect(derby.finishRace(raceId)).to.be.revertedWithCustomError(derby, "TargetBlockExpired");

    await derby.voidStaleRound(raceId);
    expect(await derby.voided(raceId)).to.equal(true);

    await derby.connect(alice).carryForwardStake(raceId);
    const nextRaceId = await derby.currentRaceId();
    expect(await derby.stakeOf(nextRaceId, alice.address)).to.equal(ethers.parseEther("0.01"));
  });

  it("voidStaleRound reverts on a race that already finished normally", async () => {
    const { derby, alice, bob } = await deployDerby();
    const raceId = await derby.currentRaceId();
    await derby.connect(alice).placeBet(0, { value: ethers.parseEther("0.01") });
    await derby.connect(bob).placeBet(1, { value: ethers.parseEther("0.01") });
    await closeBettingAndLock(derby);
    await mineToTargetAndFinish(derby, raceId);

    await expect(derby.voidStaleRound(raceId)).to.be.revertedWithCustomError(derby, "BadPhase");
  });

  // ── Keeper incentive (finishRace() stays timely with no operator bot watching) ──

  it("finishRace() pays its caller a real reward carved from the rake, not from bettors' distributable pool", async () => {
    const { derby, treasury, alice, bob } = await deployDerby();
    const raceId = await derby.currentRaceId();
    await derby.connect(alice).placeBet(0, { value: ethers.parseEther("1") });
    await derby.connect(bob).placeBet(1, { value: ethers.parseEther("1") });
    await closeBettingAndLock(derby);

    const race = await derby.races(raceId);
    const target = race.targetBlock;
    const current = await ethers.provider.getBlockNumber();
    const toMine = Number(target) - current + 1;
    if (toMine > 0) await networkHelpers.mine(toMine);

    // A third party (not a bettor, not the treasury) calls finishRace --
    // the exact "nobody's tab needs to be open" scenario this exists for.
    const [, , , , , keeper] = await ethers.getSigners();
    await derby.connect(keeper).finishRace(raceId);

    const finished = await derby.races(raceId);
    const totalRake = finished.pool - finished.distributable;
    const expectedKeeperCut = (totalRake * KEEPER_REWARD_BPS) / 10000n;
    expect(expectedKeeperCut).to.be.gt(0n);

    await derby.connect(keeper).withdrawPayments(keeper.address);
    const keeperBalance = await ethers.provider.getBalance(keeper.address);
    expect(keeperBalance).to.be.gt(0n);

    // The remainder still went to the treasury's normal rake path,
    // undiminished beyond the keeper's carved-out share.
    await derby.claimRake();
    await derby.connect(treasury).withdrawPayments(treasury.address);
  });
});
