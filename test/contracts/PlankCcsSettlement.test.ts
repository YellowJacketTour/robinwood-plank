import { expect } from "chai";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { ethers } from "./helpers/hardhat.js";

/**
 * EXACT JS <-> Solidity differential for Continuous Capped Settlement (CCS).
 *
 * The JS oracle is docs/marketplank/sim-settlement-ccs/engine.mjs (the same
 * engine that ran the property suite and the 2M-round campaign). Every case
 * below asserts wei-for-wei equality of every payout, lambda, mode,
 * capExcess and vaultRemainder, plus the exact bigint solvency identity on
 * the Solidity side. Also measures gas for n = 2 / 10 / 50 / 100 survivors.
 *
 * TEST-ONLY: contracts/test/PlankCcsSettlement.sol is a candidate harness,
 * not production settlement code.
 */
describe("PlankCcsSettlement -- CCS JS<->Solidity wei-exact differential", () => {
  const MODES = ["all-bust", "cap-excess", "floor-scaled", "interior"] as const;
  let engine: any;
  let ccs: any;
  const params = { floorBps: 7_500n, ceilMultBps: 500_000n };
  const gasRows: Array<{ n: number; mode: string; gas: bigint }> = [];

  before(async () => {
    engine = await import(
      pathToFileURL(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "..",
          "docs",
          "marketplank",
          "sim-settlement-ccs",
          "engine.mjs",
        ),
      ).href
    );
    ccs = await (await ethers.getContractFactory("PlankCcsSettlement")).deploy();
  });

  async function differential(
    label: string,
    distributable: bigint,
    crashBps: bigint,
    seats: Array<{ stake: bigint; targetBps: bigint }>,
  ) {
    const js = engine.settleCcs(
      distributable,
      crashBps,
      seats.map((s, i) => ({ id: `s${i}`, ...s })),
      { floorBps: params.floorBps, ceilMultBps: params.ceilMultBps },
    );
    const sol = await ccs.settle(
      distributable,
      crashBps,
      seats.map((s) => ({ stake: s.stake, targetBps: s.targetBps })),
      params,
    );
    expect(MODES[Number(sol.mode)], `${label}: mode`).to.equal(js.meta.mode);
    expect(sol.lambda, `${label}: lambda`).to.equal(js.meta.lambda);
    expect(sol.capExcess, `${label}: capExcess`).to.equal(js.capExcess);
    expect(sol.vaultRemainder, `${label}: vaultRemainder`).to.equal(js.vaultRemainder);
    let paid = 0n;
    for (let i = 0; i < seats.length; i++) {
      expect(sol.payouts[i], `${label}: payout[${i}]`).to.equal(js.allocations[i].payout);
      paid += sol.payouts[i];
    }
    expect(sol.totalPayout, `${label}: totalPayout`).to.equal(paid);
    // exact solvency identity on the Solidity outputs
    expect(paid + sol.capExcess + sol.vaultRemainder, `${label}: solvency`).to.equal(distributable);
    return js;
  }

  const E = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

  it("lnScaled agrees bit-for-bit across the multiplier range", async () => {
    const points = [10_000n, 10_100n, 10_101n, 14_000n, 27_183n, 100_000n, 398_300n, 10_000_000n, 10n ** 9n];
    for (const x of points) {
      expect(await ccs.lnScaled(x)).to.equal(engine.lnScaled(x));
    }
    // random sweep
    let s = 12345n;
    for (let i = 0; i < 200; i++) {
      s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      const x = 10_000n + (s % 999_990_000n);
      expect(await ccs.lnScaled(x)).to.equal(engine.lnScaled(x));
    }
  });

  it("named feasibility cases match wei-for-wei", async () => {
    // all-bust
    await differential("all-bust", E(10), 10_500n, [{ stake: E(1), targetBps: 20_000n }]);
    // single survivor -> cap-excess routing
    await differential("single-survivor", E(100), 30_000n, [
      { stake: E(1), targetBps: 14_000n },
      { stake: E(99), targetBps: 50_000n },
    ]);
    // floors exceed pool -> floor-scaled degenerate
    await differential("floor-scaled", E(1), 100_000n, [
      { stake: E(4), targetBps: 20_000n },
      { stake: E(4), targetBps: 80_000n },
    ]);
    // interior with cap kink: one seat pinned at its cap
    await differential("interior-cap-kink", E(18), 400_000n, [
      { stake: E(2), targetBps: 398_300n },
      { stake: E(8), targetBps: 14_000n },
      { stake: E(8), targetBps: 20_000n },
    ]);
    // 1-wei boundary probes around the same shape
    await differential("interior-1wei-a", E(18) + 1n, 400_000n, [
      { stake: E(2) + 1n, targetBps: 398_300n },
      { stake: E(8), targetBps: 14_000n },
      { stake: E(8) - 1n, targetBps: 20_000n },
    ]);
    // global ceiling binds (m > 50x cap)
    await differential("global-ceiling", E(500), 900_000n, [
      { stake: E(1), targetBps: 700_000n },
      { stake: E(3), targetBps: 15_000n },
    ]);
  });

  it("round-123-SHAPED synthetic scenario matches wei-for-wei", async () => {
    const seats = [
      { stake: E(2), targetBps: 398_300n },
      { stake: E(3), targetBps: 14_000n },
      { stake: E(3), targetBps: 15_000n },
      { stake: E(2.5), targetBps: 18_000n },
      { stake: E(2.5), targetBps: 20_000n },
      { stake: E(2), targetBps: 22_000n },
      { stake: E(2), targetBps: 30_000n },
      { stake: E(1), targetBps: 45_000n },
      { stake: E(1.5), targetBps: 420_000n },
    ];
    const D = E(0.05) + (E(19.5) * 9_700n) / 10_000n;
    const js = await differential("round-123-shaped", D, 400_000n, seats);
    expect(js.meta.mode).to.equal("interior");
  });

  it("500 random seats/rounds match wei-for-wei (deterministic seed)", async () => {
    const rng = engine.makeRng(424242n);
    for (let t = 0; t < 500; t++) {
      const n = 1 + Number(engine.rngBelow(rng, 12n));
      const crash = engine.deriveCrashBps(engine.rngBelow(rng, 10_000n));
      const seats = [];
      for (let i = 0; i < n; i++) {
        seats.push({
          stake: 1n + engine.rngBelow(rng, E(25)),
          targetBps: 10_100n + engine.rngBelow(rng, 600_000n),
        });
      }
      const D = engine.rngBelow(rng, E(300));
      await differential(`random-${t}`, D, crash, seats);
    }
  });

  it("measures gas for n = 2, 10, 50, 100 survivors", async () => {
    for (const n of [2, 10, 50, 100]) {
      const seats = [];
      for (let i = 0; i < n; i++) {
        seats.push({
          stake: E(1) + BigInt(i) * 10n ** 15n,
          targetBps: 10_100n + BigInt(i * 137), // all survive: crash above max
        });
      }
      const crash = 400_000n;
      const D = (E(1) * BigInt(n) * 9_000n) / 10_000n; // interior regime
      const js = engine.settleCcs(
        D,
        crash,
        seats.map((s: any, i: number) => ({ id: `s${i}`, ...s })),
        { floorBps: params.floorBps, ceilMultBps: params.ceilMultBps },
      );
      const tx = await ccs.settleGas(D, crash, seats, params);
      const receipt = await tx.wait();
      gasRows.push({ n, mode: js.meta.mode, gas: receipt.gasUsed });
    }
    // eslint-disable-next-line no-console
    console.log(
      "      CCS settle() gas:",
      gasRows.map((r) => `n=${r.n} (${r.mode}): ${r.gas}`).join("  "),
    );
    expect(gasRows.length).to.equal(4);
    for (const r of gasRows) expect(r.gas < 30_000_000n, `n=${r.n} exceeds block gas`).to.equal(true);
  });
});
