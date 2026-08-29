import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { hardeningFor, multiplierAt } from "./helpers/crashHardening.js";

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
 * Constants used here are FIXTURE values, not the spec's proposed
 * production values (those live, unratified, in scripts/deploy-casino.ts).
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
    // block ordering across >= 5 seeds. Whatever the order, (1) every
    // SUCCESSFUL manual cash-out landed in a block with timestamp <
    // revealNotBefore, (2) every manual cash-out attempted at or after
    // revealNotBefore reverted CashOutWindowClosed -- regardless of whether
    // the randomness had been relayed/revealed -- and (3) the effective
    // cash-out block is exactly min(manual, lockBlock + invert(auto)).
    const AUTO_CHOICES = [0n, 10001n, multiplierAt(3), multiplierAt(10)];
    for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
      const rand = prng(seed);
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
      expect(rnb).to.equal(DRAND_GENESIS + (BigInt(r.targetDrandRound) - 1n) * DRAND_PERIOD);

      const manualBlock: Record<string, bigint> = {};
      let attemptsAfterRnb = 0;
      let successes = 0;
      for (let step = 0; step < 30; step++) {
        const op = Math.floor(rand() * 6);
        if (op === 0) {
          await networkHelpers.time.increase(1 + Math.floor(rand() * 8));
        } else if (op === 1) {
          await networkHelpers.mine(1 + Math.floor(rand() * 3));
        } else if (op === 2) {
          // "Off-chain-known randomness": the relayer may inject the target
          // round's value at ANY time (the mock does not enforce due-time),
          // modelling a player who fetched the signature the instant it
          // was producible -- or even an out-of-band leak before that.
          await beacon.setRandomness(r.targetDrandRound, ethers.keccak256(ethers.toUtf8Bytes(`c1-${seed}-${step}`)));
        } else if (op === 3) {
          await crash.revealEntropy(rid).catch(() => {});
        } else {
          const who = op === 4 ? alice : bob;
          const latest = BigInt(await networkHelpers.time.latest());
          const nextTsAtLeast = latest + 1n;
          try {
            const tx = await crash.connect(who).cashOut(rid);
            const rc = await tx.wait();
            const blk = await ethers.provider.getBlock(rc.blockNumber);
            expect(BigInt(blk!.timestamp), `seed ${seed} step ${step}: cash-out landed at/after revealNotBefore`).to.be.lt(rnb);
            manualBlock[who.address] = BigInt(rc.blockNumber);
            successes++;
          } catch (err: any) {
            if (nextTsAtLeast >= rnb) {
              attemptsAfterRnb++;
              expect(String(err?.message ?? err), `seed ${seed} step ${step}: wrong revert after revealNotBefore`).to.include(
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
      // Sanity that the fuzz really exercised the boundary on this seed, or at least one side of it.
      expect(successes + attemptsAfterRnb, `seed ${seed} exercised nothing`).to.be.gt(0);

      // The round is still settleable after any ordering.
      if (!(await crash.rounds(rid)).entropyRevealed) await revealWith(crash, beacon, rid, await winnableRandomness(crash, `c1-tail-${seed}`));
      await settle(crash, rid);
      expect((await crash.rounds(rid)).phase).to.equal(2n);
    }
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
    const CAP_BPS = 200n;
    const { crash, beacon, alice, bob } = await deploy({ singlePayoutCapBps: CAP_BPS });
    await crash.connect(alice).fundVault({ value: ethers.parseEther("10") });
    await lock(crash); // voids the empty round; the next one is seeded with 5 ETH
    const rid: bigint = await crash.currentRoundId();
    const seed: bigint = (await crash.rounds(rid)).rolledOverFromPrevious;
    expect(seed).to.equal(ethers.parseEther("5"));

    await crash.connect(alice).placeBet(10001n, { value: ethers.parseEther("1") });
    await crash.connect(bob).placeBet(0n, { value: ethers.parseEther("1") });
    await lock(crash);
    const reserveAtLock: bigint = (await crash.rounds(rid)).reserveAtLock;
    expect(reserveAtLock).to.equal(ethers.parseEther("5"));
    await revealWith(crash, beacon, rid, await winnableRandomness(crash, "c3"));
    await settle(crash, rid);
    await crash.registerResult(rid, alice.address);
    await crash.registerResult(rid, bob.address);
    await networkHelpers.mine(REG + 1);

    const r = await crash.rounds(rid);
    const D: bigint = r.distributable;
    expect(D).to.equal(seed + (ethers.parseEther("2") * (10000n - RAKE_BPS)) / 10000n);
    // Alice is the sole winner: her uncapped share is the WHOLE pool, of
    // which the whole 5 ETH seed is house money. The cap bounds that to
    // reserveAtLock*2% = 0.1 ETH; the rest of the seed returns to the Vault.
    const cap = (reserveAtLock * CAP_BPS) / 10000n;
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
    const { crash, Crash, alice } = await deploy({ seedMaxBps: 500n }); // num/den says 1/2; the bytecode cap says 5%
    await crash.connect(alice).fundVault({ value: ethers.parseEther("10") });
    expect(await crash.nextSeed()).to.equal(ethers.parseEther("0.5")); // 10 * 500 / 10000, not 5
    await lock(crash);
    const rid: bigint = await crash.currentRoundId();
    expect((await crash.rounds(rid)).rolledOverFromPrevious).to.equal(ethers.parseEther("0.5"));
    expect(await crash.reserve()).to.equal(ethers.parseEther("9.5"));
    // The ceiling is in bytecode: no config can exceed SEED_MAX_BPS_CEILING or be 0.
    expect(await crash.SEED_MAX_BPS_CEILING()).to.equal(5000n);
    await expect(deploy({ seedMaxBps: 5001n })).to.be.revertedWithCustomError(Crash, "BadHardeningConfig");
    await expect(deploy({ seedMaxBps: 0n })).to.be.revertedWithCustomError(Crash, "BadHardeningConfig");
  });

  // ───────────────────────────── C4 ─────────────────────────────────────
  it("dailyDrawdownHaltsSeed", async () => {
    const { crash, beacon, alice, bob } = await deploy({ dailyDrawdownBps: 1000n, seedNumerator: 1n, seedDenominator: 4n });
    await crash.connect(alice).fundVault({ value: ethers.parseEther("1") });
    expect(await crash.drawdownWindowPeak()).to.equal(ethers.parseEther("1"));
    await lock(crash); // void -> seeds 0.25 into the next round
    expect(await crash.reserve()).to.equal(ethers.parseEther("0.75"));
    expect(await crash.seedHaltReason()).to.equal(1); // already 25% below the window peak > 10%

    // The seed of THIS round is lost to a winner; the NEXT round must seed 0.
    const rid = await playSeededRound(crash, beacon, alice, bob, "c4-daily");
    void rid;
    const haltedId: bigint = await crash.currentRoundId();
    const halted = await crash.rounds(haltedId);
    expect(halted.pool).to.equal(0n);
    expect(halted.rolledOverFromPrevious).to.equal(0n);
    expect(await crash.nextSeed()).to.equal(0n);
    const evs = await crash.queryFilter(crash.filters.SeedHalted(haltedId));
    expect(evs.length).to.equal(1);
    expect(evs[0].args.reason).to.equal(1n);
    // PLAY CONTINUES: betting on the unseeded round works normally.
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("0.2") });
    expect(await crash.stakeOf(haltedId, alice.address)).to.equal(ethers.parseEther("0.2"));

    // After the 24h window rolls, the peak resets to the current balance and
    // seeding resumes.
    await networkHelpers.time.increase(24 * 3600 + 1);
    expect(await crash.seedHaltReason()).to.equal(0);
    expect(await crash.nextSeed()).to.be.gt(0n);
    await crash.lockRound(); // voids (1 participant) and starts a seeded round
    const resumed = await crash.rounds(await crash.currentRoundId());
    expect(resumed.rolledOverFromPrevious).to.be.gt(0n);
  });

  it("hwmDrawdownHaltsSeed", async () => {
    const { crash, beacon, alice, bob } = await deploy({ hwmDrawdownBps: 5000n });
    await crash.connect(alice).fundVault({ value: ethers.parseEther("1") });
    expect(await crash.reserveHighWaterMark()).to.equal(ethers.parseEther("1"));
    await lock(crash); // void -> seeds 0.5 (reserve 0.5 == exactly 50% of HWM: not yet below)
    expect(await crash.seedHaltReason()).to.equal(0);
    await playSeededRound(crash, beacon, alice, bob, "c4-hwm-1"); // 0.5 lost; next round seeds 0.25 -> reserve 0.25
    expect(await crash.reserve()).to.equal(ethers.parseEther("0.25"));
    expect(await crash.seedHaltReason()).to.equal(2); // 75% below HWM > 50%
    await playSeededRound(crash, beacon, alice, bob, "c4-hwm-2");
    const haltedId: bigint = await crash.currentRoundId();
    expect((await crash.rounds(haltedId)).rolledOverFromPrevious).to.equal(0n);
    expect(await crash.reserve()).to.equal(ethers.parseEther("0.25")); // untouched: seed 0
    const evs = await crash.queryFilter(crash.filters.SeedHalted(haltedId));
    expect(evs.length).to.equal(1);
    expect(evs[0].args.reason).to.equal(2n);
    // Play continues on the unseeded round.
    await crash.connect(alice).placeBet(0n, { value: ethers.parseEther("0.2") });
    // Refill lifts the HWM to the new balance: seeding resumes.
    await crash.connect(bob).fundVault({ value: ethers.parseEther("1") });
    expect(await crash.reserveHighWaterMark()).to.equal(ethers.parseEther("1.25"));
    expect(await crash.seedHaltReason()).to.equal(0);
    expect(await crash.nextSeed()).to.equal(ethers.parseEther("0.625"));
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
    await lock(crash); // voids the empty round 1 (seed 0); round 2 seeded with 0.5
    const rid2: bigint = await crash.currentRoundId();
    expect((await crash.rounds(rid2)).rolledOverFromPrevious).to.equal(ethers.parseEther("0.5"));
    expect(await crash.reserve()).to.equal(ethers.parseEther("0.5"));
    // Path 1: under-threshold void at lock.
    await lock(crash);
    expect(await crash.voided(rid2)).to.equal(true);
    expect((await crash.rounds(rid2)).rolledOverFromPrevious).to.equal(0n);
    // Vault back to 1.0 BEFORE the next seed was drawn, i.e. reserve == 1.0 - nextSeed.
    const rid3: bigint = await crash.currentRoundId();
    const seed3: bigint = (await crash.rounds(rid3)).rolledOverFromPrevious;
    expect(seed3).to.equal(ethers.parseEther("0.5"));
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
    // manual cash-outs / Vault sizes: for every winner,
    //   paid_i + excessToVault_i == floor(D * w_i / W)   (exact)
    //   excess_i == max(0, floor(seed * w_i / W) - cap)  (exact)
    // so sum(paid) + sum(excess) == sum(share_i) <= D with the only slack
    // being integer-division dust (< number of winners wei), and the Vault
    // grows by exactly sum(excess). Nothing is minted or destroyed.
    const CAP_BPS = 200n;
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const rand = prng(seed);
      const { crash, beacon, signers } = await deploy({ singlePayoutCapBps: CAP_BPS });
      const players = signers.slice(2, 6);
      const fund = ethers.parseEther((2 + Math.floor(rand() * 9)).toString());
      await crash.connect(players[0]).fundVault({ value: fund });
      await lock(crash); // void -> seeded round
      const rid: bigint = await crash.currentRoundId();
      const seedAmt: bigint = (await crash.rounds(rid)).rolledOverFromPrevious;
      expect(seedAmt).to.equal(fund / 2n);

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
      const weights: Record<string, bigint> = {};
      for (const e of await crash.queryFilter(crash.filters.ResultRegistered(rid))) weights[e.args.player] = e.args.weight;

      const reserveBefore: bigint = await crash.reserve();
      let sumPaid = 0n;
      let sumExcess = 0n;
      let sumShare = 0n;
      let winners = 0n;
      const cap = (reserveAtLock * CAP_BPS) / 10000n;
      for (const p of players) {
        const w = weights[p.address] ?? 0n;
        if (w === 0n) {
          await expect(crash.claim(rid, p.address)).to.be.revertedWithCustomError(crash, "NotWinner");
          continue;
        }
        winners++;
        const share = (D * w) / W;
        const seedShare = (seedAmt * w) / W;
        const expectedExcess = seedShare > cap ? seedShare - cap : 0n;
        const before: bigint = await crash.payments(p.address);
        await crash.claim(rid, p.address);
        const paid = (await crash.payments(p.address)) - before;
        const capEvs = await crash.queryFilter(crash.filters.PayoutCapped(rid, p.address));
        const excess: bigint = capEvs.length ? capEvs[0].args.excessToVault : 0n;
        expect(excess, `seed ${seed}: excess`).to.equal(expectedExcess);
        expect(paid + excess, `seed ${seed}: paid+excess`).to.equal(share);
        expect(paid, `seed ${seed}: player-funded portion never capped`).to.be.gte(share - seedShare);
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
      expect(D - sumShare, `seed ${seed}: only division dust may remain`).to.be.lt(winners);
      expect((await crash.reserve()) - reserveBefore).to.equal(sumExcess);
    }
  });
});
