import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import {
  takeSnapshot,
  time,
  type SnapshotRestorer,
} from "./helpers/network-helpers.js";
import {
  CONCENTRATION_CAP_BPS,
  TIMELOCK,
  WAD,
  deployOpenIndex,
  maxIn,
} from "./helpers/index-vault.js";

/**
 * Audit-style suite for PlankGauge generation 2: the epoch-scoped
 * burn-voting-and-boost PUBLISHER that replaced the permanent-claim,
 * threshold-accumulate, ETH-custodying generation 1.
 *
 * One test per named property of contracts/PlankGauge.sol's header, each
 * attacking the vector the property exists for rather than asserting a happy
 * path — same bar as GlobalIndexVault.audit.test.ts and VaultV3.audit.test.ts.
 *
 * WHAT WAS DELETED FROM THIS FILE AND WHY. Generation 1's reward tests
 * (proportional claim share, "a later burn cannot claw back a folded pot",
 * double-claim, non-burner claims nothing, soulbound claim ledger,
 * below-threshold accumulation, per-gauge earmarking, "no privileged path over
 * pushed reward ETH") are gone because the MECHANISM they covered is gone —
 * there is no claim, no pot, no threshold, no fold, and no ETH. Coverage was
 * not dropped: the property those tests ultimately protected (nobody can
 * extract value through this contract) is now proven far more strongly by
 * `NO PAYMENT MECHANISM`, which asserts the contract cannot hold or move
 * value AT ALL rather than that its accounting for held value is correct.
 *
 * LOCAL HARDHAT ONLY. Nothing in this repo may deploy either contract until
 * the external audit gate (§2.6) clears.
 */
describe("PlankGauge", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const DEAD = "0x000000000000000000000000000000000000dEaD";
  const RAW_MULT = 10_000n;
  const LP_MULT = 25_000n;
  const COLL_MULT = 30_000n;
  const EPOCH = 7 * 24 * 3_600;
  const BASE_BOOST = 10_000n;
  const MAX_BOOST = 25_000n;

  /** Integer sqrt, matching OpenZeppelin Math.sqrt's floor semantics. */
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

  async function fixture() {
    // Offset past the index fixture's signers so a gauge whale can never
    // coincidentally BE a privileged basket role.
    const all = await ethers.getSigners();
    const [whale, minnow, funder] = [all[12], all[13], all[14]];
    // Two SEPARATELY KEYED gauge roles plus the role-management key. Nothing
    // holds more than one of them, which is what makes the isolation suite's
    // cross-role attempts meaningful rather than tautological.
    const [gaugeRoleAdmin, registry, tuning] = [all[15], all[16], all[17]];

    const Token = await ethers.getContractFactory("MockIndexToken");
    const plank: any = await Token.deploy("PLANK", "PLANK");
    const plankEthLp: any = await Token.deploy("PLANK/ETH LP", "PE-LP");
    const collLp: any = await Token.deploy("vROBIN/ETH LP", "VR-LP");
    const impostorLp: any = await Token.deploy("PLANK/ETH LP", "PE-LP"); // same name+symbol

    const Gauge = await ethers.getContractFactory("PlankGauge");
    const gauge: any = await Gauge.deploy(
      await plank.getAddress(),
      [gaugeRoleAdmin.address, registry.address, tuning.address],
      TIMELOCK,
      [RAW_MULT, LP_MULT, COLL_MULT],
      EPOCH
    );
    const gaugeAddr = await gauge.getAddress();

    // Two gauge ids standing in for two collections' v-tokens.
    const gA = ethers.Wallet.createRandom().address;
    const gB = ethers.Wallet.createRandom().address;
    const vaultA = ethers.Wallet.createRandom().address;

    await gauge.connect(registry).queueGauge(gA, false);
    await gauge.connect(registry).queueGauge(gB, false);
    await gauge.connect(registry).queuePlankEthLp(await plankEthLp.getAddress(), false);
    await gauge
      .connect(registry)
      .queueCollectionLp(gA, await collLp.getAddress(), vaultA, false);
    await time.increase(TIMELOCK + 1);
    await gauge.executeGauge(gA);
    await gauge.executeGauge(gB);
    await gauge.executePlankEthLp(await plankEthLp.getAddress());
    await gauge.executeCollectionLp(gA);

    for (const who of [whale, minnow, funder]) {
      for (const t of [plank, plankEthLp, collLp, impostorLp]) {
        await t.mint(who.address, 1_000_000n * WAD);
        await t.connect(who).approve(gaugeAddr, ethers.MaxUint256);
      }
    }

    return {
      gaugeRoleAdmin,
      registry,
      tuning,
      whale,
      minnow,
      funder,
      plank,
      plankEthLp,
      collLp,
      impostorLp,
      gauge,
      gaugeAddr,
      gA,
      gB,
      vaultA,
    };
  }

  // ══ Burn paths and their multipliers (carried over, unchanged mechanism) ══

  it("an LP burn earns a real multiplier over an identical raw PLANK burn", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, gA, plankEthLp } = fx;
    const amount = 1_000n * WAD;
    const e: bigint = await gauge.currentEpoch();

    await gauge.connect(whale).burnPlank(gA, amount);
    await gauge.connect(minnow).burnPlankEthLp(gA, await plankEthLp.getAddress(), amount);

    // The MULTIPLIER is applied to the raw burn, before the sqrt dampening.
    expect(await gauge.epochWeightedBurn(e, gA, whale.address)).to.equal(amount);
    expect(await gauge.epochWeightedBurn(e, gA, minnow.address)).to.equal(
      (amount * LP_MULT) / RAW_MULT
    );
    const raw: bigint = await gauge.accountWeight(gA, whale.address);
    const lp: bigint = await gauge.accountWeight(gA, minnow.address);
    expect(raw).to.equal(isqrt(amount));
    expect(lp).to.equal(isqrt((amount * LP_MULT) / RAW_MULT));
    expect(lp).to.be.gt(raw, "LP burn must strictly dominate a raw burn");
    expect(await gauge.gaugeWeight(gA)).to.equal(raw + lp);
  });

  it("a collection v-token LP burn earns at least the PLANK/ETH LP rate", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, gA, plankEthLp } = fx;
    const amount = 500n * WAD;
    await gauge.connect(whale).burnPlankEthLp(gA, await plankEthLp.getAddress(), amount);
    await gauge.connect(minnow).burnCollectionLp(gA, amount);
    const lp: bigint = await gauge.accountWeight(gA, whale.address);
    const coll: bigint = await gauge.accountWeight(gA, minnow.address);
    expect(coll).to.be.gte(lp, "the exact-market LP burn must never be worth less");
    expect(coll).to.equal(isqrt((amount * COLL_MULT) / RAW_MULT));
  });

  it("an impostor LP token — same name, same symbol — earns nothing", async () => {
    const fx = await fixture();
    const { gauge, whale, gA, impostorLp, plankEthLp } = fx;
    expect(await impostorLp.name()).to.equal(await plankEthLp.name());
    expect(await impostorLp.symbol()).to.equal(await plankEthLp.symbol());
    await expect(
      gauge.connect(whale).burnPlankEthLp(gA, await impostorLp.getAddress(), 100n * WAD)
    ).to.be.revertedWithCustomError(gauge, "NotApprovedLp");
    expect(await gauge.accountWeight(gA, whale.address)).to.equal(0n);
  });

  it("a collection LP burn cannot be pointed at a different collection's gauge", async () => {
    const fx = await fixture();
    const { gauge, whale, gB } = fx;
    // gB has no registered collection LP, so the path is simply closed there.
    await expect(
      gauge.connect(whale).burnCollectionLp(gB, 100n * WAD)
    ).to.be.revertedWithCustomError(gauge, "NotApprovedLp");
  });

  it("burns cannot be directed at an unregistered gauge", async () => {
    const fx = await fixture();
    const { gauge, whale } = fx;
    const ghost = ethers.Wallet.createRandom().address;
    await expect(gauge.connect(whale).burnPlank(ghost, WAD)).to.be.revertedWithCustomError(
      gauge,
      "UnknownGauge"
    );
  });

  it("the tokens really leave circulation — they land at the dead address", async () => {
    const fx = await fixture();
    const { gauge, whale, gA, plank } = fx;
    const deadBefore: bigint = await plank.balanceOf(DEAD);
    const mine: bigint = await plank.balanceOf(whale.address);
    await gauge.connect(whale).burnPlank(gA, 777n * WAD);
    expect(await plank.balanceOf(DEAD)).to.equal(deadBefore + 777n * WAD);
    expect(await plank.balanceOf(whale.address)).to.equal(mine - 777n * WAD);
    // And the gauge itself never custodies a burnt token.
    expect(await plank.balanceOf(fx.gaugeAddr)).to.equal(0n);
  });

  it("a fee-on-transfer token buys only the weight it actually destroyed", async () => {
    const fx = await fixture();
    const { gauge, whale, gA, plank } = fx;
    await plank.setFeeBps(1_000); // 10% skimmed... to the dead address as well
    const deadBefore: bigint = await plank.balanceOf(DEAD);
    const e: bigint = await gauge.currentEpoch();
    await gauge.connect(whale).burnPlank(gA, 1_000n * WAD);
    const reallyBurnt = (await plank.balanceOf(DEAD)) - deadBefore;
    // MockIndexToken's fee also goes to dead, so the observed delta is the
    // full amount here — the point of the assertion is that the credited
    // weight equals the OBSERVED delta, never the nominal argument.
    expect(await gauge.epochWeightedBurn(e, gA, whale.address)).to.equal(reallyBurnt);
  });

  // ══ EPOCH RESET — the whole point of generation 2 ═══════════════════════

  it("EPOCH: a gauge's weight is zero in a fresh epoch until someone burns into it", async () => {
    const fx = await fixture();
    const { gauge, whale, gA } = fx;
    expect(await gauge.gaugeWeight(gA)).to.equal(0n);
    await gauge.connect(whale).burnPlank(gA, 100n * WAD);
    expect(await gauge.gaugeWeight(gA)).to.be.gt(0n);
  });

  it("EPOCH: weight resets to zero the instant the boundary is crossed", async () => {
    const fx = await fixture();
    const { gauge, whale, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 900n * WAD);
    const e0: bigint = await gauge.currentEpoch();
    const weight: bigint = await gauge.gaugeWeight(gA);
    expect(weight).to.equal(isqrt(900n * WAD));

    // One second before the boundary the weight is still fully live...
    const endsAt: bigint = await gauge.epochEndsAt();
    await time.increaseTo(endsAt - 2n);
    expect(await gauge.currentEpoch()).to.equal(e0);
    expect(await gauge.gaugeWeight(gA)).to.equal(weight);

    // ...and one second after it, it is ZERO. Not decayed. Zero.
    await time.increaseTo(endsAt + 1n);
    expect(await gauge.currentEpoch()).to.equal(e0 + 1n);
    expect(await gauge.gaugeWeight(gA)).to.equal(0n);
    expect(await gauge.accountWeight(gA, whale.address)).to.equal(0n);
    expect(await gauge.rawShareWad(gA, whale.address)).to.equal(0n);
    expect(await gauge.boostMultiplier(gA, whale.address)).to.equal(BASE_BOOST);

    // The old epoch's record is still readable — the reset is a change of
    // storage key, not a deletion of history.
    expect(await gauge.gaugeWeightAt(gA, e0)).to.equal(weight);
  });

  it("EPOCH: there is NO carry-forward — influence must be re-bought every epoch", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, gA } = fx;
    // Epoch 1: the whale buys total control with an enormous burn.
    await gauge.connect(whale).burnPlank(gA, 1_000_000n * WAD);
    expect(await gauge.rawShareWad(gA, whale.address)).to.equal(WAD);

    await time.increaseTo((await gauge.epochEndsAt()) + 1n);

    // Epoch 2: a minnow burns a thousandth of what the whale burned, and owns
    // the gauge outright, because the whale's purchase did not renew.
    await gauge.connect(minnow).burnPlank(gA, 1_000n * WAD);
    expect(await gauge.rawShareWad(gA, whale.address)).to.equal(0n);
    expect(await gauge.rawShareWad(gA, minnow.address)).to.equal(WAD);
    expect(await gauge.gaugeWeight(gA)).to.equal(isqrt(1_000n * WAD));
  });

  it("EPOCH: retuning the duration jumps the index forward, never onto live storage", async () => {
    const fx = await fixture();
    const { gauge, tuning, whale, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 500n * WAD);
    const before: bigint = await gauge.currentEpoch();
    const weight: bigint = await gauge.gaugeWeight(gA);

    const key = ethers.encodeBytes32String("epochDuration");
    await gauge.connect(tuning).queueParam(key, 24 * 3_600);
    await time.increase(TIMELOCK + 1);
    await gauge.executeParam(key);

    const after: bigint = await gauge.currentEpoch();
    expect(after).to.be.gt(before, "the rebase must move strictly forward");
    // The retune therefore cannot resurrect the pre-retune epoch's weights.
    expect(await gauge.gaugeWeight(gA)).to.equal(0n);
    expect(await gauge.gaugeWeightAt(gA, before)).to.equal(weight);
    expect(await gauge.epochDuration()).to.equal(24n * 3_600n);
  });

  it("EPOCH: the duration is bounded and timelocked", async () => {
    const fx = await fixture();
    const { gauge, tuning } = fx;
    const key = ethers.encodeBytes32String("epochDuration");
    for (const bad of [3_600n, BigInt(200 * 24 * 3_600)]) {
      await gauge.connect(tuning).queueParam(key, bad);
      await time.increase(TIMELOCK + 1);
      await expect(gauge.executeParam(key)).to.be.revertedWithCustomError(gauge, "BadParam");
    }
    expect(await gauge.epochDuration()).to.equal(BigInt(EPOCH));
  });

  // ══ sqrt DAMPENING, and the honest sybil finding ═══════════════════════

  it("SQRT: doubling a burn buys ~1.41x the weight, not 2x", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, gA } = fx;
    await gauge.connect(minnow).burnPlank(gA, 1_000n * WAD);
    await gauge.connect(whale).burnPlank(gA, 2_000n * WAD);
    const small: bigint = await gauge.accountWeight(gA, minnow.address);
    const big: bigint = await gauge.accountWeight(gA, whale.address);
    // 2x the money buys strictly less than 2x the weight — the anti-whale
    // property this curve is actually here for.
    expect(big).to.be.lt(small * 2n, "dampening did not bite");
    expect(big).to.be.gt(small, "dampening inverted the ordering");
    // ...and it is sqrt-shaped: big/small ~= sqrt(2) ~= 1.4142.
    const ratio = (big * 10_000n) / small;
    expect(ratio).to.be.gte(14_130n).and.to.be.lte(14_152n);
  });

  it("SQRT: repeated small burns from ONE wallet are worth exactly one large one", async () => {
    // The dampening is applied to the wallet's epoch TOTAL, not per call, so
    // transaction chunking is economically neutral. If it were per-call, ten
    // small burns would beat one large one from the same address, which is
    // the sybil incentive turned inward and would make the accounting depend
    // on how the caller happened to batch.
    const fx = await fixture();
    const { gauge, whale, minnow, gA, gB } = fx;
    for (let i = 0; i < 10; i++) await gauge.connect(whale).burnPlank(gA, 100n * WAD);
    await gauge.connect(minnow).burnPlank(gB, 1_000n * WAD);
    expect(await gauge.accountWeight(gA, whale.address)).to.equal(
      await gauge.accountWeight(gB, minnow.address)
    );
  });

  it("SYBIL, HONESTLY: splitting a burn across two wallets yields MORE weight, not less", async () => {
    /**
     * The design note asking for this mechanism claimed sqrt dampening makes
     * splitting "strictly worse" via `sqrt(a) + sqrt(b) < sqrt(a+b)`. That
     * inequality is BACKWARDS and this test exists to pin the direction that
     * is really true, rather than shipping a suite that asserts a false
     * theorem and a comment that repeats it.
     *
     * (sqrt(a)+sqrt(b))^2 = a + b + 2*sqrt(a*b) > a + b, so for all a,b > 0
     *
     *     sqrt(a) + sqrt(b) > sqrt(a + b)
     *
     * sqrt is CONCAVE and every concave weighting strictly rewards splitting.
     * This is the same reason quadratic funding needs a personhood layer: the
     * sqrt is what CREATES the sybil incentive, not what removes it. The
     * contract keeps sqrt because anti-whale dampening is what it was really
     * wanted for, and the exposure is documented and measured here.
     */
    const fx = await fixture();
    const { gauge, whale, minnow, funder, gA, gB } = fx;
    const total = 4_000n * WAD;

    // One wallet, one burn.
    await gauge.connect(whale).burnPlank(gA, total);
    const undivided: bigint = await gauge.gaugeWeight(gA);

    // The same money, same epoch, split across two wallets.
    await gauge.connect(minnow).burnPlank(gB, total / 2n);
    await gauge.connect(funder).burnPlank(gB, total / 2n);
    const split: bigint = await gauge.gaugeWeight(gB);

    expect(split).to.be.gt(undivided, "sqrt is concave; splitting must gain");
    expect(split).to.equal(isqrt(total / 2n) * 2n);
    expect(undivided).to.equal(isqrt(total));
    // The gain is the sqrt(2) factor and nothing more: splitting reduces the
    // PRICE of a given amount of influence by ~41%, it never makes influence
    // free, and every sybil wallet still permanently destroys real tokens.
    const gain = (split * 10_000n) / undivided;
    expect(gain).to.be.gte(14_130n).and.to.be.lte(14_152n);
  });

  // ══ CONCENTRATION PENALTY ══════════════════════════════════════════════

  it("PENALTY: the retention rate strictly decreases as a burner's raw share rises", async () => {
    /**
     * The claim that IS true and provable. `effectiveShare_i / rawShare_i =
     * 1 - rawShare_i^k` is strictly decreasing in rawShare_i.
     *
     * Note what is deliberately NOT asserted: `effectiveShare_i` itself is
     * NOT monotone in rawShare_i. d/ds [s - s^2.5] = 1 - 2.5*s^1.5 vanishes at
     * s = 0.4^(2/3) ~= 0.5429, so effectiveShare rises up to ~54% share and
     * falls after. Asserting "effectiveShare strictly decreases as rawShare
     * increases" would assert something false over most of the domain, and
     * the suite says so out loud rather than picking three points where it
     * happens to hold.
     */
    const fx = await fixture();
    const { gauge, whale, minnow, funder, gA } = fx;
    // Three very different sizes in one epoch on one gauge.
    await gauge.connect(whale).burnPlank(gA, 1_000_000n * WAD);
    await gauge.connect(minnow).burnPlank(gA, 10_000n * WAD);
    await gauge.connect(funder).burnPlank(gA, 100n * WAD);

    const who = [whale, minnow, funder];
    const raws: bigint[] = [];
    const retention: bigint[] = [];
    for (const a of who) {
      const raw: bigint = await gauge.rawShareWad(gA, a.address);
      const eff: bigint = await gauge.effectiveShareWad(gA, a.address);
      expect(raw).to.be.gt(0n);
      raws.push(raw);
      retention.push((eff * WAD) / raw);
    }
    // Sizes are strictly decreasing, so raw shares must be too...
    expect(raws[0]).to.be.gt(raws[1]);
    expect(raws[1]).to.be.gt(raws[2]);
    // ...and retention must move strictly the OTHER way. That is concavity.
    expect(retention[0]).to.be.lt(retention[1], "bigger share kept a bigger fraction");
    expect(retention[1]).to.be.lt(retention[2], "bigger share kept a bigger fraction");
    // Every retention is a real fraction of one, never above it: the penalty
    // can only ever take away.
    for (const r of retention) expect(r).to.be.lte(WAD);
  });

  it("PENALTY: a sole burner is penalised to zero effective share", async () => {
    const fx = await fixture();
    const { gauge, whale, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 5_000n * WAD);
    expect(await gauge.rawShareWad(gA, whale.address)).to.equal(WAD);
    expect(await gauge.concentrationPenaltyWad(gA, whale.address)).to.equal(WAD);
    expect(await gauge.effectiveShareWad(gA, whale.address)).to.equal(0n);
    // ...and the whole epoch's share is therefore reported as protocol share.
    expect(await gauge.protocolShareWad(gA)).to.equal(WAD);
  });

  it("PENALTY: dilution by a second burner moves the whale's effective share UP", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, funder, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 10_000n * WAD);
    const alone: bigint = await gauge.effectiveShareWad(gA, whale.address);
    const rawAlone: bigint = await gauge.rawShareWad(gA, whale.address);

    // A second burner arrives and dilutes the whale's RAW share...
    await gauge.connect(minnow).burnPlank(gA, 10_000n * WAD);
    const rawDiluted: bigint = await gauge.rawShareWad(gA, whale.address);
    const diluted: bigint = await gauge.effectiveShareWad(gA, whale.address);
    expect(rawDiluted).to.be.lt(rawAlone, "dilution did not reduce the raw share");
    expect(diluted).to.be.gt(alone, "effective share did not recover on dilution");

    // AND THE HONEST OTHER HALF, measured rather than assumed. Recovery is
    // not unbounded, because effectiveShare = s - s^2.5 is a HUMP with its
    // maximum at s = 0.4^(2/3) ~= 0.5429. Diluting from 1/1 to 1/2 climbs
    // toward that peak; diluting on to 1/3 walks back DOWN the far side. A
    // suite that only checked "more dilution is always better" would be
    // asserting something the curve does not do.
    await gauge.connect(funder).burnPlank(gA, 10_000n * WAD);
    const raw3: bigint = await gauge.rawShareWad(gA, whale.address);
    const eff3: bigint = await gauge.effectiveShareWad(gA, whale.address);
    expect(raw3).to.be.lt(rawDiluted);
    expect(eff3).to.be.lt(diluted, "the hump is not where the maths says it is");
    expect(eff3).to.be.gt(alone, "still strictly better than sole-whale zero");
    // The retention RATE, which is the monotone quantity, keeps improving.
    expect((eff3 * WAD) / raw3).to.be.gt((diluted * WAD) / rawDiluted);
  });

  it("PENALTY: the remainder is a REPORTING figure with no claim path anywhere", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 40_000n * WAD);
    await gauge.connect(minnow).burnPlank(gA, 10_000n * WAD);

    // It is exactly what is left after every burner's effective share.
    let assigned = 0n;
    const n: bigint = await gauge.burnerCount(gA);
    expect(n).to.equal(2n);
    for (let i = 0n; i < n; i++) {
      assigned += await gauge.effectiveShareWad(gA, await gauge.burnerAt(gA, i));
    }
    expect(await gauge.protocolShareWad(gA)).to.equal(WAD - assigned);
    expect(await gauge.protocolShareWad(gA)).to.be.gt(0n);

    // And there is no function anywhere that could ever pay it to anybody.
    const names = gauge.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name.toLowerCase());
    for (const bad of ["claim", "withdraw", "distribute", "settle", "payout", "payto"]) {
      expect(names.some((x: string) => x.includes(bad))).to.equal(false, `found ${bad}`);
    }
  });

  it("PENALTY: the exponent k is timelocked and bounded below 1.0x", async () => {
    const fx = await fixture();
    const { gauge, tuning, whale, minnow, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 40_000n * WAD);
    await gauge.connect(minnow).burnPlank(gA, 10_000n * WAD);
    const before: bigint = await gauge.concentrationPenaltyWad(gA, whale.address);

    const key = ethers.encodeBytes32String("concentrationExponentHalves");
    // k below 1.0 would make the penalty CONVEX in share and reward
    // concentration — the opposite of the parameter's purpose. Hard floor.
    await gauge.connect(tuning).queueParam(key, 1n);
    await time.increase(TIMELOCK + 1);
    await expect(gauge.executeParam(key)).to.be.revertedWithCustomError(gauge, "BadParam");
    await gauge.connect(tuning).queueParam(key, 99n);
    await time.increase(TIMELOCK + 1);
    await expect(gauge.executeParam(key)).to.be.revertedWithCustomError(gauge, "BadParam");
    expect(await gauge.concentrationExponentHalves()).to.equal(3n);

    // A legal retune is queued, never instant.
    await gauge.connect(tuning).queueParam(key, 4n); // k = 2.0
    expect(await gauge.concentrationPenaltyWad(gA, whale.address)).to.equal(before);
    await expect(gauge.executeParam(key)).to.be.revertedWithCustomError(
      gauge,
      "TimelockNotElapsed"
    );
    await time.increase(TIMELOCK + 1);
    await gauge.executeParam(key);
    // A higher k means a smaller penalty for a sub-1.0 share (s^2 < s^1.5).
    expect(await gauge.concentrationPenaltyWad(gA, whale.address)).to.be.lt(before);
  });

  // ══ THE PUBLISHED BOOST ════════════════════════════════════════════════

  it("BOOST: the multiplier follows the veCRV shape and is capped", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, gA } = fx;
    // Nobody has burned: everyone sits at the floor, and nobody is excluded.
    expect(await gauge.boostMultiplier(gA, whale.address)).to.equal(BASE_BOOST);

    await gauge.connect(whale).burnPlank(gA, 4_000n * WAD);
    // A sole burner is at 100% of the weight, so exactly at the ceiling.
    expect(await gauge.boostMultiplier(gA, whale.address)).to.equal(MAX_BOOST);

    await gauge.connect(minnow).burnPlank(gA, 4_000n * WAD);
    // Two identical burners: contribution ratio 1/2 each, so
    // 10000 + (25000-10000)/2 = 17500 bps for both.
    expect(await gauge.boostMultiplier(gA, whale.address)).to.equal(17_500n);
    expect(await gauge.boostMultiplier(gA, minnow.address)).to.equal(17_500n);

    // A non-burner never falls below the floor and never exceeds the cap.
    const b: bigint = await gauge.boostMultiplier(gA, fx.funder.address);
    expect(b).to.equal(BASE_BOOST);
    for (const who of [whale, minnow, fx.funder]) {
      const m: bigint = await gauge.boostMultiplier(gA, who.address);
      expect(m).to.be.gte(BASE_BOOST).and.to.be.lte(MAX_BOOST);
    }
  });

  it("BOOST: the formula matches the published expression exactly, at every size", async () => {
    const fx = await fixture();
    const { gauge, whale, minnow, funder, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 900_000n * WAD);
    await gauge.connect(minnow).burnPlank(gA, 40_000n * WAD);
    await gauge.connect(funder).burnPlank(gA, 900n * WAD);
    const total: bigint = await gauge.gaugeWeight(gA);
    for (const who of [whale, minnow, funder]) {
      const c: bigint = await gauge.accountWeight(gA, who.address);
      const expected = BASE_BOOST + ((MAX_BOOST - BASE_BOOST) * c) / total;
      expect(await gauge.boostMultiplier(gA, who.address)).to.equal(expected);
    }
  });

  it("BOOST: the ceiling is timelocked and itself hard-capped at 5x", async () => {
    const fx = await fixture();
    const { gauge, tuning } = fx;
    const key = ethers.encodeBytes32String("maxBoostBps");
    await gauge.connect(tuning).queueParam(key, 1_000_000n); // 100x
    await time.increase(TIMELOCK + 1);
    await expect(gauge.executeParam(key)).to.be.revertedWithCustomError(gauge, "BadParam");
    expect(await gauge.maxBoostBps()).to.equal(MAX_BOOST);

    await gauge.connect(tuning).queueParam(key, 40_000n); // 4x, legal
    await time.increase(TIMELOCK + 1);
    await gauge.executeParam(key);
    expect(await gauge.maxBoostBps()).to.equal(40_000n);

    // The floor can never be pushed above the ceiling, in either order.
    const baseKey = ethers.encodeBytes32String("baseBoostBps");
    await gauge.connect(tuning).queueParam(baseKey, 50_000n);
    await time.increase(TIMELOCK + 1);
    await expect(gauge.executeParam(baseKey)).to.be.revertedWithCustomError(gauge, "BadParam");
    // ...and never below 1.0x either, which would publish a PENALTY dressed
    // as a boost.
    await gauge.connect(tuning).queueParam(baseKey, 5_000n);
    await time.increase(TIMELOCK + 1);
    await expect(gauge.executeParam(baseKey)).to.be.revertedWithCustomError(gauge, "BadParam");
    expect(await gauge.baseBoostBps()).to.equal(BASE_BOOST);
  });

  // ══ The wall between this contract and everything that holds value ═════

  it("NO PAYMENT MECHANISM: the contract cannot receive, hold, or move value at all", async () => {
    const fx = await fixture();
    const { gauge, gaugeAddr, funder, whale, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 100n * WAD);

    // 1. Not one payable function on the whole ABI. Generation 1 had
    //    `receiveRewards`; there is now nothing to replace it with.
    const payable = gauge.interface.fragments.filter(
      (f: any) => f.type === "function" && f.stateMutability === "payable"
    );
    expect(payable.length).to.equal(0, "a payable function exists");

    // 2. No bare receive/fallback either — a plain send bounces.
    await expect(funder.sendTransaction({ to: gaugeAddr, value: WAD })).to.be.revert(ethers);
    expect(await ethers.provider.getBalance(gaugeAddr)).to.equal(0n);

    // 3. No reward/claim/distribution surface of ANY kind, and no ERC-20 or
    //    ERC-721 surface over the burn record either — the whole point of
    //    generation 2 is that there is nothing here to own or trade.
    const names = gauge.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name.toLowerCase());
    for (const bad of [
      "reward",
      "claim",
      "distribute",
      "payout",
      "withdraw",
      "harvest",
      "sweep",
      "rescue",
      "emergency",
      "recover",
      "seize",
      "balanceof",
      "ownerof",
      "allowance",
      "totalsupply",
    ]) {
      expect(names.some((n: string) => n.includes(bad))).to.equal(false, `found ${bad}`);
    }
    // ...and no MUTATING function that could move a token or a balance. (The
    // `approvedPlankEthLp` allowlist getter is a view and is exactly the sort
    // of read a blanket name filter would false-positive on, so the
    // value-moving names are checked against the non-view surface only.)
    const mutating = gauge.interface.fragments
      .filter((f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
      .map((f: any) => f.name.toLowerCase());
    for (const bad of ["transfer", "approve", "permit", "mint", "delegate", "setweight"]) {
      expect(mutating.some((n: string) => n.includes(bad))).to.equal(false, `found ${bad}`);
    }

    // 4. And it holds no token of any kind: every burn went to dEaD, never here.
    for (const t of [fx.plank, fx.plankEthLp, fx.collLp]) {
      expect(await t.balanceOf(gaugeAddr)).to.equal(0n);
    }
    expect((await gauge.capabilities())[2]).to.equal(false, "capabilities claims it pays");
  });

  it("ANCHOR RULE: PlankGauge has no reach into GlobalIndexVault, in ABI or bytecode", async () => {
    const fx = await fixture();
    const { gauge, gaugeAddr } = fx;
    const idx = await deployOpenIndex({}, [1000n * WAD, 2000n * WAD, 500n * WAD]);

    // 1. No function name or argument name anywhere mentions a vault concept,
    //    or any external payment/reward mechanism at all.
    for (const f of gauge.interface.fragments.filter((x: any) => x.type === "function") as any[]) {
      const blob = (f.name + " " + f.inputs.map((i: any) => i.name).join(" ")).toLowerCase();
      for (const bad of [
        "index",
        "basket",
        "constituent",
        "reserve",
        "redeem",
        "nav",
        "treasury",
        "fee",
        "revenue",
        "dividend",
        "payer",
        "router",
      ]) {
        expect(blob.includes(bad)).to.equal(false, `gauge.${f.name} mentions ${bad}`);
      }
    }
    // 2. No vault address appears in this contract's deployed bytecode,
    //    because it was never given one — there is no constructor argument,
    //    no setter, and no storage slot that could hold one. Same for the
    //    dividend distributor, the other value-holding contract in this repo.
    const code = await ethers.provider.getCode(gaugeAddr);
    expect(code.toLowerCase()).to.not.include(idx.vaultAddr.slice(2).toLowerCase());
    for (const a of idx.addrs) {
      expect(code.toLowerCase()).to.not.include(a.slice(2).toLowerCase());
    }
    // 3. Symmetrically, the vault knows nothing about gauges (re-affirming
    //    GlobalIndexVault guarantee #5 against the NEW contract).
    for (const f of idx.vault.interface.fragments.filter(
      (x: any) => x.type === "function"
    ) as any[]) {
      const blob = (f.name + " " + f.inputs.map((i: any) => i.name).join(" ")).toLowerCase();
      for (const bad of ["gauge", "burn", "plank", "claim", "reward", "boost", "epoch"]) {
        // `claimDividend` is the vault's OWN holder dividend claim (round 9b).
        // It is not a gauge reach: it reads this contract's own share balances
        // and pays this contract's own dividend ledger. The exemption is named
        // rather than the keyword dropped, so any OTHER "claim*" on the vault
        // still trips this assertion.
        // Round 10 adds two more of the vault's OWN claims, for the same
        // reason and with the same shape: `claimPending` / `claimPendingMany`
        // pay a redemption leg that bounced back to the holder it was already
        // owed to. Like `claimDividend` they read only this contract's own
        // ledgers and reach no gauge, no PLANK, and no reward stream. The
        // exemptions stay NAMED rather than the keyword dropped, so any OTHER
        // "claim*" appearing on the vault still trips this assertion.
        if (
          bad === "claim" &&
          // The diamond refactor adds ONE more, and it is a READ: ERC-7540's
          // `claimableRedeemRequest` reports the deferred credit this contract
          // already owes the caller. It is a view over the same `pendingClaim`
          // ledger the three exemptions above pay out of — no gauge, no PLANK,
          // no reward stream, and no write at all. Named rather than the
          // keyword dropped, exactly as the others are, so any OTHER "claim*"
          // appearing anywhere in the FINALIZED FACET SET still trips this.
          [
            "claimDividend",
            "claimPending",
            "claimPendingMany",
            "pendingClaim",
            "reservedClaims",
            "claimableRedeemRequest",
          ].includes(f.name)
        ) continue;
        expect(blob.includes(bad)).to.equal(false, `vault.${f.name} mentions ${bad}`);
      }
    }
  });

  it("ANCHOR RULE: every gauge function, called by every role, moves no vault reserve", async () => {
    const fx = await fixture();
    const { gauge, gaugeRoleAdmin, registry, tuning, whale, gA } = fx;
    const idx = await deployOpenIndex({}, [1000n * WAD, 2000n * WAD, 500n * WAD]);
    await idx.vault.connect(idx.alice).mintProRata(500n * WAD, maxIn(3));
    const before = await Promise.all(idx.addrs.map((a) => idx.vault.reserveOf(a)));
    const balBefore = await Promise.all(idx.tokens.map((t) => t.balanceOf(idx.vaultAddr)));

    // Enumerate the whole non-view ABI and call it with arguments chosen to be
    // as favourable to the attacker as possible — the vault's own addresses.
    const fns = gauge.interface.fragments.filter(
      (f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)
    );
    expect(fns.length).to.be.greaterThan(8, "ABI enumeration found nothing");
    const argFor = (t: string): any => {
      if (t === "address") return idx.vaultAddr;
      if (t.startsWith("uint")) return 10n ** 24n;
      if (t === "bool") return true;
      if (t === "bytes32") return ethers.encodeBytes32String("multiplierRawBps");
      if (t.endsWith("[]")) return [];
      return 0n;
    };
    for (const who of [gaugeRoleAdmin, registry, tuning, whale]) {
      for (const f of fns as any[]) {
        const args = f.inputs.map((i: any) => argFor(i.type));
        try {
          await (gauge.connect(who) as any)[f.format("sighash")](...args);
        } catch {
          /* a guard firing is correct behaviour */
        }
      }
    }

    for (let i = 0; i < 3; i++) {
      expect(await idx.vault.reserveOf(idx.addrs[i])).to.equal(before[i], `reserve ${i} moved`);
      expect(await idx.tokens[i].balanceOf(idx.vaultAddr)).to.equal(
        balBefore[i],
        `vault balance ${i} moved`
      );
      expect(await idx.tokens[i].balanceOf(gauge.target as string)).to.equal(0n);
    }
    // ...and the vault's parameters are exactly where they were.
    expect((await idx.vault.params()).concentrationCapBps).to.equal(CONCENTRATION_CAP_BPS);
    expect(await idx.vault.roleHolder(await idx.vault.ROLE_RISK_PARAM())).to.equal(
      idx.risk.address
    );
    // The gauge's own book is likewise untouched by the sweep.
    expect(await gauge.gaugeWeight(gA)).to.equal(0n);
  });

  // ══ Timelocked administration — the vault's exact pattern ══════════════

  it("a multiplier change is QUEUED, never applied instantly", async () => {
    const fx = await fixture();
    const { gauge, tuning } = fx;
    const key = ethers.encodeBytes32String("multiplierCollectionLpBps");
    await gauge.connect(tuning).queueParam(key, 40_000n);
    expect(await gauge.multiplierBps(2)).to.equal(COLL_MULT, "applied on queue");
    await expect(gauge.executeParam(key)).to.be.revertedWithCustomError(
      gauge,
      "TimelockNotElapsed"
    );
    await time.increase(TIMELOCK + 1);
    await gauge.executeParam(key);
    expect(await gauge.multiplierBps(2)).to.equal(40_000n);
  });

  it("the hard multiplier ceiling holds even after the timelock elapses", async () => {
    const fx = await fixture();
    const { gauge, tuning } = fx;
    for (const [name, value] of [
      ["multiplierCollectionLpBps", 1_000_000n], // 100x
      ["multiplierRawBps", 1n], // below 1.0x
    ] as const) {
      const key = ethers.encodeBytes32String(name);
      await gauge.connect(tuning).queueParam(key, value);
      await time.increase(TIMELOCK + 1);
      await expect(gauge.executeParam(key)).to.be.revertedWithCustomError(gauge, "BadParam");
    }
    expect(await gauge.multiplierBps(0)).to.equal(RAW_MULT);
    expect(await gauge.multiplierBps(2)).to.equal(COLL_MULT);
  });

  it("an unknown parameter key can never be QUEUED, let alone applied", async () => {
    const fx = await fixture();
    const { gauge, tuning } = fx;
    const key = ethers.encodeBytes32String("distributionThresholdWei"); // generation 1's
    // The key whitelist in `roleForParamKey` now rejects it one step EARLIER
    // than the old executor did — an unknown key has no owning role, so no
    // caller can put it in the queue at all.
    await expect(gauge.connect(tuning).queueParam(key, 1n)).to.be.revertedWithCustomError(
      gauge,
      "BadParam"
    );
    // And the executor's own rejection is still there behind it: nothing that
    // somehow reached the queue could ever be applied.
    await time.increase(TIMELOCK + 1);
    await expect(gauge.executeParam(key)).to.be.revertedWithCustomError(gauge, "NothingQueued");
  });

  it("the path ordering (raw <= plank/eth LP <= collection LP) cannot be inverted", async () => {
    const fx = await fixture();
    const { gauge, tuning } = fx;
    const key = ethers.encodeBytes32String("multiplierRawBps");
    await gauge.connect(tuning).queueParam(key, 40_000n); // above the LP rate
    await time.increase(TIMELOCK + 1);
    await expect(gauge.executeParam(key)).to.be.revertedWithCustomError(gauge, "BadParam");
    // And a constructor that inverts them will not deploy at all.
    const Gauge = await ethers.getContractFactory("PlankGauge");
    await expect(
      Gauge.deploy(
        await fx.plank.getAddress(),
        [fx.gaugeRoleAdmin.address, fx.registry.address, fx.tuning.address],
        TIMELOCK,
        [30_000n, 20_000n, 10_000n],
        EPOCH
      )
    ).to.be.revertedWithCustomError(Gauge, "BadParam");
  });

  it("a below-floor timelock delay or epoch duration cannot be deployed at all", async () => {
    const fx = await fixture();
    const Gauge = await ethers.getContractFactory("PlankGauge");
    await expect(
      Gauge.deploy(
        await fx.plank.getAddress(),
        [fx.gaugeRoleAdmin.address, fx.registry.address, fx.tuning.address],
        3_600,
        [RAW_MULT, LP_MULT, COLL_MULT],
        EPOCH
      )
    ).to.be.revertedWithCustomError(Gauge, "BadParam");
    await expect(
      Gauge.deploy(
        await fx.plank.getAddress(),
        [fx.gaugeRoleAdmin.address, fx.registry.address, fx.tuning.address],
        TIMELOCK,
        [RAW_MULT, LP_MULT, COLL_MULT],
        60 // one minute — an epoch nobody could re-buy into
      )
    ).to.be.revertedWithCustomError(Gauge, "BadParam");
  });

  it("the LP allowlist is itself timelocked, so a fake pair cannot be slipped in", async () => {
    const fx = await fixture();
    const { gauge, registry, whale, gA, impostorLp } = fx;
    const addr = await impostorLp.getAddress();
    await gauge.connect(registry).queuePlankEthLp(addr, false);
    // Not approved yet, and no way to shorten the wait.
    await expect(
      gauge.connect(whale).burnPlankEthLp(gA, addr, WAD)
    ).to.be.revertedWithCustomError(gauge, "NotApprovedLp");
    await expect(gauge.executePlankEthLp(addr)).to.be.revertedWithCustomError(
      gauge,
      "TimelockNotElapsed"
    );
    await time.increase(TIMELOCK + 1);
    await gauge.executePlankEthLp(addr);
    expect(await gauge.approvedPlankEthLp(addr)).to.equal(true);
  });

  it("an unprivileged key can queue nothing at all", async () => {
    const fx = await fixture();
    const { gauge, whale, gA } = fx;
    const calls: [string, any[]][] = [
      ["queueParam", [ethers.encodeBytes32String("multiplierRawBps"), 1n]],
      ["queueGauge", [gA, true]],
      ["queuePlankEthLp", [whale.address, false]],
      ["queueCollectionLp", [gA, whale.address, whale.address, false]],
      ["queueRedirectSink", [whale.address]],
      ["queueRole", [await gauge.ROLE_GAUGE_TUNING(), whale.address]],
      ["cancelRole", [await gauge.ROLE_GAUGE_TUNING()]],
    ];
    for (const [name, args] of calls) {
      await expect((gauge.connect(whale) as any)[name](...args), name).to.be.revertedWithCustomError(
        gauge,
        "NotRoleHolder"
      );
    }
  });

  it("a role handover is itself timelocked", async () => {
    const fx = await fixture();
    const { gauge, gaugeRoleAdmin, registry, minnow } = fx;
    const ROLE_REG = await gauge.ROLE_GAUGE_REGISTRY();
    await gauge.connect(gaugeRoleAdmin).queueRole(ROLE_REG, minnow.address);
    expect(await gauge.roleHolder(ROLE_REG)).to.equal(registry.address, "applied on queue");
    await expect(gauge.executeRole(ROLE_REG)).to.be.revertedWithCustomError(
      gauge,
      "RoleTimelockNotElapsed"
    );
    await time.increase(TIMELOCK + 1);
    await gauge.executeRole(ROLE_REG);
    expect(await gauge.roleHolder(ROLE_REG)).to.equal(minnow.address);
  });

  it("un-registering a gauge stops new burns but erases no record", async () => {
    const fx = await fixture();
    const { gauge, registry, whale, gA } = fx;
    await gauge.connect(whale).burnPlank(gA, 100n * WAD);
    const e: bigint = await gauge.currentEpoch();
    const weight: bigint = await gauge.gaugeWeight(gA);

    await gauge.connect(registry).queueGauge(gA, true);
    await time.increase(TIMELOCK + 1);
    await gauge.executeGauge(gA);

    expect(await gauge.gaugeRegistered(gA)).to.equal(false);
    await expect(gauge.connect(whale).burnPlank(gA, WAD)).to.be.revertedWithCustomError(
      gauge,
      "UnknownGauge"
    );
    // The record survives intact — un-registering is not a confiscation, and
    // with epoch scoping its blast radius expires at the boundary anyway.
    expect(await gauge.gaugeWeightAt(gA, e)).to.equal(weight);
    expect(await gauge.epochWeightedBurn(e, gA, whale.address)).to.equal(100n * WAD);

    // Re-registering restores exactly the same book.
    await gauge.connect(registry).queueGauge(gA, false);
    await time.increase(TIMELOCK + 1);
    await gauge.executeGauge(gA);
    expect(await gauge.gaugeWeightAt(gA, e)).to.equal(weight);
  });
});
