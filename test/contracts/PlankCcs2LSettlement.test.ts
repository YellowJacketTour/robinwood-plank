import { expect } from "chai";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";
import { ethers } from "./helpers/hardhat.js";

type SolSeat = { stake: bigint; targetBps: bigint };
type SolParams = { floorBps: bigint; houseCapBps: bigint };

interface SolResult {
  mode: bigint;
  lambda: bigint;
  totalPlayerPaid: bigint;
  totalBonus: bigint;
  houseReturned: bigint;
  bustedToReserve: bigint;
  playerDust: bigint;
  dustIndex: bigint;
  playerPayouts: bigint[];
  bonuses: bigint[];
}

interface CcsHarness {
  settle(
    playerD: bigint, seedH: bigint, crashBps: bigint,
    seats: SolSeat[], reserveAtLock: bigint, params: SolParams,
  ): Promise<SolResult>;
  settleGas(
    playerD: bigint, seedH: bigint, crashBps: bigint,
    seats: SolSeat[], reserveAtLock: bigint, params: SolParams,
  ): Promise<{ wait(): Promise<{ gasUsed: bigint }> }>;
  lnScaled(xBps: bigint): Promise<bigint>;
  paramsHash(params: SolParams): Promise<string>;
}

interface EngineAllocation {
  playerPayout: bigint;
  houseBonus: bigint;
}

interface EngineSettlement {
  allBust: boolean;
  houseReturned: bigint;
  bustedToReserve: bigint;
  allocations: EngineAllocation[];
  meta: { mode: string; lambda: bigint; playerDust: bigint; dustIndex: number };
}

interface CcsEngine {
  settleCcs2L: (
    playerD: bigint,
    seedH: bigint,
    crashBps: bigint,
    seats: Array<{ id: string; stake: bigint; targetBps: bigint }>,
    reserveAtLock: bigint,
    params: { floorBps: bigint; playerWeight: string; houseCapBps: bigint },
  ) => EngineSettlement;
  lnScaled: (xBps: bigint) => bigint;
  makeRng: (seed: bigint) => () => bigint;
  rngBelow: (rng: () => bigint, bound: bigint) => bigint;
  deriveCrashBps: (r: bigint) => bigint;
}

/**
 * EXACT JS <-> Solidity differential for Two-Layer Continuous Capped
 * Settlement (CCS-2L, variant A).
 *
 * The JS oracle is docs/marketplank/sim-settlement-ccs2l/engine.mjs — the same
 * engine that ran the property suite and the 2M-round campaigns. Every case
 * asserts wei-for-wei equality of every player payout, house bonus, lambda,
 * mode, houseReturned, bustedToReserve and dust, plus BOTH exact conservation
 * identities on the Solidity outputs. Gas for n = 2 / 10 / 50 / 100 survivors.
 *
 * TEST-ONLY: contracts/test/PlankCcs2LSettlement.sol is a candidate harness,
 * not production settlement code.
 */
describe("PlankCcs2LSettlement -- CCS-2L JS<->Solidity wei-exact differential", () => {
  const MODES = ["no-survivor", "floor-degenerate", "normal"] as const;
  let engine: CcsEngine;
  let ccs: CcsHarness;
  const params = { floorBps: 7_500n, houseCapBps: 1_000n };
  const gasRows: Array<{ n: number; mode: string; gas: bigint }> = [];
  const E = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
  const RESERVE = E(500);

  before(async () => {
    engine = (await import(
      pathToFileURL(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "..",
          "docs",
          "marketplank",
          "sim-settlement-ccs2l",
          "engine.mjs",
        ),
      ).href
    )) as unknown as CcsEngine;
    ccs = (await (await ethers.getContractFactory("PlankCcs2LSettlement")).deploy()) as unknown as CcsHarness;
  });

  async function differential(
    label: string,
    playerD: bigint,
    seedH: bigint,
    crashBps: bigint,
    seats: Array<{ stake: bigint; targetBps: bigint }>,
    reserveAtLock: bigint = RESERVE,
  ) {
    const js = engine.settleCcs2L(
      playerD,
      seedH,
      crashBps,
      seats.map((s, i) => ({ id: `s${i}`, ...s })),
      reserveAtLock,
      { floorBps: params.floorBps, playerWeight: "ln", houseCapBps: params.houseCapBps },
    );
    const sol = await ccs.settle(playerD, seedH, crashBps, seats, reserveAtLock, params);
    expect(MODES[Number(sol.mode)], `${label}: mode`).to.equal(
      js.allBust ? "no-survivor" : js.meta.mode === "floor-degenerate" ? "floor-degenerate" : "normal",
    );
    expect(sol.lambda, `${label}: lambda`).to.equal(js.meta.lambda);
    expect(sol.playerDust, `${label}: dust`).to.equal(js.meta.playerDust);
    expect(sol.dustIndex, `${label}: dustIndex`).to.equal(BigInt(js.meta.dustIndex));
    expect(sol.houseReturned, `${label}: houseReturned`).to.equal(js.houseReturned);
    expect(sol.bustedToReserve, `${label}: bustedToReserve`).to.equal(js.bustedToReserve);
    let playerPaid = 0n;
    let bonus = 0n;
    for (let i = 0; i < seats.length; i++) {
      expect(sol.playerPayouts[i], `${label}: player[${i}]`).to.equal(js.allocations[i].playerPayout);
      expect(sol.bonuses[i], `${label}: bonus[${i}]`).to.equal(js.allocations[i].houseBonus);
      playerPaid += sol.playerPayouts[i];
      bonus += sol.bonuses[i];
    }
    expect(sol.totalPlayerPaid, `${label}: totalPlayerPaid`).to.equal(playerPaid);
    expect(sol.totalBonus, `${label}: totalBonus`).to.equal(bonus);
    // BOTH exact conservation identities on the Solidity outputs:
    if (sol.mode === 0n) {
      expect(sol.bustedToReserve, `${label}: bust conservation`).to.equal(playerD + seedH);
      expect(playerPaid + bonus, `${label}: bust pays zero`).to.equal(0n);
    } else {
      expect(playerPaid, `${label}: player conservation`).to.equal(playerD);
      expect(bonus + sol.houseReturned, `${label}: house conservation`).to.equal(seedH);
    }
    return js;
  }

  it("deployed harness (library fully inlined) fits the EIP-170 size limit", async () => {
    const address = await (ccs as unknown as { getAddress(): Promise<string> }).getAddress();
    const code = await ethers.provider.getCode(address);
    const bytes = (code.length - 2) / 2;
    console.log(`      PlankCcs2LSettlement deployed size: ${bytes} bytes (limit 24576)`);
    expect(bytes).to.be.greaterThan(0).and.lessThan(24_576);
  });

  it("paramsHash matches the registry convention byte-for-byte", async () => {
    // keccak256(abi.encode(keccak256("ccs-2l"), 1, floorBps, houseCapBps)) —
    // the same bytes lib/casino/settlement-rules.ts ccs2lParamsHash() emits
    // (pinned there against this literal expression in its own test).
    const expected = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint256", "uint256", "uint256"],
        [keccak256(toUtf8Bytes("ccs-2l")), 1n, params.floorBps, params.houseCapBps],
      ),
    );
    expect(await ccs.paramsHash(params)).to.equal(expected);
  });

  it("lnScaled agrees bit-for-bit across the multiplier range", async () => {
    const points = [10_000n, 10_100n, 10_101n, 14_000n, 27_183n, 100_000n, 398_300n, 10_000_000n, 10n ** 9n];
    for (const x of points) {
      expect(await ccs.lnScaled(x)).to.equal(engine.lnScaled(x));
    }
    let s = 12345n;
    for (let i = 0; i < 200; i++) {
      s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      const x = 10_000n + (s % 999_990_000n);
      expect(await ccs.lnScaled(x)).to.equal(engine.lnScaled(x));
    }
  });

  it("named cases match wei-for-wei (both conservation identities)", async () => {
    // no-survivor: everything to reserve
    await differential("no-survivor", E(10), E(1), 10_500n, [{ stake: E(1), targetBps: 20_000n }]);
    // sole survivor takes the whole player purse + fair-odds-capped bonus
    await differential("sole-survivor", E(100), E(5), 30_000n, [
      { stake: E(1), targetBps: 14_000n },
      { stake: E(99), targetBps: 50_000n },
    ]);
    // whale/top-lock mixed round
    await differential("whale-mixed", E(19), E(0.05), 400_000n, [
      { stake: E(2), targetBps: 398_300n },
      { stake: E(8), targetBps: 14_000n },
      { stake: E(8), targetBps: 20_000n },
    ]);
    // all-low-lock: player RTP still exactly the full purse
    await differential("all-low-lock", E(9.7), 0n, 10_200n, [
      { stake: E(4), targetBps: 10_100n },
      { stake: E(3), targetBps: 10_150n },
      { stake: E(3), targetBps: 10_101n },
    ]);
    // cap-saturation: tiny reserve so the GLOBAL house-purse cap binds
    await differential("cap-saturation", E(9.7), E(50), 40_000n, [
      { stake: E(10), targetBps: 30_000n },
      { stake: E(1), targetBps: 15_000n },
    ], E(1));
    // tiny pool + 1-wei boundary
    await differential("tiny-pool", 97n, 3n, 20_000n, [
      { stake: 50n, targetBps: 15_000n },
      { stake: 50n, targetBps: 19_999n },
    ]);
    await differential("1-wei-boundary", E(9.7) + 1n, E(1) - 1n, 40_000n, [
      { stake: E(5) + 1n, targetBps: 20_000n },
      { stake: E(5) - 1n, targetBps: 30_001n },
    ]);
    // floor-degenerate (f > 1 - rake regime, defensive branch)
    const js = engine.settleCcs2L(
      E(1),
      0n,
      100_000n,
      [
        { id: "s0", stake: E(4), targetBps: 20_000n },
        { id: "s1", stake: E(4), targetBps: 80_000n },
      ],
      RESERVE,
      { floorBps: 7_500n, playerWeight: "ln", houseCapBps: 1_000n },
    );
    expect(js.meta.mode).to.equal("floor-degenerate");
    await differential("floor-degenerate", E(1), 0n, 100_000n, [
      { stake: E(4), targetBps: 20_000n },
      { stake: E(4), targetBps: 80_000n },
    ]);
  });

  it("500 random rounds match wei-for-wei (deterministic seed)", async () => {
    const rng = engine.makeRng(424242n);
    for (let t = 0; t < 500; t++) {
      const n = 1 + Number(engine.rngBelow(rng, 12n));
      const crash = engine.deriveCrashBps(engine.rngBelow(rng, 10_000n));
      const seats: SolSeat[] = [];
      for (let i = 0; i < n; i++) {
        seats.push({
          stake: 1n + engine.rngBelow(rng, E(25)),
          targetBps: 10_100n + engine.rngBelow(rng, 600_000n),
        });
      }
      const playerD = engine.rngBelow(rng, E(300));
      const seedH = engine.rngBelow(rng, 3n) === 0n ? engine.rngBelow(rng, E(5)) : 0n;
      await differential(`random-${t}`, playerD, seedH, crash, seats);
    }
  });

  it("measures gas for n = 2, 10, 50, 100 survivors", async () => {
    for (const n of [2, 10, 50, 100]) {
      const seats: SolSeat[] = [];
      for (let i = 0; i < n; i++) {
        seats.push({
          stake: E(1) + BigInt(i) * 10n ** 15n,
          targetBps: 10_100n + BigInt(i * 137),
        });
      }
      const crash = 400_000n;
      const playerD = (E(1) * BigInt(n) * 9_700n) / 10_000n;
      const seedH = E(0.5);
      const tx = await ccs.settleGas(playerD, seedH, crash, seats, RESERVE, params);
      const receipt = await tx.wait();
      gasRows.push({ n, mode: "normal", gas: receipt.gasUsed });
    }
    console.log(
      "      CCS-2L settle() gas:",
      gasRows.map((r) => `n=${r.n} (${r.mode}): ${r.gas}`).join("  "),
    );
    expect(gasRows.length).to.equal(4);
    for (const r of gasRows) expect(r.gas < 30_000_000n, `n=${r.n} exceeds block gas`).to.equal(true);
  });
});
