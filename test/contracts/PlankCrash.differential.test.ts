import { expect } from "chai";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { toBeHex } from "ethers";
import { ethers } from "./helpers/hardhat.js";
import { BPS, CREDIT, assertConserved, deployCasino, seatsOf, settleCurrent, type CasinoEnv } from "./helpers/casino.js";
import { DEFAULT_CCS2L_PARAMS, settleCcs2L } from "../../lib/casino/economics-ccs2l.js";

interface CcsEngine {
  settleCcs2L: (
    playerD: bigint, seedH: bigint, crashBps: bigint,
    seats: Array<{ id: string; stake: bigint; targetBps: bigint }>, reserveAtLock: bigint,
    params: { floorBps: bigint; playerWeight: string; houseCapBps: bigint },
  ) => { allBust: boolean; houseReturned: bigint; bustedToReserve: bigint; totalPlayerPaid: bigint; totalBonus: bigint; allocations: Array<{ playerPayout: bigint; houseBonus: bigint }>; meta: { mode: string } };
  makeRng: (seed: bigint) => () => bigint;
  rngBelow: (rng: () => bigint, bound: bigint) => bigint;
}

/**
 * C.9 three-way differential: the REAL PlankCrash.settleRound (pull-ledger
 * credits per seat) vs lib/casino/economics-ccs2l.ts settleCcs2L vs the
 * simulation engine docs/marketplank/sim-settlement-ccs2l/engine.mjs --
 * same seats, same crashBps, same seed, same reserveAtLock, same params,
 * wei-exact. Deterministic seed; every round also asserts S-1/S-2 and
 * physical conservation.
 */
describe("PlankCrash -- three-way wei-exact differential (settleRound vs settleCcs2L vs engine.mjs)", () => {
  const E = (x: string) => ethers.parseEther(x);
  let engine: CcsEngine;
  let env: CasinoEnv;

  before(async () => {
    engine = (await import(
      pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "marketplank", "sim-settlement-ccs2l", "engine.mjs")).href
    )) as unknown as CcsEngine;
    env = await deployCasino({ crash: { crashSeedWei: E("0.4"), seedBootstrapBudgetWei: E("1000"), maxStakePerWalletBps: 10_000n, minPoolWei: 1n } });
    await env.crash.fundVault({ value: E("50") });
  });

  async function differential(label: string, rng: () => bigint, t = 0) {
    const id: bigint = await env.crash.currentRoundId();
    const before = await env.crash.rounds(id);
    const n = 2 + Number(engine.rngBelow(rng, 10n));
    for (let i = 0; i < n; i++) {
      const stake = 500n * CREDIT + engine.rngBelow(rng, E("4"));
      const target = 10_100n + engine.rngBelow(rng, t % 3 === 0 ? 600_000n : 40_000n); // mix low locks (mostly survive) and deep tails
      await env.crash.placeBetFor(ethers.Wallet.createRandom().address, target, { value: stake });
    }
    const seats = await seatsOf(env, id);
    const playerPool = seats.reduce((a, s) => a + s.stake, 0n);
    const rake: bigint = await env.crash.effectiveRakeBps();
    const { crashBps, round } = await settleCurrent(env, toBeHex(engine.rngBelow(rng, 1n << 200n) + 1n, 32));
    const D = (playerPool * (BPS - rake)) / BPS;
    expect(round.playerDistributable, `${label}: D`).to.equal(D);
    expect(round.seed, `${label}: seed committed before bets`).to.equal(before.seed);

    const libSeats = seats.map((s, i) => ({ id: `s${i}`, stake: s.stake, targetBps: s.targetBps }));
    const lib = settleCcs2L(D, before.seed, crashBps, libSeats, before.reserveAtLock, DEFAULT_CCS2L_PARAMS);
    const eng = engine.settleCcs2L(D, before.seed, crashBps, libSeats, before.reserveAtLock, { floorBps: 7500n, playerWeight: "ln", houseCapBps: 1000n });

    for (let i = 0; i < seats.length; i++) {
      const onChain: bigint = await env.crash.paidOf(id, seats[i].player);
      expect(onChain, `${label}: seat ${i} chain==lib`).to.equal(lib.allocations[i].playerPayout + lib.allocations[i].houseBonus);
      expect(onChain, `${label}: seat ${i} chain==engine`).to.equal(eng.allocations[i].playerPayout + eng.allocations[i].houseBonus);
    }
    expect(round.totalPlayerPaid, `${label}: totalPlayerPaid`).to.equal(lib.totalPlayerPaid);
    expect(round.totalBonus, `${label}: totalBonus`).to.equal(lib.totalBonus);
    expect(round.houseReturned, `${label}: houseReturned`).to.equal(lib.houseReturned);
    expect(eng.houseReturned, `${label}: engine houseReturned`).to.equal(lib.houseReturned);
    expect(eng.bustedToReserve, `${label}: engine bustedToReserve`).to.equal(lib.bustedToReserve);
    if (lib.allBust) {
      expect(round.totalPlayerPaid + round.totalBonus).to.equal(0n);
    } else {
      expect(round.totalPlayerPaid).to.equal(D); // S-1
      expect(round.totalBonus + round.houseReturned).to.equal(before.seed); // S-2
    }
    await assertConserved(env, expect);
    return lib;
  }

  it("300 random rounds through the real contract match both JS references wei-for-wei", async () => {
    const rng = engine.makeRng(20260904n);
    let busts = 0;
    for (let t = 0; t < 300; t++) {
      const lib = await differential(`round-${t}`, rng, t);
      if (lib.allBust) busts++;
    }
    console.log(`      differential: 300 rounds, ${busts} all-bust`);
    expect(busts).to.be.greaterThan(0);
  });
});
