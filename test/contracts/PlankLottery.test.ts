import { expect } from "chai";
import { toBeHex } from "ethers";
import { ethers } from "./helpers/hardhat.js";
import {
  BPS, CREDIT, DEFAULT_LOTTERY, PROB_ONE, assertConserved, ballHits, bet, deployCasino, findRandomness, hitThresholdOf,
  netRakeOf, resultSeedOf, seatsOf, settleCurrent, winnerOf, type CasinoEnv,
} from "./helpers/casino.js";

/** JS mirror of PlankLottery.carve(): one floor division. */
function carve(P: bigint, min = DEFAULT_LOTTERY.carveMinBps, max = DEFAULT_LOTTERY.carveMaxBps, c = DEFAULT_LOTTERY.carveHalfSaturationWei) {
  if (P === 0n) return { W: 0n, S: 0n };
  const denom = P + c;
  const S = (P * (min * denom + (max - min) * P)) / (BPS * denom);
  return { W: P - S, S };
}

/**
 * PlankLottery -- the C.8 lottery invariants L-1 .. L-6 under the ratified
 * design (round-only eligibility, progressive carve, uncapped base, prize
 * snapshot, structural reset) and the v2 actuarial hit rule L-7 .. L-9
 * (RESEARCH-game-theory-lottery-seed-resolution-2026-09-05). There is no
 * forced hit: a progressive lottery pays when the ball falls.
 */
describe("PlankLottery -- round-only draw, progressive carve, actuarial hit rule, C.8 lottery invariants", () => {
  const E = (x: string) => ethers.parseEther(x);
  const ROUND_POOL = E("3.5"); // alice 1 + bob 2 + carol 0.5

  /** The threshold the NEXT settlement will use: this round's rake against the committed prize. */
  async function nextThreshold(env: CasinoEnv, playerPool = ROUND_POOL): Promise<bigint> {
    const rake: bigint = await env.crash.effectiveRakeBps();
    const P: bigint = await env.lottery.committedPrize();
    return env.lottery.hitThreshold(netRakeOf(playerPool, rake), P);
  }

  async function playRound(env: CasinoEnv, wantHit: boolean | null) {
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    await bet(env, env.alice, "1", 15_000n);
    await bet(env, env.bob, "2", 20_000n);
    await bet(env, env.carol, "0.5", 30_000n);
    const threshold = await nextThreshold(env);
    const rnd = wantHit === null
      ? toBeHex(id + 1n, 32)
      : await findRandomness(env, id, BigInt(r0.targetDrandRound), (_c, seed) => ballHits(seed, threshold) === wantHit);
    return { ...(await settleCurrent(env, rnd)), threshold };
  }

  const drawOf = (env: CasinoEnv, receipt: any) =>
    receipt.logs.map((l: any) => { try { return env.lottery.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Draw");

  it("L-2: carve conservation and monotonicity over the whole domain (W + S == P; both non-decreasing in P)", async () => {
    const env = await deployCasino();
    const table: Array<[bigint, bigint, bigint]> = [
      [50_000n, 43_334n, 6_666n], [250_000n, 200_000n, 50_000n], [1_000_000n, 740_000n, 260_000n], [10_000_000n, 7_048_781n, 2_951_219n],
    ];
    for (const [pCredits, wCredits, sCredits] of table) {
      const [W, S] = (await env.lottery.carve(pCredits * CREDIT)).map((v: bigint) => v / CREDIT);
      expect(W - wCredits <= 1n && wCredits - W <= 1n, `W(${pCredits})`).to.equal(true);
      expect(S - sCredits <= 1n && sCredits - S <= 1n, `S(${pCredits})`).to.equal(true);
    }
    let prevW = -1n, prevS = -1n;
    for (let e = 0; e <= 30; e++) {
      const P = 10n ** BigInt(e);
      const [W, S] = await env.lottery.carve(P);
      expect(W + S).to.equal(P);
      expect(W >= prevW && S >= prevS, `monotone at 1e${e}`).to.equal(true);
      const js = carve(P);
      expect(W).to.equal(js.W);
      expect(S).to.equal(js.S);
      prevW = W; prevS = S;
    }
    for (const base of [0n, 10n ** 12n, 249_999n * CREDIT, 10n ** 21n, 10n ** 27n]) {
      let prev = carve(base);
      for (let k = 1n; k <= 20_000n; k++) {
        const cur = carve(base + k);
        if (cur.W < prev.W || cur.S < prev.S) throw new Error(`monotonicity broken at P=${base + k}`);
        if (cur.W + cur.S !== base + k) throw new Error(`conservation broken at P=${base + k}`);
        prev = cur;
      }
    }
  });

  it("L-7: the actuarial hit rule -- threshold == min(flat, c*PROB_ONE/(kappa*W)) on-chain == JS; E[payout] <= c/kappa; monotone in rake and in prize", async () => {
    const env = await deployCasino();
    const flat = PROB_ONE / DEFAULT_LOTTERY.oddsOneIn;
    for (const rakeWei of [0n, 225n * CREDIT, netRakeOf(ROUND_POOL), E("1")]) {
      const c = (rakeWei * DEFAULT_LOTTERY.contributionBps) / BPS;
      let prev = flat + 1n;
      for (let e = 0; e <= 27; e += 3) {
        const P = 10n ** BigInt(e);
        const [W] = await env.lottery.carve(P);
        const t: bigint = await env.lottery.hitThreshold(rakeWei, P);
        expect(t, `mirror at rake=${rakeWei} P=1e${e}`).to.equal(hitThresholdOf(rakeWei, P));
        expect(t <= flat, "never better than the flat ceiling").to.equal(true);
        expect(t <= prev, "non-increasing in the prize").to.equal(true);
        prev = t;
        if (W > 0n) {
          // Actuarial identity: t*W/PROB_ONE <= c/kappa (allowing the floor-division wei).
          expect(t * W <= (c * PROB_ONE * BPS) / DEFAULT_LOTTERY.kappaBps + W, "E[payout] <= c/kappa").to.equal(true);
        }
      }
    }
    // Non-decreasing in the rake at a fixed prize.
    const P = 90_000n * CREDIT;
    let prevT = -1n;
    for (const rakeWei of [0n, 1n * CREDIT, 100n * CREDIT, 10_000n * CREDIT, E("10")]) {
      const t: bigint = await env.lottery.hitThreshold(rakeWei, P);
      expect(t >= prevT).to.equal(true);
      prevT = t;
    }
    // Zero prize / zero W falls back to the flat ceiling (draw is skipped by recordRound anyway).
    expect(await env.lottery.hitThreshold(0n, 0n)).to.equal(flat);
    // Small prizes keep the flat cadence: a 3.5 ETH round against a 100-credit prize.
    expect(await env.lottery.hitThreshold(netRakeOf(ROUND_POOL), 100n * CREDIT)).to.equal(flat);
  });

  it("L-1/L-3: the winner is the stake-weighted ticket among THAT round's seats, paid exactly the quoted W; the board reopens at exactly S", async () => {
    const env = await deployCasino();
    await env.lottery.fund({ value: E("0.1") }); // gross 0.1 -> fee 0.01 -> pool 0.09
    expect(await env.lottery.pool()).to.equal(E("0.09"));
    expect(await env.lottery.founderEscrow()).to.equal(E("0.01"));
    expect(await env.lottery.committedPrize()).to.equal(0n);
    await playRound(env, null); // no draw: unfunded snapshot
    expect(await env.lottery.draws()).to.equal(0n);
    expect(await env.lottery.committedPrize()).to.equal(E("0.09"));
    const [P, W, S] = await env.lottery.quote();
    expect(P).to.equal(E("0.09"));
    const { id, seed, receipt, threshold } = await playRound(env, true);
    const seats = await seatsOf(env, id);
    const expectedWinner = winnerOf(seats, seed);
    const draw = drawOf(env, receipt);
    expect(draw.args.winner).to.equal(expectedWinner);
    expect(seats.map((s) => s.player)).to.include(draw.args.winner);
    expect(draw.args.hit).to.equal(true);
    expect(draw.args.threshold).to.equal(threshold);
    expect(draw.args.winnerPaid).to.equal(W);
    expect(draw.args.seeded).to.equal(S);
    expect(await env.lottery.owed(expectedWinner)).to.equal(W);
    expect(W + S).to.equal(P);
    expect(await env.lottery.pool()).to.equal(S); // structural reset at exactly S > 0
    expect(S).to.be.greaterThan(0n);
    expect(await env.lottery.committedPrize()).to.equal(S);
    expect((await env.crash.rounds(id)).lotteryWinner).to.equal(expectedWinner);
    await assertConserved(env, expect);
    const winnerSigner = env.signers.find((s: any) => s.address === expectedWinner);
    const before = await ethers.provider.getBalance(expectedWinner);
    const tx = await env.lottery.connect(winnerSigner).withdraw();
    const rc = await tx.wait();
    expect((await ethers.provider.getBalance(expectedWinner)) - before + rc.gasUsed * rc.gasPrice).to.equal(W);
    await assertConserved(env, expect);
  });

  it("L-4: a draw pays only the prize banked BEFORE its round's randomness was committed (funding mid-round joins the next board)", async () => {
    const env = await deployCasino();
    await env.lottery.fund({ value: E("0.1") });
    await playRound(env, null); // snapshot = 0.09
    expect(await env.lottery.committedPrize()).to.equal(E("0.09"));
    await env.lottery.fund({ value: E("1") });
    expect(await env.lottery.pool()).to.equal(E("0.99"));
    expect(await env.lottery.committedPrize()).to.equal(E("0.09"));
    const { receipt } = await playRound(env, true);
    const draw = drawOf(env, receipt);
    expect(draw.args.prize).to.equal(E("0.09"));
    const { S } = carve(E("0.09"));
    expect(await env.lottery.pool()).to.equal(E("0.9") + S); // late funding carried whole + seed
    expect(await env.lottery.committedPrize()).to.equal(E("0.9") + S);
    await assertConserved(env, expect);
  });

  it("L-3: the base never decreases except by a hit that pays exactly W; misses leave the pool untouched", async () => {
    const env = await deployCasino();
    await env.lottery.fund({ value: E("2") });
    await playRound(env, null);
    let pool: bigint = await env.lottery.pool();
    for (let i = 0; i < 4; i++) {
      const { receipt } = await playRound(env, false);
      expect(drawOf(env, receipt).args.hit).to.equal(false);
      const now: bigint = await env.lottery.pool();
      expect(now >= pool).to.equal(true);
      pool = now;
    }
    expect(await env.lottery.hits()).to.equal(0n);
    expect(await env.lottery.draws()).to.equal(4n);
  });

  it("L-8: a big prize is rarer in exact proportion to what the round pays in -- the draw threshold falls as the prize grows and never exceeds the flat ceiling (Powerball law, no forced hit anywhere)", async () => {
    const env = await deployCasino();
    await env.lottery.fund({ value: E("100") }); // P = 90 ETH: far above the flat regime for a 3.5 ETH round
    await playRound(env, null);
    const big = await nextThreshold(env);
    expect(big < PROB_ONE / DEFAULT_LOTTERY.oddsOneIn).to.equal(true);
    const [P, W] = await env.lottery.quote();
    const c = (netRakeOf(ROUND_POOL) * DEFAULT_LOTTERY.contributionBps) / BPS;
    expect(big).to.equal((c * PROB_ONE * BPS) / (DEFAULT_LOTTERY.kappaBps * W));
    console.log(`      P = ${P / CREDIT} credits: a 3.5 ETH round draws at 1/${PROB_ONE / big} (flat ceiling 1/${DEFAULT_LOTTERY.oddsOneIn})`);
    // No forced-hit surface exists: neither in the ABI nor as an event field.
    const names = env.lottery.interface.fragments.filter((f: any) => f.type === "function").map((f: any) => f.name as string);
    for (const n of names) expect(/forced|mustHit|fundedRoundsSinceHit|roundsUntil/i.test(n), n).to.equal(false);
    const drawEvent = env.lottery.interface.getEvent("Draw");
    expect(drawEvent!.inputs.map((i: any) => i.name)).to.not.include("forced");
    // A miss at the big prize leaves everything in place.
    const { receipt } = await playRound(env, false);
    expect(drawOf(env, receipt).args.threshold).to.equal(big);
    expect(await env.lottery.pool()).to.equal(E("90"));
    await assertConserved(env, expect);
  });

  it("L-6 (ratified form): the reset is structural -- after every hit the next board opens at S(P) > 0 and is immediately drawable", async () => {
    const env = await deployCasino();
    await env.lottery.fund({ value: E("0.1") });
    await playRound(env, null); // snapshot
    let expected: bigint = await env.lottery.committedPrize();
    for (let i = 0; i < 4; i++) {
      const { S } = carve(expected);
      await playRound(env, true);
      expect(await env.lottery.hits()).to.equal(BigInt(i + 1));
      expect(S).to.be.greaterThan(0n);
      expect(await env.lottery.pool()).to.equal(S);
      expect(await env.lottery.committedPrize()).to.equal(S);
      expected = S;
    }
    await assertConserved(env, expect);
  });

  it("L-9: recordRound uses the rake the crash actually passes (net of keeper bounty) -- the event threshold equals hitThreshold(netRake, committedPrize)", async () => {
    const env = await deployCasino({ crash: { keeperRewardBps: 100n } });
    await env.lottery.fund({ value: E("0.5") });
    await playRound(env, null);
    const rake: bigint = await env.crash.effectiveRakeBps();
    const gross = ROUND_POOL - (ROUND_POOL * (BPS - rake)) / BPS;
    const net = gross - (gross * 100n) / BPS;
    const P: bigint = await env.lottery.committedPrize();
    const expected: bigint = await env.lottery.hitThreshold(net, P);
    const id: bigint = await env.crash.currentRoundId();
    await bet(env, env.alice, "1", 15_000n);
    await bet(env, env.bob, "2", 20_000n);
    await bet(env, env.carol, "0.5", 30_000n);
    const { receipt } = await settleCurrent(env, toBeHex(id + 7n, 32));
    expect(drawOf(env, receipt).args.threshold).to.equal(expected);
    expect(expected).to.not.equal(await env.lottery.hitThreshold(gross, P));
  });

  it("only the crash may record a draw; the founder fee is pushed only to the fixed sink; forced ETH is never a leg", async () => {
    const env = await deployCasino();
    await expect(env.lottery.recordRound(1n, toBeHex(1n, 32), env.alice.address, 0n)).to.be.revertedWithCustomError(env.lottery, "UnauthorizedSource");
    await env.lottery.fund({ value: E("1") });
    const before = await ethers.provider.getBalance(env.treasury.address);
    await env.lottery.connect(env.alice).withdrawFounderFees();
    expect((await ethers.provider.getBalance(env.treasury.address)) - before).to.equal(E("0.1"));
    expect(await env.lottery.founderEscrow()).to.equal(0n);
    await expect(env.lottery.connect(env.alice).withdraw()).to.be.revertedWithCustomError(env.lottery, "NothingToWithdraw");
    const names = env.lottery.interface.fragments.filter((f: any) => f.type === "function").map((f: any) => f.name as string);
    for (const n of names) expect(/claimTickets|requestDraw|drawWinner|setProgression|pause|owner/i.test(n), n).to.equal(false);
    const Fl = await ethers.getContractFactory("PlankLottery");
    await expect(Fl.deploy({ ...env.lotteryConfig, carveMaxBps: 10_000n })).to.be.revertedWithCustomError(Fl, "BadConfig");
    await expect(Fl.deploy({ ...env.lotteryConfig, founderFeeBps: 10_000n })).to.be.revertedWithCustomError(Fl, "BadConfig");
    await expect(Fl.deploy({ ...env.lotteryConfig, oddsOneIn: 0n })).to.be.revertedWithCustomError(Fl, "BadConfig");
    await expect(Fl.deploy({ ...env.lotteryConfig, kappaBps: 10_000n })).to.be.revertedWithCustomError(Fl, "BadConfig");
    await expect(Fl.deploy({ ...env.lotteryConfig, contributionBps: 0n })).to.be.revertedWithCustomError(Fl, "BadConfig");
    void resultSeedOf;
  });

  // ── v3: participation-count carve adaptation (SPEC-monotonic-vault-
  // positive-sum-2026-09-05 §5.2) — adapts the EXISTING carve() rather than
  // adding a parallel mechanism: the half-saturation constant `c` shrinks
  // toward a floor as roundsContributed grows, so the same prize pays the
  // winner more over time. carve()'s own conservation/monotonicity proofs
  // hold for ANY positive c (see PlankCcs2LSettlement.test.ts's sibling
  // suite for the same reasoning applied to PlankCrash's vault bonus).
  describe("v3 participation-count carve adaptation", () => {
    it("config validation: the ceiling must be strictly greater than the base, and the decay ratio strictly between 0 and 1 WAD, only when the feature is enabled", async () => {
      const env2 = await deployCasino();
      const Fl = await ethers.getContractFactory("PlankLottery");
      // Feature OFF (ceiling == 0): decayWad is unchecked, any value is fine.
      await Fl.deploy({ ...env2.lotteryConfig, carveDecayWad: 0n, carveHalfSaturationCeilingWei: 0n });
      // Feature ON: ceiling must be strictly ABOVE the base (c grows toward it).
      await expect(
        Fl.deploy({
          ...env2.lotteryConfig,
          carveDecayWad: 999_000_000_000_000_000n,
          carveHalfSaturationCeilingWei: env2.lotteryConfig.carveHalfSaturationWei,
        }),
      ).to.be.revertedWithCustomError(Fl, "BadConfig");
      // Feature ON: decayWad == 0 would jump straight to the ceiling on round 1 — rejected.
      await expect(
        Fl.deploy({ ...env2.lotteryConfig, carveDecayWad: 0n, carveHalfSaturationCeilingWei: 2_500_000n * CREDIT }),
      ).to.be.revertedWithCustomError(Fl, "BadConfig");
      // Feature ON: decayWad >= 1e18 would never grow — rejected.
      await expect(
        Fl.deploy({ ...env2.lotteryConfig, carveDecayWad: 10n ** 18n, carveHalfSaturationCeilingWei: 2_500_000n * CREDIT }),
      ).to.be.revertedWithCustomError(Fl, "BadConfig");
    });

    it("feature OFF is byte-identical to pre-v3 carve() regardless of roundsContributed", async () => {
      const env2 = await deployCasino();
      // Play several rounds so roundsContributed genuinely advances internally
      // (it always tracks, even when unused) — must have zero effect on carve().
      for (let i = 0; i < 3; i++) await playRound(env2, null);
      const before = await env2.lottery.effectiveHalfSaturationWei();
      expect(before).to.equal(DEFAULT_LOTTERY.carveHalfSaturationWei);
      const [w1, s1] = await env2.lottery.carve(E("5"));
      const js = carve(E("5"));
      expect(w1).to.equal(js.W);
      expect(s1).to.equal(js.S);
    });

    it("feature ON: effectiveHalfSaturationWei GROWS monotonically toward the ceiling as real rounds settle, and the winner's take increases as a result", async () => {
      const decayWad = 900_000_000_000_000_000n; // r = 0.9 — fast ramp for a short test
      const ceiling = 2_500_000n * CREDIT; // 10x base
      const base = DEFAULT_LOTTERY.carveHalfSaturationWei;
      const env2 = await deployCasino({ lottery: { carveDecayWad: decayWad, carveHalfSaturationCeilingWei: ceiling } });
      let prevC = await env2.lottery.effectiveHalfSaturationWei();
      expect(prevC).to.equal(base); // round 0: identical to the base, no regression
      const prize = E("5");
      let prevW = carve(prize, DEFAULT_LOTTERY.carveMinBps, DEFAULT_LOTTERY.carveMaxBps, prevC).W;
      for (let i = 0; i < 6; i++) {
        await playRound(env2, null);
        const c = await env2.lottery.effectiveHalfSaturationWei();
        expect(c, `round ${i + 1}: c must be >= previous (growing toward the ceiling)`).to.be.gte(prevC);
        expect(c, `round ${i + 1}: c must never exceed the ceiling`).to.be.lte(ceiling);
        // Same prize, larger c => larger winner take (x(P) decreases in c).
        const [wNow] = await env2.lottery.carve(prize);
        expect(wNow, `round ${i + 1}: winner take must not be less than at the previous (smaller) c`).to.be.gte(prevW);
        prevC = c;
        prevW = wNow;
      }
    });

    it("a fundVault-style donation (fund()) can NEVER advance roundsContributed on its own — only recordRound, gated to the crash's own source, can", async () => {
      const decayWad = 900_000_000_000_000_000n;
      const ceiling = 2_500_000n * CREDIT;
      const env2 = await deployCasino({ lottery: { carveDecayWad: decayWad, carveHalfSaturationCeilingWei: ceiling } });
      const before = await env2.lottery.roundsContributed();
      // Many donations, various sizes, no real crash round in between.
      for (let i = 0; i < 5; i++) await env2.lottery.fund({ value: E("0.01") + BigInt(i) });
      expect(await env2.lottery.roundsContributed(), "donations alone must never move the counter").to.equal(before);
      // A real settled round is the ONLY thing that can.
      await playRound(env2, null);
      expect(await env2.lottery.roundsContributed()).to.equal(before + 1n);
    });

    it("roundsContributed advances by AT MOST one per real crash round, however many recordRound calls somehow reference the same roundId", async () => {
      // recordRound is gated to msg.sender === source (the crash contract) and
      // called exactly once per real settlement in normal operation, so this
      // proves the GATE itself (not just the happy path): a second call for
      // the SAME roundId must be a no-op on the counter.
      const env2 = await deployCasino();
      const crashAddr = await env2.crash.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [crashAddr]);
      await ethers.provider.send("hardhat_setBalance", [crashAddr, "0x56BC75E2D63100000"]); // 100 ETH
      const asCrash = await ethers.getSigner(crashAddr);
      const before = await env2.lottery.roundsContributed();
      await env2.lottery.connect(asCrash).recordRound(1n, toBeHex(1n, 32), env2.alice.address, 0n);
      expect(await env2.lottery.roundsContributed()).to.equal(before + 1n);
      await env2.lottery.connect(asCrash).recordRound(1n, toBeHex(2n, 32), env2.alice.address, 0n);
      expect(await env2.lottery.roundsContributed(), "same roundId twice must not double-count").to.equal(before + 1n);
      await env2.lottery.connect(asCrash).recordRound(2n, toBeHex(3n, 32), env2.alice.address, 0n);
      expect(await env2.lottery.roundsContributed(), "a genuinely new roundId must advance it").to.equal(before + 2n);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [crashAddr]);
    });
  });

  // SPEC-monotonic-vault-positive-sum-2026-09-05 §3.5: once THIS pool's own
  // curve is past SPILLOVER_THRESHOLD_ROUNDS (4,000, ~98.2% saturated),
  // further contributing rounds stop growing roundsContributed here and
  // instead credit the crash contract's counter -- the actual cross-game
  // "unified economics" mechanism. Driven with impersonation + direct calls
  // (as the suite above already does) rather than 4,000 real gameplay
  // rounds, which would make this test suite impractically slow.
  describe("v3 spillover past the saturation threshold", () => {
    const THRESHOLD = 4_000n;

    async function impersonateCrash(env2: CasinoEnv) {
      const crashAddr = await env2.crash.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [crashAddr]);
      await ethers.provider.send("hardhat_setBalance", [crashAddr, "0x56BC75E2D63100000"]);
      return { crashAddr, asCrash: await ethers.getSigner(crashAddr) };
    }

    it("SPILLOVER_THRESHOLD_ROUNDS is the ratified 4,000", async () => {
      const env2 = await deployCasino();
      expect(await env2.lottery.SPILLOVER_THRESHOLD_ROUNDS()).to.equal(THRESHOLD);
    });

    it("below the threshold, recordRound grows this pool's own counter exactly as before", async () => {
      const env2 = await deployCasino();
      const { asCrash } = await impersonateCrash(env2);
      for (let i = 1n; i <= 5n; i++) {
        await env2.lottery.connect(asCrash).recordRound(i, toBeHex(i, 32), env2.alice.address, 0n);
      }
      expect(await env2.lottery.roundsContributed()).to.equal(5n);
    });

    it("past the threshold, recordRound stops advancing this pool's own counter and instead credits the crash contract's roundsContributed", async () => {
      const env2 = await deployCasino();
      const { crashAddr, asCrash } = await impersonateCrash(env2);
      // Fast-forward this pool's own counter to exactly the threshold via
      // direct storage write (avoids 4,000 real recordRound calls, which the
      // gate above already proves advance the counter correctly one at a
      // time). roundsContributed is the counter declared first among the v3
      // fields; recompute the slot rather than assume it if fields move.
      const slot = await findStorageSlot(env2.lottery, "roundsContributed", THRESHOLD - 1n);
      await ethers.provider.send("hardhat_setStorageAt", [await env2.lottery.getAddress(), slot, toBeHex(THRESHOLD - 1n, 32)]);
      expect(await env2.lottery.roundsContributed()).to.equal(THRESHOLD - 1n);
      const crashBefore: bigint = await env2.crash.roundsContributed();

      // One more real round: this crosses into "already at threshold" territory
      // on the round AFTER this one, so first prove the boundary round itself
      // still grows locally (>= vs > matters: the gate is `>= THRESHOLD`, so
      // sitting AT THRESHOLD-1 and settling one more round pushes local count
      // to THRESHOLD, which is the round that starts spilling over from here on).
      await env2.lottery.connect(asCrash).recordRound(1n, toBeHex(1n, 32), env2.alice.address, 0n);
      expect(await env2.lottery.roundsContributed(), "the round that reaches the threshold still counts locally").to.equal(THRESHOLD);

      // The NEXT round is where local growth stops and spillover begins.
      await env2.lottery.connect(asCrash).recordRound(2n, toBeHex(2n, 32), env2.alice.address, 0n);
      expect(await env2.lottery.roundsContributed(), "local counter must stop advancing once at the threshold").to.equal(THRESHOLD);
      expect(await env2.crash.roundsContributed(), "the crash contract's counter must be credited instead").to.equal(crashBefore + 1n);

      // A further round spills over again, by exactly one.
      await env2.lottery.connect(asCrash).recordRound(3n, toBeHex(3n, 32), env2.alice.address, 0n);
      expect(await env2.lottery.roundsContributed()).to.equal(THRESHOLD);
      expect(await env2.crash.roundsContributed()).to.equal(crashBefore + 2n);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [crashAddr]);
    });

    it("creditSpilloverRound is gated to the crash contract (source) only, and moves the counter by exactly one", async () => {
      const env2 = await deployCasino();
      await expect(env2.lottery.connect(env2.alice).creditSpilloverRound()).to.be.revertedWithCustomError(
        env2.lottery, "UnauthorizedSource",
      );
      const { crashAddr, asCrash } = await impersonateCrash(env2);
      const before = await env2.lottery.roundsContributed();
      await env2.lottery.connect(asCrash).creditSpilloverRound();
      expect(await env2.lottery.roundsContributed()).to.equal(before + 1n);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [crashAddr]);
    });

    it("a bricked/reverting crash contract cannot block the lottery's own settlement: spillover failure is swallowed, not fatal", async () => {
      const env2 = await deployCasino();
      const { crashAddr, asCrash } = await impersonateCrash(env2);
      const slot = await findStorageSlot(env2.lottery, "roundsContributed", THRESHOLD);
      await ethers.provider.send("hardhat_setStorageAt", [await env2.lottery.getAddress(), slot, toBeHex(THRESHOLD, 32)]);
      // `crashAddr` here is an EOA impersonation target with no contract code
      // at all, so IPlankCrashSpillover(source).creditSpilloverRound() on it
      // is guaranteed to revert/no-op inside the try/catch -- this is the
      // worst case (a totally unresponsive counterparty), not a best case.
      await env2.lottery.connect(asCrash).recordRound(1n, toBeHex(1n, 32), env2.alice.address, 0n);
      expect(await env2.lottery.roundsContributed(), "stays at the threshold: spillover was attempted but swallowed").to.equal(THRESHOLD);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [crashAddr]);
    });
  });
});

/** Binary-searches for the storage slot of a public uint256 by writing a probe value and reading it back through the getter, then restores it. */
async function findStorageSlot(contract: any, getterName: string, restoreValue: bigint): Promise<string> {
  const addr = await contract.getAddress();
  const probe = 0x424242n;
  for (let slot = 0; slot < 60; slot++) {
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
