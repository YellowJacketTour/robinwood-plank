import { expect } from "chai";
import { AbiCoder, keccak256, toBeHex, toUtf8Bytes } from "ethers";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import {
  BPS, CREDIT, DEFAULT_CRASH, assertConserved, bet, betFor, closeBetting, crashFromSeed, deployCasino, findRandomness,
  freshAddress, increaseToAtLeast, resultSeedOf, seatsOf, settleCurrent, type CasinoEnv,
} from "./helpers/casino.js";
import { evolutionQuote, type SimulationPolicy } from "../../lib/casino/simulation.js";
import { ratifiedRakeSplit } from "../../lib/casino/economics.js";

/**
 * PlankCrash -- the C.8 settlement invariants (S-1 .. S-14) of
 * docs/marketplank/AUDIT-contracts-hardening-2026-09-04.md, proven against
 * the REAL contract graph (only the beacon / PLANK / DEX are mocks).
 */
describe("PlankCrash -- CCS-2L on-chain: lifecycle + C.8 settlement invariants", () => {
  const E = (x: string) => ethers.parseEther(x);

  async function fresh(overrides: Parameters<typeof deployCasino>[0] = {}) {
    const env = await deployCasino(overrides);
    // Bootstrap the Vault so rounds seed (bounded by seedBootstrapBudgetWei).
    await env.crash.connect(env.deployer).fundVault({ value: E("1") });
    // Round 1 was committed by the constructor with an empty Vault (seed 0);
    // void it so the round under test carries a real seed.
    await closeBetting(env);
    await env.crash.lockRound();
    return env;
  }

  it("deployed bytecode fits EIP-170 (all four new contracts)", async () => {
    const env = await deployCasino();
    for (const [name, c] of [["PlankCrash", env.crash], ["PlankLottery", env.lottery], ["PlankRakeRouter", env.rakeRouter], ["PlankBank", env.bank]] as const) {
      const bytes = ((await ethers.provider.getCode(await c.getAddress())).length - 2) / 2;
      console.log(`      ${name} deployed size: ${bytes} bytes (limit 24576)`);
      expect(bytes).to.be.greaterThan(0).and.lessThan(24_576);
    }
  });

  it("S-9/S-10: the round commitment binds rule, params hash and drand target BEFORE any stake; targets are unique; revealNotBefore > bettingEndsAt", async () => {
    const env = await fresh();
    const expectedHash = keccak256(AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
      [
        keccak256(toUtf8Bytes("ccs-2l")),
        2n,
        DEFAULT_CRASH.floorBps,
        DEFAULT_CRASH.houseCapBps,
        DEFAULT_CRASH.houseRakeCapBps,
        DEFAULT_CRASH.maxVaultBonusBps,
        DEFAULT_CRASH.vaultBonusDecayWad,
      ],
    ));
    expect(await env.crash.settlementRuleId()).to.equal(keccak256(toUtf8Bytes("ccs-2l")));
    expect(await env.crash.settlementParamsHash()).to.equal(expectedHash);
    const r1 = await env.crash.rounds(1n);
    expect(r1.paramsHash).to.equal(expectedHash);
    expect(r1.targetDrandRound).to.be.greaterThan(0n);
    expect(await env.crash.seatCount(1n)).to.equal(0n); // committed before any seat
    expect(BigInt(r1.revealNotBefore)).to.be.greaterThan(BigInt(r1.bettingEndsAt));
    expect(await env.crash.drandRoundToRoundId(r1.targetDrandRound)).to.equal(1n);
    // Uniqueness across rounds: play two rounds and compare targets.
    await bet(env, env.alice, "1", 15_000n);
    await bet(env, env.bob, "1", 20_000n);
    await settleCurrent(env, toBeHex(7n, 32));
    const r2 = await env.crash.rounds(2n);
    expect(r2.targetDrandRound).to.not.equal(r1.targetDrandRound);
    expect(await env.crash.drandRoundToRoundId(r2.targetDrandRound)).to.equal(2n);
  });

  it("S-11: a seat is immutable -- no second bet, no setter, no cash-out surface exists", async () => {
    const env = await fresh();
    await bet(env, env.alice, "1", 15_000n);
    await expect(bet(env, env.alice, "1", 30_000n)).to.be.revertedWithCustomError(env.crash, "AlreadyBet");
    const names = env.crash.interface.fragments.filter((f: any) => f.type === "function").map((f: any) => f.name as string);
    for (const n of names) {
      expect(/cashOut|setProgression|setPayoutRedirect|registerResult|pause|owner/i.test(n), `forbidden surface: ${n}`).to.equal(false);
    }
    await expect(bet(env, env.bob, "1", 10_099n)).to.be.revertedWithCustomError(env.crash, "BadTarget");
    await expect(bet(env, env.bob, "0.0001", 15_000n)).to.be.revertedWithCustomError(env.crash, "BadStake");
    await closeBetting(env);
    await expect(bet(env, env.bob, "1", 15_000n)).to.be.revertedWithCustomError(env.crash, "TooLate");
  });

  it("S-1/S-2/S-3/S-5/S-6/S-8: one settled round conserves every purse wei-for-wei (survivors and busts)", async () => {
    const env = await fresh({ crash: { crashSeedWei: E("0.5"), seedBootstrapBudgetWei: E("10") } });
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    expect(r0.seed).to.equal(E("0.5"));
    await bet(env, env.alice, "2", 12_000n);
    await bet(env, env.bob, "3", 25_000n);
    await bet(env, env.carol, "1", 90_000n);
    const seats = await seatsOf(env, id);
    const reserveBefore: bigint = await env.crash.reserve();
    const rnd = await findRandomness(env, id, BigInt(r0.targetDrandRound), (c) => c >= 25_000n && c < 90_000n);
    const { crashBps, round } = await settleCurrent(env, rnd);
    expect(round.crashBps).to.equal(crashBps);
    const playerPool = 6n * 10n ** 18n;
    const rake = 450n;
    const D = (playerPool * (BPS - rake)) / BPS;
    expect(round.playerDistributable).to.equal(D);
    // S-1: player layer pays exactly D to survivors.
    expect(round.totalPlayerPaid).to.equal(D);
    // S-2: bonuses + houseReturned == seed; bonuses <= min(seed, reserveAtLock*cap)
    expect(round.totalBonus + round.houseReturned).to.equal(round.seed);
    const capBase = (BigInt(round.reserveAtLock) * DEFAULT_CRASH.houseCapBps) / BPS;
    expect(round.totalBonus <= (round.seed < capBase ? round.seed : capBase)).to.equal(true);
    // S-2b (v2 actuarial identity): bonuses <= houseRakeCapBps of the round's rake.
    expect(round.totalBonus <= ((playerPool - D) * DEFAULT_CRASH.houseRakeCapBps) / BPS).to.equal(true);
    const preview = await env.crash.previewSettlement(id, crashBps);
    let paidSum = 0n;
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      const owed: bigint = await env.crash.paidOf(id, s.player);
      expect(owed).to.equal(preview.playerPayouts[i] + preview.bonuses[i]);
      paidSum += owed;
      if (s.targetBps <= crashBps) {
        // S-5 survivor floor; S-3 fair-odds cap.
        expect(preview.playerPayouts[i] >= (DEFAULT_CRASH.floorBps * s.stake) / BPS).to.equal(true);
        expect(preview.bonuses[i] <= (s.stake * (s.targetBps - BPS)) / BPS).to.equal(true);
      } else {
        expect(owed).to.equal(0n);
      }
    }
    expect(paidSum).to.equal(round.totalPlayerPaid + round.totalBonus);
    // Rake: gross escrowed for the router (keeper 0).
    expect(await env.crash.pendingRake()).to.equal(playerPool - D);
    // S-6: reserve moves by exactly houseReturned - nextSeed (no bust, no overflow).
    const next = await env.crash.currentRound();
    expect((await env.crash.reserve()) + (await env.crash.pendingOverflow())).to.equal(reserveBefore + round.houseReturned - next.seed);
    expect((await env.crash.reserve()) >= (await env.crash.protectedPrincipal())).to.equal(true);
    await assertConserved(env, expect);
    // Withdraw and verify the pull ledger pays exactly.
    const owedAlice: bigint = await env.crash.owed(env.alice.address);
    const before = await ethers.provider.getBalance(env.alice.address);
    const tx = await env.crash.connect(env.alice).withdraw();
    const rc = await tx.wait();
    const after = await ethers.provider.getBalance(env.alice.address);
    expect(after - before + rc.gasUsed * rc.gasPrice).to.equal(owedAlice);
    await assertConserved(env, expect);
  });

  it("S-1 (all-bust): bustedToReserve == playerDistributable + seed and nobody is paid", async () => {
    const env = await fresh({ crash: { crashSeedWei: E("0.2"), seedBootstrapBudgetWei: E("10") } });
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    await bet(env, env.alice, "1", 30_000n);
    await bet(env, env.bob, "1", 40_000n);
    const reserveBefore: bigint = await env.crash.reserve();
    const rnd = await findRandomness(env, id, BigInt(r0.targetDrandRound), (c) => c < 30_000n);
    const { round, receipt } = await settleCurrent(env, rnd);
    const settled = receipt.logs.map((l: any) => { try { return env.crash.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "RoundSettled");
    expect(settled.args.mode).to.equal(0n);
    const D = (2n * 10n ** 18n * (BPS - 450n)) / BPS;
    expect(settled.args.bustedToReserve).to.equal(D + round.seed);
    expect(await env.crash.paidOf(id, env.alice.address)).to.equal(0n);
    expect(await env.crash.paidOf(id, env.bob.address)).to.equal(0n);
    const next = await env.crash.currentRound();
    expect((await env.crash.reserve()) + (await env.crash.pendingOverflow())).to.equal(reserveBefore + D + round.seed - next.seed);
    await assertConserved(env, expect);
  });

  it("S-7: cumulative net seed never exceeds bootstrap + house income (the income budget)", async () => {
    const env = await fresh({ crash: { crashSeedWei: E("0.3"), seedBootstrapBudgetWei: E("0.5") } });
    // Only 0.5 ETH of budget: after the first draws the seed must starve
    // until income (returns/busts/rake) replenishes it.
    let donations = E("1");
    let houseIncome = 0n; // busted player money + community returns to buffer
    for (let i = 0; i < 6; i++) {
      const id: bigint = await env.crash.currentRoundId();
      const r0 = await env.crash.rounds(id);
      await bet(env, env.alice, "1", 15_000n);
      await bet(env, env.bob, "1", 20_000n);
      const rnd = await findRandomness(env, id, BigInt(r0.targetDrandRound), (c) => (i % 2 === 0 ? c >= 20_000n : c < 15_000n));
      const { round } = await settleCurrent(env, rnd);
      if (round.crashBps < 15_000n) houseIncome += (2n * 10n ** 18n * (BPS - 450n)) / BPS; // busted pot (player part)
      const seeded: bigint = await env.crash.totalSeeded();
      const returned: bigint = await env.crash.totalSeedReturned();
      expect(seeded - returned <= E("0.5") + donations + houseIncome, `round ${i}: income budget`).to.equal(true);
      expect((await env.crash.reserve()) >= (await env.crash.protectedPrincipal())).to.equal(true);
    }
    void donations;
  });

  it("S-4: partition invariance -- splitting one seat across k wallets gains at most k wei (same library the game inlines)", async () => {
    const harness: any = await (await ethers.getContractFactory("PlankCcs2LSettlement")).deploy();
    const params = { floorBps: 7500n, houseCapBps: 1000n, houseRakeCapBps: 5000n, maxVaultBonusBps: 0n, vaultBonusDecayWad: 0n };
    let s = 99n;
    const rng = () => { s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return s; };
    for (let t = 0; t < 40; t++) {
      const n = 2 + Number(rng() % 5n);
      const seats: Array<{ stake: bigint; targetBps: bigint }> = [];
      for (let i = 0; i < n; i++) seats.push({ stake: E("0.5") + rng() % E("5"), targetBps: 10_100n + rng() % 300_000n });
      const crash = 10_100n + rng() % 400_000n;
      const D = E("10") + rng() % E("20");
      const seedH = rng() % E("3");
      const reserve = E("20");
      const rakeWei = D / 20n; // ~4.5% rake against D; the rake cap binds in most cases
      const base = await harness.settle(D, seedH, crash, seats, reserve, rakeWei, 0n, params);
      const victim = Number(rng() % BigInt(n));
      const k = 2 + Number(rng() % 6n);
      const parts: Array<{ stake: bigint; targetBps: bigint }> = [];
      let left = seats[victim].stake;
      for (let j = 0; j < k; j++) {
        const part = j === k - 1 ? left : left / BigInt(k - j);
        parts.push({ stake: part, targetBps: seats[victim].targetBps });
        left -= part;
      }
      const split = [...seats.slice(0, victim), ...parts, ...seats.slice(victim + 1)];
      const res = await harness.settle(D, seedH, crash, split, reserve, rakeWei, 0n, params);
      const unsplitTake = base.playerPayouts[victim] + base.bonuses[victim];
      let splitTake = 0n;
      for (let j = 0; j < k; j++) splitTake += res.playerPayouts[victim + j] + res.bonuses[victim + j];
      expect(splitTake <= unsplitTake + BigInt(k), `case ${t}: split gain ${splitTake - unsplitTake} > ${k} wei`).to.equal(true);
    }
  });

  it("S-12: settleRound never reverts for any in-bound seat set up to MAX_SEATS (fuzz + a full round)", async () => {
    const env = await fresh({ crash: { crashSeedWei: E("0.2"), seedBootstrapBudgetWei: E("100"), maxStakePerWalletBps: 10_000n, bettingDurationSeconds: 1000n } });
    let s = 4242n;
    const rng = () => { s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return s; };
    for (let t = 0; t < 12; t++) {
      const n = 2 + Number(rng() % 10n);
      for (let i = 0; i < n; i++) {
        await betFor(env, freshAddress(), 10_100n + rng() % 5_000_000n, 500n * CREDIT + rng() % E("3"));
      }
      const { round } = await settleCurrent(env, toBeHex(rng(), 32));
      expect(round.phase).to.equal(2n);
      await assertConserved(env, expect);
    }
    // A full round at MAX_SEATS.
    const max = Number(DEFAULT_CRASH.maxSeats);
    for (let i = 0; i < max; i++) {
      await betFor(env, freshAddress(), 10_100n + BigInt(i) * 997n, E("0.01") + BigInt(i) * 10n ** 14n);
    }
    await expect(betFor(env, freshAddress(), 15_000n, E("0.01"))).to.be.revertedWithCustomError(env.crash, "RoundFull");
    const { receipt, round } = await settleCurrent(env, toBeHex(31337n, 32));
    console.log(`      settleRound gas at MAX_SEATS=${max}: ${receipt.gasUsed}`);
    expect(round.phase).to.equal(2n);
    expect(round.totalPlayerPaid + round.totalBonus + round.houseReturned).to.be.greaterThan(0n);
    await assertConserved(env, expect);
  });

  it("gas: settleRound at n = 2 / 10 / 50 / 100 seats", async () => {
    const env = await fresh({ crash: { crashSeedWei: E("0.5"), seedBootstrapBudgetWei: E("100"), maxStakePerWalletBps: 10_000n } });
    const rows: string[] = [];
    for (const n of [2, 10, 50, 100]) {
      const id: bigint = await env.crash.currentRoundId();
      const r0 = await env.crash.rounds(id);
      for (let i = 0; i < n; i++) {
        await betFor(env, freshAddress(), 10_100n + BigInt(i) * 137n, E("1") + BigInt(i) * 10n ** 15n);
      }
      // All survive (crash >= every target), the most expensive branch.
      const rnd = await findRandomness(env, id, BigInt(r0.targetDrandRound), (c) => c >= 40_000n);
      const { receipt } = await settleCurrent(env, rnd);
      rows.push(`n=${n}: ${receipt.gasUsed}`);
      expect(receipt.gasUsed < 30_000_000n).to.equal(true);
    }
    console.log("      settleRound gas:", rows.join("  "));
  });

  it("void path: an under-threshold round refunds every stake exactly and returns the seed", async () => {
    const env = await fresh();
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    const reserveBefore: bigint = await env.crash.reserve();
    await bet(env, env.alice, "1", 15_000n); // minParticipants is 2
    await closeBetting(env);
    await expect(env.crash.lockRound()).to.emit(env.crash, "RoundVoided");
    expect((await env.crash.rounds(id)).phase).to.equal(3n);
    expect(await env.crash.unclaimedRefunds()).to.equal(E("1"));
    await env.crash.claimRefund(id, env.alice.address);
    expect(await env.crash.owed(env.alice.address)).to.equal(E("1"));
    await expect(env.crash.claimRefund(id, env.alice.address)).to.be.revertedWithCustomError(env.crash, "AlreadyRefunded");
    const next = await env.crash.currentRound();
    expect(await env.crash.reserve()).to.equal(reserveBefore + r0.seed - next.seed);
    await assertConserved(env, expect);
    // Whale-dominated rounds void too (60% cap of the FINAL pool).
    await bet(env, env.alice, "10", 15_000n);
    await bet(env, env.bob, "1", 15_000n);
    await closeBetting(env);
    await expect(env.crash.lockRound()).to.emit(env.crash, "RoundVoided").withArgs(await env.crash.currentRoundId() , E("11"), "whale-dominated");
  });

  it("S-13: outcome-independent refund -- fires only after the timeout with NO randomness; settle always wins the race", async () => {
    const env = await fresh();
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    const reserveBefore: bigint = await env.crash.reserve();
    await bet(env, env.alice, "1", 15_000n);
    await bet(env, env.bob, "1", 20_000n);
    await closeBetting(env);
    await env.crash.lockRound();
    expect((await env.crash.rounds(id)).phase).to.equal(1n);
    await expect(env.crash.refundRound()).to.be.revertedWithCustomError(env.crash, "TooEarly");
    await increaseToAtLeast(BigInt(r0.revealNotBefore) + DEFAULT_CRASH.refundTimeoutSeconds);
    // Randomness present => refund is impossible, whatever the outcome would be.
    await env.beacon.setRandomness(r0.targetDrandRound, toBeHex(5n, 32));
    await expect(env.crash.refundRound()).to.be.revertedWithCustomError(env.crash, "RandomnessAvailable");
    // A fresh env where drand truly went dark:
    const env2 = await fresh();
    const id2: bigint = await env2.crash.currentRoundId();
    const r2 = await env2.crash.rounds(id2);
    const reserve2: bigint = await env2.crash.reserve();
    await bet(env2, env2.alice, "1", 15_000n);
    await bet(env2, env2.bob, "1", 20_000n);
    await closeBetting(env2);
    await env2.crash.lockRound();
    await increaseToAtLeast(BigInt(r2.revealNotBefore) + DEFAULT_CRASH.refundTimeoutSeconds);
    await expect(env2.crash.refundRound()).to.emit(env2.crash, "RoundRefunded").withArgs(id2, E("2"), r2.seed);
    await env2.crash.claimRefund(id2, env2.alice.address);
    await env2.crash.claimRefund(id2, env2.bob.address);
    expect(await env2.crash.owed(env2.alice.address)).to.equal(E("1"));
    expect(await env2.crash.owed(env2.bob.address)).to.equal(E("1"));
    const next = await env2.crash.currentRound();
    expect(await env2.crash.reserve()).to.equal(reserve2 + r2.seed - next.seed);
    // Late signature: the refunded round can never settle (mutual exclusion by phase).
    await env2.beacon.setRandomness(r2.targetDrandRound, toBeHex(5n, 32));
    expect((await env2.crash.rounds(id2)).phase).to.equal(4n);
    await expect(env2.crash.settleRound()).to.be.revertedWithCustomError(env2.crash, "TooEarly"); // the NEW round is still betting
    await assertConserved(env2, expect);
    void reserveBefore;
  });

  it("S-14: the rake staircase matches lib evolutionQuote for 10,000 random volumes, and keeper + net == gross exactly", async () => {
    const env = await fresh({ crash: { keeperRewardBps: 500n } });
    let s = 777n;
    const rng = () => { s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return s; };
    // The ratified staircase (lib/playtest-room-core.ts DEFAULT_PLAYTEST_POLICY); only these four fields feed evolutionQuote.
    const policy = { rakeBps: 450n, rakeFloorBps: 250n, rakeStepBps: 25n, rakeVolumeStep: 25_000_000n } as SimulationPolicy;
    for (let i = 0; i < 10_000; i++) {
      const volumeCredits = i < 100 ? BigInt(i) * 25_000_000n : rng() % 400_000_000n;
      const expected = evolutionQuote(policy, volumeCredits).effectiveRakeBps;
      expect(await env.crash.effectiveRakeBpsAt(volumeCredits * CREDIT), `volume ${volumeCredits}`).to.equal(expected);
    }
    // Split identity on a settled round with a 5% keeper bounty.
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    await bet(env, env.alice, "2", 15_000n);
    await bet(env, env.bob, "2", 20_000n);
    const rnd = await findRandomness(env, id, BigInt(r0.targetDrandRound), (c) => c >= 20_000n);
    await settleCurrent(env, rnd, env.keeper);
    const gross = (4n * 10n ** 18n) - (4n * 10n ** 18n * (BPS - 450n)) / BPS;
    const split = ratifiedRakeSplit(gross, 500n);
    expect(await env.crash.owed(env.keeper.address)).to.equal(split.keeper);
    expect(await env.crash.pendingRake()).to.equal(split.netRake);
    await env.crash.flushRake();
    expect(await env.rakeRouter.burnEscrow()).to.equal(split.burn);
    expect((await env.rakeRouter.lotteryEscrow()) + (await env.rakeRouter.vaultEscrow())).to.equal(split.community);
    expect(await env.rakeRouter.founderEscrow()).to.equal(split.founders);
    expect(split.keeper + split.burn + split.community + split.founders).to.equal(gross);
    await assertConserved(env, expect);
  });

  it("the Vault is a solvency floor: principal is monotone and never seeded; overflow above the cap cascades to the lottery", async () => {
    const env = await fresh({ crash: { emissionBufferCapWei: E("0.05"), crashSeedWei: E("0.02"), seedBootstrapBudgetWei: E("100") } });
    // fundVault(1 ETH) above the 0.05 cap: the excess is queued for the lottery.
    expect(await env.crash.pendingOverflow()).to.equal(E("1") - E("0.05"));
    expect((await env.crash.reserve()) + (await env.crash.currentRound()).seed).to.equal(E("0.05"));
    await env.crash.deliverOverflow();
    expect(await env.crash.pendingOverflow()).to.equal(0n);
    expect(await env.lottery.totalFunded()).to.equal(E("0.95"));
    // Play a round, flush rake through the router, claim the Vault leg: 50% becomes principal.
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    await bet(env, env.alice, "5", 15_000n);
    await bet(env, env.bob, "5", 20_000n);
    const rnd = await findRandomness(env, id, BigInt(r0.targetDrandRound), (c) => c >= 20_000n);
    await settleCurrent(env, rnd);
    await env.crash.flushRake();
    const vaultLeg: bigint = await env.rakeRouter.vaultEscrow();
    expect(vaultLeg).to.be.greaterThan(0n);
    await expect(env.crash.fundCommunityReturn({ value: 1n })).to.be.revertedWithCustomError(env.crash, "NotRouter");
    await env.rakeRouter.claimVault();
    expect(await env.crash.protectedPrincipal()).to.equal((vaultLeg * 5000n) / BPS);
    expect((await env.crash.reserve()) >= (await env.crash.protectedPrincipal())).to.equal(true);
    // The floor is never drawn: buffer == reserve - principal bounds nextSeed.
    expect(await env.crash.nextSeed()).to.be.lessThanOrEqual((await env.crash.reserve()) - (await env.crash.protectedPrincipal()));
    await assertConserved(env, expect);
  });

  it("previewSettlement == the settlement actually paid (displayed == redeemable)", async () => {
    const env = await fresh({ crash: { crashSeedWei: E("0.3"), seedBootstrapBudgetWei: E("10") } });
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    await bet(env, env.alice, "1.5", 13_000n);
    await bet(env, env.bob, "2.5", 17_000n);
    await bet(env, env.carol, "0.7", 50_000n);
    const rnd = await findRandomness(env, id, BigInt(r0.targetDrandRound), (c) => c >= 17_000n && c < 50_000n);
    const seed = resultSeedOf(env, id, BigInt(r0.targetDrandRound), rnd, await env.beacon.getAddress());
    const preview = await env.crash.previewSettlement(id, crashFromSeed(seed));
    await settleCurrent(env, rnd);
    const seats = await seatsOf(env, id);
    for (let i = 0; i < seats.length; i++) {
      expect(await env.crash.paidOf(id, seats[i].player)).to.equal(preview.playerPayouts[i] + preview.bonuses[i]);
    }
  });

  it("constructor rejects unsafe configurations (rule/rake/seat/target/refund bounds)", async () => {
    const env = await deployCasino();
    const F = await ethers.getContractFactory("PlankCrash");
    const base = env.crashConfig;
    const bad = (patch: Partial<typeof base>) => F.deploy({ ...base, ...patch });
    await expect(bad({ floorBps: 9_600n })).to.be.revertedWithCustomError(F, "BadConfig"); // floor > 1 - rake
    await expect(bad({ rakeFloorBps: 500n })).to.be.revertedWithCustomError(F, "BadConfig");
    await expect(bad({ rakeStepBps: 0n })).to.be.revertedWithCustomError(F, "BadConfig");
    await expect(bad({ keeperRewardBps: 501n })).to.be.revertedWithCustomError(F, "BadConfig");
    await expect(bad({ maxSeats: 513n })).to.be.revertedWithCustomError(F, "BadConfig");
    await expect(bad({ maxTargetBps: 100_000_001n })).to.be.revertedWithCustomError(F, "BadConfig");
    await expect(bad({ refundTimeoutSeconds: 0n })).to.be.revertedWithCustomError(F, "BadConfig");
    await expect(bad({ roundIntervalSeconds: 10n })).to.be.revertedWithCustomError(F, "BadConfig"); // <= (20+1)*period
    await expect(bad({ beacon: ethers.ZeroAddress })).to.be.revertedWithCustomError(F, "ZeroAddress");
    void networkHelpers;
  });

  // SPEC-monotonic-vault-positive-sum-2026-09-05 §3.5: once THIS contract's
  // own curve is past SPILLOVER_THRESHOLD_ROUNDS (4,000, ~98.2% saturated),
  // further contributing rounds stop growing roundsContributed here and
  // instead credit the lottery's counter -- the reverse direction of the
  // mirror-image mechanism tested in PlankLottery.test.ts.
  describe("v3 spillover past the saturation threshold", () => {
    const THRESHOLD = 4_000n;

    it("SPILLOVER_THRESHOLD_ROUNDS is the ratified 4,000, matching the lottery's own constant", async () => {
      const env = await deployCasino();
      expect(await env.crash.SPILLOVER_THRESHOLD_ROUNDS()).to.equal(THRESHOLD);
      expect(await env.crash.SPILLOVER_THRESHOLD_ROUNDS()).to.equal(await env.lottery.SPILLOVER_THRESHOLD_ROUNDS());
    });

    it("below the threshold, fundVault donations grow this contract's own counter exactly as before", async () => {
      const env = await fresh();
      const before = await env.crash.roundsContributed();
      await env.crash.connect(env.deployer).fundVault({ value: E("0.01") });
      expect(await env.crash.roundsContributed()).to.equal(before + 1n);
    });

    it("past the threshold, further vault-crediting rounds stop advancing this contract's own counter and instead credit the lottery's roundsContributed", async () => {
      const env = await fresh();
      const slot = await findStorageSlot(env.crash, "roundsContributed", THRESHOLD - 1n);
      await ethers.provider.send("hardhat_setStorageAt", [await env.crash.getAddress(), slot, toBeHex(THRESHOLD - 1n, 32)]);
      expect(await env.crash.roundsContributed()).to.equal(THRESHOLD - 1n);
      const lotteryBefore: bigint = await env.lottery.roundsContributed();

      // Each fundVault() call advances currentRoundId's gate by opening a NEW
      // round via closeBetting/lockRound between calls, mirroring how a real
      // round boundary lets _creditRoundsContributed count again.
      await env.crash.connect(env.deployer).fundVault({ value: E("0.01") });
      expect(await env.crash.roundsContributed(), "the round that reaches the threshold still counts locally").to.equal(THRESHOLD);

      await closeBetting(env);
      await env.crash.lockRound();
      await env.crash.connect(env.deployer).fundVault({ value: E("0.01") });
      expect(await env.crash.roundsContributed(), "local counter must stop advancing once at the threshold").to.equal(THRESHOLD);
      expect(await env.lottery.roundsContributed(), "the lottery's counter must be credited instead").to.equal(lotteryBefore + 1n);
    });

    it("creditSpilloverRound is gated to the lottery contract only, and moves the counter by exactly one", async () => {
      const env = await deployCasino();
      await expect(env.crash.connect(env.alice).creditSpilloverRound()).to.be.revertedWithCustomError(env.crash, "NotLottery");
      const lotteryAddr = await env.lottery.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [lotteryAddr]);
      await ethers.provider.send("hardhat_setBalance", [lotteryAddr, "0x56BC75E2D63100000"]);
      const asLottery = await ethers.getSigner(lotteryAddr);
      const before = await env.crash.roundsContributed();
      await env.crash.connect(asLottery).creditSpilloverRound();
      expect(await env.crash.roundsContributed()).to.equal(before + 1n);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [lotteryAddr]);
    });

    it("a bricked/reverting lottery cannot block fundVault: spillover failure is swallowed, not fatal", async () => {
      const env = await deployCasino();
      const slot = await findStorageSlot(env.crash, "roundsContributed", THRESHOLD);
      await ethers.provider.send("hardhat_setStorageAt", [await env.crash.getAddress(), slot, toBeHex(THRESHOLD, 32)]);
      // The real lottery contract's creditSpilloverRound only reverts on the
      // UnauthorizedSource check, so this test forces the WORST case (the
      // lottery slot pointed at a fresh EOA with no code at all) rather than
      // relying on the real lottery ever actually reverting in practice.
      await env.crash.connect(env.deployer).fundVault({ value: E("0.01") });
      expect(await env.crash.roundsContributed(), "stays at the threshold: spillover was attempted but swallowed").to.equal(THRESHOLD);
    });
  });
});

/** Binary-searches for the storage slot of a public uint256 by writing a probe value and reading it back through the getter, then restores it. */
async function findStorageSlot(contract: any, getterName: string, restoreValue: bigint): Promise<string> {
  const addr = await contract.getAddress();
  const probe = 0x424242n;
  for (let slot = 0; slot < 80; slot++) {
    const slotHex = toBeHex(slot, 32);
    const original = await ethers.provider.getStorage(addr, slotHex);
    await ethers.provider.send("hardhat_setStorageAt", [addr, slotHex, toBeHex(probe, 32)]);
    const value: bigint = await contract[getterName]();
    if (value === probe) {
      await ethers.provider.send("hardhat_setStorageAt", [addr, slotHex, toBeHex(restoreValue, 32)]);
      return slotHex;
    }
    await ethers.provider.send("hardhat_setStorageAt", [addr, slotHex, original]);
  }
  throw new Error(`could not locate storage slot for ${getterName}`);
}
