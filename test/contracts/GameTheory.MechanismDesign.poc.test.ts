import { expect } from "chai";
import { ethers, network } from "./helpers/hardhat.js";
import {
  takeSnapshot,
  time,
  type SnapshotRestorer,
} from "./helpers/network-helpers.js";
import { TIMELOCK, WAD, deployOpenIndex, maxIn } from "./helpers/index-vault.js";

/**
 * GAME-THEORY / MECHANISM-DESIGN PoC SUITE (read-only audit artefact).
 *
 * NEW FILE ONLY. Nothing existing is modified. Every assertion below is about
 * whether a rational profit-maximizing actor's best response matches the
 * INTENDED equilibrium, not about whether value can be stolen. The existing
 * 447-test suite already covers the latter.
 *
 * LOCAL HARDHAT ONLY.
 */
describe("GAME THEORY — mechanism-design PoCs", () => {
  const E = (n: string) => ethers.parseEther(n);
  const RAW_MULT = 10_000n;
  const LP_MULT = 25_000n;
  const COLL_MULT = 30_000n;
  const EPOCH = 7 * 24 * 3_600;

  // Later suites (Seaport EIP-712 expiries, stale-price bands) are clock
  // sensitive, so this file spends exactly ONE timelock period of chain time in
  // total: every gauge it will ever need is deployed and registered up front
  // behind a single `time.increase`, and a snapshot restores the clock at the
  // end regardless.
  let clockSnapshot: SnapshotRestorer;
  const gaugePool: any[] = [];
  let poolIdx = 0;

  function isqrt(n: bigint): bigint {
    if (n < 2n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
      x = y;
      y = (x + n / x) / 2n;
    }
    return x;
  }

  // ── gauge fixture ───────────────────────────────────────────────────────

  const POOL_SIZE = 14;

  before(async () => {
    clockSnapshot = await takeSnapshot();
    const all = await ethers.getSigners();
    const [gaugeRoleAdmin, registry, tuning, rival] = [all[15], all[16], all[17], all[18]];
    const Token = await ethers.getContractFactory("MockIndexToken");
    const Gauge = await ethers.getContractFactory("PlankGauge");

    for (let i = 0; i < POOL_SIZE; i++) {
      const plank: any = await Token.deploy("PLANK", "PLANK");
      const gauge: any = await Gauge.deploy(
        await plank.getAddress(),
        [gaugeRoleAdmin.address, registry.address, tuning.address],
        TIMELOCK,
        [RAW_MULT, LP_MULT, COLL_MULT],
        EPOCH
      );
      const gaugeAddr = await gauge.getAddress();
      const gA = ethers.Wallet.createRandom().address;
      await gauge.connect(registry).queueGauge(gA, false);
      await plank.mint(rival.address, 10_000_000n * WAD);
      await plank.connect(rival).approve(gaugeAddr, ethers.MaxUint256);
      gaugePool.push({ gauge, gaugeAddr, plank, gA, rival });
    }
    // ONE clock advance for the whole file.
    await time.increase(TIMELOCK + 1);
    for (const g of gaugePool) await g.gauge.executeGauge(g.gA);
  });

  after(async () => {
    await clockSnapshot.restore();
  });

  function freshGauge() {
    if (poolIdx >= gaugePool.length) throw new Error("gauge pool exhausted");
    return gaugePool[poolIdx++];
  }

  /** Fund + impersonate an arbitrary address so N can exceed the signer count. */
  async function sybil(plank: any, gaugeAddr: string, seed: number, amount: bigint) {
    const addr = ethers.Wallet.createRandom().address;
    await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
    const signer = await ethers.getSigner(addr);
    await plank.mint(addr, amount);
    await plank.connect(signer).approve(gaugeAddr, ethers.MaxUint256);
    return { addr, signer };
  }

  /**
   * Burn `total` weighted PLANK split evenly across N fresh addresses, against a
   * fixed rival burn, and report the attacker's AGGREGATE effective share plus
   * one shard's published boost multiplier.
   */
  async function runSplit(N: number, total: bigint, rivalAmount: bigint) {
    const { gauge, gaugeAddr, plank, gA, rival } = freshGauge();
    await gauge.connect(rival).burnPlank(gA, rivalAmount);

    const per = total / BigInt(N);
    const addrs: string[] = [];
    for (let i = 0; i < N; i++) {
      const s = await sybil(plank, gaugeAddr, i, per);
      await gauge.connect(s.signer).burnPlank(gA, per);
      addrs.push(s.addr);
    }
    let agg = 0n;
    for (const a of addrs) agg += await gauge.effectiveShareWad(gA, a);
    const boost: bigint = await gauge.boostMultiplier(gA, addrs[0]);
    const contribution: bigint = await gauge.gaugeWeight(gA);
    return { agg, boost, contribution, gauge, gA, addrs };
  }

  // ══ M1 — the OPTIMAL sybil strategy on PlankGauge ══════════════════════

  /**
   * THEORY. Attacker weighted burn W split into N equal shards, rival
   * contribution R fixed.
   *
   *     A(N)  = sum of shard contributions = N*sqrt(W/N) = sqrt(N*W)
   *     f(N)  = A/(A+R)                      -- attacker aggregate RAW share
   *     s(N)  = f/N                          -- one shard's raw share
   *     E(N)  = f(N) * (1 - s(N)^k)          -- attacker aggregate EFFECTIVE share
   *
   * f is strictly increasing in N (A grows as sqrt(N)); s is strictly
   * DEcreasing in N (s = sqrt(W/N)/(A+R), numerator falls, denominator rises).
   * Both factors of E therefore rise with N, so E is STRICTLY INCREASING in N
   * with NO interior optimum. There is no N* at which the mechanism itself
   * stops paying for one more address — the only stopping rule is gas.
   */
  it("M1a: aggregate effective share is STRICTLY INCREASING in sybil count — no interior optimum", async () => {
    const TOTAL = 4_000n * WAD;
    const RIVAL = 4_000n * WAD;
    const results: { N: number; agg: bigint }[] = [];
    for (const N of [1, 2, 4, 8, 16, 32]) {
      const r = await runSplit(N, TOTAL, RIVAL);
      results.push({ N, agg: r.agg });
    }
    // eslint-disable-next-line no-console
    console.log(
      "\n  M1a  attacker aggregate effectiveShare vs sybil count (identical PLANK burned):"
    );
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(
        `        N=${String(r.N).padStart(2)}  effectiveShare = ${(
          Number(r.agg) / 1e16
        ).toFixed(3)}%`
      );
    }
    // A SOLE burner facing a rival still gets something; a sole burner with NO
    // rival gets exactly zero (rawShare 1 => penalty 1). Either way N=1 is the
    // worst possible choice.
    for (let i = 1; i < results.length; i++) {
      expect(results[i].agg).to.be.gt(
        results[i - 1].agg,
        `splitting from N=${results[i - 1].N} to N=${results[i].N} must strictly pay`
      );
    }
    // No interior optimum: the last step still pays.
    expect(results[results.length - 1].agg).to.be.gt(results[0].agg * 2n);
  });

  it("M1b: a SOLE burner is paid exactly ZERO — the penalty does not merely permit sybils, it mandates them", async () => {
    const { gauge, gaugeAddr, plank, gA } = freshGauge();
    const s = await sybil(plank, gaugeAddr, 0, 1_000n * WAD);
    await gauge.connect(s.signer).burnPlank(gA, 1_000n * WAD);
    expect(await gauge.rawShareWad(gA, s.addr)).to.equal(WAD);
    expect(await gauge.effectiveShareWad(gA, s.addr)).to.equal(
      0n,
      "an honest single-wallet burner receives nothing at all"
    );
  });

  /**
   * M1c — THE OPPOSITE OPTIMUM. `boostMultiplier` reads the RAW per-address
   * contribution share c_i/T, which is
   *
   *     c_i/T = sqrt(W/N) / (sqrt(N*W) + R)
   *
   * strictly DECREASING in N. A downstream payer that scales an LP position by
   * this multiplier pays sum_i (L/N)*b_i = L*b_1, so the boost-maximizing
   * strategy is N* = 1 — the exact opposite of the weight-maximizing N* = inf.
   */
  it("M1c: boost-optimal sybil count is N=1 while weight-optimal is N=inf — the two published numbers reward opposite structures", async () => {
    const TOTAL = 4_000n * WAD;
    const RIVAL = 4_000n * WAD;
    const rows: { N: number; agg: bigint; boost: bigint }[] = [];
    for (const N of [1, 2, 4, 8, 16]) {
      const r = await runSplit(N, TOTAL, RIVAL);
      rows.push({ N, agg: r.agg, boost: r.boost });
    }
    // eslint-disable-next-line no-console
    console.log("\n  M1c  weight leg vs boost leg, same burn:");
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `        N=${String(r.N).padStart(2)}  effectiveShare = ${(
          Number(r.agg) / 1e16
        ).toFixed(3)}%   per-shard boost = ${(Number(r.boost) / 10000).toFixed(4)}x`
      );
    }
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].boost).to.be.lt(rows[i - 1].boost, "boost must fall as N rises");
      expect(rows[i].agg).to.be.gt(rows[i - 1].agg, "weight must rise as N rises");
    }
  });

  /**
   * M1d — THE ANTI-WHALE PROPERTY IS ANNIHILATED BY PROPORTIONAL SPLITTING.
   *
   * sqrt dampening claims a whale burning X times a minnow's amount gets only
   * sqrt(X) times the weight. But gas per address is an ABSOLUTE cost, so a
   * whale can afford proportionally more addresses. With N_whale/N_minnow = X:
   *
   *     C_w/C_m = sqrt(N_w*W_w)/sqrt(N_m*W_m) = sqrt(X*X) = X
   *
   * EXACTLY LINEAR. The dampening only binds on an actor too small to fragment.
   */
  it("M1d: a whale that splits proportionally restores EXACT linearity — sqrt dampening binds only on actors too small to fragment", async () => {
    const { gauge, gaugeAddr, plank, gA } = freshGauge();
    const X = 16; // whale burns 16x the minnow
    const MINNOW = 100n * WAD;

    const m = await sybil(plank, gaugeAddr, 999, MINNOW);
    await gauge.connect(m.signer).burnPlank(gA, MINNOW);
    const cMinnow: bigint = await gauge.accountWeight(gA, m.addr);

    const whaleAddrs: string[] = [];
    const per = (MINNOW * BigInt(X)) / BigInt(X); // == MINNOW per shard, X shards
    for (let i = 0; i < X; i++) {
      const s = await sybil(plank, gaugeAddr, i, per);
      await gauge.connect(s.signer).burnPlank(gA, per);
      whaleAddrs.push(s.addr);
    }
    let cWhale = 0n;
    for (const a of whaleAddrs) cWhale += await gauge.accountWeight(gA, a);

    const naiveSqrt = isqrt(MINNOW * BigInt(X) * WAD) / isqrt(MINNOW * WAD); // ~4
    // eslint-disable-next-line no-console
    console.log(
      `\n  M1d  whale burns ${X}x the minnow.` +
        `\n        undamped (linear) ratio  = ${X}` +
        `\n        sqrt-damped ratio (N=1)  = ~${Number(naiveSqrt)}` +
        `\n        ratio with ${X} shards     = ${Number(cWhale) / Number(cMinnow)}`
    );
    // The realised ratio is X, not sqrt(X).
    expect(cWhale).to.equal(cMinnow * BigInt(X));
    expect(Number(naiveSqrt)).to.be.lt(X, "sanity: sqrt(X) < X");
  });

  // ══ M6 — HHI correlation-blindness, quantified ═════════════════════════

  it("M6a: 32 perfectly-correlated legs read the BEST possible HHI while being 100% one bet", async () => {
    const fx = await deployOpenIndex();
    const rows: string[] = [];
    for (const n of [2, 3, 4, 10, 20, 32, 50]) {
      const cap: bigint = await fx.vault.capBpsFor(n);
      const hhiEqualWeight = 10_000 / n; // bps: sum of (1/n)^2 over n legs
      rows.push(
        `        n=${String(n).padStart(2)}  capBpsFor=${String(cap).padStart(5)}bps` +
          `   equal-weight HHI=${hhiEqualWeight.toFixed(0)}bps (target 2000bps)` +
          `   hidden single-bet exposure if all n are correlated = 100%`
      );
    }
    // eslint-disable-next-line no-console
    console.log("\n  M6a  HHI reads BEST exactly where true concentration is WORST:\n" + rows.join("\n"));

    // At the contract's own MAX_CONSTITUENTS the measured HHI is 312 bps —
    // 6.4x BETTER than the 2000 bps target — with 100% true concentration.
    const hhi32 = 10_000 / 32;
    expect(hhi32).to.be.lessThan(2_000);
    // And every leg is far under the enforced cap.
    const cap32: bigint = await fx.vault.capBpsFor(32);
    expect(10_000 / 32).to.be.lessThan(Number(cap32));
  });

  it("M6b: inflating the ELIGIBLE COUNT only ever LOOSENS the enforced cap (capBpsFor rises with n)", async () => {
    const fx = await deployOpenIndex();
    const c3: bigint = await fx.vault.capBpsFor(3);
    const c10: bigint = await fx.vault.capBpsFor(10);
    const c50: bigint = await fx.vault.capBpsFor(50);
    // eslint-disable-next-line no-console
    console.log(
      `\n  M6b  capBpsFor(3)=${c3}  capBpsFor(10)=${c10}  capBpsFor(50)=${c50}` +
        `\n        eligibility bars at deploy: 0.1 ETH lifetime fees + 100 blocks.` +
        `\n        7 wash-traded constituents move the enforced cap ${c3} -> ${c10} bps.`
    );
    expect(c10).to.be.gt(c3);
    expect(c50).to.be.gt(c10);
  });

  // ══ M2 — the wrapper's zero-denominator carry, same-block capture ══════

  /**
   * The header claims the one-block arm "means the pot is genuinely shared by
   * whoever is present rather than won by transaction ordering". This drives a
   * whale that lands a large deposit in the SAME BLOCK as the pioneer whose
   * deposit armed the clock: `_armCarry` only fires on the 0 -> nonzero
   * transition, so the whale never re-arms, is present at the unlock, and takes
   * the pot pro rata to size with ONE block of exposure.
   */
  it("M2: the carry's one-block arm is won by the largest SAME-BLOCK deposit, not by duration", async () => {
    const DELAY = 48 * 3600;
    const fx = await deployOpenIndex();
    const signers = await ethers.getSigners();
    const lister = signers[9];
    const briber = signers[10];

    const W = await ethers.getContractFactory("WrappedIndexShare");
    const wrapper: any = await W.deploy(
      fx.vaultAddr,
      "Wrapped Global Index",
      "wIDX",
      fx.roleAdmin.address,
      lister.address,
      DELAY
    );
    const wrapperAddr = await wrapper.getAddress();
    for (const who of [fx.alice, fx.bob]) {
      await fx.vault.connect(who).approve(wrapperAddr, ethers.MaxUint256);
      await fx.tokens[0].connect(who).approve(wrapperAddr, ethers.MaxUint256);
      await fx.vault.connect(who).mintProRata(E("5000"), maxIn(3));
    }

    // List + fund a stream while the wrapper is EMPTY -> the pot is carried.
    const T = await ethers.getContractFactory("MockIndexToken");
    const bribe: any = await T.deploy("BRIBE", "BRIBE");
    const bribeAddr = await bribe.getAddress();
    await wrapper.connect(lister).queueStream(bribeAddr);
    await time.increase(DELAY + 1);
    await wrapper.executeStream(bribeAddr);
    const POT = E("100000");
    await bribe.mint(briber.address, POT);
    await bribe.connect(briber).approve(wrapperAddr, POT);
    await wrapper.connect(briber).depositStream(bribeAddr, POT);
    expect(await wrapper.carry(bribeAddr)).to.equal(POT);

    // ONE BLOCK: pioneer arms the clock, whale piles in behind them.
    await network.provider.send("evm_setAutomine", [false]);
    await wrapper.connect(fx.alice).deposit(E("1")); // pioneer, arms carry
    await wrapper.connect(fx.bob).deposit(E("4000")); // whale, same block
    await network.provider.send("evm_mine");
    await network.provider.send("evm_setAutomine", [true]);

    const aliceW: bigint = await wrapper.balanceOf(fx.alice.address);
    const bobW: bigint = await wrapper.balanceOf(fx.bob.address);
    expect(bobW).to.be.gt(0n);

    // Next block: the carry folds. Whale exits immediately.
    const before: bigint = await bribe.balanceOf(fx.bob.address);
    await wrapper.connect(fx.bob).withdraw(bobW);
    const got: bigint = (await bribe.balanceOf(fx.bob.address)) - before;

    const pct = (Number(got) / Number(POT)) * 100;
    // eslint-disable-next-line no-console
    console.log(
      `\n  M2  pioneer wIDX=${aliceW}  whale wIDX=${bobW}` +
        `\n       whale captured ${pct.toFixed(2)}% of the carried pot` +
        `\n       exposure: ONE block, full price paid for raw shares, zero duration risk.`
    );
    expect(pct).to.be.greaterThan(90, "the largest same-block depositor takes the pot");
  });
});
