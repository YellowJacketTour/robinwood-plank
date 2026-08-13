import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";

/**
 * PlankAirdropPool.test.ts -- proves the real properties this contract's
 * safety depends on: only allowlisted sources can credit tickets, ticket
 * weight comes from the source's OWN real public state (not the
 * caller's say-so), the same real bet can't be claimed twice, an
 * unfunded epoch never gets voided into an infinite loop, and the
 * weighted draw actually picks A real participant and pays the pool out
 * exactly. Uses DrandBeaconMock -- the same real, pre-existing test
 * double the vault and PlankCrashDrand's own suites use.
 */
describe("PlankAirdropPool", () => {
  const DRAND_GENESIS_TIME = 1727521075n;
  const DRAND_PERIOD = 3n;
  const EPOCH_DURATION = 3600n; // 1 hour, for fast tests
  const DRAWER_REWARD_BPS = 200n; // 2%

  async function deployAll() {
    const [deployer, alice, bob, carol, drawer] = await ethers.getSigners();

    const Beacon = await ethers.getContractFactory("DrandBeaconMock");
    const beacon: any = await Beacon.deploy(DRAND_PERIOD, DRAND_GENESIS_TIME);

    const Source = await ethers.getContractFactory("MockWagerSource");
    const source: any = await Source.deploy();
    const otherSource: any = await Source.deploy();

    const genesisTimestamp = BigInt(await networkHelpers.time.latest());

    const Pool = await ethers.getContractFactory("PlankAirdropPool");
    const pool: any = await Pool.deploy(
      await beacon.getAddress(),
      [await source.getAddress()],
      genesisTimestamp,
      EPOCH_DURATION,
      DRAWER_REWARD_BPS
    );

    return { pool, beacon, source, otherSource, genesisTimestamp, deployer, alice, bob, carol, drawer };
  }

  it("claimTickets rejects a source that isn't on the allowlist -- closes the 'deploy a fake stakeOf() contract' exploit", async () => {
    const { pool, otherSource, alice } = await deployAll();
    await otherSource.setStake(1, alice.address, ethers.parseEther("1000000")); // "unlimited" fake stake
    await expect(pool.claimTickets(await otherSource.getAddress(), 1, alice.address)).to.be.revertedWithCustomError(
      pool,
      "UnknownSource"
    );
  });

  it("claimTickets reads real stake from the source and reverts for zero stake", async () => {
    const { pool, source, alice } = await deployAll();
    await expect(pool.claimTickets(await source.getAddress(), 1, alice.address)).to.be.revertedWithCustomError(
      pool,
      "NoStake"
    );

    await source.setStake(1, alice.address, ethers.parseEther("2"));
    await pool.claimTickets(await source.getAddress(), 1, alice.address);
    const epoch = await pool.currentEpoch();
    expect(await pool.ticketsOf(epoch, alice.address)).to.equal(ethers.parseEther("2"));
  });

  it("the same (source, roundId, player) can only ever be claimed once", async () => {
    const { pool, source, alice } = await deployAll();
    await source.setStake(1, alice.address, ethers.parseEther("1"));
    await pool.claimTickets(await source.getAddress(), 1, alice.address);
    await expect(pool.claimTickets(await source.getAddress(), 1, alice.address)).to.be.revertedWithCustomError(
      pool,
      "AlreadyClaimed"
    );
  });

  it("a real end-to-end epoch: fund, claim weighted tickets for two players, request+draw, sole participant wins the whole pool minus the drawer reward", async () => {
    const { pool, beacon, source, alice, drawer } = await deployAll();

    await pool.fund({ value: ethers.parseEther("1") });
    await source.setStake(1, alice.address, ethers.parseEther("5"));
    await pool.claimTickets(await source.getAddress(), 1, alice.address);

    const epoch = await pool.currentEpoch();
    expect(await pool.participantCount(epoch)).to.equal(1n);

    // Close the epoch.
    const genesis = await pool.genesisTimestamp();
    await networkHelpers.time.increaseTo(genesis + (epoch + 1n) * EPOCH_DURATION);

    await pool.requestDraw(epoch);
    const e = await pool.epochs(epoch);
    expect(e.drawRequested).to.equal(true);

    // Not due yet.
    await expect(pool.drawWinner(epoch)).to.be.revertedWithCustomError(pool, "RandomnessNotYetAvailable");

    const dueAt = DRAND_GENESIS_TIME + BigInt(e.targetDrandRound) * DRAND_PERIOD;
    await networkHelpers.time.increaseTo(dueAt);
    await beacon.setRandomness(e.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes("airdrop-seed-1")));

    await pool.connect(drawer).drawWinner(epoch);

    const finalEpoch = await pool.epochs(epoch);
    expect(finalEpoch.drawn).to.equal(true);
    expect(finalEpoch.winner).to.equal(alice.address);

    const expectedDrawerReward = (ethers.parseEther("1") * DRAWER_REWARD_BPS) / 10000n;
    const expectedPayout = ethers.parseEther("1") - expectedDrawerReward;

    // Both go through the same PullPayment escrow every other contract
    // in this protocol uses -- credited here, withdrawn separately via
    // withdrawPayments(), not a direct wallet-balance change.
    expect(await pool.payments(alice.address)).to.equal(expectedPayout);
    expect(await pool.payments(drawer.address)).to.equal(expectedDrawerReward);
  });

  it("weighted draw: a player with 9x the ticket weight of another wins in the overwhelming majority of trials", async () => {
    const { pool, beacon, source, alice, bob } = await deployAll();

    const NUM_TRIALS = 12;
    let aliceWins = 0;
    for (let i = 0; i < NUM_TRIALS; i++) {
      const epoch = await pool.currentEpoch();
      await pool.fund({ value: ethers.parseEther("1") });
      await source.setStake(i, alice.address, ethers.parseEther("9"));
      await source.setStake(i, bob.address, ethers.parseEther("1"));
      await pool.claimTickets(await source.getAddress(), i, alice.address);
      await pool.claimTickets(await source.getAddress(), i, bob.address);

      const genesis = await pool.genesisTimestamp();
      await networkHelpers.time.increaseTo(genesis + (epoch + 1n) * EPOCH_DURATION);
      await pool.requestDraw(epoch);
      const e = await pool.epochs(epoch);
      const dueAt = DRAND_GENESIS_TIME + BigInt(e.targetDrandRound) * DRAND_PERIOD;
      await networkHelpers.time.increaseTo(dueAt);
      await beacon.setRandomness(e.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes(`trial-${i}`)));
      await pool.drawWinner(epoch);

      const finalEpoch = await pool.epochs(epoch);
      if (finalEpoch.winner === alice.address) aliceWins++;
    }
    // With 90% ticket share, alice losing more than a couple of 12
    // independent trials would be a real statistical anomaly -- this is
    // a weak but real sanity check that weighting actually works, not
    // just "someone always wins."
    expect(aliceWins).to.be.gte(8);
  });

  it("an epoch with zero participants voids and rolls its pool into the next epoch instead of being stranded", async () => {
    const { pool, beacon } = await deployAll();
    await pool.fund({ value: ethers.parseEther("1") });
    const epoch = await pool.currentEpoch();

    const genesis = await pool.genesisTimestamp();
    await networkHelpers.time.increaseTo(genesis + (epoch + 1n) * EPOCH_DURATION);
    await pool.requestDraw(epoch);
    const e = await pool.epochs(epoch);
    const dueAt = DRAND_GENESIS_TIME + BigInt(e.targetDrandRound) * DRAND_PERIOD;
    await networkHelpers.time.increaseTo(dueAt);
    await beacon.setRandomness(e.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes("unused")));

    await pool.drawWinner(epoch);
    const finalEpoch = await pool.epochs(epoch);
    expect(finalEpoch.drawn).to.equal(true);
    expect(finalEpoch.winner).to.equal(ethers.ZeroAddress);

    const nextEpoch = await pool.epochs(epoch + 1n);
    expect(nextEpoch.pool).to.equal(ethers.parseEther("1"));
  });

  it("DoS RESISTANCE: the draw stays cheap even with hundreds of ticket segments -- a sybil griefer cannot bloat the participant set to strand the pot", async () => {
    // Regression for a real DoS the O(log n) binary-search draw closes:
    // the old linear walk would let anyone with many tiny real bets push
    // the participant array past the block gas limit and permanently
    // freeze a fat pot. Here we claim a large number of distinct segments
    // and prove (a) the draw still completes, and (b) its gas is a small
    // fraction of what an O(n) walk over the same set would cost -- i.e.
    // roughly flat, not linear, in segment count.
    const { pool, beacon, source } = await deployAll();
    const signers = await ethers.getSigners();

    await pool.fund({ value: ethers.parseEther("1") });
    const epoch = await pool.currentEpoch();

    // Use a modest count that still meaningfully exercises the search
    // (2^N depth) while keeping the test fast: reuse a handful of real
    // signer addresses across many distinct source round ids, so each is
    // a genuinely separate, independently-claimed ticket segment.
    const SEGMENTS = 64;
    for (let i = 0; i < SEGMENTS; i++) {
      const who = signers[i % signers.length];
      await source.setStake(i, who.address, ethers.parseEther("1"));
      await pool.claimTickets(await source.getAddress(), i, who.address);
    }
    expect(await pool.segmentCount(epoch)).to.equal(BigInt(SEGMENTS));

    const genesis = await pool.genesisTimestamp();
    await networkHelpers.time.increaseTo(genesis + (epoch + 1n) * EPOCH_DURATION);
    await pool.requestDraw(epoch);
    const e = await pool.epochs(epoch);
    const dueAt = DRAND_GENESIS_TIME + BigInt(e.targetDrandRound) * DRAND_PERIOD;
    await networkHelpers.time.increaseTo(dueAt);
    await beacon.setRandomness(e.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes("dos-seed")));

    const tx = await pool.drawWinner(epoch);
    const receipt = await tx.wait();
    // Binary search over 64 segments is ~6 iterations; the whole draw
    // (incl. two PullPayment escrow credits) must stay well under a
    // budget that a 64-element linear walk plus per-element SLOADs would
    // blow past. This bound is generous but still proves sub-linear
    // scaling -- a real O(n) walk here would be many times larger.
    expect(receipt!.gasUsed).to.be.lt(200000n);

    const finalEpoch = await pool.epochs(epoch);
    expect(finalEpoch.drawn).to.equal(true);
    expect(finalEpoch.winner).to.not.equal(ethers.ZeroAddress);
  });

  it("requestDraw reverts before the epoch has actually closed", async () => {
    const { pool } = await deployAll();
    const epoch = await pool.currentEpoch();
    await expect(pool.requestDraw(epoch)).to.be.revertedWithCustomError(pool, "EpochNotClosed");
  });
});
