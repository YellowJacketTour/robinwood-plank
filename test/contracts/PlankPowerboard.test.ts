import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";

/**
 * POWERBOARD -- proves the rollover engine actually compounds, that the
 * jackpot can only be won on a real Plank Ball hit, and that every safety
 * property carried over from the old airdrop pool still holds (immutable
 * source allowlist, one-claim-per-bet, O(log n) draw).
 *
 * The ball and the winning ticket are both derived from ONE drand value,
 * so a test can pick a seed that deterministically hits or misses. These
 * tests search for such seeds rather than hardcoding magic numbers, so
 * they stay valid if the domain tags or ball range ever change.
 */
describe("PlankPowerboard", () => {
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;
  const EPOCH = 3600n; // 1h for fast tests
  const DRAWER_REWARD_BPS = 200n; // 2%
  const BALL_RANGE = 26n;
  const JACKPOT_BALL = 8n; // memetic: the 8 in 8.1% / 1.8%
  const CONSOLATION_BPS = 500n; // 5% of the pot on a miss

  /// Mirrors the contract's own ball derivation exactly, so a test can
  /// find a seed that lands on (or off) the jackpot ball.
  function ballFor(seedStr: string): bigint {
    const randomness = ethers.keccak256(ethers.toUtf8Bytes(seedStr));
    const h = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "string"], [randomness, "PLANK_BALL"])
    );
    return (BigInt(h) % BALL_RANGE) + 1n;
  }

  function findSeed(wantHit: boolean): string {
    for (let i = 0; i < 5000; i++) {
      const s = `pb-seed-${i}`;
      if ((ballFor(s) === JACKPOT_BALL) === wantHit) return s;
    }
    throw new Error("no seed found");
  }

  async function deploy() {
    const [deployer, alice, bob, drawer] = await ethers.getSigners();
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const source: any = await (await ethers.getContractFactory("MockWagerSource")).deploy();
    const other: any = await (await ethers.getContractFactory("MockWagerSource")).deploy();
    const pb: any = await (
      await ethers.getContractFactory("PlankPowerboard")
    ).deploy({
      beacon: await beacon.getAddress(),
      allowedSources: [await source.getAddress()],
      genesisTimestamp: DRAND_GENESIS,
      epochDuration: EPOCH,
      drawerRewardBps: DRAWER_REWARD_BPS,
      ballRange: BALL_RANGE,
      jackpotBall: JACKPOT_BALL,
      consolationBps: CONSOLATION_BPS,
      mustHitByEpochs: 0n,
    });
    return { pb, beacon, source, other, deployer, alice, bob, drawer };
  }

  /// Plays one epoch: funds, claims a ticket for `who`, closes the epoch,
  /// and draws with a chosen seed.
  async function playEpoch(
    pb: any,
    beacon: any,
    source: any,
    who: any,
    sourceRound: number,
    seedStr: string,
    drawer: any
  ) {
    const epoch = await pb.currentEpoch();
    await source.setStake(sourceRound, who.address, ethers.parseEther("1"));
    await pb.claimTickets(await source.getAddress(), sourceRound, who.address);
    await networkHelpers.time.increaseTo(DRAND_GENESIS + (epoch + 1n) * EPOCH);
    await pb.requestDraw(epoch);
    const e = await pb.epochs(epoch);
    await networkHelpers.time.increaseTo(DRAND_GENESIS + BigInt(e.targetDrandRound) * DRAND_PERIOD);
    await beacon.setRandomness(e.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes(seedStr)));
    await pb.connect(drawer).drawWinner(epoch);
    return epoch;
  }

  it("rejects nonsense config: a ball range that makes the jackpot unwinnable or guaranteed", async () => {
    const [deployer] = await ethers.getSigners();
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const PB = await ethers.getContractFactory("PlankPowerboard");
    const base = {
      beacon: await beacon.getAddress(),
      allowedSources: [] as string[],
      genesisTimestamp: DRAND_GENESIS,
      epochDuration: EPOCH,
      drawerRewardBps: DRAWER_REWARD_BPS,
      ballRange: BALL_RANGE,
      jackpotBall: JACKPOT_BALL,
      consolationBps: CONSOLATION_BPS,
      mustHitByEpochs: 0n,
    };
    // ballRange 1 -> every epoch is a guaranteed jackpot, no rollover.
    await expect(PB.deploy({ ...base, ballRange: 1n })).to.be.revertedWithCustomError(PB, "BadConfig");
    // ball outside the range -> jackpot could NEVER hit, pot grows forever.
    await expect(PB.deploy({ ...base, jackpotBall: BALL_RANGE + 1n })).to.be.revertedWithCustomError(PB, "BadConfig");
    void deployer;
  });

  it("ROLLOVER: a miss pays only the consolation slice and compounds the rest into a strictly bigger jackpot", async () => {
    const { pb, beacon, source, alice, drawer } = await deploy();
    const missSeed = findSeed(false);
    expect(ballFor(missSeed)).to.not.equal(JACKPOT_BALL);

    await pb.fund({ value: ethers.parseEther("10") });
    const before = await pb.jackpot();

    const epoch = await playEpoch(pb, beacon, source, alice, 1, missSeed, drawer);
    const e = await pb.epochs(epoch);

    expect(e.jackpotHit).to.equal(false);
    expect(e.winner).to.equal(alice.address);
    const expectedPrize = (before * CONSOLATION_BPS) / 10000n;
    expect(e.prize).to.equal(expectedPrize);

    // The pot did NOT reset -- it rolled over, minus only the consolation.
    expect(await pb.jackpot()).to.equal(before - expectedPrize);
    expect(await pb.jackpot()).to.be.gt((before * 9n) / 10n); // still ~95% intact

    // Winner and drawer are paid through the escrow, never the caller.
    const drawerReward = (expectedPrize * DRAWER_REWARD_BPS) / 10000n;
    expect(await pb.payments(alice.address)).to.equal(expectedPrize - drawerReward);
    expect(await pb.payments(drawer.address)).to.equal(drawerReward);
  });

  it("JACKPOT: when the Plank Ball hits, the winner takes the ENTIRE rolling pot and it resets", async () => {
    const { pb, beacon, source, alice, drawer } = await deploy();
    const hitSeed = findSeed(true);
    expect(ballFor(hitSeed)).to.equal(JACKPOT_BALL);

    await pb.fund({ value: ethers.parseEther("10") });
    const before = await pb.jackpot();

    const epoch = await playEpoch(pb, beacon, source, alice, 1, hitSeed, drawer);
    const e = await pb.epochs(epoch);

    expect(e.jackpotHit).to.equal(true);
    expect(e.drawnBall).to.equal(JACKPOT_BALL);
    expect(e.prize).to.equal(before); // the WHOLE pot
    expect(await pb.jackpot()).to.equal(0n); // reset, ready to grow again
    expect(await pb.jackpotsHit()).to.equal(1n);

    const drawerReward = (before * DRAWER_REWARD_BPS) / 10000n;
    expect(await pb.payments(alice.address)).to.equal(before - drawerReward);
  });

  it("COMPOUNDING: across several missed epochs the jackpot strictly grows, exactly the mechanic that makes rollovers work", async () => {
    const { pb, beacon, source, alice, drawer } = await deploy();
    const missSeeds: string[] = [];
    for (let i = 0; i < 5000 && missSeeds.length < 3; i++) {
      const s = `roll-${i}`;
      if (ballFor(s) !== JACKPOT_BALL) missSeeds.push(s);
    }

    const snapshots: bigint[] = [];
    for (let i = 0; i < missSeeds.length; i++) {
      // Each epoch the rake tops the pot up, and each miss leaves most of
      // it in place -- so the pot ratchets upward.
      await pb.fund({ value: ethers.parseEther("5") });
      await playEpoch(pb, beacon, source, alice, 100 + i, missSeeds[i], drawer);
      snapshots.push(await pb.jackpot());
    }

    expect(snapshots.length).to.equal(3);
    expect(snapshots[1]).to.be.gt(snapshots[0]);
    expect(snapshots[2]).to.be.gt(snapshots[1]);
  });

  it("an epoch nobody played is skipped and the jackpot keeps rolling -- never stranded, never burned", async () => {
    const { pb, beacon, drawer } = await deploy();
    await pb.fund({ value: ethers.parseEther("3") });
    const before = await pb.jackpot();

    const epoch = await pb.currentEpoch();
    await networkHelpers.time.increaseTo(DRAND_GENESIS + (epoch + 1n) * EPOCH);
    await pb.requestDraw(epoch);
    const e = await pb.epochs(epoch);
    await networkHelpers.time.increaseTo(DRAND_GENESIS + BigInt(e.targetDrandRound) * DRAND_PERIOD);
    await beacon.setRandomness(e.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes("empty")));
    await pb.connect(drawer).drawWinner(epoch);

    const after = await pb.epochs(epoch);
    expect(after.drawn).to.equal(true);
    expect(after.winner).to.equal(ethers.ZeroAddress);
    expect(await pb.jackpot()).to.equal(before); // fully intact
  });

  it("carries over the old pool's safety properties: allowlist-gated sources and one claim per real bet", async () => {
    const { pb, source, other, alice } = await deploy();
    // A fake source reporting enormous stake cannot mint odds.
    await other.setStake(1, alice.address, ethers.parseEther("1000000"));
    await expect(pb.claimTickets(await other.getAddress(), 1, alice.address)).to.be.revertedWithCustomError(
      pb,
      "UnknownSource"
    );
    // The same real bet can only be credited once.
    await source.setStake(1, alice.address, ethers.parseEther("1"));
    await pb.claimTickets(await source.getAddress(), 1, alice.address);
    await expect(pb.claimTickets(await source.getAddress(), 1, alice.address)).to.be.revertedWithCustomError(
      pb,
      "AlreadyClaimed"
    );
  });

  it("previewPrizes reports the honest hit/miss split the UI should show", async () => {
    const { pb } = await deploy();
    await pb.fund({ value: ethers.parseEther("10") });
    const [ifHit, ifMiss] = await pb.previewPrizes();
    expect(ifHit).to.equal(ethers.parseEther("10"));
    expect(ifMiss).to.equal((ethers.parseEther("10") * CONSOLATION_BPS) / 10000n);
    expect(await pb.jackpotOddsOneIn()).to.equal(BALL_RANGE);
  });

  it("weighted odds: a 9x-stake holder wins the large majority of drawn tickets", async () => {
    const { pb, beacon, source, alice, bob, drawer } = await deploy();
    let aliceWins = 0;
    const TRIALS = 12;
    for (let i = 0; i < TRIALS; i++) {
      await pb.fund({ value: ethers.parseEther("1") });
      const epoch = await pb.currentEpoch();
      await source.setStake(500 + i, alice.address, ethers.parseEther("9"));
      await source.setStake(600 + i, bob.address, ethers.parseEther("1"));
      await pb.claimTickets(await source.getAddress(), 500 + i, alice.address);
      await pb.claimTickets(await source.getAddress(), 600 + i, bob.address);
      await networkHelpers.time.increaseTo(DRAND_GENESIS + (epoch + 1n) * EPOCH);
      await pb.requestDraw(epoch);
      const e = await pb.epochs(epoch);
      await networkHelpers.time.increaseTo(DRAND_GENESIS + BigInt(e.targetDrandRound) * DRAND_PERIOD);
      await beacon.setRandomness(e.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes(`w-${i}`)));
      await pb.connect(drawer).drawWinner(epoch);
      if ((await pb.epochs(epoch)).winner === alice.address) aliceWins++;
    }
    expect(aliceWins).to.be.gte(8);
  });

  it("MUST BE WON: after mustHitByEpochs misses the next draw force-pays the FULL jackpot, no matter the ball", async () => {
    const [deployer, alice, bob, drawer] = await ethers.getSigners();
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const source: any = await (await ethers.getContractFactory("MockWagerSource")).deploy();
    const pb: any = await (
      await ethers.getContractFactory("PlankPowerboard")
    ).deploy({
      beacon: await beacon.getAddress(),
      allowedSources: [await source.getAddress()],
      genesisTimestamp: DRAND_GENESIS,
      epochDuration: EPOCH,
      drawerRewardBps: DRAWER_REWARD_BPS,
      ballRange: BALL_RANGE,
      jackpotBall: JACKPOT_BALL,
      consolationBps: CONSOLATION_BPS,
      mustHitByEpochs: 3n, // must pay out at least every 3 epochs
    });
    void bob;

    const missSeed = findSeed(false);
    expect(ballFor(missSeed)).to.not.equal(JACKPOT_BALL);
    await pb.fund({ value: ethers.parseEther("10") });
    // The clock starts at deployment, so the guarantee is due 3 epochs out.
    const e0 = await pb.currentEpoch();
    expect(await pb.guaranteedHitByEpoch()).to.equal(e0 + 3n);

    // The first 3 epochs are real MISSES -> consolation only, jackpot rolls.
    for (let r = 1; r <= 3; r++) {
      const epoch = await playEpoch(pb, beacon, source, alice, r, missSeed, drawer);
      expect((await pb.epochs(epoch)).jackpotHit).to.equal(false);
    }

    // The 4th epoch (e0+3): still a MISS ball, but the guarantee is due -> FULL jackpot pays.
    const potBefore = await pb.jackpot();
    const epoch = await playEpoch(pb, beacon, source, alice, 4, missSeed, drawer);
    expect(epoch).to.equal(e0 + 3n);
    const e = await pb.epochs(epoch);
    expect(ballFor(missSeed)).to.not.equal(JACKPOT_BALL); // the ball still missed
    expect(e.jackpotHit).to.equal(true); // ...but the guarantee forced a full payout
    expect(e.prize).to.equal(potBefore); // the WHOLE pot
    expect(await pb.jackpot()).to.equal(0n); // fully paid, reset
    expect(await pb.jackpotsHit()).to.equal(1n);
    // The clock reset: next guarantee is 3 epochs out from here.
    expect(await pb.guaranteedHitByEpoch()).to.equal(e0 + 6n);
    void deployer;
  });
});
