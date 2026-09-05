import { expect } from "chai";
import { toBeHex } from "ethers";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import {
  BPS, CREDIT, DEFAULT_CRASH, DRAND_GENESIS, DRAND_PERIOD, assertConserved, bet, betFor, closeBetting, deployCasino,
  findRandomness, freshAddress, increaseToAtLeast, settleCurrent, type CasinoEnv,
} from "./helpers/casino.js";

/**
 * PlankCrash / PlankLottery / PlankRakeRouter -- ADVERSARIAL cases from
 * docs/marketplank/AUDIT-ccs2l-contracts-hardening-2026-09-05.md (A-1 .. A-10).
 * Every "fix" case here has a negative control: the assertion FAILED against
 * commit 0391515 (the pre-hardening contract set) and passes after 58ecf97.
 */
describe("PlankCrash -- adversarial hardening cases (2026-09-05)", () => {
  const E = (x: string) => ethers.parseEther(x);
  const MAX_SEATS = Number(DEFAULT_CRASH.maxSeats);

  async function fresh(overrides: Parameters<typeof deployCasino>[0] = {}) {
    const env = await deployCasino(overrides);
    await env.crash.connect(env.deployer).fundVault({ value: E("1") });
    await closeBetting(env);
    await env.crash.lockRound(); // round 1 (seed 0) voided; round 2 carries a seed
    return env;
  }

  // ── A-1 seat-squatting via open placeBetFor ────────────────────────────
  it("A-1: placeBetFor is bank-only -- a stranger cannot squat a player's seat (negative control: passed on 0391515)", async () => {
    const env = await fresh();
    const id: bigint = await env.crash.currentRoundId();
    // Mallory tries to seat Alice at 1.01x for the minimum stake so Alice
    // cannot bet this round (AlreadyBet). Before the fix this succeeded.
    await expect(env.crash.connect(env.dave).placeBetFor(env.alice.address, 10_100n, { value: 500n * CREDIT }))
      .to.be.revertedWithCustomError(env.crash, "NotBank");
    expect(await env.crash.stakeOf(id, env.alice.address)).to.equal(0n);
    // Alice keeps her seat and her chosen target.
    await bet(env, env.alice, "1", 25_000n);
    expect(await env.crash.targetOf(id, env.alice.address)).to.equal(25_000n);
    // The bank path is the only third-party path and it needs the player's own signature.
    await env.bank.connect(env.bob).deposit({ value: E("1") });
    await env.bank.connect(env.bob).bet(env.crashAddr, E("0.5"), 30_000n);
    expect(await env.crash.stakeOf(id, env.bob.address)).to.equal(E("0.5"));
    // withdrawToBank cannot target a caller-chosen contract.
    await expect(env.crash.connect(env.alice).withdrawToBank(env.dave.address)).to.be.revertedWithCustomError(env.crash, "NotBank");
    expect(await env.crash.bank()).to.equal(await env.bank.getAddress());
  });

  // ── A-2 lottery revert must never lock stakes ──────────────────────────
  async function deployWithRevertingLottery() {
    const [deployer, treasury, alice, bob] = await ethers.getSigners();
    const beacon: any = await (await ethers.getContractFactory("DrandBeaconMock")).deploy(DRAND_PERIOD, DRAND_GENESIS);
    const broken: any = await (await ethers.getContractFactory("MockRevertingLottery")).deploy();
    const nonce = await deployer.getNonce();
    const predictedCrash = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
    const router: any = await (await ethers.getContractFactory("PlankRakeRouter")).deploy(
      predictedCrash, await broken.getAddress(), await broken.getAddress(), predictedCrash, treasury.address, 6500n,
    );
    const crash: any = await (await ethers.getContractFactory("PlankCrash")).deploy({
      beacon: await beacon.getAddress(), router: await router.getAddress(), lottery: await broken.getAddress(), bank: deployer.address,
      ...DEFAULT_CRASH, emissionBufferCapWei: E("0.3"),
    });
    expect((await crash.getAddress()).toLowerCase()).to.equal(predictedCrash.toLowerCase());
    return { beacon, broken, router, crash, deployer, alice, bob };
  }

  it("A-2: a reverting lottery cannot brick settleRound (stakes never locked); deliverOverflow restores escrow (negative control: reverted on 0391515)", async () => {
    const { beacon, crash, alice, bob } = await deployWithRevertingLottery();
    await crash.fundVault({ value: E("1") }); // 0.7 above the cap -> pendingOverflow
    expect(await crash.pendingOverflow()).to.equal(E("0.7"));
    // The overflow leg fails closed and restores its escrow.
    await expect(crash.deliverOverflow()).to.emit(crash, "OverflowDelivered").withArgs(E("0.7"), false);
    expect(await crash.pendingOverflow()).to.equal(E("0.7"));
    // Void round 1, play round 2.
    let r = await crash.currentRound();
    await increaseToAtLeast(BigInt(r.bettingEndsAt));
    await crash.lockRound();
    const id: bigint = await crash.currentRoundId();
    r = await crash.rounds(id);
    await crash.connect(alice).placeBet(15_000n, { value: E("1") });
    await crash.connect(bob).placeBet(20_000n, { value: E("1") });
    await increaseToAtLeast(BigInt(r.bettingEndsAt));
    await beacon.setRandomness(r.targetDrandRound, toBeHex(99n, 32));
    // Before the fix: the whole settlement reverted with Broken() and, since
    // the randomness existed, refundRound was impossible -- 2 ETH locked forever.
    await expect(crash.settleRound()).to.emit(crash, "LotteryRecordFailed").and.to.emit(crash, "RoundSettled");
    expect((await crash.rounds(id)).phase).to.equal(2n);
    const paid = (await crash.owed(alice.address)) + (await crash.owed(bob.address));
    const rr = await crash.rounds(id);
    expect(paid).to.equal(rr.totalPlayerPaid + rr.totalBonus);
    expect(await ethers.provider.getBalance(await crash.getAddress())).to.equal(await crash.accountedBalance());
    await crash.connect(alice).withdraw();
  });

  it("A-2b: insufficient-gas griefing cannot skip a HEALTHY draw -- every settle that succeeds carries the lottery's Draw", async () => {
    const env = await fresh();
    await env.lottery.fund({ value: E("1") });
    // Round A seals committedPrize (prize==0 path), round B is a real draw.
    await bet(env, env.alice, "1", 15_000n);
    await bet(env, env.bob, "1", 20_000n);
    await settleCurrent(env, toBeHex(1n, 32));
    expect(await env.lottery.committedPrize()).to.be.greaterThan(0n);
    const id: bigint = await env.crash.currentRoundId();
    const r = await env.crash.rounds(id);
    await bet(env, env.alice, "1", 15_000n);
    await bet(env, env.bob, "1", 20_000n);
    await increaseToAtLeast(BigInt(r.bettingEndsAt));
    await env.crash.lockRound(); // LIVE, so a starved settle leaves phase == 1
    await env.beacon.setRandomness(r.targetDrandRound, toBeHex(2n, 32));
    const full: bigint = await env.crash.connect(env.keeper).settleRound.estimateGas();
    const drawTopic = env.lottery.interface.getEvent("Draw")!.topicHash;
    let successes = 0;
    let reverts = 0;
    for (let k = 8; k <= 64; k++) {
      const gasLimit = (full * BigInt(k)) / 64n;
      try {
        const tx = await env.crash.connect(env.keeper).settleRound({ gasLimit });
        const rc = await tx.wait();
        successes += 1;
        const lotteryAddr = (await env.lottery.getAddress()).toLowerCase();
        const draws = rc!.logs.filter((l: any) => l.address.toLowerCase() === lotteryAddr && l.topics[0] === drawTopic);
        if (draws.length !== 1) console.log("      DEBUG logs:", rc!.logs.map((l: any) => `${l.address}:${l.fragment?.name ?? l.topics[0]}`).join(" | "), "gasUsed", rc!.gasUsed, "limit", gasLimit);
        expect(draws.length, `settle succeeded at ${gasLimit} gas without a Draw`).to.equal(1);
        expect(rc!.logs.some((l: any) => l.address === env.crash.target && l.fragment?.name === "LotteryRecordFailed")).to.equal(false);
        break; // settled; the round is gone
      } catch (e: any) {
        reverts += 1;
        expect((await env.crash.rounds(id)).phase).to.equal(1n); // still LIVE, nothing partial
      }
    }
    console.log(`      gas-griefing scan: ${reverts} starved attempts reverted whole, ${successes} settled with the draw (estimate ${full})`);
    expect(successes).to.equal(1);
  });

  // ── A-3 abandoned-round hatch ──────────────────────────────────────────
  it("A-3: a LIVE round whose randomness exists but which nobody settles becomes refundable only after 30x the timeout (negative control: RandomnessAvailable forever on 0391515)", async () => {
    const env = await fresh();
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    await bet(env, env.alice, "1", 15_000n);
    await bet(env, env.bob, "1", 20_000n);
    await closeBetting(env);
    await env.crash.lockRound();
    await env.beacon.setRandomness(r0.targetDrandRound, toBeHex(5n, 32));
    const mult: bigint = await env.crash.ABANDONED_ROUND_MULTIPLIER();
    expect(mult).to.equal(30n);
    const reveal = BigInt(r0.revealNotBefore);
    const timeout = DEFAULT_CRASH.refundTimeoutSeconds;
    await increaseToAtLeast(reveal + timeout);
    await expect(env.crash.refundRound()).to.be.revertedWithCustomError(env.crash, "RandomnessAvailable");
    await increaseToAtLeast(reveal + timeout * mult - 2n);
    await expect(env.crash.refundRound()).to.be.revertedWithCustomError(env.crash, "RandomnessAvailable");
    await increaseToAtLeast(reveal + timeout * mult);
    // Whoever settles first still wins: settle is possible right up to the refund.
    // (Here nobody does, modelling an unsettleable round.)
    await expect(env.crash.refundRound()).to.emit(env.crash, "RoundRefunded").withArgs(id, E("2"), r0.seed);
    await env.crash.claimRefund(id, env.alice.address);
    await env.crash.claimRefund(id, env.bob.address);
    expect(await env.crash.owed(env.alice.address)).to.equal(E("1"));
    expect(await env.crash.owed(env.bob.address)).to.equal(E("1"));
    await expect(env.crash.settleRound()).to.be.revertedWithCustomError(env.crash, "TooEarly"); // the NEW round is betting
    await assertConserved(env, expect);
  });

  // ── A-4 overflow stipend on a cold lottery ─────────────────────────────
  it("A-4: deliverOverflow succeeds within its stipend on a NEVER-funded lottery (four cold zero->nonzero slots)", async () => {
    const env = await deployCasino({ crash: { emissionBufferCapWei: E("0.25") } });
    expect(await env.lottery.totalFunded()).to.equal(0n);
    await env.crash.fundVault({ value: E("1") });
    expect(await env.crash.pendingOverflow()).to.equal(E("0.75"));
    await expect(env.crash.deliverOverflow()).to.emit(env.crash, "OverflowDelivered").withArgs(E("0.75"), true);
    expect(await env.crash.pendingOverflow()).to.equal(0n);
    expect(await env.lottery.totalFunded()).to.equal(E("0.75"));
    expect(await env.crash.OVERFLOW_GAS_STIPEND()).to.equal(200_000n);
    await assertConserved(env, expect);
  });

  // ── A-5 sybil partition at MAX_SEATS-1 ─────────────────────────────────
  it("A-5: MAX_SEATS-1 sybils at the same and at adjacent targets never beat one whole seat by more than k wei (player layer) and never at all (house layer)", async () => {
    const ccs: any = await (await ethers.getContractFactory("PlankCcs2LSettlement")).deploy();
    const params = { floorBps: DEFAULT_CRASH.floorBps, houseCapBps: DEFAULT_CRASH.houseCapBps };
    const honest = [{ stake: E("3"), targetBps: 18_000n }, { stake: E("2"), targetBps: 35_000n }];
    const whole = E("7.123456789012345678");
    const k = MAX_SEATS - honest.length; // 126 sybils
    for (const [m, crash] of [[20_000n, 40_000n], [10_100n, 10_100n], [10_100n, 10_101n], [150_000n, 150_001n], [20_000n, 19_999n]] as const) {
      for (const adjacent of [false, true]) {
        // "adjacent" compares against ONE whole seat at m+1 (the upper bound);
        // at the survival boundary (crash == m) that seat busts while half the
        // parts survive, which is a different bet, not a partition.
        if (adjacent && crash >= m && crash < m + 1n) continue;
        const parts: Array<{ stake: bigint; targetBps: bigint }> = [];
        let left = whole;
        for (let i = 0; i < k; i++) {
          const s = i === k - 1 ? left : whole / BigInt(k) + BigInt(i % 3); // uneven parts
          left -= s;
          parts.push({ stake: s, targetBps: adjacent ? m + BigInt(i % 2) : m });
        }
        const pool = whole + honest[0].stake + honest[1].stake;
        const D = (pool * (BPS - DEFAULT_CRASH.rakeBps)) / BPS;
        const seed = E("0.5");
        const reserve = E("40");
        const one = await ccs.settle(D, seed, crash, [...honest, { stake: whole, targetBps: adjacent ? m + 1n : m }], reserve, params);
        const split = await ccs.settle(D, seed, crash, [...honest, ...parts], reserve, params);
        const aggPlayer = (r: any, from: number) => r.playerPayouts.slice(from).reduce((a: bigint, b: bigint) => a + b, 0n);
        const aggBonus = (r: any, from: number) => r.bonuses.slice(from).reduce((a: bigint, b: bigint) => a + b, 0n);
        const gainPlayer = aggPlayer(split, 2) - aggPlayer(one, 2);
        const gainBonus = aggBonus(split, 2) - aggBonus(one, 2);
        expect(gainPlayer <= BigInt(k), `player-layer gain ${gainPlayer} at m=${m} adjacent=${adjacent}`).to.equal(true);
        expect(gainBonus <= 0n, `house-layer gain ${gainBonus} at m=${m} adjacent=${adjacent}`).to.equal(true);
        // Both still conserve exactly.
        if (split.mode !== 0n) {
          expect(split.totalPlayerPaid).to.equal(D);
          expect(split.totalBonus + split.houseReturned).to.equal(seed);
        }
      }
    }
  });

  // ── A-6 settle gas at the ceiling ──────────────────────────────────────
  it("A-6: settleRound at MAX_SEATS_CEILING, all survivors at distinct targets, stays well inside a 32M per-tx budget", async () => {
    const ceiling = Number(await (await deployCasino()).crash.MAX_SEATS_CEILING());
    const env = await fresh({ crash: { maxSeats: BigInt(ceiling), crashSeedWei: E("0.5"), seedBootstrapBudgetWei: E("100"), maxStakePerWalletBps: 10_000n, bettingDurationSeconds: 3000n } });
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    for (let i = 0; i < ceiling; i++) {
      await betFor(env, freshAddress(), 10_100n + BigInt(i) * 53n, E("0.02") + BigInt(i) * 10n ** 13n);
    }
    const rnd = await findRandomness(env, id, BigInt(r0.targetDrandRound), (c) => c >= 10_100n + BigInt(ceiling) * 53n);
    const { receipt, round } = await settleCurrent(env, rnd);
    console.log(`      settleRound gas at MAX_SEATS_CEILING=${ceiling}, all survive: ${receipt.gasUsed} (${receipt.gasUsed / BigInt(ceiling)} / seat)`);
    expect(round.phase).to.equal(2n);
    // EIP-7825 (Osaka) per-transaction cap is 2^24 = 16,777,216; hardhat's EDR
    // already enforces it. Require >= 20% headroom under it.
    expect(receipt.gasUsed < (16_777_216n * 80n) / 100n, "80% of the EIP-7825 tx gas cap").to.equal(true);
    await assertConserved(env, expect);
  });

  // ── A-7 constructor validation ─────────────────────────────────────────
  it("A-7: constructors reject the new foot-guns (odds, carve admissibility, quorum > seats, stake floor, codeless sinks)", async () => {
    const env = await deployCasino();
    const Lottery = await ethers.getContractFactory("PlankLottery");
    const base = { source: env.crashAddr, founderSink: env.treasury.address, ...env.lotteryConfig };
    for (const bad of [{ oddsOneIn: 1n }, { oddsOneIn: 0n }, { carveMinBps: 0n }, { carveMinBps: 3000n, carveMaxBps: 3000n }, { carveMinBps: 3001n, carveMaxBps: 3000n }, { carveMaxBps: 10_000n }, { carveHalfSaturationWei: 0n }]) {
      await expect(Lottery.deploy({ ...base, ...bad }), JSON.stringify(bad, (_k, v) => typeof v === "bigint" ? v.toString() : v)).to.be.revertedWithCustomError(Lottery, "BadConfig");
    }
    await Lottery.deploy({ ...base, oddsOneIn: 2n, carveMinBps: 1n }); // the boundary is admissible
    const Crash = await ethers.getContractFactory("PlankCrash");
    const cfg = env.crashConfig;
    await expect(Crash.deploy({ ...cfg, minParticipants: cfg.maxSeats + 1n })).to.be.revertedWithCustomError(Crash, "BadConfig");
    await expect(Crash.deploy({ ...cfg, minStakeWei: (1n << 96n) })).to.be.revertedWithCustomError(Crash, "BadConfig");
    await expect(Crash.deploy({ ...cfg, router: env.dave.address })).to.be.revertedWithCustomError(Crash, "ZeroAddress");
    await expect(Crash.deploy({ ...cfg, lottery: env.dave.address })).to.be.revertedWithCustomError(Crash, "ZeroAddress");
    await expect(Crash.deploy({ ...cfg, bank: ethers.ZeroAddress })).to.be.revertedWithCustomError(Crash, "ZeroAddress");
    const Router = await ethers.getContractFactory("PlankRakeRouter");
    await expect(Router.deploy(env.crashAddr, env.dave.address, await env.lottery.getAddress(), env.crashAddr, env.treasury.address, 6500n))
      .to.be.revertedWithCustomError(Router, "BadConfig");
    await expect(Router.deploy(env.crashAddr, await env.burnEngine.getAddress(), env.dave.address, env.crashAddr, env.treasury.address, 6500n))
      .to.be.revertedWithCustomError(Router, "BadConfig");
  });

  // ── A-8 reentrancy probe ───────────────────────────────────────────────
  it("A-8: inside the only outsider callback (withdraw), every entry point is closed and every accounting view is consistent", async () => {
    const env = await fresh();
    const probe: any = await (await ethers.getContractFactory("MockReentrancyProbe")).deploy(env.crashAddr, await env.lottery.getAddress());
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    await probe.bet(15_000n, { value: E("1") });
    await bet(env, env.bob, "1", 20_000n);
    await settleCurrent(env, await findRandomness(env, id, BigInt(r0.targetDrandRound), (c) => c >= 20_000n));
    const owed: bigint = await env.crash.owed(await probe.getAddress());
    expect(owed).to.be.greaterThan(0n);
    await probe.pull();
    expect(await probe.entered()).to.equal(true);
    expect(await probe.received()).to.equal(owed);
    for (const flag of ["balanceMatchedAccounting", "lotteryBalanceMatched", "owedWasZero", "placeBetReverted", "withdrawReverted", "settleReverted", "lockReverted", "refundReverted", "flushReverted", "overflowReverted", "fundVaultReverted"]) {
      expect(await probe[flag](), flag).to.equal(true);
    }
    await assertConserved(env, expect);
  });

  // ── A-9 seed extraction by a manufactured table ────────────────────────
  it("A-9: a same-target solo table is strictly negative-EV against the seed for every target and pool (fair-odds cap + rake), on-chain law", async () => {
    const ccs: any = await (await ethers.getContractFactory("PlankCcs2LSettlement")).deploy();
    const params = { floorBps: DEFAULT_CRASH.floorBps, houseCapBps: DEFAULT_CRASH.houseCapBps };
    const rake = DEFAULT_CRASH.rakeBps;
    let checked = 0;
    for (const pool of [DEFAULT_CRASH.minPoolWei, DEFAULT_CRASH.minPoolWei * 10n, E("5")]) {
      for (const seed of [pool / 10n, pool, 2n * pool, 100n * pool]) {
        for (const m of [10_100n, 10_500n, 11_000n, 15_000n, 20_000n, 29_999n, 30_000n, 30_001n, 40_000n, 100_000n, 1_000_000n, 100_000_000n]) {
          const D = (pool * (BPS - rake)) / BPS;
          const seats = [{ stake: (pool * 6n) / 10n, targetBps: m }, { stake: pool - (pool * 6n) / 10n, targetBps: m }];
          const res = await ccs.settle(D, seed, m, seats, seed * 100n, params); // cap never binds: worst case for the house
          // Exact discrete law: P(crash >= m) = floor(1e8 / m) / 1e4.
          const pSurv = 100_000_000n / m; // x 1e-4
          const evScaled = pSurv * (res.totalPlayerPaid + res.totalBonus) - 10_000n * pool;
          expect(evScaled < 0n, `EV >= 0 at pool=${pool} seed=${seed} m=${m}`).to.equal(true);
          checked += 1;
        }
      }
    }
    console.log(`      same-target solo-table EV < 0 in ${checked}/${checked} cells`);
  });

  it("A-9b (OPEN -- F-2, owner decision): a TWO-target solo table (1.01x pool-keeper + seed-farmer) is positive-EV against a fixed per-round seed; this assertion documents the exposure and must be inverted when the seed law changes", async () => {
    const ccs: any = await (await ethers.getContractFactory("PlankCcs2LSettlement")).deploy();
    const params = { floorBps: DEFAULT_CRASH.floorBps, houseCapBps: DEFAULT_CRASH.houseCapBps };
    const rake = DEFAULT_CRASH.rakeBps;
    const pool = DEFAULT_CRASH.minPoolWei; // 5,000 credits, the cheapest qualifying table
    const seed = DEFAULT_CRASH.crashSeedWei; // 10,000 credits, independent of the pool
    const sB = (pool * 6n) / 10n; // whale cap: largest stake <= 60%
    const sA = pool - sB;
    const mA = 10_100n;
    const mB = 10_000n + (seed * 10_000n) / sB; // fair-odds cap == seed
    const D = (pool * (BPS - rake)) / BPS;
    const both = await ccs.settle(D, seed, mB, [{ stake: sA, targetBps: mA }, { stake: sB, targetBps: mB }], seed * 100n, params);
    const onlyA = await ccs.settle(D, seed, mA, [{ stake: sA, targetBps: mA }, { stake: sB, targetBps: mB }], seed * 100n, params);
    const pB = 100_000_000n / mB; // x1e-4: both survive
    const pA = 100_000_000n / mA - pB; // A alone survives
    const ev = pB * (both.totalPlayerPaid + both.totalBonus) + pA * (onlyA.totalPlayerPaid + onlyA.totalBonus) - 10_000n * pool;
    console.log(`      two-target solo table: EV = +${ev / 10_000n / CREDIT} credits/round on a ${pool / CREDIT}-credit table vs seed ${seed / CREDIT} (rake paid ${(pool - D) / CREDIT})`);
    expect(ev > 0n).to.equal(true); // documents F-2; see the audit for the owner's options
  });

  // ── A-10 lottery: manufactured rounds (documents F-1) ──────────────────
  it("A-10 (OPEN -- F-1, owner decision): a minimum-pool round has the same hit probability as any round, so a P above ~16x the cost of the cheapest round is +EV to farm", async () => {
    const env = await fresh();
    await env.lottery.fund({ value: E("0.1") }); // P = 0.09 ETH net
    await bet(env, env.alice, "1", 15_000n);
    await bet(env, env.bob, "1", 20_000n);
    await settleCurrent(env, toBeHex(11n, 32)); // seals committedPrize
    const [P, W] = await env.lottery.quote();
    expect(P).to.equal(E("0.09"));
    // Two sybils at the minimum qualifying pool: exactly one ticket, odds 1/16.
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    const minPool = DEFAULT_CRASH.minPoolWei;
    await env.crash.connect(env.carol).placeBet(10_100n, { value: (minPool * 6n) / 10n });
    await env.crash.connect(env.dave).placeBet(10_100n, { value: minPool - (minPool * 6n) / 10n });
    const rnd = await findRandomness(env, id, BigInt(r0.targetDrandRound), (_c, seed) => {
      return BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [ethers.keccak256(Buffer.from("PLANK_BALL_V1")), seed]))) % 16n === 0n;
    });
    await settleCurrent(env, rnd);
    const won = (await env.lottery.owed(env.carol.address)) + (await env.lottery.owed(env.dave.address));
    expect(won).to.equal(W); // the whole committed W for a 0.005 ETH table paying 0.000225 ETH of rake
    console.log(`      F-1: a ${minPool / CREDIT}-credit table (rake ${(minPool * DEFAULT_CRASH.rakeBps) / BPS / CREDIT} credits) took W = ${W / CREDIT} credits at 1/${env.lotteryConfig.oddsOneIn}`);
  });
});
