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
});
