import { expect } from "chai";
import { toBeHex } from "ethers";
import { ethers } from "./helpers/hardhat.js";
import {
  BPS, CREDIT, DEFAULT_LOTTERY, assertConserved, ballHits, bet, deployCasino, findRandomness, resultSeedOf, seatsOf,
  settleCurrent, winnerOf, type CasinoEnv,
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
 * snapshot, mustHitByRounds, structural reset).
 */
describe("PlankLottery -- round-only draw, progressive carve, C.8 lottery invariants", () => {
  const E = (x: string) => ethers.parseEther(x);

  async function playRound(env: CasinoEnv, wantHit: boolean | null) {
    const id: bigint = await env.crash.currentRoundId();
    const r0 = await env.crash.rounds(id);
    await bet(env, env.alice, "1", 15_000n);
    await bet(env, env.bob, "2", 20_000n);
    await bet(env, env.carol, "0.5", 30_000n);
    const odds = env.lotteryConfig.oddsOneIn;
    const rnd = wantHit === null
      ? toBeHex(id + 1n, 32)
      : await findRandomness(env, id, BigInt(r0.targetDrandRound), (_c, seed) => ballHits(seed, odds) === wantHit);
    return settleCurrent(env, rnd);
  }

  it("L-2: carve conservation and monotonicity over the whole domain (W + S == P; both non-decreasing in P)", async () => {
    const env = await deployCasino();
    // On-chain spot checks across 10 orders of magnitude + the design table.
    const table: Array<[bigint, bigint, bigint]> = [
      [50_000n, 43_334n, 6_666n], [250_000n, 200_000n, 50_000n], [1_000_000n, 740_000n, 260_000n], [10_000_000n, 7_048_781n, 2_951_219n],
    ];
    for (const [pCredits, wCredits, sCredits] of table) {
      const [W, S] = (await env.lottery.carve(pCredits * CREDIT)).map((v: bigint) => v / CREDIT);
      // floor-division rounding: within one credit of the design table's real-valued split
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
    // Exhaustive JS mirror (bit-identical to the contract, checked above) over
    // dense windows at several scales: every single-wei step is monotone.
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

  it("L-1/L-3: the winner is the stake-weighted ticket among THAT round's seats, paid exactly the quoted W; the board reopens at exactly S", async () => {
    const env = await deployCasino();
    await env.lottery.fund({ value: E("10") }); // gross 10 -> fee 1 -> pool 9
    expect(await env.lottery.pool()).to.equal(E("9"));
    expect(await env.lottery.founderEscrow()).to.equal(E("1"));
    // Snapshot: committedPrize is 0 until a round settles (nothing was banked before round 1's commitment).
    expect(await env.lottery.committedPrize()).to.equal(0n);
    const first = await playRound(env, null); // no draw: unfunded snapshot
    expect((await env.lottery.draws())).to.equal(0n);
    expect(await env.lottery.committedPrize()).to.equal(E("9"));
    void first;
    // Now force a natural hit.
    const [P, W, S] = await env.lottery.quote();
    expect(P).to.equal(E("9"));
    const { id, seed, receipt } = await playRound(env, true);
    const seats = await seatsOf(env, id);
    const expectedWinner = winnerOf(seats, seed);
    const draw = receipt.logs.map((l: any) => { try { return env.lottery.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Draw");
    expect(draw.args.winner).to.equal(expectedWinner);
    expect(seats.map((s) => s.player)).to.include(draw.args.winner);
    expect(draw.args.natural).to.equal(true);
    expect(draw.args.winnerPaid).to.equal(W);
    expect(draw.args.seeded).to.equal(S);
    expect(await env.lottery.owed(expectedWinner)).to.equal(W);
    expect(W + S).to.equal(P);
    expect(await env.lottery.pool()).to.equal(S); // structural reset at exactly S > 0
    expect(S).to.be.greaterThan(0n);
    expect(await env.lottery.committedPrize()).to.equal(S);
    expect((await env.crash.rounds(id)).lotteryWinner).to.equal(expectedWinner);
    await assertConserved(env, expect);
    // Withdraw exactly W.
    const winnerSigner = env.signers.find((s: any) => s.address === expectedWinner);
    const before = await ethers.provider.getBalance(expectedWinner);
    const tx = await env.lottery.connect(winnerSigner).withdraw();
    const rc = await tx.wait();
    expect((await ethers.provider.getBalance(expectedWinner)) - before + rc.gasUsed * rc.gasPrice).to.equal(W);
    await assertConserved(env, expect);
  });

  it("L-4: a draw pays only the prize banked BEFORE its round's randomness was committed (funding mid-round joins the next board)", async () => {
    const env = await deployCasino();
    await env.lottery.fund({ value: E("10") });
    await playRound(env, null); // snapshot = 9
    expect(await env.lottery.committedPrize()).to.equal(E("9"));
    // Mid-round funding (the next round is already committed): must not enter this draw.
    await env.lottery.fund({ value: E("100") });
    expect(await env.lottery.pool()).to.equal(E("99"));
    expect(await env.lottery.committedPrize()).to.equal(E("9"));
    const { receipt } = await playRound(env, true);
    const draw = receipt.logs.map((l: any) => { try { return env.lottery.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Draw");
    expect(draw.args.prize).to.equal(E("9"));
    const { S } = carve(E("9"));
    expect(await env.lottery.pool()).to.equal(E("90") + S); // late funding carried whole + seed
    expect(await env.lottery.committedPrize()).to.equal(E("90") + S);
    await assertConserved(env, expect);
  });

  it("L-3: the base never decreases except by a hit that pays exactly W; misses leave the pool untouched", async () => {
    const env = await deployCasino();
    await env.lottery.fund({ value: E("2") });
    await playRound(env, null);
    let pool: bigint = await env.lottery.pool();
    for (let i = 0; i < 4; i++) {
      await playRound(env, false);
      const now: bigint = await env.lottery.pool();
      expect(now >= pool).to.equal(true);
      pool = now;
    }
    expect(await env.lottery.hits()).to.equal(0n);
    expect(await env.lottery.draws()).to.equal(4n);
  });

  it("L-5: a forced hit fires on exactly the mustHitByRounds-th funded qualified round -- never earlier, never skipped -- and pays the same carve", async () => {
    // Odds so long that a natural hit is negligible; the 3rd funded round must force.
    const env = await deployCasino({ lottery: { oddsOneIn: 1n << 60n, mustHitByRounds: 3n } });
    await env.lottery.fund({ value: E("5") });
    await playRound(env, null); // unfunded snapshot -> no draw, counter stays 0
    expect(await env.lottery.fundedRoundsSinceHit()).to.equal(0n);
    expect(await env.lottery.roundsUntilForcedHit()).to.equal(3n);
    for (let i = 1; i <= 2; i++) {
      await playRound(env, null);
      expect(await env.lottery.hits(), `no hit before round ${i}`).to.equal(0n);
      expect(await env.lottery.fundedRoundsSinceHit()).to.equal(BigInt(i));
    }
    const [P, W, S] = await env.lottery.quote();
    const { receipt } = await playRound(env, null);
    const draw = receipt.logs.map((l: any) => { try { return env.lottery.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Draw");
    expect(draw.args.forced).to.equal(true);
    expect(draw.args.natural).to.equal(false);
    expect(draw.args.prize).to.equal(P);
    expect(draw.args.winnerPaid).to.equal(W);
    expect(draw.args.seeded).to.equal(S);
    expect(await env.lottery.forcedHits()).to.equal(1n);
    expect(await env.lottery.fundedRoundsSinceHit()).to.equal(0n);
    expect(await env.lottery.pool()).to.equal(S);
    // The counter restarts: two more rounds do not force.
    await playRound(env, null);
    await playRound(env, null);
    expect(await env.lottery.hits()).to.equal(1n);
    await assertConserved(env, expect);
  });

  it("L-6 (ratified form): the reset is structural -- after every hit the next board opens at S(P) > 0 and is immediately drawable", async () => {
    const env = await deployCasino({ lottery: { oddsOneIn: 1n } }); // every funded round hits
    await env.lottery.fund({ value: E("3") });
    await playRound(env, null); // snapshot
    let expected: bigint = await env.lottery.committedPrize();
    for (let i = 0; i < 5; i++) {
      const { S } = carve(expected);
      await playRound(env, null);
      expect(await env.lottery.hits()).to.equal(BigInt(i + 1));
      expect(S).to.be.greaterThan(0n);
      expect(await env.lottery.pool()).to.equal(S);
      expect(await env.lottery.committedPrize()).to.equal(S);
      expected = S;
    }
    await assertConserved(env, expect);
  });

  it("only the crash may record a draw; the founder fee is pushed only to the fixed sink; forced ETH is never a leg", async () => {
    const env = await deployCasino();
    await expect(env.lottery.recordRound(1n, toBeHex(1n, 32), env.alice.address)).to.be.revertedWithCustomError(env.lottery, "UnauthorizedSource");
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
    void resultSeedOf;
  });
});
