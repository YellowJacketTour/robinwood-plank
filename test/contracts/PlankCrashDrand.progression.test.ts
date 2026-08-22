import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";

/**
 * The wired-up progression integration against a REAL PlankCrashDrand --
 * cap enforcement, premium skimming into the real Vault reserve, and rank
 * actually advancing through real bets. PlankProgression's own rank-math
 * correctness is covered in isolation in PlankProgression.test.ts; this
 * file is specifically about the two contracts working together, and about
 * the deployer-gated one-time wiring itself.
 *
 * fuelBooster/powerboard are EOA stand-ins here, not real contracts --
 * PlankProgression only checks msg.sender against these addresses, so a
 * plain signer exercises the exact same access-control path a real
 * PlankFuelBooster/PlankPowerboard would. Their OWN sides of this wiring
 * (that burnFuel/claimTickets actually call recordFuelBurn/
 * recordPowerboardClaim) are covered in PlankFuelBooster.test.ts and
 * PlankPowerboard.test.ts respectively, against their real fixtures.
 */
describe("PlankCrashDrand x PlankProgression integration", () => {
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;
  const BETTING_SECONDS = 20;

  async function deploy() {
    const [deployer, treasury, alice, bob, fuelStandIn, pbStandIn] = await ethers.getSigners();
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);

    const crash: any = await (
      await ethers.getContractFactory("PlankCrashDrand")
    ).deploy({
      bettingDurationSeconds: BETTING_SECONDS,
      roundIntervalSeconds: 0,
      maxAwaitBlocks: 300,
      maxElapsedBlocks: 1800,
      registrationWindowBlocks: 50,
      rakeBps: 450n,
      minParticipants: 1n, // isolate progression behavior from the unrelated participant-count void path
      minPoolSize: 0n,
      maxStakePerWalletBps: 10000n, // isolate progression's OWN cap from the pre-existing pool-relative cap
      keeperRewardBps: 0n,
      seedNumerator: 1n,
      seedDenominator: 8n,
      reserveShareBps: 0n,
      reserveFloorWei: 0n,
      reserveCap: 0n,
      jackpotSink: ethers.ZeroAddress,
      treasury: treasury.address,
      beacon: await beacon.getAddress(),
    });
    const crashAddr = await crash.getAddress();

    const progression: any = await (
      await ethers.getContractFactory("PlankProgression")
    ).deploy(crashAddr, fuelStandIn.address, pbStandIn.address);

    return { crash, crashAddr, progression, beacon, deployer, treasury, alice, bob, fuelStandIn, pbStandIn };
  }

  it("setProgression is restricted to the crash contract's own deployer, exactly once", async () => {
    const { crash, progression, alice } = await deploy();
    const progressionAddr = await progression.getAddress();

    await expect(crash.connect(alice).setProgression(progressionAddr)).to.be.revertedWithCustomError(
      crash,
      "NotDeployer"
    );

    await (await crash.setProgression(progressionAddr)).wait();
    expect(await crash.progression()).to.equal(progressionAddr);

    await expect(crash.setProgression(progressionAddr)).to.be.revertedWithCustomError(
      crash,
      "ProgressionAlreadySet"
    );
  });

  it("with progression unset, behavior is byte-identical to before -- no cap, no premium", async () => {
    const { crash, alice } = await deploy();
    // Well above every rank-based cap this feature would ever impose, and
    // the pool-relative cap is disabled (maxStakePerWalletBps=10000) for
    // this fixture -- should succeed with the FULL amount as the stake,
    // no premium skimmed anywhere.
    const stake = ethers.parseEther("50");
    await (await crash.connect(alice).placeBet({ value: stake })).wait();
    expect(await crash.stakeOf(1, alice.address)).to.equal(stake);
    expect(await crash.reserve()).to.equal(0n); // nothing to skim -- progression was never wired
  });

  it("rejects a bet above the Sapling cap once progression is wired, even with the pool-relative cap disabled", async () => {
    const { crash, progression, alice } = await deploy();
    await (await crash.setProgression(await progression.getAddress())).wait();

    const saplingCap = await progression.CAP_SAPLING();
    await expect(crash.connect(alice).placeBet({ value: saplingCap + 1n })).to.be.revertedWithCustomError(
      crash,
      "StakeExceedsCap"
    );
    // Exactly at the cap succeeds -- the CAP check is against the gross
    // payment, but the recorded stake is net of the Sapling premium (this
    // bet is above the exempt threshold, so 15% is skimmed to the Vault;
    // see the dedicated premium test below for that behavior in isolation).
    await (await crash.connect(alice).placeBet({ value: saplingCap })).wait();
    const expectedNet = saplingCap - (saplingCap * 1500n) / 10000n;
    expect(await crash.stakeOf(1, alice.address)).to.equal(expectedNet);
  });

  it("skims the rank-based premium into the real Vault reserve, and never counts it as the payer's own stake", async () => {
    const { crash, progression, alice } = await deploy();
    await (await crash.setProgression(await progression.getAddress())).wait();

    // Above the exempt threshold, so the Sapling premium (15%) applies.
    const exempt = await progression.FIRST_BET_EXEMPT_WEI();
    const gross = exempt * 2n; // still well under CAP_SAPLING
    const expectedPremium = (gross * 1500n) / 10000n;
    const expectedNetStake = gross - expectedPremium;

    const reserveBefore = await crash.reserve();
    await (await crash.connect(alice).placeBet({ value: gross })).wait();

    expect(await crash.stakeOf(1, alice.address)).to.equal(expectedNetStake);
    expect(await crash.reserve()).to.equal(reserveBefore + expectedPremium);
    // The pool only ever grew by the NET stake, never the gross payment --
    // conservation of the premium's destination (Vault, not the pot).
    const round = await crash.rounds(1);
    expect(round.pool).to.equal(expectedNetStake);
  });

  it("never taxes a bet at or below the exempt threshold, regardless of rank", async () => {
    const { crash, progression, alice } = await deploy();
    await (await crash.setProgression(await progression.getAddress())).wait();

    const exempt = await progression.FIRST_BET_EXEMPT_WEI();
    await (await crash.connect(alice).placeBet({ value: exempt })).wait();
    expect(await crash.stakeOf(1, alice.address)).to.equal(exempt);
    expect(await crash.reserve()).to.equal(0n);
  });

  it("advances rank through real bets, and a higher rank's larger cap actually unlocks a bigger bet", async () => {
    const { crash, progression, beacon, alice } = await deploy();
    await (await crash.setProgression(await progression.getAddress())).wait();

    const saplingCap = await progression.CAP_SAPLING();
    const perBet = saplingCap / 2n; // comfortably under the Sapling cap every round

    let i = 0;
    while ((await progression.rankOf(alice.address)) === 0n /* Sapling */ && i < 50) {
      const roundId = await crash.currentRoundId();
      await (await crash.connect(alice).placeBet({ value: perBet })).wait();

      // Lock, then reveal with entropy that resolves to an IMMEDIATE crash
      // (r=0 -> elapsed=0 -> 1.00x), then settle right away -- so a fresh
      // round genuinely opens for the next bet, instead of leaving this
      // one stuck LIVE forever (settleRound, not lockRound, is what calls
      // _startRound for the next one).
      await networkHelpers.time.increase(BETTING_SECONDS + 1);
      await (await crash.lockRound()).wait();
      const r = await crash.rounds(roundId);
      // r=0 -> immediate 1.00x crash, but the beacon's own "not yet
      // available" sentinel IS bytes32(0) -- use the smallest NONZERO
      // value that's still ≡ 0 (mod 10000) so _deriveCrash sees r=0
      // without also looking unset to the beacon itself.
      const immediateCrash = ethers.zeroPadValue(ethers.toBeHex(10000n), 32);
      await beacon.setRandomness(r.targetDrandRound, immediateCrash);
      await (await crash.revealEntropy(roundId)).wait();
      await (await crash.settleRound(roundId)).wait();
      i++;
    }

    expect(await progression.rankOf(alice.address)).to.equal(1n); // Rank.Stick
    const stickCap = await progression.CAP_STICK();
    expect(stickCap).to.be.greaterThan(saplingCap);

    // A bet ABOVE the Sapling cap but AT/BELOW the newly-earned Stick cap
    // now succeeds -- proving the cap is genuinely rank-driven, not stuck
    // at the wallet's original ceiling.
    const overSapling = saplingCap + 1n;
    expect(overSapling).to.be.at.most(stickCap);
    await (await crash.connect(alice).placeBet({ value: overSapling })).wait();
  });
});
