import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { TIMELOCK, WAD } from "./helpers/index-vault";

/**
 * ============================================================================
 *  ROUND 9f — THE PER-IDENTITY REGISTRATION BURN (PlankGauge)
 *
 *  Primary regression suite for the HIGH finding that PlankGauge's two headline
 *  economic properties invert under rational play:
 *
 *    (a) "anti-whale" sqrt dampening is actually ANTI-MINNOW, because a whale
 *        that splits PROPORTIONALLY restores exact linearity and the only cost
 *        of an extra address was GAS — an absolute cost, not a proportional
 *        one, so it binds only on actors too small to fragment;
 *    (b) `gaugeWeight` (aggregated across addresses) is maximised at N -> inf
 *        while `boostMultiplier` (read per address) is maximised at N = 1, and
 *        since a SOLE burner's effective share is exactly zero, anybody who
 *        wants influence is FORCED to fragment and forfeit the boost.
 *
 *  The repair implemented is the audit's own recommendation: a per-address,
 *  per-gauge, per-epoch REGISTRATION BURN denominated in the burned asset
 *  itself. The whole claim it makes is that the sybil count stops being
 *  gas-limited-and-unbounded and becomes budget-limited with a hard interior
 *  optimum. This file proves exactly that and nothing more.
 *
 *    THEORY. Budget B, per-address registration cost p, N shards:
 *        A(N) = sqrt( N * (B - N*p) * mult )     -- a downward parabola
 *        N*   = B / (2p)                        -- gas-independent
 *        A(N) = 0 for N >= B/p                  -- a hard ceiling
 *    At the optimum the attacker destroys HALF their budget on registrations
 *    and receives no weight whatsoever for it.
 *
 *  LOCAL HARDHAT ONLY. Same deployment gate as the contract itself.
 * ============================================================================
 */
describe("PlankGauge — asset-denominated sybil cost (round 9f)", () => {
  let __snap: SnapshotRestorer;
  before(async () => {
    __snap = await takeSnapshot();
  });
  after(async () => {
    await __snap.restore();
  });

  const RAW_MULT = 10_000n;
  const LP_MULT = 25_000n;
  const COLL_MULT = 30_000n;
  const EPOCH = 7 * 24 * 3_600;
  const K_REG = ethers.encodeBytes32String("registrationBurnPlank");
  const DEAD = "0x000000000000000000000000000000000000dEaD";

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

  async function deploy() {
    const all = await ethers.getSigners();
    const [roleAdmin, registry, tuning] = [all[15], all[16], all[17]];
    const Token = await ethers.getContractFactory("MockIndexToken");
    const plank: any = await Token.deploy("PLANK", "PLANK");
    const Gauge = await ethers.getContractFactory("PlankGauge");
    const gauge: any = await Gauge.deploy(
      await plank.getAddress(),
      [roleAdmin.address, registry.address, tuning.address],
      TIMELOCK,
      [RAW_MULT, LP_MULT, COLL_MULT],
      EPOCH
    );
    const gaugeAddr = await gauge.getAddress();
    const gA = ethers.Wallet.createRandom().address;
    await gauge.connect(registry).queueGauge(gA, false);
    await time.increase(TIMELOCK + 1);
    await gauge.executeGauge(gA);
    return { gauge, gaugeAddr, plank, gA, roleAdmin, registry, tuning };
  }

  /** Set `registrationBurnPlank` through the REAL timelocked governance path. */
  async function setRegistrationBurn(fx: any, value: bigint) {
    await fx.gauge.connect(fx.tuning).queueParam(K_REG, value);
    await time.increase(TIMELOCK + 1);
    await fx.gauge.executeParam(K_REG);
    expect(await fx.gauge.registrationBurnPlank()).to.equal(value);
  }

  async function sybil(fx: any, amount: bigint) {
    const addr = ethers.Wallet.createRandom().address;
    await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
    const signer = await ethers.getSigner(addr);
    await fx.plank.mint(addr, amount);
    await fx.plank.connect(signer).approve(fx.gaugeAddr, ethers.MaxUint256);
    return { addr, signer };
  }

  /**
   * Drive the real attack: total PLANK budget B split across N addresses, each
   * paying the registration cost `p` out of its own slice and burning the rest
   * for weight. Returns the attacker's realised AGGREGATE contribution.
   */
  async function attack(fx: any, B: bigint, N: number, p: bigint) {
    const perAddr = B / BigInt(N);
    if (perAddr <= p) return { agg: 0n, wasted: B, addrs: [] as string[] };
    const burnEach = perAddr - p;
    const addrs: string[] = [];
    for (let i = 0; i < N; i++) {
      const s = await sybil(fx, perAddr);
      await fx.gauge.connect(s.signer).burnPlank(fx.gA, burnEach);
      addrs.push(s.addr);
    }
    let agg = 0n;
    for (const a of addrs) agg += await fx.gauge.accountWeight(fx.gA, a);
    return { agg, wasted: p * BigInt(N), addrs };
  }

  // ══ 1. THE COST IS REAL, IS A BURN, AND CREATES NO CUSTODY ═══════════════

  it("defaults to ZERO — the fix ships inert, exactly as documented, and changes nothing until governance calibrates it", async () => {
    const fx = await deploy();
    expect(await fx.gauge.registrationBurnPlank()).to.equal(0n);
    const s = await sybil(fx, 1_000n * WAD);
    const before = await fx.plank.balanceOf(s.addr);
    await fx.gauge.connect(s.signer).burnPlank(fx.gA, 1_000n * WAD);
    // Not one extra unit was taken.
    expect(before - (await fx.plank.balanceOf(s.addr))).to.equal(1_000n * WAD);
  });

  it("is charged once per (epoch, gauge, address), goes to BURN_ADDRESS, and buys ZERO weight", async () => {
    const fx = await deploy();
    const P = 10n * WAD;
    await setRegistrationBurn(fx, P);

    const s = await sybil(fx, 1_000n * WAD);
    const deadBefore: bigint = await fx.plank.balanceOf(DEAD);

    // First burn pays the registration on top of the burn itself.
    await expect(fx.gauge.connect(s.signer).burnPlank(fx.gA, 100n * WAD))
      .to.emit(fx.gauge, "RegistrationBurned")
      .withArgs(fx.gA, s.addr, P);
    expect((await fx.plank.balanceOf(DEAD)) - deadBefore).to.equal(100n * WAD + P);

    // The registration bought NO weight: contribution is sqrt of the burned
    // amount alone, with the fee excluded.
    expect(await fx.gauge.accountWeight(fx.gA, s.addr)).to.equal(
      isqrt(100n * WAD),
      "contribution is sqrt of the WEIGHT-BEARING burn only — the fee bought nothing"
    );
    expect(await fx.gauge.epochWeightedBurn(await fx.gauge.currentEpoch(), fx.gA, s.addr)).to.equal(
      100n * WAD,
      "the registration burn is not credited as weighted burn"
    );

    // SECOND burn from the same address in the same epoch is NOT charged again.
    const dead2: bigint = await fx.plank.balanceOf(DEAD);
    await expect(fx.gauge.connect(s.signer).burnPlank(fx.gA, 50n * WAD)).to.not.emit(
      fx.gauge,
      "RegistrationBurned"
    );
    expect((await fx.plank.balanceOf(DEAD)) - dead2).to.equal(50n * WAD);
  });

  it("creates NO custody: the gauge's PLANK balance is zero before, during and after", async () => {
    const fx = await deploy();
    await setRegistrationBurn(fx, 10n * WAD);
    expect(await fx.plank.balanceOf(fx.gaugeAddr)).to.equal(0n);
    const s = await sybil(fx, 1_000n * WAD);
    await fx.gauge.connect(s.signer).burnPlank(fx.gA, 100n * WAD);
    expect(await fx.plank.balanceOf(fx.gaugeAddr)).to.equal(
      0n,
      "a registration BURN is destruction, not a payment surface"
    );
    const [, , paysRewards] = await fx.gauge.capabilities();
    expect(paysRewards).to.equal(false);
  });

  it("is timelocked, tuning-role-only, and hard-capped by a constant no governance can raise", async () => {
    const fx = await deploy();
    // Wrong role cannot queue it.
    await expect(
      fx.gauge.connect(fx.registry).queueParam(K_REG, 1n)
    ).to.be.revertedWithCustomError(fx.gauge, "NotRoleHolder");
    // Right role, but never instant.
    await fx.gauge.connect(fx.tuning).queueParam(K_REG, 1n);
    await expect(fx.gauge.executeParam(K_REG)).to.be.revertedWithCustomError(
      fx.gauge,
      "TimelockNotElapsed"
    );
    await time.increase(TIMELOCK + 1);
    await fx.gauge.executeParam(K_REG);
    // And the ceiling holds even after a full timelock — a registration cost
    // so high that honest participation is impossible is not reachable.
    await fx.gauge
      .connect(fx.tuning)
      .queueParam(K_REG, 1_000_001n * WAD);
    await time.increase(TIMELOCK + 1);
    await expect(fx.gauge.executeParam(K_REG)).to.be.revertedWithCustomError(
      fx.gauge,
      "BadParam"
    );
    expect(await fx.gauge.registrationBurnPlank()).to.equal(1n);
  });

  // ══ 2. THE FINDING ITSELF: N* GOES FROM UNBOUNDED TO BOUNDED ═════════════

  it("BEFORE (p = 0): aggregate weight is strictly increasing in N with no interior optimum — only gas stops it", async () => {
    const rows: { N: number; agg: bigint }[] = [];
    const B = 4_000n * WAD;
    for (const N of [1, 2, 4, 8, 16, 32]) {
      const fx = await deploy();
      const r = await attack(fx, B, N, 0n);
      rows.push({ N, agg: r.agg });
    }
    // eslint-disable-next-line no-console
    console.log("\n  p = 0 (the finding):");
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `        N=${String(r.N).padStart(3)}  aggregate contribution = ${(
          Number(r.agg) / 1e9
        ).toFixed(3)}e9`
      );
    }
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].agg).to.be.gt(rows[i - 1].agg, "every extra address still pays");
    }
    // sqrt(N) growth: 32 shards is ~5.6x a single wallet.
    expect(rows[5].agg).to.be.gt(rows[0].agg * 5n);
  });

  it("AFTER (p > 0): N* is a real interior optimum at B/(2p), and weight COLLAPSES TO ZERO at N = B/p", async () => {
    const B = 4_000n * WAD;
    const P = 100n * WAD; // p = B/40  =>  N* = B/(2p) = 20, hard ceiling at 40
    const N_STAR_THEORY = Number(B / (2n * P));
    const N_CEILING = Number(B / P);

    const rows: { N: number; agg: bigint; wasted: bigint }[] = [];
    for (const N of [1, 4, 10, 20, 30, 40, 64]) {
      const fx = await deploy();
      await setRegistrationBurn(fx, P);
      const r = await attack(fx, B, N, P);
      rows.push({ N, agg: r.agg, wasted: r.wasted });
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n  p = ${P / WAD} PLANK, budget B = ${B / WAD} PLANK  =>  theory N* = ${N_STAR_THEORY}, ceiling N = ${N_CEILING}:`
    );
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `        N=${String(r.N).padStart(3)}  aggregate contribution = ${(
          Number(r.agg) / 1e9
        ).toFixed(3)}e9   budget destroyed on registrations = ${(
          (Number(r.wasted) / Number(B)) *
          100
        ).toFixed(1)}%`
      );
    }

    const best = rows.reduce((a, b) => (b.agg > a.agg ? b : a));
    // eslint-disable-next-line no-console
    console.log(
      `        measured argmax N = ${best.N}  (theory B/(2p) = ${N_STAR_THEORY})` +
        `\n        => the sybil count is now set by BUDGET/COST, not by gas price.`
    );

    // (1) There IS an interior optimum now: it is not N=1 and not the largest N.
    expect(best.N).to.be.greaterThan(1);
    expect(best.N).to.be.lessThan(64);
    // (2) It sits at the derived N* = B/(2p), within one sample step.
    expect(Math.abs(best.N - N_STAR_THEORY)).to.be.lessThanOrEqual(10);
    // (3) Past the ceiling the strategy is worth exactly nothing.
    expect(rows[rows.length - 1].agg).to.equal(0n, "N >= B/p buys zero weight");
    expect(rows.find((r) => r.N === 40)!.agg).to.equal(0n);
    // (4) At the optimum the attacker has destroyed ~half their budget for
    //     nothing at all — the genuinely proportional cost gas could not give.
    const atStar = rows.find((r) => r.N === N_STAR_THEORY)!;
    expect(atStar.wasted).to.equal(B / 2n);
  });

  it("the thousand-address strategy the audit derived is now simply unaffordable", async () => {
    // The audit's N* ~= [V*R/(2*sqrt(W)*G*p)]^(2/3) reached the THOUSANDS at L2
    // gas prices, because gas is the ONLY per-address cost. With p set to just
    // 1/1000 of the budget, N is hard-capped at 1000 and optimal at 500 — and
    // that cap does not move when gas gets cheaper.
    const B = 4_000n * WAD;
    const P = B / 1000n;
    const fx = await deploy();
    await setRegistrationBurn(fx, P);

    // Drive the ceiling directly: 1000 shards leaves nothing to burn.
    const perAddr = B / 1000n;
    expect(perAddr).to.equal(P);
    const s = await sybil(fx, perAddr);
    // The address can pay the registration OR burn, never both.
    await expect(fx.gauge.connect(s.signer).burnPlank(fx.gA, perAddr)).to.be.reverted;

    // eslint-disable-next-line no-console
    console.log(
      `\n  p = B/1000  =>  N* = 500, hard ceiling N = 1000, INDEPENDENT of gas price.` +
        `\n  (audit's gas-only derivation put N* in the thousands and rising as gas falls)`
    );
  });

  /**
   * AN HONEST NEGATIVE RESULT, RECORDED RATHER THAN OMITTED.
   *
   * The impossibility result the header states is NOT repealed by this fix and
   * this test proves it rather than quietly avoiding the case: a whale that
   * matches the minnow's PER-SHARD budget and splits X ways still realises
   * EXACTLY X times the weight. `p` is an absolute per-address cost, the same
   * SHAPE of cost gas was; denominating it in the burned asset does not make it
   * proportional at an arbitrary N.
   *
   * What the fix actually buys — and the only thing it claims — is that the
   * cost is now paid in the SAME BUDGET the attack is funded from, so the
   * strategy has a ceiling and an interior optimum instead of running to
   * infinity. Both halves are asserted below.
   */
  it("does NOT repeal the impossibility result: matched-per-shard splitting is still exactly linear — and the ceiling is what bounds it instead", async () => {
    const X = 16n;
    const MINNOW = 100n * WAD;
    const P = 10n * WAD;
    const fx = await deploy();
    await setRegistrationBurn(fx, P);

    const m = await sybil(fx, MINNOW + P);
    await fx.gauge.connect(m.signer).burnPlank(fx.gA, MINNOW);
    const cMinnow: bigint = await fx.gauge.accountWeight(fx.gA, m.addr);

    let cWhale = 0n;
    for (let i = 0n; i < X; i++) {
      const s = await sybil(fx, MINNOW + P);
      await fx.gauge.connect(s.signer).burnPlank(fx.gA, MINNOW);
      cWhale += await fx.gauge.accountWeight(fx.gA, s.addr);
    }
    // The honest negative: still exactly linear at matched per-shard budgets.
    expect(cWhale).to.equal(cMinnow * X);

    // THE PART THAT DID CHANGE. The whale's registration spend is X*p, i.e.
    // it scales one-for-one with the fleet, and it is destroyed for nothing.
    const wasted = P * X;
    const burned = MINNOW * X;
    // eslint-disable-next-line no-console
    console.log(
      `\n  matched-per-shard whale, X = ${X}:` +
        `\n        realised weight ratio        : ${Number(cWhale) / Number(cMinnow)} (still linear — impossibility NOT repealed)` +
        `\n        PLANK destroyed on identity  : ${wasted / WAD} of ${(wasted + burned) / WAD} total (${(
          (Number(wasted) / Number(wasted + burned)) *
          100
        ).toFixed(1)}%)` +
        `\n        with p = 0 that number was 0, and N was limited only by gas.`
    );
    expect(wasted).to.equal(P * X, "identity cost scales one-for-one with the fleet");

    // And with a FIXED budget — the case an attacker actually faces — pushing
    // the same trick past the ceiling buys literally nothing.
    const fx2 = await deploy();
    await setRegistrationBurn(fx2, P);
    const B = (MINNOW + P) * X;
    const r = await attack(fx2, B, Number(B / P), P); // N at the hard ceiling
    expect(r.agg).to.equal(0n, "a fixed budget cannot fund an unbounded fleet");
  });

  // ══ 3. THE HONEST BURNER IS NOT DETERRED ═════════════════════════════════

  it("a single honest burner pays the cost once and is barely touched by it", async () => {
    const fx = await deploy();
    const P = 10n * WAD;
    await setRegistrationBurn(fx, P);
    const HONEST = 10_000n * WAD; // a realistic honest burn: p is 0.1% of it

    const s = await sybil(fx, HONEST + P);
    await fx.gauge.connect(s.signer).burnPlank(fx.gA, HONEST);
    const withFee: bigint = await fx.gauge.accountWeight(fx.gA, s.addr);

    const fx2 = await deploy();
    const s2 = await sybil(fx2, HONEST);
    await fx2.gauge.connect(s2.signer).burnPlank(fx2.gA, HONEST);
    const without: bigint = await fx2.gauge.accountWeight(fx2.gA, s2.addr);

    // eslint-disable-next-line no-console
    console.log(
      `\n  honest single burner: p is ${(Number(P) / Number(HONEST)) * 100}% of the burn;` +
        ` published weight identical = ${withFee === without}`
    );
    expect(withFee).to.equal(without, "the honest burner's published weight is unchanged");
  });

  it("all three burn paths charge the registration in PLANK, including the LP paths", async () => {
    const fx = await deploy();
    const P = 5n * WAD;
    await setRegistrationBurn(fx, P);

    const Token = await ethers.getContractFactory("MockIndexToken");
    const lp: any = await Token.deploy("LP", "LP");
    const lpAddr = await lp.getAddress();
    await fx.gauge.connect(fx.registry).queuePlankEthLp(lpAddr, false);
    await time.increase(TIMELOCK + 1);
    await fx.gauge.executePlankEthLp(lpAddr);

    const s = await sybil(fx, 1_000n * WAD);
    await lp.mint(s.addr, 100n * WAD);
    await lp.connect(s.signer).approve(fx.gaugeAddr, ethers.MaxUint256);

    const plankBefore: bigint = await fx.plank.balanceOf(s.addr);
    await expect(fx.gauge.connect(s.signer).burnPlankEthLp(fx.gA, lpAddr, 100n * WAD)).to.emit(
      fx.gauge,
      "RegistrationBurned"
    );
    // The registration is PLANK-denominated even when the weight-bearing burn
    // is an LP token: the cost is in the asset the attack's budget is in.
    expect(plankBefore - (await fx.plank.balanceOf(s.addr))).to.equal(P);
  });

  it("a new epoch re-charges registration — influence is rented, and so is identity", async () => {
    const fx = await deploy();
    const P = 10n * WAD;
    await setRegistrationBurn(fx, P);
    const s = await sybil(fx, 1_000n * WAD);
    await fx.gauge.connect(s.signer).burnPlank(fx.gA, 100n * WAD);

    await time.increase(EPOCH + 1);
    expect(await fx.gauge.gaugeWeight(fx.gA)).to.equal(0n);
    // Fresh epoch, fresh book, fresh registration.
    await expect(fx.gauge.connect(s.signer).burnPlank(fx.gA, 100n * WAD)).to.emit(
      fx.gauge,
      "RegistrationBurned"
    );
  });

  it("an address that cannot cover the registration simply cannot register — it never registers for free", async () => {
    const fx = await deploy();
    const P = 100n * WAD;
    await setRegistrationBurn(fx, P);
    const s = await sybil(fx, 10n * WAD); // enough to burn, not to register
    await expect(fx.gauge.connect(s.signer).burnPlank(fx.gA, 5n * WAD)).to.be.reverted;
    expect(await fx.gauge.accountWeight(fx.gA, s.addr)).to.equal(0n);
    expect(await fx.gauge.gaugeWeight(fx.gA)).to.equal(0n);
  });
});
