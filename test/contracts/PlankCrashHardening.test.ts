import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { HARDENING_TEST_DEFAULTS, hardeningFor, multiplierAt, splitPayout, weightsAt } from "./helpers/crashHardening.js";

/**
 * Phase 3 go-live hardening of PlankCrashDrand -- the "attack fails" tests
 * required by docs/marketplank/SPEC-CRASH-GO-LIVE-HARDENING.md §5, named
 * exactly as that table names them (C1..C8), plus:
 *   - invariant I-a as a fuzz over randomized relay/reveal/cash-out
 *     ordering (>= 5 seeds): no sequence lets ANY player set a cash-out at
 *     or after revealNotBefore, and the effective cash-out block is always
 *     min(manual, lockBlock + invert(auto));
 *   - a pool-conservation property under the single-payout cap.
 *
 * Hardening constants used here are the spec's §6 PROPOSED values (review
 * MED-3: the fixture defaults in helpers/crashHardening.ts ARE the proposals,
 * so these suites exercise what would ship); they remain unratified.
 */
describe("PlankCrashDrand — Phase 3 go-live hardening (a)(b)(c)", () => {
  const DRAND_PERIOD = 3n;
  const DRAND_GENESIS = 1727521075n;
  const BETTING = 30; // long enough that register + window blocks never close the next round's betting
  const MAX_ELAPSED = 40;
  const REG = 6;
  const AWAIT = 60;
  const RAKE_BPS = 450n;
  const KEEPER_BPS = 500n;
  const SEED_MAX_BPS = HARDENING_TEST_DEFAULTS.seedMaxBps; // 500: the binding seed fraction under the proposals (num/den 1/2 is looser)
  const CAP_BPS = HARDENING_TEST_DEFAULTS.singlePayoutCapBps;
  const MARGIN = 2n * DRAND_PERIOD; // CASHOUT_CLOSE_MARGIN_PERIODS * period (MED-1)
  const seedFor = (reserve: bigint) => (reserve * SEED_MAX_BPS) / 10000n;

  function prng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  async function deploy(over: Record<string, any> = {}) {
    const signers = await ethers.getSigners();
    const [deployer, treasury, alice, bob, carol, dave, erin] = signers;
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const cfg: Record<string, any> = {
      bettingDurationSeconds: BETTING,
      roundIntervalSeconds: 0,
      maxAwaitBlocks: AWAIT,
      maxElapsedBlocks: MAX_ELAPSED,
      registrationWindowBlocks: REG,
      rakeBps: RAKE_BPS,
      minParticipants: 2n,
      minPoolSize: ethers.parseEther("0.001"),
      maxStakePerWalletBps: 10000n, // whale cap off: irrelevant to these properties
      keeperRewardBps: KEEPER_BPS,
      seedNumerator: 1n,
      seedDenominator: 2n,
      reserveShareBps: 0n,
      reserveFloorWei: 0n,
      reserveCap: 0n,
      jackpotSink: ethers.ZeroAddress,
      treasury: treasury.address,
      beacon: await beacon.getAddress(),
      ...hardeningFor(MAX_ELAPSED),
      ...over,
    };
    const Crash = await ethers.getContractFactory("PlankCrashDrand");
    const crash: any = await Crash.deploy(cfg);
    return { crash, beacon, Crash, cfg, deployer, treasury, alice, bob, carol, dave, erin, signers };
  }

  async function lock(crash: any, signer?: any) {
    await networkHelpers.time.increase(BETTING + 1);
    await (signer ? crash.connect(signer) : crash).lockRound();
  }

  /// Finds a randomness value whose crash point is >= 1 block (so a 1.0001x
  /// auto target wins) and <= the cap -- deterministic per label.
  async function winnableRandomness(crash: any, label: string) {
    for (let i = 0; i < 50; i++) {
      const v = ethers.keccak256(ethers.toUtf8Bytes(`${label}-${i}`));
      const [, elapsed] = await crash._deriveCrash(v);
      if (elapsed >= 1n && elapsed <= BigInt(MAX_ELAPSED)) return v;
    }
    throw new Error("no winnable randomness found");
  }

  async function revealWith(crash: any, beacon: any, rid: bigint, randomness: string, signer?: any) {
    const r = await crash.rounds(rid);
    const now = BigInt(await networkHelpers.time.latest());
    if (r.revealNotBefore > now) await networkHelpers.time.increaseTo(r.revealNotBefore);
    await beacon.setRandomness(r.targetDrandRound, randomness);
    await (signer ? crash.connect(signer) : crash).revealEntropy(rid);
  }

  async function settle(crash: any, rid: bigint, signer?: any) {
    const r = await crash.rounds(rid);
    const eff = r.trueCrashElapsedBlocks < BigInt(MAX_ELAPSED) ? r.trueCrashElapsedBlocks : BigInt(MAX_ELAPSED);
    const cur = BigInt(await ethers.provider.getBlockNumber());
    const target = r.lockBlock + eff;
    if (target > cur) await networkHelpers.mine(Number(target - cur));
    await (signer ? crash.connect(signer) : crash).settleRound(rid);
  }

  /// Full round: alice commits a 1.0001x auto target (wins whenever the
  /// crash is >= 1 block), bob rides to the crash. Returns the settled id.
  async function playSeededRound(crash: any, beacon: any, alice: any, bob: any, label: string) {
    const rid: bigint = await crash.currentRoundId();
    await crash.connect(alice).placeBet(10001n, { value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("1") });
    await lock(crash);
    await revealWith(crash, beacon, rid, await winnableRandomness(crash, label));
    await settle(crash, rid);
    await crash.registerResult(rid, alice.address);
    await crash.registerResult(rid, bob.address);
    await networkHelpers.mine(REG + 1);
    return rid;
  }

  // ───────────────────────────── C1 ─────────────────────────────────────
  it("noCashOutAfterRevealNotBefore", async () => {
    // Invariant I-a, fuzzed: randomized relay / reveal / cash-out / time /
    // block ordering across >= 5 seeds, under a SEQUENCER-LAG MODEL (review
    // MED-1): wall-clock = chain clock + delta, delta = (seed mod 9) periods
    // i.e. 0..8 periods -- most seeds lag MORE than the 2-period margin.
    // The relayer can only inject the target round once it exists in
    // wall-clock terms (chain time + delta >= emission). Whatever the order,
    // (1) every SUCCESSFUL manual cash-out landed in a block with timestamp
    // < revealNotBefore = emission - margin AND before the round had been
    // relayed (the clock-independent belt), (2) every manual cash-out
    // attempted at or after revealNotBefore, or after the relay, reverted
    // CashOutWindowClosed -- regardless of on-chain reveal state -- and
    // (3) the effective cash-out block is exactly min(manual, lockBlock +
    // invert(auto)).
    const AUTO_CHOICES = [0n, 10001n, multiplierAt(3), multiplierAt(10)];
    let totalSuccesses = 0;
    let totalAfterClose = 0;
    let totalBeltOnly = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const rand = prng(seed);
      const delta = BigInt(seed % 9) * DRAND_PERIOD; // sequencer lag, seconds (the LCG's first draw barely depends on the seed)
      const { crash, beacon, alice, bob } = await deploy();
      const rid: bigint = await crash.currentRoundId();
      const autos: Record<string, bigint> = {
        [alice.address]: AUTO_CHOICES[Math.floor(rand() * AUTO_CHOICES.length)],
        [bob.address]: AUTO_CHOICES[Math.floor(rand() * AUTO_CHOICES.length)],
      };
      await crash.connect(alice).placeBet(autos[alice.address], { value: ethers.parseEther("0.5") });
      await crash.connect(bob).placeBet(autos[bob.address], { value: ethers.parseEther("0.5") });
      await lock(crash);
      const r = await crash.rounds(rid);
      const rnb: bigint = r.revealNotBefore;
      const emission = DRAND_GENESIS + (BigInt(r.targetDrandRound) - 1n) * DRAND_PERIOD;
      expect(rnb).to.equal(emission - MARGIN);

      const manualBlock: Record<string, bigint> = {};
      let relayed = false;
      let attemptsAfterClose = 0;
      let attempts = 0;
      let successes = 0;
      // The target round is >= 21 periods (63 s) after lock; ~48 steps of
      // 1..12 s time hops plus ~1 s per mined block straddle that boundary
      // on most seeds (and stay short of it on some -- both are wanted).
      for (let step = 0; step < 48; step++) {
        const op = Math.floor(rand() * 6);
        if (op === 0) {
          await networkHelpers.time.increase(1 + Math.floor(rand() * 12));
        } else if (op === 1) {
          await networkHelpers.mine(1 + Math.floor(rand() * 3));
        } else if (op === 2) {
          // Lag model: the signature exists (and a player who fetched it
          // knows the crash point) once WALL time reaches emission, i.e.
          // chain time >= emission - delta. When delta > MARGIN the chain-
          // clock gate alone would still be open for a while -- the belt
          // must close it the moment the relay lands.
          const chainNow = BigInt(await networkHelpers.time.latest());
          if (chainNow + delta >= emission) {
            await beacon.setRandomness(r.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes(`c1-${seed}-${step}`)));
            relayed = true;
          }
        } else if (op === 3) {
          await crash.revealEntropy(rid).catch(() => {});
        } else {
          const who = op === 4 ? alice : bob;
          const latest = BigInt(await networkHelpers.time.latest());
          const nextTsAtLeast = latest + 1n;
          attempts++;
          try {
            const tx = await crash.connect(who).cashOut(rid);
            const rc = await tx.wait();
            const blk = await ethers.provider.getBlock(rc.blockNumber);
            expect(BigInt(blk!.timestamp), `seed ${seed} step ${step}: cash-out landed at/after revealNotBefore`).to.be.lt(rnb);
            expect(relayed, `seed ${seed} step ${step}: cash-out landed after the round was relayed (belt failed)`).to.equal(false);
            manualBlock[who.address] = BigInt(rc.blockNumber);
            successes++;
          } catch (err: any) {
            if (nextTsAtLeast >= rnb || relayed) {
              attemptsAfterClose++;
              if (relayed && nextTsAtLeast < rnb) totalBeltOnly++; // the chain clock said open; only the belt closed it
              expect(String(err?.message ?? err), `seed ${seed} step ${step}: wrong revert after the window closed`).to.include(
                "CashOutWindowClosed"
              );
            }
          }
        }
      }

      // (3) effective block == min(manual, lockBlock + invert(auto)), a pure
      // function of at-or-before-lock data plus <= 1 pre-revealNotBefore action.
      for (const who of [alice, bob]) {
        const auto = autos[who.address];
        const manual = manualBlock[who.address];
        let expected = manual ?? 0n;
        if (auto !== 0n) {
          const autoBlock = r.lockBlock + (await crash._invertMultiplier(auto));
          expected = manual !== undefined && manual < autoBlock ? manual : autoBlock;
        }
        expect(await crash.effectiveCashOutBlock(rid, who.address), `seed ${seed} ${who.address}`).to.equal(expected);
        expect(await crash.cashOutBlockOf(rid, who.address)).to.equal(manual ?? 0n);
        expect(await crash.autoCashOutBps(rid, who.address)).to.equal(auto);
      }
      // Sanity that the fuzz really attempted cash-outs on this seed.
      expect(attempts, `seed ${seed} attempted nothing`).to.be.gt(0);
      totalSuccesses += successes;
      totalAfterClose += attemptsAfterClose;

      // The round is still settleable after any ordering.
      if (!(await crash.rounds(rid)).entropyRevealed) await revealWith(crash, beacon, rid, await winnableRandomness(crash, `c1-tail-${seed}`));
      await settle(crash, rid);
      expect((await crash.rounds(rid)).phase).to.equal(2n);
    }
    // Across the seeds both sides of the boundary were exercised, and the
    // lag model produced at least one case only the belt could close.
    expect(totalSuccesses, "no cash-out ever succeeded").to.be.gt(0);
    expect(totalAfterClose, "no cash-out was ever attempted after the close").to.be.gt(0);
    expect(totalBeltOnly, "the lag model never produced a belt-only close (delta > margin)").to.be.gt(0);
  });

  // ───────────────────────────── C2 ─────────────────────────────────────
  it("autoTargetImmutable", async () => {
    const { crash, alice, bob } = await deploy();
    // No mutator exists: presetCashOut is gone and nothing else writes the target.
    const fns = crash.interface.fragments.filter((f: any) => f.type === "function").map((f: any) => f.name);
    expect(fns).to.not.include("presetCashOut");
    expect(fns.filter((n: string) => /auto/i.test(n))).to.deep.equal(["autoCashOutBps"]); // the getter only

    const rid: bigint = await crash.currentRoundId();
    const target = multiplierAt(5);
    await crash.connect(alice).placeBet(target, { value: ethers.parseEther("0.5") });
    expect(await crash.autoCashOutBps(rid, alice.address)).to.equal(target);
    // Cannot re-bet to change it.
    await expect(crash.connect(alice).placeBet(multiplierAt(20), { value: 1n })).to.be.revertedWithCustomError(crash, "AlreadyBet");
    // Bounds: below 1.00x and above the explicit max are rejected at commit time.
    await expect(crash.connect(bob).placeBet(9999n, { value: 1n })).to.be.revertedWithCustomError(crash, "BadAutoTarget");
    await expect(crash.connect(bob).placeBet(multiplierAt(MAX_ELAPSED) + 1n, { value: 1n })).to.be.revertedWithCustomError(
      crash,
      "BadAutoTarget"
    );

    // A void (only 1 participant) + carry-forward copies the target verbatim.
    await lock(crash);
    expect(await crash.voided(rid)).to.equal(true);
    await crash.connect(alice).carryForwardStake(rid);
    const rid2: bigint = await crash.currentRoundId();
    expect(await crash.autoCashOutBps(rid2, alice.address)).to.equal(target);
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("0.5") });
    await lock(crash);
    // A manual cash-out (earlier) does not touch the committed target.
    await crash.connect(alice).cashOut(rid2);
    expect(await crash.autoCashOutBps(rid2, alice.address)).to.equal(target);
    expect(await crash.cashOutBlockOf(rid2, alice.address)).to.be.lt((await crash.rounds(rid2)).lockBlock + 5n);
  });

  // ───────────────────────────── C3 ─────────────────────────────────────
  it("singlePayoutCapped", async () => {
    // Under the proposals the seed is 5% of the Vault and the per-wallet
    // house-side cap is 2% of reserveAtLock. To make the (b).2 cap the
    // BINDING bound (rather than HIGH-1's fair-odds cap, which is tested on
    // its own below) the sole winner exits at the max multiplier: 40 blocks
    // = 1.192x on a 5 ETH stake, so her fair-odds profit (0.96 ETH) exceeds
    // both the seed (0.5) and the 2% cap (0.19).
    const { crash, beacon, alice, bob } = await deploy();
    await crash.connect(alice).fundVault({ value: ethers.parseEther("10") });
    await lock(crash); // voids the empty round; the next one is seeded with 5% = 0.5 ETH
    const rid: bigint = await crash.currentRoundId();
    const seed: bigint = (await crash.rounds(rid)).rolledOverFromPrevious;
    expect(seed).to.equal(ethers.parseEther("0.5"));

    const AUTO = multiplierAt(MAX_ELAPSED);
    const STAKE_A = ethers.parseEther("5");
    await crash.connect(alice).placeBet(AUTO, { value: STAKE_A });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("1") });
    await lock(crash);
    const reserveAtLock: bigint = (await crash.rounds(rid)).reserveAtLock;
    expect(reserveAtLock).to.equal(ethers.parseEther("9.5"));
    // A crash at/after the cap so the 4.92x auto target wins.
    let v = "";
    for (let i = 0; i < 400 && !v; i++) {
      const cand = ethers.keccak256(ethers.toUtf8Bytes(`c3-max-${i}`));
      const [, elapsed] = await crash._deriveCrash(cand);
      if (elapsed >= BigInt(MAX_ELAPSED)) v = cand;
    }
    expect(v, "no capped-crash randomness found").to.not.equal("");
    await revealWith(crash, beacon, rid, v);
    await settle(crash, rid);
    await crash.registerResult(rid, alice.address);
    await crash.registerResult(rid, bob.address);
    await networkHelpers.mine(REG + 1);

    const r = await crash.rounds(rid);
    const D: bigint = r.distributable;
    expect(D).to.equal(seed + (ethers.parseEther("6") * (10000n - RAKE_BPS)) / 10000n);
    // Alice is the sole winner: her uncapped share is the WHOLE pool, of
    // which the whole 0.5 ETH seed is house money. Her fair-odds cap is
    // 0.96 ETH (does not bind); the (b).2 cap bounds the house side to
    // reserveAtLock*2% = 0.19 ETH; the rest of the seed returns to the Vault.
    const cap = (reserveAtLock * CAP_BPS) / 10000n;
    expect(cap).to.equal(ethers.parseEther("0.19"));
    expect(weightsAt(STAKE_A, MAX_ELAPSED).pw).to.be.gt(seed);
    const expectedExcess = seed - cap;
    const expectedPayout = D - expectedExcess;
    expect(await crash.estimatedPayout(rid, alice.address)).to.equal(expectedPayout);

    const reserveBefore: bigint = await crash.reserve();
    await expect(crash.claim(rid, alice.address))
      .to.emit(crash, "PayoutCapped")
      .withArgs(rid, alice.address, D, expectedPayout, expectedExcess)
      .and.to.emit(crash, "Claimed")
      .withArgs(rid, alice.address, expectedPayout);
    expect(await crash.payments(alice.address)).to.equal(expectedPayout);
    expect((await crash.reserve()) - reserveBefore).to.equal(expectedExcess);
    // Pool conserved: paid + returned-to-Vault == distributable, exactly.
    expect(expectedPayout + expectedExcess).to.equal(D);
    // The player-funded portion is never capped: she gets at least all of it.
    expect(expectedPayout).to.be.gte(D - seed);
  });

  it("seedCapped", async () => {
    const { crash, Crash, alice } = await deploy(); // num/den says 1/2; the PROPOSED bytecode cap says 5%
    await crash.connect(alice).fundVault({ value: ethers.parseEther("10") });
    expect(await crash.nextSeed()).to.equal(ethers.parseEther("0.5")); // 10 * 500 / 10000, not 5
    await lock(crash);
    const rid: bigint = await crash.currentRoundId();
    expect((await crash.rounds(rid)).rolledOverFromPrevious).to.equal(ethers.parseEther("0.5"));
    expect(await crash.reserve()).to.equal(ethers.parseEther("9.5"));
    // The ceiling is in bytecode (review MED-3: 1000, i.e. 2x the proposal,
    // not 10x): no config can exceed SEED_MAX_BPS_CEILING or be 0.
    expect(await crash.SEED_MAX_BPS_CEILING()).to.equal(1000n);
    await expect(deploy({ seedMaxBps: 1001n })).to.be.revertedWithCustomError(Crash, "BadHardeningConfig");
    await expect(deploy({ seedMaxBps: 5000n })).to.be.revertedWithCustomError(Crash, "BadHardeningConfig");
    await expect(deploy({ seedMaxBps: 0n })).to.be.revertedWithCustomError(Crash, "BadHardeningConfig");
    const { crash: atCeiling } = await deploy({ seedMaxBps: 1000n });
    await atCeiling.connect(alice).fundVault({ value: ethers.parseEther("10") });
    expect(await atCeiling.nextSeed()).to.equal(ethers.parseEther("1"));
  });

  // ─────────────────── HIGH-1: the seed is not farmable ──────────────────
  it("seedNotFarmableAtMinExit", async () => {
    // Reviewer's probe, reproduced under the PROPOSED constants: a 2 ETH
    // bankroll; 4 sybil wallets, each betting the minimum-ish stake with a
    // 1.0001x auto target (fires at elapsed = 1 block = 1.004x, wins with
    // P = 0.9999); 7 rounds back to back (~5 min at real cadence). Under
    // the old stake*mult seed key the sybils took the ENTIRE 5% seed every
    // round for a 0.4% risk -- 0.37 ETH = 18.5% of the bankroll in 7 rounds
    // at ~6.6x the stake they ever risked. Bound asserted (HIGH-1 fix):
    //   houseMoneyExtracted <= sum over (round, wallet) that won of
    //                          stake * (mult_at_exit - 1)
    // i.e. house money never exceeds the FAIR-ODDS profit on the risk
    // actually taken -- the player's EV-equivalent contribution: a fair
    // book pays stake*(m-1) with probability 1/m, expectation stake*(m-1)/m,
    // which at a 1.004x exit is 0.4% of stake per round. The old code paid
    // ~0.1 ETH/round against a bound of 4*0.01*0.004 = 0.00016 ETH/round:
    // this test FAILS on it by ~600x. Also asserted, in the reviewer's own
    // units: total extraction < 1% of the bankroll (old: 18.5%).
    const { crash, beacon, signers } = await deploy();
    const sybils = signers.slice(2, 6);
    const BANKROLL = ethers.parseEther("2");
    const STAKE = ethers.parseEther("0.01");
    await crash.connect(signers[7]).fundVault({ value: BANKROLL });
    await lock(crash); // void the empty round; the next one is seeded
    let fairOddsBound = 0n;
    let roundsWon = 0;
    for (let i = 0; i < 7; i++) {
      const rid: bigint = await crash.currentRoundId();
      const seed: bigint = (await crash.rounds(rid)).rolledOverFromPrevious;
      for (const s of sybils) await crash.connect(s).placeBet(10001n, { value: STAKE });
      await lock(crash);
      await revealWith(crash, beacon, rid, await winnableRandomness(crash, `farm-${i}`));
      await settle(crash, rid);
      const r = await crash.rounds(rid);
      expect(r.crashElapsedBlocks).to.be.gte(1n); // the min exit won this round
      for (const s of sybils) await crash.registerResult(rid, s.address);
      await networkHelpers.mine(REG + 1);
      for (const s of sybils) {
        await crash.claim(rid, s.address);
        fairOddsBound += weightsAt(STAKE, 1).pw; // stake * (1.004 - 1) = 0.00004 ETH
      }
      if (seed > 0n) roundsWon++;
    }
    // The seed of the round currently open is house money still in flight,
    // not extracted: the Vault + that seed is what the house still holds.
    const inFlight: bigint = (await crash.rounds(await crash.currentRoundId())).rolledOverFromPrevious;
    const houseNow: bigint = (await crash.reserve()) + inFlight;
    const extracted = BANKROLL - houseNow;
    expect(roundsWon, "the probe did not exercise seeded rounds").to.be.gte(4); // daily circuit may halt the tail
    expect(extracted, "house money extracted must be <= the fair-odds profit on the risk taken").to.be.lte(fairOddsBound);
    expect(extracted * 100n, "extraction must be < 1% of the bankroll (reviewer's probe: 18.5%)").to.be.lt(BANKROLL);
    // And the sybils' NET result is a loss (rake on their own pool > the
    // dust of house money): the farm is unprofitable, not just slow.
    let sybilOut = 0n;
    for (const s of sybils) sybilOut += await crash.payments(s.address);
    expect(sybilOut).to.be.lt(STAKE * 4n * 7n);
  });

  it("seedSplitByProfitWeight", async () => {
    // Two winners in one round: alice exits at ~1x (profit weight ~0), bob
    // at 10 blocks (1.42x). The PLAYER pot still splits by stake*mult, but
    // the SEED splits by stake*(mult-1) -- bob takes essentially all of it,
    // capped at his fair-odds profit, and each winner's house money is
    // <= stake*(mult-1). Pool conserved exactly.
    const { crash, beacon, alice, bob } = await deploy();
    await crash.connect(alice).fundVault({ value: ethers.parseEther("10") });
    await lock(crash);
    const rid: bigint = await crash.currentRoundId();
    const seed: bigint = (await crash.rounds(rid)).rolledOverFromPrevious;
    const SA = ethers.parseEther("1");
    const SB = ethers.parseEther("1");
    await crash.connect(alice).placeBet(10001n, { value: SA });
    await crash.connect(bob).placeBet(multiplierAt(10), { value: SB });
    await lock(crash);
    const reserveAtLock: bigint = (await crash.rounds(rid)).reserveAtLock;
    let v = "";
    for (let i = 0; i < 400 && !v; i++) {
      const cand = ethers.keccak256(ethers.toUtf8Bytes(`split-${i}`));
      const [, elapsed] = await crash._deriveCrash(cand);
      if (elapsed >= 10n && elapsed <= BigInt(MAX_ELAPSED)) v = cand;
    }
    await revealWith(crash, beacon, rid, v);
    await settle(crash, rid);
    await crash.registerResult(rid, alice.address);
    await crash.registerResult(rid, bob.address);
    await networkHelpers.mine(REG + 1);
    const r = await crash.rounds(rid);
    const a = weightsAt(SA, 1);
    const b = weightsAt(SB, 10);
    expect(r.totalWinningWeight).to.equal(a.w + b.w);
    expect(r.totalWinningProfitWeight).to.equal(a.pw + b.pw);
    const common = { W: a.w + b.w, PW: a.pw + b.pw, distributable: r.distributable, seed, reserveAtLock, singlePayoutCapBps: CAP_BPS };
    const ea = splitPayout({ ...a, ...common });
    const eb = splitPayout({ ...b, ...common });
    expect(await crash.estimatedPayout(rid, alice.address)).to.equal(ea.paid);
    expect(await crash.estimatedPayout(rid, bob.address)).to.equal(eb.paid);
    const reserveBefore: bigint = await crash.reserve();
    await crash.claim(rid, alice.address);
    await crash.claim(rid, bob.address);
    expect(await crash.payments(alice.address)).to.equal(ea.paid);
    expect(await crash.payments(bob.address)).to.equal(eb.paid);
    // House money per winner <= fair-odds profit; alice's is dust, bob's is real.
    expect(ea.seedPaid).to.be.lte(a.pw);
    expect(eb.seedPaid).to.be.lte(b.pw);
    expect(ea.seedPaid * 10n).to.be.lt(eb.seedPaid); // 0.004 vs 0.042 ETH: profit weights 40 : 420
    // Player pot by stake*mult exactly; conservation to within division
    // dust (two floors per winner: player pot and seed share).
    const playerPot = r.distributable - seed;
    expect(ea.paid - ea.seedPaid).to.equal((playerPot * a.w) / (a.w + b.w));
    expect((await crash.reserve()) - reserveBefore).to.equal(ea.excess + eb.excess);
    expect(r.distributable - (ea.paid + eb.paid + ea.excess + eb.excess)).to.be.lte(4n);
  });

  // ───────────────────────────── C4 ─────────────────────────────────────
  /// A round whose whole seed is LOST to the house: the sole winner exits at
  /// the max multiplier so the seed leaves the Vault for good (HIGH-1 means
  /// a ~1x exit would return most of it as excess). Returns the settled id.
  async function playSeedLosingRound(crash: any, beacon: any, alice: any, bob: any, label: string, delayBeforeLock = 0) {
    const rid: bigint = await crash.currentRoundId();
    await crash.connect(alice).placeBet(multiplierAt(MAX_ELAPSED), { value: ethers.parseEther("5") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("1") });
    if (delayBeforeLock > 0) await networkHelpers.time.increase(delayBeforeLock);
    await lock(crash);
    let v = "";
    for (let i = 0; i < 400 && !v; i++) {
      const cand = ethers.keccak256(ethers.toUtf8Bytes(`${label}-${i}`));
      const [, elapsed] = await crash._deriveCrash(cand);
      if (elapsed >= BigInt(MAX_ELAPSED)) v = cand;
    }
    await revealWith(crash, beacon, rid, v);
    await settle(crash, rid);
    await crash.registerResult(rid, alice.address);
    await crash.registerResult(rid, bob.address);
    await networkHelpers.mine(REG + 1);
    await crash.claim(rid, alice.address);
    return rid;
  }

  it("dailyDrawdownHaltsSeed", async () => {
    // Proposals: seed 5%/round, daily circuit 15%. The circuit is checked
    // BEFORE each draw: four draws happen (5%, 4.75%, 4.51%, 4.29% -> the
    // fourth is drawn at 14.26% down and leaves the Vault 18.55% down), so
    // the FIFTH round seeds 0. (The reviewer's probe is exactly this
    // arithmetic: ~0.37 of 2 ETH before the halt.)
    // singlePayoutCapBps off (10000) so the max-exit winner really takes the
    // whole seed and the Vault's loss per round is exactly the seed.
    const { crash, beacon, alice, bob } = await deploy({ singlePayoutCapBps: 10000n });
    await crash.connect(alice).fundVault({ value: ethers.parseEther("1") });
    expect(await crash.drawdownWindowPeak()).to.equal(ethers.parseEther("1"));
    await lock(crash); // void -> seeds 0.05 into the next round
    let expected = ethers.parseEther("0.95");
    expect(await crash.reserve()).to.equal(expected);
    expect(await crash.seedHaltReason()).to.equal(0);
    for (let i = 0; i < 3; i++) {
      await playSeedLosingRound(crash, beacon, alice, bob, `c4-d${i}`);
      expected -= seedFor(expected);
      expect(await crash.reserve(), `after draw ${i + 2}`).to.equal(expected);
      expect(await crash.seedHaltReason(), `after draw ${i + 2}`).to.equal(i < 2 ? 0 : 1);
    }
    expect(expected).to.equal(ethers.parseEther("0.81450625")); // 18.55% below the 1.0 peak
    await playSeedLosingRound(crash, beacon, alice, bob, "c4-d-halt"); // the NEXT draw is halted
    const haltedId: bigint = await crash.currentRoundId();
    const halted = await crash.rounds(haltedId);
    expect(halted.pool).to.equal(0n);
    expect(halted.rolledOverFromPrevious).to.equal(0n);
    expect(await crash.reserve()).to.equal(expected); // untouched: seed 0
    expect(await crash.nextSeed()).to.equal(0n);
    expect(await crash.seedHaltReason()).to.equal(1);
    const evs = await crash.queryFilter(crash.filters.SeedHalted(haltedId));
    expect(evs.length).to.equal(1);
    expect(evs[0].args.reason).to.equal(1n);
    // PLAY CONTINUES: betting on the unseeded round works normally.
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("0.2") });
    expect(await crash.stakeOf(haltedId, alice.address)).to.equal(ethers.parseEther("0.2"));

    // Review MED-2: after the 24h window rolls the peak does NOT reset to
    // the depleted balance (which would re-arm a fresh 15% on top of the
    // 18.55% already spent); it decays by exactly the allowed 15%:
    //   newPeak = max(0.81450625, 1 * 0.85) = 0.85
    // so the Vault is only 4.2% below the new peak and the budget left in
    // the new window is ~10.8%, not 15% -- what a true rolling window
    // would leave.
    await networkHelpers.time.increase(24 * 3600 + 1);
    expect(await crash.seedHaltReason()).to.equal(0);
    expect(await crash.nextSeed()).to.be.gt(0n);
    await crash.lockRound(); // voids (1 participant) and starts a seeded round
    expect(await crash.drawdownWindowPeak()).to.equal(ethers.parseEther("0.85"));
    const resumed = await crash.rounds(await crash.currentRoundId());
    expect(resumed.rolledOverFromPrevious).to.equal(seedFor(expected));
  });

  it("drawdownPeakDecaysAcrossWindows", async () => {
    // Review MED-2, the boundary case itself: with the OLD reset-to-balance
    // rule a Vault that had spent 14% of the daily 15% budget just before a
    // boundary could spend ~15% more right after it (~2x). With decay the
    // peak after n elapsed windows is prevPeak * 0.85^n, floored at the
    // balance -- and a return of house money (rescued seed, capped-payout
    // excess) never lifts the peak inside a window.
    const { crash, beacon, alice, bob } = await deploy({ hwmDrawdownBps: 10000n, singlePayoutCapBps: 10000n });
    await crash.connect(alice).fundVault({ value: ethers.parseEther("1") });
    await lock(crash); // draw 1 (0.05) out: reserve 0.95, peak 1
    // Three lost rounds: each settle draws the next seed (draws 2..4), so
    // the Vault sits at 0.95^4 = 0.8145 (18.55% down) with the 4th seed in
    // flight. Note the roll happens at a round START (the draw), i.e. at the
    // SETTLE of the previous round -- so the 24h delay goes before the
    // lock of the round whose settle should roll the window.
    for (let i = 0; i < 3; i++) await playSeedLosingRound(crash, beacon, alice, bob, `decay-${i}`);
    expect(await crash.reserve()).to.equal(ethers.parseEther("0.81450625"));
    expect(await crash.drawdownWindowPeak()).to.equal(ethers.parseEther("1"));
    expect(await crash.seedHaltReason()).to.equal(1); // 18.55% > 15%: halted inside this window
    // Boundary: under reset-to-balance the new peak would be 0.8145 and a
    // fresh 15% (another ~0.12) could be spent right after 18.55% was --
    // ~2.2x the daily budget in 24h. With decay: peak = max(0.8145, 1*0.85)
    // = 0.85, so the Vault is 4.2% below the new peak and only ~10.8% of
    // budget remains -- what a true rolling window would leave.
    await playSeedLosingRound(crash, beacon, alice, bob, "decay-roll", 24 * 3600 + 1);
    expect(await crash.drawdownWindowPeak()).to.equal(ethers.parseEther("0.85"));
    expect(await crash.seedHaltReason()).to.equal(0); // seeding resumed, on the decayed peak
    // The draw at that settle: 5% of 0.8145 -> reserve 0.77378.
    const bal: bigint = await crash.reserve();
    expect(bal).to.equal(ethers.parseEther("0.81450625") - seedFor(ethers.parseEther("0.81450625")));
    // After 3 more idle windows the peak decays 0.85^n but never below the
    // balance. The 1-participant void first RESCUES the in-flight seed
    // (a return: does not lift the peak), so the balance the roll sees is
    // bal + seed = 0.8145 again; then the new seed is drawn from it.
    const inFlight: bigint = (await crash.rounds(await crash.currentRoundId())).rolledOverFromPrevious;
    const balAtRoll = bal + inFlight;
    expect(balAtRoll).to.equal(ethers.parseEther("0.81450625"));
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("0.2") });
    await networkHelpers.time.increase(3 * 24 * 3600 + 1);
    await crash.lockRound(); // 1 participant: void -> rescue -> roll (3 windows) -> re-seed
    let expectedPeak = ethers.parseEther("0.85");
    for (let i = 0; i < 3 && expectedPeak > balAtRoll; i++) expectedPeak = (expectedPeak * 8500n) / 10000n;
    if (expectedPeak < balAtRoll) expectedPeak = balAtRoll;
    expect(await crash.drawdownWindowPeak()).to.equal(expectedPeak);
    expect(expectedPeak).to.equal(balAtRoll); // 0.85 * 0.85 = 0.7225 < 0.8145: floored at the balance after ONE decay step
    expect(await crash.reserve()).to.equal(balAtRoll - seedFor(balAtRoll));

    // Returns do not raise the peak: freeze the peak at the balance with a
    // seed out, then let a capped payout's excess return more than the
    // peak. hwm circuit is off here (10000) so only the daily peak matters.
    const { crash: c2, beacon: b2 } = await deploy({ hwmDrawdownBps: 10000n });
    await c2.connect(alice).fundVault({ value: ethers.parseEther("1") });
    await lock(c2); // seed 0.05 out, reserve 0.95, peak 1
    const rid: bigint = await c2.currentRoundId();
    await c2.connect(alice).placeBet(10001n, { value: ethers.parseEther("0.1") }); // ~1x exit: her house money is 0.1*0.004 = dust; nearly the whole 0.05 seed returns as excess
    await c2.connect(bob).placeBet(0n, { value: ethers.parseEther("1") });
    await networkHelpers.time.increase(24 * 3600 + 1);
    await c2.lockRound();
    await revealWith(c2, b2, rid, await winnableRandomness(c2, "decay-return"));
    await settle(c2, rid); // the roll at this start: peak = max(0.95, 1*0.85) = 0.95, then the next 5% is drawn -> reserve 0.9025
    const peakBefore: bigint = await c2.drawdownWindowPeak();
    await c2.registerResult(rid, alice.address);
    await c2.registerResult(rid, bob.address);
    await networkHelpers.mine(REG + 1);
    const reserveBefore: bigint = await c2.reserve();
    await c2.claim(rid, alice.address);
    const returned = (await c2.reserve()) - reserveBefore;
    expect(returned).to.be.gt(0n);
    expect(reserveBefore + returned, "the return must exceed the peak for this case to bite").to.be.gt(peakBefore);
    expect(await c2.drawdownWindowPeak(), "a returned excess must not lift the window peak").to.equal(peakBefore);
  });

  it("hwmDrawdownHaltsSeed", async () => {
    // Daily circuit off (10000) so only the HWM circuit acts; seeds at the
    // 10% bytecode ceiling so the 50% line is reached in 7 lost rounds.
    const { crash, beacon, alice, bob } = await deploy({ hwmDrawdownBps: 5000n, dailyDrawdownBps: 10000n, seedMaxBps: 1000n, singlePayoutCapBps: 10000n });
    await crash.connect(alice).fundVault({ value: ethers.parseEther("1") });
    expect(await crash.reserveHighWaterMark()).to.equal(ethers.parseEther("1"));
    await lock(crash); // void -> seeds 0.1 (reserve 0.9)
    expect(await crash.seedHaltReason()).to.equal(0);
    let expected = ethers.parseEther("0.9");
    for (let i = 0; i < 5; i++) {
      await playSeedLosingRound(crash, beacon, alice, bob, `c4-hwm-${i}`);
      expected -= expected / 10n;
      expect(await crash.reserve()).to.equal(expected);
      expect(await crash.seedHaltReason(), `round ${i}`).to.equal(0); // 0.9^6 = 0.531 still >= 0.5
    }
    await playSeedLosingRound(crash, beacon, alice, bob, "c4-hwm-last"); // draws to 0.9^7 = 0.478 < 50% of HWM
    expected -= expected / 10n;
    expect(await crash.reserve()).to.equal(expected);
    expect(await crash.seedHaltReason()).to.equal(2);
    await playSeedLosingRound(crash, beacon, alice, bob, "c4-hwm-halted"); // this round had a seed; the NEXT is halted
    const haltedId: bigint = await crash.currentRoundId();
    expect((await crash.rounds(haltedId)).rolledOverFromPrevious).to.equal(0n);
    expect(await crash.reserve()).to.equal(expected); // untouched: seed 0
    expect(await crash.seedHaltReason()).to.equal(2);
    const evs = await crash.queryFilter(crash.filters.SeedHalted(haltedId));
    expect(evs.length).to.equal(1);
    expect(evs[0].args.reason).to.equal(2n);
    // Play continues on the unseeded round.
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("0.2") });
    // Refill lifts the HWM to the new balance: seeding resumes.
    await crash.connect(bob).fundVault({ value: ethers.parseEther("1") });
    expect(await crash.reserveHighWaterMark()).to.equal(expected + ethers.parseEther("1"));
    expect(await crash.seedHaltReason()).to.equal(0);
    expect(await crash.nextSeed()).to.equal((expected + ethers.parseEther("1")) / 10n);
  });

  // ───────────────────────────── C5 ─────────────────────────────────────
  it("keeperPaidOnLockRevealSettle", async () => {
    const REVEAL_BPS = 100n;
    const LOCK_BPS = 100n;
    const { crash, beacon, Crash, alice, bob, carol, dave, erin } = await deploy({
      keeperRevealBps: REVEAL_BPS,
      keeperLockBps: LOCK_BPS,
    });
    // (c) the settle bounty is mandatory, and the three bounties are bounded.
    await expect(deploy({ keeperRewardBps: 0n })).to.be.revertedWithCustomError(Crash, "KeeperRewardRequired");
    await expect(deploy({ keeperRewardBps: 5000n, keeperRevealBps: 3000n, keeperLockBps: 2001n })).to.be.revertedWithCustomError(
      Crash,
      "BadHardeningConfig"
    );

    const rid: bigint = await crash.currentRoundId();
    await crash.connect(alice).placeBet(10001n, { value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("1") });
    await lock(crash, carol); // carol locks
    expect((await crash.rounds(rid)).lockedBy).to.equal(carol.address);
    await revealWith(crash, beacon, rid, await winnableRandomness(crash, "c5"), dave); // dave reveals
    expect((await crash.rounds(rid)).revealedBy).to.equal(dave.address);
    await settle(crash, rid, erin); // erin settles

    const rake = (ethers.parseEther("2") * RAKE_BPS) / 10000n;
    // All three are PULL payments (PullPayment escrow), never pushed.
    expect(await crash.payments(erin.address)).to.equal((rake * KEEPER_BPS) / 10000n);
    expect(await crash.payments(dave.address)).to.equal((rake * REVEAL_BPS) / 10000n);
    expect(await crash.payments(carol.address)).to.equal((rake * LOCK_BPS) / 10000n);
    expect(await crash.accumulatedRake()).to.equal(rake - (rake * (KEEPER_BPS + REVEAL_BPS + LOCK_BPS)) / 10000n);
    const evs = await crash.queryFilter(crash.filters.KeeperRewarded(rid));
    expect(evs.map((e: any) => Number(e.args.kind)).sort()).to.deep.equal([0, 1, 2]);
    // Pulling works, and only for the payee's own credit.
    const before = await ethers.provider.getBalance(carol.address);
    await crash.connect(alice).withdrawPayments(carol.address);
    expect((await ethers.provider.getBalance(carol.address)) - before).to.equal((rake * LOCK_BPS) / 10000n);
  });

  // ───────────────────────────── C6 ─────────────────────────────────────
  it("rescueSeedRegression", async () => {
    // Existing HIGH fix (_rescueSeed): a voided round's seed must return to
    // the Vault exactly, via BOTH void paths, never stranding house money.
    const { crash, alice, bob } = await deploy();
    await crash.connect(alice).fundVault({ value: ethers.parseEther("1") });
    await lock(crash); // voids the empty round 1 (seed 0); round 2 seeded with 5% = 0.05
    const rid2: bigint = await crash.currentRoundId();
    expect((await crash.rounds(rid2)).rolledOverFromPrevious).to.equal(ethers.parseEther("0.05"));
    expect(await crash.reserve()).to.equal(ethers.parseEther("0.95"));
    // Path 1: under-threshold void at lock.
    await lock(crash);
    expect(await crash.voided(rid2)).to.equal(true);
    expect((await crash.rounds(rid2)).rolledOverFromPrevious).to.equal(0n);
    // Vault back to 1.0 BEFORE the next seed was drawn, i.e. reserve == 1.0 - nextSeed.
    const rid3: bigint = await crash.currentRoundId();
    const seed3: bigint = (await crash.rounds(rid3)).rolledOverFromPrevious;
    expect(seed3).to.equal(ethers.parseEther("0.05"));
    expect((await crash.reserve()) + seed3).to.equal(ethers.parseEther("1"));
    // Path 2: reveal-timeout void of a LIVE round.
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("0.1") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("0.1") });
    await lock(crash);
    await networkHelpers.mine(AWAIT + 1);
    await crash.voidStaleRound(rid3);
    expect((await crash.rounds(rid3)).rolledOverFromPrevious).to.equal(0n);
    const rid4: bigint = await crash.currentRoundId();
    expect((await crash.reserve()) + (await crash.rounds(rid4)).rolledOverFromPrevious).to.equal(ethers.parseEther("1"));
    // And the players' stakes are recoverable, untouched.
    await crash.connect(alice).carryForwardStake(rid3);
    expect(await crash.stakeOf(rid4, alice.address)).to.equal(ethers.parseEther("0.1"));
  });

  // ───────────────────────────── C7 ─────────────────────────────────────
  it("pullPaymentOnly", async () => {
    // Reentrancy on claim via a malicious payoutRedirect sink: the inner
    // claim() must be blocked by nonReentrant so the winner is paid exactly
    // once; and a sink that cannot take the push falls back to the
    // PullPayment escrow -- funds never stuck, never pushed to an EOA.
    const { crash, beacon, alice, bob } = await deploy();
    const sink: any = await (await ethers.getContractFactory("MockReentrantSink")).deploy();
    await crash.connect(alice).setPayoutRedirect(await sink.getAddress());
    const rid = await playSeededRound(crash, beacon, alice, bob, "c7");
    await sink.arm(rid);
    const expected: bigint = await crash.estimatedPayout(rid, alice.address);
    expect(expected).to.be.gt(0n);

    const contractBefore = await ethers.provider.getBalance(await crash.getAddress());
    await crash.claim(rid, alice.address);
    expect(await sink.attempts()).to.equal(1n);
    expect(await sink.innerSucceeded()).to.equal(false); // ReentrancyGuard held
    expect(await ethers.provider.getBalance(await sink.getAddress())).to.equal(expected); // paid once, to her chosen sink
    expect(await crash.payments(alice.address)).to.equal(0n);
    expect(await crash.claimed(rid, alice.address)).to.equal(true);
    await expect(crash.claim(rid, alice.address)).to.be.revertedWithCustomError(crash, "AlreadyClaimed");
    expect(contractBefore - (await ethers.provider.getBalance(await crash.getAddress()))).to.equal(expected);

    // Escrow fallback: a sink with no creditFor() (the beacon mock) rejects
    // the push, so the payout lands in the pull escrow instead.
    await crash.connect(alice).setPayoutRedirect(await beacon.getAddress());
    const rid2 = await playSeededRound(crash, beacon, alice, bob, "c7-fallback");
    const expected2: bigint = await crash.estimatedPayout(rid2, alice.address);
    expect(expected2).to.be.gt(0n);
    await crash.claim(rid2, alice.address);
    expect(await crash.payments(alice.address)).to.equal(expected2);
    // Every keeper/treasury payment in this contract is likewise a pull.
    await crash.claimRake();
    expect(await crash.payments((await ethers.getSigners())[1].address)).to.be.gt(0n);
  });

  // ───────────────────────────── C8 ─────────────────────────────────────
  it("neverSettlesOnZeroRandomness", async () => {
    // Beacon spoof / stale round: the beacon verifies BLS once (proven for
    // real in DrandBeacon.bls.test.ts); this contract only ever reads
    // randomnessOrZero and refuses to reveal or settle on 0 -- and a value
    // for the WRONG (stale) round is not the target round's value.
    const { crash, beacon, alice, bob } = await deploy();
    const rid: bigint = await crash.currentRoundId();
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("0.1") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("0.1") });
    await lock(crash);
    const r = await crash.rounds(rid);
    await networkHelpers.time.increaseTo(r.revealNotBefore + 10n);
    await expect(crash.revealEntropy(rid)).to.be.revertedWithCustomError(crash, "RandomnessNotYetAvailable");
    await expect(crash.settleRound(rid)).to.be.revertedWithCustomError(crash, "EntropyNotRevealed");
    // A stale/adjacent round's value changes nothing.
    await beacon.setRandomness(BigInt(r.targetDrandRound) - 1n, ethers.keccak256(ethers.toUtf8Bytes("stale")));
    await beacon.setRandomness(BigInt(r.targetDrandRound) + 1n, ethers.keccak256(ethers.toUtf8Bytes("future")));
    await expect(crash.revealEntropy(rid)).to.be.revertedWithCustomError(crash, "RandomnessNotYetAvailable");
    await expect(crash.settleRound(rid)).to.be.revertedWithCustomError(crash, "EntropyNotRevealed");
    expect((await crash.rounds(rid)).entropyRevealed).to.equal(false);
    // Only the target round's own (verified-by-the-beacon) value reveals.
    await beacon.setRandomness(r.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes("real")));
    await crash.revealEntropy(rid);
    expect((await crash.rounds(rid)).entropyRevealed).to.equal(true);
  });

  // ─────────────── pool conservation under the payout cap ───────────────
  it("poolConservedUnderPayoutCap", async () => {
    // Property, fuzzed over >= 5 seeds with random stakes / auto targets /
    // manual cash-outs / Vault sizes: for every winner, with the HIGH-1
    // split (player pot P = D - seed by w; seed by profit weight pw),
    //   share_i  == floor(P * w_i / W) + floor(seed * pw_i / PW)
    //   paid_i + excessToVault_i == share_i                        (exact)
    //   excess_i == floor(seed*pw_i/PW) - min(that, pw_i, cap)      (exact)
    // so sum(paid) + sum(excess) == sum(share_i) <= D with the only slack
    // being integer-division dust (< 2 * winners wei), and the Vault
    // grows by exactly sum(excess). Nothing is minted or destroyed.
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const rand = prng(seed);
      const { crash, beacon, signers } = await deploy();
      const players = signers.slice(2, 6);
      const fund = ethers.parseEther((2 + Math.floor(rand() * 9)).toString());
      await crash.connect(players[0]).fundVault({ value: fund });
      await lock(crash); // void -> seeded round
      const rid: bigint = await crash.currentRoundId();
      const seedAmt: bigint = (await crash.rounds(rid)).rolledOverFromPrevious;
      expect(seedAmt).to.equal(seedFor(fund));

      const AUTO = [0n, 10001n, multiplierAt(2), multiplierAt(5)];
      let playerPool = 0n;
      for (const p of players) {
        const stake = ethers.parseEther((0.1 + rand() * 0.9).toFixed(6));
        await crash.connect(p).placeBet(AUTO[Math.floor(rand() * AUTO.length)], { value: stake });
        playerPool += stake;
      }
      await lock(crash);
      const reserveAtLock: bigint = (await crash.rounds(rid)).reserveAtLock;
      for (const p of players) if (rand() < 0.5) await crash.connect(p).cashOut(rid).catch(() => {});
      await revealWith(crash, beacon, rid, ethers.keccak256(ethers.toUtf8Bytes(`pc-${seed}`)));
      await settle(crash, rid);
      for (const p of players) await crash.registerResult(rid, p.address);
      await networkHelpers.mine(REG + 1);

      const r = await crash.rounds(rid);
      const D: bigint = r.distributable;
      expect(D).to.equal(seedAmt + (playerPool * (10000n - RAKE_BPS)) / 10000n);
      const W: bigint = r.totalWinningWeight;
      const PW: bigint = r.totalWinningProfitWeight;
      const weights: Record<string, bigint> = {};
      for (const e of await crash.queryFilter(crash.filters.ResultRegistered(rid))) weights[e.args.player] = e.args.weight;

      const reserveBefore: bigint = await crash.reserve();
      let sumPaid = 0n;
      let sumExcess = 0n;
      let sumShare = 0n;
      let winners = 0n;
      for (const p of players) {
        const w = weights[p.address] ?? 0n;
        if (w === 0n) {
          await expect(crash.claim(rid, p.address)).to.be.revertedWithCustomError(crash, "NotWinner");
          continue;
        }
        winners++;
        const exitElapsed = (await crash.effectiveCashOutBlock(rid, p.address)) - r.lockBlock;
        const mine = weightsAt(await crash.stakeOf(rid, p.address), exitElapsed);
        expect(mine.w).to.equal(w);
        const exp = splitPayout({ ...mine, W, PW, distributable: D, seed: seedAmt, reserveAtLock, singlePayoutCapBps: CAP_BPS });
        const share = exp.paid + exp.excess;
        const expectedExcess = exp.excess;
        expect(exp.seedPaid, `seed ${seed}: house money <= fair-odds profit (HIGH-1)`).to.be.lte(mine.pw);
        const before: bigint = await crash.payments(p.address);
        await crash.claim(rid, p.address);
        const paid = (await crash.payments(p.address)) - before;
        const capEvs = await crash.queryFilter(crash.filters.PayoutCapped(rid, p.address));
        const excess: bigint = capEvs.length ? capEvs[0].args.excessToVault : 0n;
        expect(excess, `seed ${seed}: excess`).to.equal(expectedExcess);
        expect(paid + excess, `seed ${seed}: paid+excess`).to.equal(share);
        expect(paid, `seed ${seed}: player-funded portion never capped`).to.be.gte(share - exp.seedRaw);
        sumPaid += paid;
        sumExcess += excess;
        sumShare += share;
      }
      if (winners === 0n) {
        // Fully busted: the whole pot rolls into the Vault -- conserved.
        await crash.sweepBustedRound(rid);
        expect((await crash.reserve()) - reserveBefore).to.equal(D);
        continue;
      }
      expect(sumPaid + sumExcess).to.equal(sumShare);
      expect(sumShare).to.be.lte(D);
      expect(D - sumShare, `seed ${seed}: only division dust may remain`).to.be.lt(2n * winners);
      expect((await crash.reserve()) - reserveBefore).to.equal(sumExcess);
    }
  });
  // ─────────────────── Fable re-review NEW-1 / NEW-2 ────────────────────
  it("autoTargetMustExceedOneX", async () => {
    // NEW-1 (b): exactly 1.00x inverts to elapsed 0 -- a bet that wins with
    // P = 1 and takes the whole player pot whenever anyone else loses (the
    // colluding group's absorber). Rejected; 1.0001x (1 block of risk) is
    // the smallest committed target.
    const { crash, alice } = await deploy();
    await expect(crash.connect(alice).placeBet(10000n, { value: ethers.parseEther("1") })).to.be.revertedWithCustomError(
      crash,
      "BadAutoTarget",
    );
    await crash.connect(alice).placeBet(10001n, { value: ethers.parseEther("1") });
    expect(await crash.autoCashOutBps(await crash.currentRoundId(), alice.address)).to.equal(10001n);
  });

  it("colludingAbsorberIsNotProfitable", async () => {
    // Reviewer's re-review probe (NEW-1). The fair-odds cap bounds house
    // money PER WINNER at stake*(m-1), but the LOSING stakes go to the
    // player pot, not the house, so a colluding group recycles them:
    //   - absorber A: the smallest possible target (1.0001x -> 1 block; the
    //     old 1.00x/elapsed-0 absorber is now rejected, see above), wins
    //     with P ~ 1 and takes the whole player pot whenever the B's lose;
    //   - B1..B3 at target m, sized so sum(pw) >= seed, so whenever the
    //     crash reaches m they take the ENTIRE seed (cap never binds).
    // Group EV/round on 0f21383 = seed/m - rake*stakes > 0 for m >~ 1.06
    // (reviewer: 15.6% of a 2 ETH bankroll in 6 rounds, group +0.136 ETH).
    // Unbiased randomness (a PRNG stream, not cherry-picked "winnable"
    // values), 8 rounds per m, m in {1.088, 1.25, 1.6, 2.6}.
    //
    // Bounds asserted (exact, in wei), per m over the whole run:
    //   (1) houseMoneyPaid <= SEED_BOOTSTRAP + sum(reserveCut)
    //       where houseMoneyPaid = BANKROLL - (reserve + seed in flight),
    //       reserveCut = reserveShareBps of (rake - settle/reveal/lock
    //       bounties) per settled round, i.e. the wei that actually
    //       ENTERED the Vault (re-review NEW-5: the treasury's share never
    //       did and is not recyclable) -- cumulative house money paid out
    //       never exceeds SEED_INCOME_MULTIPLE (100%) of the rake the
    //       VAULT retained, plus the one-off bootstrap allowance (0.02 ETH
    //       = 1% of the bankroll, within the constructor's reserveCap/10
    //       bound);
    //   (2) groupNet = sum(payments to A, B1..3) - sum(stakes)
    //                <= SEED_BOOTSTRAP - sum(rake - reserveCut)
    //       i.e. the group can at best recover the rake the Vault kept, so
    //       it nets at most the one-off bootstrap minus the bounties AND
    //       the treasury share it paid. The bootstrap is the ONLY house money a
    //       colluding group can ever net, and it is a constructor input
    //       bounded by reserveCap/10 -- so each m is ALSO run with
    //       bootstrap 0 (the steady state once it is spent), where
    //       groupNet <= -sum(rake - reserveCut) < 0 is asserted strictly:
    //       collusion LOSES money.
    // Each (m, bootstrap) runs at reserveShareBps in {0, 4000 (deploy
    // default), 10000}: at 0 the Vault retains NO rake, so after the
    // bootstrap the house pays exactly nothing.
    // On 0f21383 the seed is 5% of the reserve every round regardless of
    // income, so (1) fails (house pays ~seed/m per round against a rake
    // budget of ~0.045*stakes*0.93) and (2) fails (group net > 0). On
    // 1fdc931 the budget is credited with the whole net rake, so at share
    // 4000 the house pays up to 2.5x the rake the Vault kept: (1) fails.
    const BANKROLL = ethers.parseEther("2");
    const BOOTSTRAP = ethers.parseEther("0.02");
    const A_STAKE = ethers.parseEther("0.01");
    const MAXE = 200; // multiplierAt(200) == 26000: the 2.6x probe is exactly the cap
    const ROUNDS = 8;
    const BOUNTY_BPS = KEEPER_BPS + HARDENING_TEST_DEFAULTS.keeperRevealBps + HARDENING_TEST_DEFAULTS.keeperLockBps;
    const rand = prng(777);
    const unbiased = () => {
      let h = "0x";
      for (let i = 0; i < 8; i++) h += Math.floor(rand() * 0x100000000).toString(16).padStart(8, "0");
      return h;
    };
    for (const [m, bootstrap, share] of [10880n, 12500n, 16000n, 26000n].flatMap((x) =>
      [0n, 4000n, 10000n].flatMap((sh) => [
        [x, BOOTSTRAP, sh],
        [x, 0n, sh],
      ]),
    )) {
      const { crash, beacon, signers } = await deploy({
        ...hardeningFor(MAXE),
        maxElapsedBlocks: MAXE,
        reserveCap: BANKROLL,
        reserveShareBps: share,
        seedBootstrapBudgetWei: bootstrap,
      });
      const [A, B1, B2, B3] = signers.slice(2, 6);
      const Bs = [B1, B2, B3];
      const group = [A, ...Bs];
      await crash.connect(signers[7]).fundVault({ value: BANKROLL });
      await lock(crash); // void the empty round; the next one is seeded
      const eB: bigint = await crash._invertMultiplier(m);
      const mB = multiplierAt(eB); // the multiplier B's exit actually pays
      let sumStakes = 0n;
      let sumReserveCut = 0n;
      let sumLeak = 0n; // rake - reserveCut: bounties + treasury share, never recyclable
      let seededRounds = 0;
      let bWins = 0;
      for (let i = 0; i < ROUNDS; i++) {
        const rid: bigint = await crash.currentRoundId();
        const seed: bigint = (await crash.rounds(rid)).rolledOverFromPrevious;
        if (seed > 0n) seededRounds++;
        // B stake so that 3 * stake * (mB - 1) >= seed, floor 0.01 ETH.
        let bStake = (seed * 10000n) / (3n * (mB - 10000n)) + 1n;
        if (bStake < A_STAKE) bStake = A_STAKE;
        await crash.connect(A).placeBet(10001n, { value: A_STAKE });
        for (const b of Bs) await crash.connect(b).placeBet(m, { value: bStake });
        sumStakes += A_STAKE + 3n * bStake;
        const playerPool = A_STAKE + 3n * bStake;
        const rake = playerPool - (playerPool * (10000n - RAKE_BPS)) / 10000n;
        const bounties =
          (rake * KEEPER_BPS) / 10000n +
          (rake * HARDENING_TEST_DEFAULTS.keeperRevealBps) / 10000n +
          (rake * HARDENING_TEST_DEFAULTS.keeperLockBps) / 10000n;
        await lock(crash);
        await revealWith(crash, beacon, rid, unbiased());
        // settle at the (larger) block cap of this fixture
        {
          const r = await crash.rounds(rid);
          const eff = r.trueCrashElapsedBlocks < BigInt(MAXE) ? r.trueCrashElapsedBlocks : BigInt(MAXE);
          const cur = BigInt(await ethers.provider.getBlockNumber());
          if (r.lockBlock + eff > cur) await networkHelpers.mine(Number(r.lockBlock + eff - cur));
          await crash.settleRound(rid);
        }
        const reserveCut = ((rake - bounties) * share) / 10000n;
        sumReserveCut += reserveCut;
        sumLeak += rake - reserveCut;
        for (const p of group) await crash.registerResult(rid, p.address);
        await networkHelpers.mine(REG + 1);
        const r = await crash.rounds(rid);
        if (r.crashElapsedBlocks >= eB) bWins++;
        if (r.totalWinningWeight === 0n) {
          await crash.sweepBustedRound(rid);
          continue;
        }
        for (const p of group) await crash.claim(rid, p.address).catch(() => {});
      }
      expect(BOUNTY_BPS).to.equal(700n);
      // share 0: the bootstrap is the ONLY budget, spent in the first seeded round
      const minSeeded = share > 0n ? 3 : bootstrap > 0n ? 1 : 0;
      expect(seededRounds, `m=${m} b=${bootstrap} share=${share}: probe must exercise seeded rounds`).to.be.gte(minSeeded);
      const inFlight: bigint = (await crash.rounds(await crash.currentRoundId())).rolledOverFromPrevious;
      const houseNow: bigint = (await crash.reserve()) + inFlight;
      const houseMoneyPaid = BANKROLL - houseNow;
      let groupOut = 0n;
      for (const p of group) groupOut += await crash.payments(p.address);
      const groupNet = groupOut - sumStakes;
      // (1) house money paid <= bootstrap + 100% of the rake the VAULT retained (NEW-5)
      const tag = `m=${m} bootstrap=${ethers.formatEther(bootstrap)} share=${share} (B won ${bWins}/${ROUNDS})`;
      expect(houseMoneyPaid, `${tag}: house money paid (${ethers.formatEther(houseMoneyPaid)}) must be <= bootstrap + sum(reserveCut) (${ethers.formatEther(bootstrap + sumReserveCut)})`).to.be.lte(
        bootstrap + sumReserveCut,
      );
      // (2) group net <= bootstrap - (rake - reserveCut); strictly negative once the bootstrap is spent
      expect(groupNet, `${tag}: group net (${ethers.formatEther(groupNet)}) must be <= bootstrap - (rake - reserveCut) (${ethers.formatEther(bootstrap - sumLeak)})`).to.be.lte(
        bootstrap - sumLeak,
      );
      if (bootstrap === 0n) expect(groupNet, `${tag}: collusion must lose money (group net ${ethers.formatEther(groupNet)})`).to.be.lt(0n);
    }
  });

  it("seedBoundedByHouseIncome", async () => {
    // NEW-1 bookkeeping: seedBudget starts at the bootstrap, every seed is
    // <= it (and <= every other cap), settle credits exactly reserveCut --
    // the wei that entered the Vault, NOT the whole net rake (re-review
    // NEW-5) -- and a voided round's rescued seed / a capped payout's
    // excess come back. reserveShareBps = 4000 (the deploy default) so the
    // two differ.
    const BANKROLL = ethers.parseEther("2");
    const BOOTSTRAP = ethers.parseEther("0.05");
    const SHARE = 4000n;
    const { crash, beacon, alice, bob, Crash, cfg } = await deploy({ reserveCap: BANKROLL, reserveShareBps: SHARE, seedBootstrapBudgetWei: BOOTSTRAP });
    await expect(Crash.deploy({ ...cfg, reserveCap: BANKROLL, seedBootstrapBudgetWei: BANKROLL / 10n + 1n })).to.be.revertedWithCustomError(
      crash,
      "BadHardeningConfig",
    );
    expect(await crash.SEED_INCOME_MULTIPLE_BPS()).to.equal(10000n);
    expect(await crash.seedBudget()).to.equal(BOOTSTRAP);
    await crash.connect(alice).fundVault({ value: BANKROLL });
    expect(await crash.nextSeed()).to.equal(BOOTSTRAP); // 5% of 2 ETH = 0.1 would exceed the budget
    await lock(crash); // void -> seeded round draws the whole budget
    let rid: bigint = await crash.currentRoundId();
    expect((await crash.rounds(rid)).rolledOverFromPrevious).to.equal(BOOTSTRAP);
    expect(await crash.seedBudget()).to.equal(0n);
    // Void this seeded round: the seed is rescued AND the budget restored.
    await lock(crash);
    expect(await crash.seedBudget()).to.equal(0n); // the new round re-drew it
    rid = await crash.currentRoundId();
    expect((await crash.rounds(rid)).rolledOverFromPrevious).to.equal(BOOTSTRAP);
    // Play it: budget after settle == reserveCut exactly (seed fully drawn).
    const SA = ethers.parseEther("1");
    await crash.connect(alice).placeBet(10001n, { value: SA });
    await crash.connect(bob).placeBet(0n, { value: SA });
    await lock(crash);
    await revealWith(crash, beacon, rid, await winnableRandomness(crash, "income"));
    const rake = 2n * SA - (2n * SA * (10000n - RAKE_BPS)) / 10000n;
    const netRake =
      rake -
      (rake * KEEPER_BPS) / 10000n -
      (rake * HARDENING_TEST_DEFAULTS.keeperRevealBps) / 10000n -
      (rake * HARDENING_TEST_DEFAULTS.keeperLockBps) / 10000n;
    const reserveCut = (netRake * SHARE) / 10000n;
    expect(reserveCut).to.be.lt(netRake); // the treasury's 60% is NOT budget
    const reserveBefore: bigint = await crash.reserve();
    await settle(crash, rid);
    // settle credited reserveCut (to the Vault AND the budget), then the
    // next round drew min(reserveCut, 5% of reserve).
    const nextSeed: bigint = (await crash.rounds(await crash.currentRoundId())).rolledOverFromPrevious;
    expect(nextSeed).to.equal(reserveCut); // ~0.035 ETH < 5% of the ~1.95 ETH Vault: the income bound binds
    expect(await crash.seedBudget()).to.equal(reserveCut - nextSeed);
    expect(await crash.reserve()).to.equal(reserveBefore + reserveCut - nextSeed); // budget == wei that entered
    // alice's ~1x exit returns almost the whole seed as excess -> budget back.
    await crash.registerResult(rid, alice.address);
    await crash.registerResult(rid, bob.address);
    await networkHelpers.mine(REG + 1);
    const before: bigint = await crash.seedBudget();
    await crash.claim(rid, alice.address);
    const ev = await crash.queryFilter(crash.filters.PayoutCapped(rid, alice.address));
    expect(ev.length).to.equal(1);
    expect((await crash.seedBudget()) - before).to.equal(ev[0].args.excessToVault);
    expect(ev[0].args.excessToVault).to.be.gt(0n);
  });

  it("vaultNeverBleedsUnderHonestPlay", async () => {
    // Re-review NEW-5. On 1fdc931 settle credited seedBudget with the WHOLE
    // net rake while the Vault only retained reserveCut (reserveShareBps of
    // it; deploy default 4000), so seeds were paid from reserve capital the
    // treasury had already taken and the Vault bled ~12-16% per 22 rounds
    // of honest play, ratcheting down to the HWM circuit floor. With the
    // budget credited with reserveCut only, the seed after the bootstrap
    // is a rebate of rake the Vault actually took in, so under honest play
    // the Vault can never lose more than the bootstrap:
    //   reserve_end + seedInFlight + spilledToJackpot >= reserve_start - bootstrap
    // Fuzz: 5 PRNG seeds x reserveShareBps in {0, 4000, 10000}, 4 honest
    // players with random stakes and random committed targets (or riding
    // to the crash), unbiased PRNG randomness, 24 rounds, the day rolled
    // every 6 rounds so the daily circuit re-arms and cannot mask a bleed.
    const BANKROLL = ethers.parseEther("2");
    const BOOTSTRAP = BANKROLL / 10n; // the proposed reserveCap/10
    const ROUNDS = 24;
    const ROUNDS_PER_DAY = 6;
    for (const share of [0n, 4000n, 10000n]) {
      for (const fuzz of [11, 22, 33, 44, 55]) {
        const rand = prng(fuzz * 7919 + Number(share));
        const unbiased = () => {
          let h = "0x";
          for (let i = 0; i < 8; i++) h += Math.floor(rand() * 0x100000000).toString(16).padStart(8, "0");
          return h;
        };
        const { crash, beacon, signers } = await deploy({
          reserveCap: BANKROLL,
          reserveShareBps: share,
          seedBootstrapBudgetWei: BOOTSTRAP,
        });
        const players = signers.slice(2, 6);
        await crash.connect(signers[7]).fundVault({ value: BANKROLL });
        const reserveStart: bigint = await crash.reserve();
        expect(reserveStart).to.equal(BANKROLL);
        await lock(crash); // void the empty round; the next one is seeded
        let seededRounds = 0;
        let minReserve = reserveStart;
        for (let i = 0; i < ROUNDS; i++) {
          if (i > 0 && i % ROUNDS_PER_DAY === 0) {
            // roll the day: the open round's betting has expired, so void it
            // (seed rescued, budget restored) and play the fresh one
            await networkHelpers.time.increase(Number(await crash.DRAWDOWN_WINDOW()) + 1);
            await lock(crash);
          }
          const rid: bigint = await crash.currentRoundId();
          if ((await crash.rounds(rid)).rolledOverFromPrevious > 0n) seededRounds++;
          for (const p of players) {
            const stake = ethers.parseEther("0.05") + BigInt(Math.floor(rand() * 45)) * ethers.parseEther("0.01"); // 0.05..0.49
            const ride = rand() < 0.25;
            const target = ride ? 0n : multiplierAt(1 + Math.floor(rand() * MAX_ELAPSED)); // 1.004x .. cap
            await crash.connect(p).placeBet(target, { value: stake });
          }
          await lock(crash);
          await revealWith(crash, beacon, rid, unbiased());
          await settle(crash, rid);
          for (const p of players) await crash.registerResult(rid, p.address);
          await networkHelpers.mine(REG + 1);
          if ((await crash.rounds(rid)).totalWinningWeight === 0n) {
            await crash.sweepBustedRound(rid);
          } else {
            for (const p of players) await crash.claim(rid, p.address).catch(() => {});
          }
          const now: bigint = await crash.reserve();
          if (now < minReserve) minReserve = now;
        }
        const inFlight: bigint = (await crash.rounds(await crash.currentRoundId())).rolledOverFromPrevious;
        let spilled = 0n;
        for (const ev of await crash.queryFilter(crash.filters.VaultOverflow())) spilled += ev.args.spilledToJackpot;
        const reserveEnd: bigint = await crash.reserve();
        const tag = `share=${share} fuzz=${fuzz} (seeded ${seededRounds}/${ROUNDS} rounds, min reserve ${ethers.formatEther(minReserve)})`;
        expect(seededRounds, `${tag}: must exercise seeded rounds`).to.be.gte(3);
        expect(
          reserveEnd + inFlight + spilled,
          `${tag}: Vault end ${ethers.formatEther(reserveEnd)} + in flight ${ethers.formatEther(inFlight)} + spilled ${ethers.formatEther(spilled)} must be >= start - bootstrap (${ethers.formatEther(reserveStart - BOOTSTRAP)}) -- the Vault bled house capital`,
        ).to.be.gte(reserveStart - BOOTSTRAP);
      }
    }
  });

  it("estimateEqualBettingAndLive", async () => {
    // NEW-2: during BETTING reserveAtLock is 0, so the single-payout cap
    // base must be the CURRENT reserve (what lock will stamp), or the
    // virtual-lock estimate drops the whole seed portion. Setup where the
    // cap binds: 10 ETH Vault -> 0.5 ETH seed; alice's pw at 1.192x (the
    // cap multiplier) on 2 ETH is 0.384 > cap 2% * 9.5 = 0.19.
    const { crash, alice, bob } = await deploy();
    await crash.connect(alice).fundVault({ value: ethers.parseEther("10") });
    await lock(crash);
    const rid: bigint = await crash.currentRoundId();
    const seed: bigint = (await crash.rounds(rid)).rolledOverFromPrevious;
    const SA = ethers.parseEther("2");
    await crash.connect(alice).placeBet(multiplierAt(MAX_ELAPSED), { value: SA });
    await crash.connect(bob).placeBet(0n, { value: SA });
    const reserveNow: bigint = await crash.reserve();
    const betting: bigint = await crash.estimatedPayout(rid, alice.address);
    await lock(crash);
    expect((await crash.rounds(rid)).reserveAtLock).to.equal(reserveNow);
    const live: bigint = await crash.estimatedPayout(rid, alice.address);
    expect(betting, "BETTING (virtual lock) estimate must equal the LIVE estimate on the same state").to.equal(live);
    const a = weightsAt(SA, MAX_ELAPSED);
    const distributable = seed + (2n * SA * (10000n - RAKE_BPS)) / 10000n;
    const exp = splitPayout({ ...a, W: a.w, PW: a.pw, distributable, seed, reserveAtLock: reserveNow, singlePayoutCapBps: CAP_BPS });
    expect(exp.seedPaid).to.equal((reserveNow * CAP_BPS) / 10000n); // the cap binds
    expect(live).to.equal(exp.paid);
    expect(betting).to.be.gt(distributable - seed); // the seed portion is present pre-lock
  });
});
