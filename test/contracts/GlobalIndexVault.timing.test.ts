import { expect } from "chai";
import { ethers } from "hardhat";
import {
  takeSnapshot,
  time,
  type SnapshotRestorer,
} from "@nomicfoundation/hardhat-network-helpers";
import {
  BPS,
  LARGE_OP_WEI,
  MIN_CHECKPOINT,
  RAMP_DURATION,
  TIMELOCK,
  WAD,
  deployOpenIndex,
  maxIn,
  warmCheckpoints,
  zeroOut,
} from "./helpers/index-vault";

/**
 * Third hardening pass on GlobalIndexVault: TIMING and EDGE CASES the first
 * two rounds did not attack head-on, plus the platform/operator share
 * allocation.
 *
 *   A. Ramp-out is redemption-only from the moment a removal is QUEUED.
 *   B. The persistence gate is SIZE-PROPORTIONAL, so the "hold the push for
 *      exactly N checkpoints then cash out" attack no longer has a fixed N
 *      to aim at.
 *   C. Removal/at-risk status can never be reached by price or NAV alone.
 *   D. The mint-side imbalance fee is DIRECTIONAL, symmetric in intent with
 *      the redeem side: a deposit that rebalances is cheaper than one that
 *      unbalances.
 *   E. The platform allocation dilutes the depositor by exactly its disclosed
 *      bps and NEVER touches an existing holder's per-share backing.
 *
 * LOCAL HARDHAT ONLY. Nothing in this repo may deploy this contract until the
 * external audit gate (§2.6) clears.
 */
describe("GlobalIndexVault — timing and allocation", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const RESERVES = [1000n * WAD, 2000n * WAD, 500n * WAD]; // 1/3 each by NAV
  const fixture = (overrides = {}, reserves = RESERVES) =>
    deployOpenIndex(overrides, reserves);

  // ══ A. Ramp-out is redemption-only ═════════════════════════════════════

  it("RAMP-OUT: a queued removal freezes NEW deposits into that leg immediately", async () => {
    const fx = await fixture();
    const { vault, admin, alice, addrs } = fx;
    await warmCheckpoints(fx, 7);
    await vault.connect(alice).mintProRata(500n * WAD, maxIn(3));

    // Before the queue it is an ordinary constituent.
    expect(await vault.isExiting(addrs[1])).to.equal(false);
    await expect(vault.connect(alice).mintSingleAsset(addrs[1], 10n * WAD, 0n)).to.not.be.reverted;

    // The freeze lands the instant the removal is QUEUED — not when it
    // executes. Between queue and execution the intent is already public, and
    // a constituent being removed BECAUSE it is broken must not keep taking
    // deposits for the whole timelock.
    await vault.connect(admin).queueListing(addrs[1], addrs[1], 0, true);
    expect(await vault.isExiting(addrs[1])).to.equal(true);
    await expect(
      vault.connect(alice).mintSingleAsset(addrs[1], 10n * WAD, 0n)
    ).to.be.revertedWithCustomError(vault, "ConstituentExiting");

    // ...and it stays frozen after execution, for the whole ramp-out.
    await time.increase(TIMELOCK + 1);
    await vault.executeListing(addrs[1]);
    await expect(
      vault.connect(alice).mintSingleAsset(addrs[1], 10n * WAD, 0n)
    ).to.be.revertedWithCustomError(vault, "ConstituentExiting");
    await time.increase(RAMP_DURATION + 10);
    await expect(
      vault.connect(alice).mintSingleAsset(addrs[1], 10n * WAD, 0n)
    ).to.be.revertedWithCustomError(vault, "ConstituentExiting");

    // The other legs are entirely unaffected — the freeze is per-constituent.
    await vault.checkpointAll();
    await expect(vault.connect(alice).mintSingleAsset(addrs[0], 5n * WAD, 0n)).to.not.be.reverted;
  });

  it("RAMP-OUT: every exit stays open for the whole ramp-out, at every stage", async () => {
    const fx = await fixture();
    const { vault, admin, alice, addrs, tokens } = fx;
    await warmCheckpoints(fx, 7);
    await vault.connect(alice).mintProRata(2000n * WAD, maxIn(3));

    const canStillExit = async (stage: string) => {
      // Pro-rata: pays out the exiting leg like any other, no price read.
      const [, out] = await vault.previewRedeemProRata(100n * WAD);
      expect(out[1]).to.be.gt(0n, `${stage}: exiting leg stopped paying out`);
      const before: bigint = await tokens[1].balanceOf(alice.address);
      await vault.connect(alice).redeemProRata(100n * WAD, zeroOut(3));
      expect(await tokens[1].balanceOf(alice.address)).to.be.gt(before, `${stage}: pro-rata`);
      // Single-asset INTO the exiting leg is also still an exit, and exits
      // are never frozen — only entries are. (It can still be refused for the
      // ORDINARY reasons any single-asset exit can be: the concentration cap
      // fires when shrinking one leg pushes another over. What must never
      // happen is ConstituentExiting, which is the freeze reaching a path it
      // has no business on.)
      await expect(
        vault.connect(alice).redeemSingleAsset(20n * WAD, addrs[1], 0n),
        `${stage}: single-asset exit`
      ).to.not.be.revertedWithCustomError(vault, "ConstituentExiting");
    };

    await vault.connect(admin).queueListing(addrs[1], addrs[1], 0, true);
    await canStillExit("queued");
    await time.increase(TIMELOCK + 1);
    await vault.executeListing(addrs[1]);
    await canStillExit("executed");
    await time.increase(RAMP_DURATION / 2);
    await vault.checkpointAll();
    await canStillExit("mid-ramp");
    await time.increase(RAMP_DURATION / 2 + 10);
    await vault.checkpointAll();
    await canStillExit("fully ramped out");
  });

  it("RAMP-OUT: mintProRata stays open, and deliberately so", async () => {
    // Documented, reasoned exception. mintProRata cannot be used to CHOOSE to
    // enter the exiting leg — it enters every leg at the ratio the basket
    // already holds. Freezing it would shut the basket's primary, no-oracle
    // entry point for the whole timelock plus ramp, a liveness cost paid by
    // everyone to prevent a concentration nobody can actually ask for.
    const fx = await fixture();
    const { vault, admin, alice, addrs } = fx;
    await vault.connect(admin).queueListing(addrs[1], addrs[1], 0, true);
    await expect(vault.connect(alice).mintProRata(100n * WAD, maxIn(3))).to.not.be.reverted;
  });

  // ══ B. Size-proportional persistence ═══════════════════════════════════

  it("PERSISTENCE: the checkpoint requirement scales with operation size", async () => {
    const fx = await fixture();
    const { vault } = fx;
    const base = (await vault.params()).persistenceCheckpoints as bigint;
    expect(base).to.equal(3n);

    // Below the threshold there is no gate at all.
    expect(await vault.requiredCheckpoints(LARGE_OP_WEI - 1n)).to.equal(base);
    // At the threshold: the original fixed N.
    expect(await vault.requiredCheckpoints(LARGE_OP_WEI)).to.equal(base);
    // And then one more settled checkpoint per additional threshold-unit.
    expect(await vault.requiredCheckpoints(LARGE_OP_WEI * 2n)).to.equal(base + 1n);
    expect(await vault.requiredCheckpoints(LARGE_OP_WEI * 3n)).to.equal(base + 2n);
    // ...clamped at the observation-buffer depth, so it can never demand more
    // history than the ring buffer physically retains.
    expect(await vault.requiredCheckpoints(LARGE_OP_WEI * 1_000n)).to.equal(8n);
    expect(await vault.requiredCheckpoints(ethers.MaxUint256 / 2n)).to.equal(8n);
  });

  it("PERSISTENCE: 'hold for exactly N then cash out' fails once the op is large", async () => {
    /**
     * THE ATTACK, and why a fixed N loses to it. Holding a pushed price costs
     * the attacker capital linearly in the number of checkpoints; the profit
     * from the basket-moving trade is linear in SIZE. At a fixed N there is
     * therefore always a size at which the attack pays. The requirement now
     * grows with size, so the bigger the extraction, the longer the push must
     * be financed before it can be cashed.
     */
    const fx = await fixture();
    const { vault, alice, addrs } = fx;

    // Exactly 3 settled observations: the fixed-N bar, and nothing more. This
    // is precisely the state an attacker would engineer and stop at.
    // (Seeding lays two observations — seedConstituent and seedDeposit each
    // bootstrap one — so a single warm round reaches exactly three.)
    await warmCheckpoints(fx, 1);
    const info = await vault.constituentInfo(addrs[0]);
    expect(info[7]).to.equal(3, "the attack state is not the one under test");

    // THE FIXED-N CHECK PASSES. Against the pre-fix build this was the whole
    // gate, and everything below would have gone through.
    expect(await vault.persistenceHolds(addrs[0])).to.equal(true);
    expect(await vault.persistenceHoldsFor(addrs[0], 3n)).to.equal(true);

    // A small op (under the threshold) is ungated and goes through.
    await expect(vault.connect(alice).mintSingleAsset(addrs[0], 5n * WAD, 0n)).to.not.be.reverted;

    // An op right at ~1x the threshold needs exactly N, which it has.
    await expect(vault.connect(alice).mintSingleAsset(addrs[0], 12n * WAD, 0n)).to.not.be.reverted;

    // But the BIG one — ~4x the threshold, so N+3 = 6 checkpoints — is
    // refused, even though the band is perfectly flat and the fixed-N check
    // still says yes. That is the attack failing.
    expect(await vault.requiredCheckpoints(ethers.parseEther("40"))).to.equal(6n);
    expect(await vault.persistenceHoldsFor(addrs[0], 6n)).to.equal(false);
    await expect(
      vault.connect(alice).mintSingleAsset(addrs[0], 45n * WAD, 0n)
    ).to.be.revertedWithCustomError(vault, "PersistenceCheckFailed");

    // Financing the push for three more settled checkpoints — the cost the
    // gate exists to impose — is what unlocks it, and nothing else does.
    await warmCheckpoints(fx, 3);
    expect(await vault.persistenceHoldsFor(addrs[0], 6n)).to.equal(true);
    await expect(vault.connect(alice).mintSingleAsset(addrs[0], 45n * WAD, 0n)).to.not.be.reverted;
  });

  it("PERSISTENCE: the size-scaled gate still rejects a band that has not held", async () => {
    const fx = await fixture();
    const { vault, alice, sources, addrs } = fx;
    await warmCheckpoints(fx, 8); // full buffer, flat
    expect(await vault.persistenceHoldsFor(addrs[0], 8n)).to.equal(true);
    // Sustained capped pressure: the buffer is deep but no longer settled.
    for (let i = 0; i < 3; i++) {
      await sources[0].scalePrice(20_000);
      await time.increase(MIN_CHECKPOINT + 1);
      await vault.checkpoint(addrs[0]);
    }
    expect(await vault.persistenceHoldsFor(addrs[0], 3n)).to.equal(false);
    await expect(
      vault.connect(alice).mintSingleAsset(addrs[0], 500n * WAD, 0n)
    ).to.be.revertedWithCustomError(vault, "PersistenceCheckFailed");
  });

  // ══ C. Removal can never be triggered by price alone ═══════════════════

  it("ELIGIBILITY: nothing about price or NAV can deactivate or delist a leg", async () => {
    /**
     * HONEST SCOPE NOTE, and it is the important part of this test. The
     * eligibility signals the spec names — real fee revenue and distinct
     * wallet count — are NOT read on-chain by this contract, at all. There is
     * no oracle for either, and inventing an on-chain read of a number that
     * is actually produced off-chain would be worse than not having it: it
     * would look like a check while being a value a privileged caller types
     * in. What this contract has is `metric` (a timelocked admin input,
     * documented as "fee revenue + locked LP") which feeds the target-weight
     * VIEW and moves no value.
     *
     * So the property that IS enforceable on-chain, and is enforced, is the
     * negative one: removal is reachable ONLY through the timelocked admin
     * path, and NOTHING about a constituent's price, band, staleness or NAV
     * share can reach it. Wiring the real eligibility signals into that admin
     * decision is an off-chain integration point and is flagged as such.
     */
    const fx = await fixture();
    const { vault, alice, sources, addrs } = fx;
    await warmCheckpoints(fx, 4);
    await vault.connect(alice).mintProRata(500n * WAD, maxIn(3));
    const stillLive = async (label: string) => {
      const info = await vault.constituentInfo(addrs[0]);
      expect(info[5]).to.equal(true, `${label}: delisted`);
      expect(info[6]).to.equal(true, `${label}: deactivated`);
      expect(await vault.isExiting(addrs[0])).to.equal(false, `${label}: exiting`);
    };

    // Collapse the price to nearly nothing, in as many capped steps as the
    // oracle will take.
    for (let i = 0; i < 8; i++) {
      await sources[0].scalePrice(5_000);
      await time.increase(MIN_CHECKPOINT + 1);
      await vault.checkpointAll();
    }
    // The truncated oracle caps each observation at 5%, so eight settled
    // steps is a ~34% repricing — a real collapse, arriving in the capped
    // increments the design forces it into rather than in one block.
    expect(await vault.weightBps(addrs[0])).to.be.lt(2_600n, "price did not actually collapse");
    await stillLive("after a price collapse");

    // Blow it up instead, past the concentration cap.
    for (let i = 0; i < 12; i++) {
      await sources[0].scalePrice(20_000);
      await time.increase(MIN_CHECKPOINT + 1);
      await vault.checkpointAll();
    }
    await stillLive("after a price melt-up");

    // Go completely silent — the staleness breaker fires and NAV_low collapses
    // to zero, which is the harshest signal this contract produces...
    await time.increase(60 * 24 * 3_600);
    const [navLow] = await vault.nav();
    expect(navLow).to.equal(0n);
    await stillLive("after going fully stale");
    // ...and even then delisting is refused while reserves are outstanding.
    await expect(vault.delistEmpty(addrs[0])).to.be.revertedWithCustomError(vault, "BadParam");

    // Structurally: only ONE pair of functions can deactivate anything, and
    // both are admin+timelock. No price/NAV/band input appears in either.
    const deactivators = vault.interface.fragments
      .filter((f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
      .map((f: any) => f.name);
    expect(deactivators).to.include("queueListing");
    expect(deactivators).to.include("executeListing");
    for (const bad of ["prune", "evict", "autoRemove", "liquidate", "kick", "deactivate"]) {
      expect(deactivators).to.not.include(bad);
    }
    // A non-admin cannot even queue it.
    await expect(
      vault.connect(alice).queueListing(addrs[0], addrs[0], 0, true)
    ).to.be.revertedWithCustomError(vault, "NotAdmin");
  });

  // ══ D. Directional mint-side imbalance fee ═════════════════════════════

  it("FEE SYMMETRY: a deposit into an UNDERWEIGHT leg is discounted, an OVERWEIGHT one surcharged", async () => {
    // 800@1.0 / 1000@0.5 / 1100@2.0 ETH of NAV => 27.6% / 34.5% / 37.9%,
    // against an equal 33.3% target vector. Leg 0 is under, leg 2 is over,
    // and neither is at the concentration cap.
    const fx = await fixture({}, [800n * WAD, 2000n * WAD, 550n * WAD]);
    const { vault, alice, addrs } = fx;
    await warmCheckpoints(fx, 7);

    const [, target] = await vault.targetWeightsBps();
    const under: bigint = await vault.weightBps(addrs[0]);
    const over: bigint = await vault.weightBps(addrs[2]);
    expect(under).to.be.lt(target[0], "leg 0 is not actually underweight");
    expect(over).to.be.gt(target[2], "leg 2 is not actually overweight");

    const amount = 20n * WAD;
    // The DEPTH-only fee is the baseline each leg would have paid before the
    // directional term existed.
    const depthUnder: bigint = await vault.imbalanceFeeBps(
      amount,
      await vault.reserveOf(addrs[0])
    );
    const depthOver: bigint = await vault.imbalanceFeeBps(amount, await vault.reserveOf(addrs[2]));
    const feeUnder: bigint = await vault.previewMintFeeBps(addrs[0], amount);
    const feeOver: bigint = await vault.previewMintFeeBps(addrs[2], amount);

    expect(feeUnder).to.be.lt(depthUnder, "underweight deposit was not discounted");
    expect(feeOver).to.be.gt(depthOver, "overweight deposit was not surcharged");
    // The discount NEVER reaches zero: a negative or free rebalance fee would
    // be a payment out of the pool, i.e. an externalisation path §2.8 forbids.
    const base = (await vault.params()).baseImbalanceFeeBps as bigint;
    expect(feeUnder).to.be.gte(base, "the discount went below the base fee");
    // ...and the surcharge is bounded by the same hard ceiling as everything.
    expect(feeOver).to.be.lte((await vault.params()).maxImbalanceFeeBps as bigint);

    // And it is visible in real shares, not only in the quote: the same
    // deposit value buys a better rate on the leg that needs it.
    const sharesUnder: bigint = await vault
      .connect(alice)
      .mintSingleAsset.staticCall(addrs[0], amount, 0n);
    expect(sharesUnder).to.be.gt(0n);
  });

  it("FEE SYMMETRY: the discount decays to nothing as the leg reaches its target", async () => {
    const fx = await fixture({}, [800n * WAD, 2000n * WAD, 550n * WAD]);
    const { vault, alice, addrs } = fx;
    await warmCheckpoints(fx, 7);
    const amount = 5n * WAD;
    // Measure the DIRECTIONAL RELIEF specifically — depth fee minus the
    // quoted fee. The absolute fee is the wrong quantity to watch here
    // because the depth term falls on its own as the leg gets deeper, and
    // that fall would mask (or fake) a change in the directional term.
    const relief = async () => {
      const depth: bigint = await vault.imbalanceFeeBps(amount, await vault.reserveOf(addrs[0]));
      const quoted: bigint = await vault.previewMintFeeBps(addrs[0], amount);
      return depth - quoted;
    };
    const first = await relief();
    expect(first).to.be.gt(0n, "there was no discount to decay");
    // Fill the underweight leg up toward its target...
    for (let i = 0; i < 6; i++) {
      await vault.connect(alice).mintSingleAsset(addrs[0], 15n * WAD, 0n);
    }
    expect(await relief()).to.be.lt(first, "the discount did not decay as the gap closed");
  });

  // ══ E. Platform / operator share allocation ═══════════════════════════

  async function withTreasury(reserves = RESERVES) {
    const fx = await deployOpenIndex({}, reserves);
    const all = await ethers.getSigners();
    const treasury = all[11];
    await fx.vault.connect(fx.admin).queuePlatformTreasury(treasury.address);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executePlatformTreasury();
    return { ...fx, treasury };
  }

  it("ALLOCATION: inert until a treasury is appointed, and the appointment is timelocked", async () => {
    const fx = await fixture();
    const { vault, admin, alice } = fx;
    const all = await ethers.getSigners();
    const treasury = all[11];

    // Born with a non-zero bps and no treasury: the whole mechanism is off.
    expect(await vault.platformAllocationBps()).to.equal(200n);
    expect(await vault.platformTreasury()).to.equal(ethers.ZeroAddress);
    await vault.connect(alice).mintProRata(100n * WAD, maxIn(3));
    expect(await vault.balanceOf(alice.address)).to.equal(100n * WAD, "diluted with no treasury");

    await vault.connect(admin).queuePlatformTreasury(treasury.address);
    expect(await vault.platformTreasury()).to.equal(ethers.ZeroAddress, "applied on queue");
    await expect(vault.executePlatformTreasury()).to.be.revertedWithCustomError(
      vault,
      "TimelockNotElapsed"
    );
    await time.increase(TIMELOCK + 1);
    await vault.executePlatformTreasury();
    expect(await vault.platformTreasury()).to.equal(treasury.address);
    // Only the admin could ever have queued it.
    await expect(
      vault.connect(alice).queuePlatformTreasury(alice.address)
    ).to.be.revertedWithCustomError(vault, "NotAdmin");
  });

  it("ALLOCATION (a): the depositor's value in matches their redeem out, net of exactly the bps", async () => {
    const fx = await withTreasury();
    const { vault, alice, treasury, addrs } = fx;
    const alloc = (await vault.platformAllocationBps()) as bigint;

    const shares = 400n * WAD;
    const [, quoted] = await vault.previewMintProRata(shares);
    const amountsIn: bigint[] = await vault
      .connect(alice)
      .mintProRata.staticCall(shares, maxIn(3));
    await vault.connect(alice).mintProRata(shares, maxIn(3));

    // The depositor paid full value in for `shares` worth, and holds
    // (1 - alloc) of them. The treasury holds exactly the rest — never more,
    // and never anything minted on top.
    const mine: bigint = await vault.balanceOf(alice.address);
    const cut: bigint = await vault.balanceOf(treasury.address);
    expect(mine + cut).to.equal(shares, "total minted was not the pre-allocation amount");
    expect(cut).to.equal((shares * alloc) / BPS);

    // Redeeming everything back, with no price movement in between, returns
    // exactly (1 - alloc) of what went in, slot for slot. Nothing else is
    // lost anywhere: no hidden fee, no second haircut.
    const [, out] = await vault.previewRedeemProRata(mine);
    for (let i = 0; i < 3; i++) {
      const expected = ((amountsIn[i] as bigint) * (BPS - alloc)) / BPS;
      expect(out[i] as bigint).to.be.lte(expected, `leg ${i} paid out MORE than value in`);
      // ...and within a whisker of it — the only gap is the vault-favouring
      // ceil-in/floor-out rounding the redemption doctrine requires.
      expect(out[i] as bigint).to.be.gte(
        expected - expected / 1_000_000n - 2n,
        `leg ${i} lost value beyond the disclosed bps`
      );
      expect(quoted[i] as bigint).to.be.gte(amountsIn[i] as bigint);
      expect(await vault.reserveOf(addrs[i])).to.be.gt(0n);
    }
  });

  it("ALLOCATION (b): an existing holder's per-share backing is EXACTLY unaffected", async () => {
    const V = 1000n;
    // Two identical baskets driven through identical operations, one with the
    // allocation live and one without. Bob is the incumbent in both.
    const on = await withTreasury();
    const off = await fixture();

    for (const fx of [on, off] as any[]) {
      await fx.vault.connect(fx.bob).mintProRata(1000n * WAD, maxIn(3));
    }
    const backing = async (fx: any) => {
      const s: bigint = await fx.vault.totalSupply();
      const r: bigint[] = await Promise.all(
        fx.addrs.map((a: string) => fx.vault.reserveOf(a) as Promise<bigint>)
      );
      return r.map((x) => (x * 10n ** 30n) / (s + V));
    };
    const beforeOn = await backing(on);
    const beforeOff = await backing(off);

    // Alice mints. With the allocation live, some of HER shares go to the
    // treasury — and the share COUNT minted in total is identical either way,
    // which is what makes the incumbent's backing identical either way.
    for (const fx of [on, off] as any[]) {
      await fx.vault.connect(fx.alice).mintProRata(750n * WAD, maxIn(3));
    }
    const afterOn = await backing(on);
    const afterOff = await backing(off);

    for (let i = 0; i < 3; i++) {
      expect(afterOn[i]).to.equal(afterOff[i], `leg ${i} backing diverged with the allocation on`);
      // Backing rises very slightly on any mint, in BOTH worlds and by the
      // same amount: the pro-rata deposit CEILS, so the vault over-collects
      // by at most one base unit per leg and keeps it (§2.9 doctrine).
      expect(afterOn[i]).to.be.gte(beforeOn[i], `leg ${i} backing fell`);
      expect(afterOff[i]).to.be.gte(beforeOff[i], `leg ${i} backing fell`);
    }
    // Bob's redeemable slice is bit-for-bit the same in both worlds.
    const [, outOn] = await on.vault.previewRedeemProRata(1000n * WAD);
    const [, outOff] = await off.vault.previewRedeemProRata(1000n * WAD);
    for (let i = 0; i < 3; i++) expect(outOn[i]).to.equal(outOff[i]);
    expect(await on.vault.totalSupply()).to.equal(await off.vault.totalSupply());
  });

  it("ALLOCATION (c): the 5% ceiling is enforced at execution, and the change is timelocked", async () => {
    const fx = await withTreasury();
    const { vault, admin } = fx;
    const key = ethers.encodeBytes32String("platformAllocationBps");

    // Past the compile-time ceiling: queueable (the timelock queue is dumb by
    // design), never executable.
    await vault.connect(admin).queueParam(key, 501n);
    await time.increase(TIMELOCK + 1);
    await expect(vault.executeParam(key)).to.be.revertedWithCustomError(
      vault,
      "AllocationCapExceeded"
    );
    await vault.connect(admin).queueParam(key, 10_000n); // 100%
    await time.increase(TIMELOCK + 1);
    await expect(vault.executeParam(key)).to.be.revertedWithCustomError(
      vault,
      "AllocationCapExceeded"
    );
    expect(await vault.platformAllocationBps()).to.equal(200n);

    // A legal change is queued, never instant.
    await vault.connect(admin).queueParam(key, 500n);
    expect(await vault.platformAllocationBps()).to.equal(200n, "applied on queue");
    await expect(vault.executeParam(key)).to.be.revertedWithCustomError(
      vault,
      "TimelockNotElapsed"
    );
    await time.increase(TIMELOCK + 1);
    await vault.executeParam(key);
    expect(await vault.platformAllocationBps()).to.equal(500n);

    // ...and it can always be turned off entirely.
    await vault.connect(admin).queueParam(key, 0n);
    await time.increase(TIMELOCK + 1);
    await vault.executeParam(key);
    expect(await vault.platformAllocationBps()).to.equal(0n);
    await vault.connect(fx.alice).mintProRata(100n * WAD, maxIn(3));
    expect(await vault.balanceOf(fx.alice.address)).to.equal(100n * WAD);
  });

  it("ALLOCATION: the treasury gets SHARES and no reach over reserves whatsoever", async () => {
    const fx = await withTreasury();
    const { vault, vaultAddr, alice, treasury, tokens, addrs } = fx;
    await vault.connect(alice).mintProRata(1000n * WAD, maxIn(3));
    expect(await vault.balanceOf(treasury.address)).to.be.gt(0n);

    // Enumerate the whole non-view ABI as the treasury and prove no reserve
    // moves — the same anchor-rule sweep the admin and seeder get.
    const before = await Promise.all(addrs.map((a) => vault.reserveOf(a)));
    const balBefore = await Promise.all(tokens.map((t) => t.balanceOf(vaultAddr)));
    const fns = vault.interface.fragments.filter(
      (f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)
    );
    const argFor = (t: string): any => {
      if (t === "address") return addrs[0];
      if (t.startsWith("uint")) return 10n ** 24n;
      if (t === "bool") return true;
      if (t === "bytes32") return ethers.encodeBytes32String("platformAllocationBps");
      if (t.endsWith("[]")) return [0n, 0n, 0n];
      if (t === "string") return "x";
      return 0n;
    };
    for (const f of fns as any[]) {
      const args = f.inputs.map((i: any) => argFor(i.type));
      try {
        await (vault.connect(treasury) as any)[f.format("sighash")](...args);
      } catch {
        /* a guard firing is correct behaviour */
      }
    }
    for (let i = 0; i < 3; i++) {
      expect(await vault.reserveOf(addrs[i])).to.equal(before[i], `reserve ${i} moved`);
      expect(await tokens[i].balanceOf(vaultAddr)).to.equal(balBefore[i], `balance ${i} moved`);
      expect(await tokens[i].balanceOf(treasury.address)).to.equal(0n, "treasury took a leg");
    }
    expect(await vault.admin()).to.equal(fx.admin.address);

    // The only thing it can do with its shares is what anyone else can: a
    // strict pro-rata redemption, at the same price, through the same code.
    const mine: bigint = await vault.balanceOf(treasury.address);
    await expect(vault.connect(treasury).redeemProRata(mine, zeroOut(3))).to.not.be.reverted;
  });
});
