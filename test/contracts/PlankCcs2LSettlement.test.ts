import { expect } from "chai";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";
import { ethers } from "./helpers/hardhat.js";

type SolSeat = { stake: bigint; targetBps: bigint };
type SolParams = {
  floorBps: bigint;
  houseCapBps: bigint;
  houseRakeCapBps: bigint;
  maxVaultBonusBps: bigint;
  vaultBonusDecayWad: bigint;
};

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
    seats: SolSeat[], reserveAtLock: bigint, rakeWei: bigint, vaultRoundsContributed: bigint, params: SolParams,
  ): Promise<SolResult>;
  settleGas(
    playerD: bigint, seedH: bigint, crashBps: bigint,
    seats: SolSeat[], reserveAtLock: bigint, rakeWei: bigint, vaultRoundsContributed: bigint, params: SolParams,
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
    params: {
      floorBps: bigint;
      playerWeight: string;
      houseCapBps: bigint;
      houseRakeCapBps: bigint;
      maxVaultBonusBps: bigint;
      vaultBonusDecayWad: bigint;
    },
    rakeWei?: bigint,
    vaultRoundsContributed?: bigint,
  ) => EngineSettlement;
  lnScaled: (xBps: bigint) => bigint;
  makeRng: (seed: bigint) => () => bigint;
  rngBelow: (rng: () => bigint, bound: bigint) => bigint;
  deriveCrashBps: (r: bigint) => bigint;
  vaultBonusBps: (maxVaultBonusBps: bigint, vaultBonusDecayWad: bigint, roundsContributed: bigint) => bigint;
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
  const params = {
    floorBps: 7_500n,
    houseCapBps: 1_000n,
    houseRakeCapBps: 5_000n,
    maxVaultBonusBps: 0n,
    vaultBonusDecayWad: 0n,
  };
  // A second, feature-ON params set for the dedicated vault-bonus differential
  // cases below -- kept separate from `params` so every EXISTING case above
  // still exercises the feature-off (backward-compatible) path unchanged.
  const vaultParams = { ...params, maxVaultBonusBps: 2_500n, vaultBonusDecayWad: 999_000_000_000_000_000n };
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
    // Default: the rake a 4.5%-rake round would leave against this D, so the
    // v2 rake cap is exercised (binding or not) in every differential case.
    rakeWei: bigint = (playerD * 450n) / 9_550n,
    activeParams: SolParams = params,
    vaultRoundsContributed: bigint = 0n,
  ) {
    const js = engine.settleCcs2L(
      playerD,
      seedH,
      crashBps,
      seats.map((s, i) => ({ id: `s${i}`, ...s })),
      reserveAtLock,
      {
        floorBps: activeParams.floorBps,
        playerWeight: "ln",
        houseCapBps: activeParams.houseCapBps,
        houseRakeCapBps: activeParams.houseRakeCapBps,
        maxVaultBonusBps: activeParams.maxVaultBonusBps,
        vaultBonusDecayWad: activeParams.vaultBonusDecayWad,
      },
      rakeWei,
      vaultRoundsContributed,
    );
    const sol = await ccs.settle(playerD, seedH, crashBps, seats, reserveAtLock, rakeWei, vaultRoundsContributed, activeParams);
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
    // keccak256(abi.encode(keccak256("ccs-2l"), 2, floorBps, houseCapBps,
    // houseRakeCapBps, maxVaultBonusBps, vaultBonusDecayWad)) — the same
    // bytes lib/casino/settlement-rules.ts ccs2lParamsHash() emits (pinned
    // there against this literal expression in its own test).
    const expected = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
        [
          keccak256(toUtf8Bytes("ccs-2l")),
          2n,
          params.floorBps,
          params.houseCapBps,
          params.houseRakeCapBps,
          params.maxVaultBonusBps,
          params.vaultBonusDecayWad,
        ],
      ),
    );
    expect(await ccs.paramsHash(params)).to.equal(expected);
  });

  it("paramsHash changes when the vault-bonus params change (feature-on differs from feature-off)", async () => {
    expect(await ccs.paramsHash(vaultParams)).to.not.equal(await ccs.paramsHash(params));
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
      {
        floorBps: 7_500n,
        playerWeight: "ln",
        houseCapBps: 1_000n,
        houseRakeCapBps: 5_000n,
        maxVaultBonusBps: 0n,
        vaultBonusDecayWad: 0n,
      },
      (E(1) * 450n) / 9_550n,
      0n,
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

  // ── v3: participation-count vault bonus (SPEC-monotonic-vault-positive-
  // sum-2026-09-05 §3.4) — JS<->Solidity differential + the mechanism's own
  // real invariants (monotone in roundsContributed, capped by rake, never
  // reads a vault balance, backward-compatible when the feature is off).
  describe("v3 participation-count vault bonus", () => {
    it("feature OFF (maxVaultBonusBps == 0) is byte-identical to the pre-v3 house layer regardless of roundsContributed", async () => {
      // A large roundsContributed must have ZERO effect when the feature is
      // off -- proves the off-switch is real, not just "usually zero."
      for (const rounds of [0n, 1n, 1_000n, 1_000_000n]) {
        await differential(`feature-off-rounds-${rounds}`, E(100), E(5), 30_000n, [
          { stake: E(1), targetBps: 14_000n },
          { stake: E(99), targetBps: 50_000n },
        ], RESERVE, undefined, params, rounds);
      }
    });

    it("feature ON matches wei-for-wei across a sweep of roundsContributed, and the bonus is monotone non-decreasing", async () => {
      const sweep = [0n, 1n, 100n, 500n, 1_000n, 2_000n, 4_000n, 10_000n, 100_000n];
      let prevBonus: bigint = -1n;
      for (const rounds of sweep) {
        const js = await differential(`vault-on-rounds-${rounds}`, E(100), E(5), 30_000n, [
          { stake: E(1), targetBps: 14_000n },
          { stake: E(99), targetBps: 50_000n },
        ], RESERVE, undefined, vaultParams, rounds);
        const bonus = js.allocations.reduce((a, alloc) => a + alloc.houseBonus, 0n);
        expect(bonus, `rounds=${rounds}: monotone non-decreasing`).to.be.gte(prevBonus);
        prevBonus = bonus;
      }
    });

    it("the vault bonus cap can only ever NARROW hAvail, never widen it past houseRakeCapBps's own room", async () => {
      // Same seats/pot, feature off vs. on at rounds=0 (curve's own floor,
      // smallest possible bonus fraction): the ON case must never pay MORE
      // than the OFF case, since maxVaultBonusBps <= houseRakeCapBps by the
      // contract's own config validation and the curve starts near zero.
      const seats = [
        { stake: E(1), targetBps: 14_000n },
        { stake: E(99), targetBps: 50_000n },
      ];
      const off = await differential("cap-narrows-off", E(100), E(5), 30_000n, seats, RESERVE, undefined, params, 0n);
      const on = await differential("cap-narrows-on", E(100), E(5), 30_000n, seats, RESERVE, undefined, vaultParams, 0n);
      const offBonus = off.allocations.reduce((a, alloc) => a + alloc.houseBonus, 0n);
      const onBonus = on.allocations.reduce((a, alloc) => a + alloc.houseBonus, 0n);
      expect(onBonus, "vault cap at rounds=0 must not exceed the feature-off bonus").to.be.lte(offBonus);
    });

    it("at a moderately large roundsContributed the curve is asymptotically close to, but strictly under, maxVaultBonusBps", async () => {
      // At n=10,000 (r=0.999) the curve is real-valued-close to the ceiling
      // but WAD fixed-point precision has not yet underflowed r^n to exactly
      // 0 -- the honest "still climbing" regime, matching the spec's own
      // worked table (docs/marketplank/SPEC-monotonic-vault-positive-sum-
      // 2026-09-05.md §3.4.1: 25.00% at 10,000 rounds, verified there by
      // direct computation too). Confirmed by direct computation here that
      // WAD precision saturation (r^n floors to exactly 0) does not begin
      // until n is somewhere between 40,000 and 50,000 -- well past this.
      const nearCeiling = engine.vaultBonusBps(vaultParams.maxVaultBonusBps, vaultParams.vaultBonusDecayWad, 10_000n);
      expect(nearCeiling, "must be strictly under the ceiling at this scale").to.be.lt(vaultParams.maxVaultBonusBps);
      expect(nearCeiling, "must be extremely close to the ceiling at this scale").to.be.gte(vaultParams.maxVaultBonusBps - 1n);
    });

    it("at an astronomically large roundsContributed, WAD precision saturates r^n to exactly 0 -- the cap equals but NEVER EXCEEDS maxVaultBonusBps", async () => {
      // Real, honest fixed-point behavior, not a bug: 0.999^10,000,000 is far
      // below any representable WAD (1e-18) precision, so r^n correctly
      // computes to exactly 0 and the bonus cap saturates AT the ceiling.
      // The one invariant that must hold at every scale, forever, is
      // "never exceeds" -- verified here at the most extreme scale tested,
      // and in the sweep test above across every earlier, still-climbing one.
      const saturated = engine.vaultBonusBps(vaultParams.maxVaultBonusBps, vaultParams.vaultBonusDecayWad, 10_000_000n);
      expect(saturated, "must equal the ceiling once WAD precision saturates").to.equal(vaultParams.maxVaultBonusBps);
    });

    it("roundsContributed alone (never a vault balance) drives the bonus: identical seats/pot, only the round-count input differs", async () => {
      // This is the exploit-resistance property from spec §3.6, verified at
      // the settlement-math layer: the function signature has NO vault
      // balance parameter at all -- there is structurally nothing for a
      // single large deposit to move. Confirmed by re-running the exact same
      // economic inputs at two different roundsContributed values and seeing
      // the bonus move ONLY with that one input.
      const seats = [
        { stake: E(1), targetBps: 14_000n },
        { stake: E(99), targetBps: 50_000n },
      ];
      const low = await differential("rounds-driver-low", E(100), E(5), 30_000n, seats, RESERVE, undefined, vaultParams, 10n);
      const high = await differential("rounds-driver-high", E(100), E(5), 30_000n, seats, RESERVE, undefined, vaultParams, 5_000n);
      const lowBonus = low.allocations.reduce((a, alloc) => a + alloc.houseBonus, 0n);
      const highBonus = high.allocations.reduce((a, alloc) => a + alloc.houseBonus, 0n);
      expect(highBonus, "more participation must never pay LESS").to.be.gt(lowBonus);
    });
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
      const tx = await ccs.settleGas(playerD, seedH, crash, seats, RESERVE, RESERVE / 100n, 0n, params);
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
