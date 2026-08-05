import { expect } from "chai";
import { ethers } from "hardhat";
import {
  takeSnapshot,
  time,
  type SnapshotRestorer,
} from "@nomicfoundation/hardhat-network-helpers";
import {
  BPS,
  CONCENTRATION_CAP_BPS,
  MIN_CHECKPOINT,
  RAMP_DURATION,
  STALE_AFTER,
  TIMELOCK,
  WAD,
  deployConstituent,
  deployOpenIndex,
  maxIn,
  warmCheckpoints,
  zeroOut,
  type IndexFixture,
} from "./helpers/index-vault";

/**
 * Audit-style suite for GlobalIndexVault + VePlank, written to the bar
 * VaultV3.audit.test.ts set: one test per NAMED defense in
 * docs/marketplank/SPEC-PLANK-CHECKS-AND-INDEX.md §2.7/§2.8/§2.9 and
 * docs/marketplank/SPEC-GLOBAL-INDEX-ULTIMATE-FORM.md §1-§5, each attacking
 * the specific vector the defense exists for rather than asserting the happy
 * path.
 *
 * LOCAL HARDHAT ONLY. Nothing in this repo may deploy either contract
 * anywhere until the external audit gate (§2.6) clears.
 */
describe("GlobalIndexVault", () => {

  // These suites advance the shared Hardhat clock by YEARS (four-year vePLANK
  // locks, month-long weight ramps). Mocha shares one network across files, so
  // without restoring the snapshot afterwards every later suite runs in the
  // future — which silently expires the fixed-endTime Seaport orders in
  // SeaportPerTokenApproval/SeaportCriteriaFulfill. Snapshot in, restore out.
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });
  const RESERVES = [1000n * WAD, 2000n * WAD, 500n * WAD]; // 1/3 each by NAV

  const fixture = (overrides = {}) => deployOpenIndex(overrides, RESERVES);

  async function reservesOf(fx: IndexFixture): Promise<bigint[]> {
    return Promise.all(fx.addrs.map((a) => fx.vault.reserveOf(a) as Promise<bigint>));
  }

  // ══ §1 — strict pro-rata in-kind redemption ═════════════════════════════

  it("pro-rata redemption never pays more than a strict slice of the real reserve", async () => {
    const fx = await fixture();
    const { vault, alice, bob } = fx;
    await vault.connect(alice).mintProRata(300n * WAD, maxIn(3));
    await vault.connect(bob).mintProRata(120n * WAD, maxIn(3));

    const before = await reservesOf(fx);
    const supply: bigint = await vault.totalSupply();
    const V = 1000n; // VIRTUAL_SHARES
    const burn = 137n * WAD + 7n;

    await vault.connect(alice).redeemProRata(burn, zeroOut(3));
    const after = await reservesOf(fx);

    for (let i = 0; i < 3; i++) {
      const paid = before[i] - after[i];
      // THE invariant: out_k * (S + V) <= sharesIn * reserve_k, for every k.
      // Anything else is a per-share-backing leak to the redeemer.
      expect(paid * (supply + V)).to.be.lte(burn * before[i], `leg ${i} overpaid`);
    }
  });

  it("every remaining holder's per-share backing is non-decreasing in every asset", async () => {
    const fx = await fixture();
    const { vault, alice, bob } = fx;
    await vault.connect(alice).mintProRata(300n * WAD, maxIn(3));
    await vault.connect(bob).mintProRata(50n * WAD, maxIn(3));

    const V = 1000n;
    const before = await reservesOf(fx);
    const sBefore: bigint = await vault.totalSupply();

    await vault.connect(alice).redeemProRata(211n * WAD + 3n, zeroOut(3));

    const after = await reservesOf(fx);
    const sAfter: bigint = await vault.totalSupply();
    for (let i = 0; i < 3; i++) {
      // backing_after >= backing_before, cross-multiplied to stay exact.
      expect(after[i] * (sBefore + V)).to.be.gte(
        before[i] * (sAfter + V),
        `backing fell for leg ${i}`
      );
    }
  });

  it("the redeemer's ownership fraction is identical across every constituent", async () => {
    const fx = await fixture();
    const { vault, alice } = fx;
    await vault.connect(alice).mintProRata(400n * WAD, maxIn(3));
    const before = await reservesOf(fx);
    const burn = 99n * WAD;
    await vault.connect(alice).redeemProRata(burn, zeroOut(3));
    const after = await reservesOf(fx);

    // paid_k / reserve_k must be the same ratio for all k up to one base unit
    // of rounding — that is what "never chooses composition" means.
    const ratios = before.map((b, i) => ((b - after[i]) * 10n ** 27n) / b);
    for (let i = 1; i < ratios.length; i++) {
      const d = ratios[i] > ratios[0] ? ratios[i] - ratios[0] : ratios[0] - ratios[i];
      expect(d).to.be.lt(10n ** 12n, "composition drifted between legs");
    }
  });

  it("a mint -> redeem round trip never returns more than was put in", async () => {
    const fx = await fixture();
    const { vault, alice, tokens } = fx;
    const shares = 250n * WAD + 13n;
    const balBefore = await Promise.all(tokens.map((t) => t.balanceOf(alice.address)));
    await vault.connect(alice).mintProRata(shares, maxIn(3));
    await vault.connect(alice).redeemProRata(shares, zeroOut(3));
    const balAfter = await Promise.all(tokens.map((t) => t.balanceOf(alice.address)));
    for (let i = 0; i < 3; i++) {
      expect(balAfter[i]).to.be.lte(balBefore[i], `leg ${i} round-tripped a profit`);
    }
  });

  it("dust never accumulates to whoever redeems last", async () => {
    const fx = await fixture();
    const { vault, alice, bob, carol } = fx;
    for (const who of [alice, bob, carol]) {
      await vault.connect(who).mintProRata(100n * WAD + 7n, maxIn(3));
    }
    const V = 1000n;
    const backings: bigint[][] = [];
    for (const who of [alice, bob, carol]) {
      const r = await reservesOf(fx);
      const s: bigint = await vault.totalSupply();
      backings.push(r.map((x) => (x * 10n ** 18n) / (s + V)));
      await vault.connect(who).redeemProRata(100n * WAD, zeroOut(3));
    }
    // Backing per share only ever improves as people leave; the last redeemer
    // is never worse off and never systematically better off by more than dust.
    for (let leg = 0; leg < 3; leg++) {
      for (let i = 1; i < backings.length; i++) {
        expect(backings[i][leg]).to.be.gte(backings[i - 1][leg]);
      }
    }
  });

  it("redemption needs no price at all — it works with every constituent stale", async () => {
    const fx = await fixture();
    const { vault, alice } = fx;
    await vault.connect(alice).mintProRata(200n * WAD, maxIn(3));
    await time.increase(STALE_AFTER * 5);
    const [navLow] = await vault.nav();
    expect(navLow).to.equal(0n, "stale legs must value to zero, not to a frozen price");
    // ...and pro-rata in-kind still works, because it never reads a price.
    await expect(vault.connect(alice).redeemProRata(200n * WAD, zeroOut(3))).to.not.be.reverted;
  });

  // ══ §1 — the single-asset convenience exit ══════════════════════════════

  it("the single-asset exit is strictly worse than the pro-rata exit", async () => {
    const fx = await fixture();
    const { vault, alice, addrs } = fx;
    await vault.connect(alice).mintProRata(300n * WAD, maxIn(3));
    await warmCheckpoints(fx, 3);

    const burn = 50n * WAD;
    const [, proRata] = await vault.previewRedeemProRata(burn);
    const single: bigint = await vault.previewRedeemSingleAsset(burn, addrs[0]);

    // Value both in ETH at the SAME (low) band so the comparison is honest.
    const lows: bigint[] = await Promise.all(
      addrs.map(async (a) => (await vault.priceBand(a))[0] as bigint)
    );
    let proRataEth = 0n;
    for (let i = 0; i < 3; i++) proRataEth += ((proRata[i] as bigint) * lows[i]) / WAD;
    const singleEth = (single * lows[0]) / WAD;

    expect(singleEth).to.be.lt(proRataEth, "cherry-picking must never be free");
  });

  it("the single-asset exit fee scales with how imbalanced the ask is", async () => {
    const fx = await fixture();
    const { vault, alice, addrs } = fx;
    await vault.connect(alice).mintProRata(2000n * WAD, maxIn(3));
    await warmCheckpoints(fx, 3);

    // Effective haircut = 1 - (single-asset value / pro-rata value), measured
    // at three escalating sizes. It must be monotonically increasing.
    const haircut = async (burn: bigint) => {
      const [, pr] = await vault.previewRedeemProRata(burn);
      const single: bigint = await vault.previewRedeemSingleAsset(burn, addrs[0]);
      const lows: bigint[] = await Promise.all(
        addrs.map(async (a) => (await vault.priceBand(a))[0] as bigint)
      );
      let prEth = 0n;
      for (let i = 0; i < 3; i++) prEth += ((pr[i] as bigint) * lows[i]) / WAD;
      const sEth = (single * lows[0]) / WAD;
      return ((prEth - sEth) * 10n ** 9n) / prEth;
    };

    const h1 = await haircut(10n * WAD);
    const h2 = await haircut(200n * WAD);
    const h3 = await haircut(900n * WAD);
    expect(h2).to.be.gt(h1, "fee must rise with size");
    expect(h3).to.be.gt(h2, "fee must keep rising with size");
  });

  it("the imbalance fee is retained in reserves for the holders who stayed", async () => {
    const fx = await fixture();
    const { vault, alice, bob, addrs } = fx;
    await vault.connect(alice).mintProRata(1000n * WAD, maxIn(3));
    await vault.connect(bob).mintProRata(1000n * WAD, maxIn(3));
    await warmCheckpoints(fx, 3);

    const V = 1000n;
    const before = await reservesOf(fx);
    const sBefore: bigint = await vault.totalSupply();
    await vault.connect(alice).redeemSingleAsset(400n * WAD, addrs[0], 0n);
    const after = await reservesOf(fx);
    const sAfter: bigint = await vault.totalSupply();

    // Bob's per-share claim on the legs he did NOT get drained must strictly
    // improve, and on the drained leg must not fall below pro-rata.
    for (let i = 1; i < 3; i++) {
      expect(after[i] * (sBefore + V)).to.be.gt(before[i] * (sAfter + V), `leg ${i}`);
    }
  });

  it("a single-asset exit can never empty the leg it targets", async () => {
    const fx = await fixture();
    const { vault, alice, addrs } = fx;
    await vault.connect(alice).mintProRata(5000n * WAD, maxIn(3));
    await warmCheckpoints(fx, 3);
    await expect(
      vault.connect(alice).redeemSingleAsset(5000n * WAD, addrs[2], 0n)
    ).to.be.revertedWithCustomError(vault, "ReserveWouldEmpty");
  });

  it("a single-asset mint -> single-asset redeem round trip is unprofitable", async () => {
    const fx = await fixture();
    const { vault, alice, tokens, addrs } = fx;
    await warmCheckpoints(fx, 4);
    const before: bigint = await tokens[0].balanceOf(alice.address);
    const shares: bigint = await vault
      .connect(alice)
      .mintSingleAsset.staticCall(addrs[0], 100n * WAD, 0n);
    await vault.connect(alice).mintSingleAsset(addrs[0], 100n * WAD, 0n);
    await vault.connect(alice).redeemSingleAsset(shares, addrs[0], 0n);
    const after: bigint = await tokens[0].balanceOf(alice.address);
    expect(after).to.be.lt(before, "band + imbalance fee must make the loop lossy");
  });

  // ══ §2.7/§2.9 — inflation defense at THIS nesting layer ═════════════════

  it("a raw donation to the vault is inert — reserves are explicit, never balanceOf", async () => {
    const fx = await fixture();
    const { vault, vaultAddr, alice, tokens, addrs } = fx;
    const before: bigint = await vault.reserveOf(addrs[0]);
    await tokens[0].connect(alice).transfer(vaultAddr, 100_000n * WAD);
    expect(await vault.reserveOf(addrs[0])).to.equal(before, "donation moved the reserve");

    // ...and it does not change what anyone else's shares are worth.
    const [, quoted] = await vault.previewMintProRata(WAD);
    await vault.connect(alice).mintProRata(WAD, maxIn(3));
    expect(quoted[0]).to.be.lt(2n * WAD, "donation inflated the mint price");
  });

  it("the first public depositor cannot be inflation-attacked (virtual offset + locked seed)", async () => {
    const fx = await fixture();
    const { vault, alice, bob, addrs } = fx;

    // Classic shape: attacker takes the smallest possible position, then
    // donates hugely, hoping the victim's mint rounds to zero shares.
    await vault.connect(alice).mintProRata(1n, maxIn(3));
    for (let i = 0; i < 3; i++) {
      await fx.tokens[i].connect(alice).transfer(fx.vaultAddr, 200_000n * WAD);
    }
    const victim = 10n * WAD;
    await vault.connect(bob).mintProRata(victim, maxIn(3));
    expect(await vault.balanceOf(bob.address)).to.equal(victim);

    // And the victim can immediately redeem a real slice back out.
    const [, out] = await vault.previewRedeemProRata(victim);
    expect(out[0]).to.be.gt(0n);
    expect(await vault.reserveOf(addrs[0])).to.be.gt(0n);
  });

  it("the seed shares are locked at a dead address forever, so supply is never zero", async () => {
    const fx = await fixture();
    expect(await fx.vault.balanceOf(await fx.vault.SEED_LOCK())).to.equal(1000n * WAD);
    // No path exists to burn them: address(0) cannot sign, and there is no
    // owner-burn, no sweep, no emergency function.
    const fns = fx.vault.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.name.toLowerCase());
    for (const bad of ["burn", "sweep", "rescue", "emergency", "skim", "recover"]) {
      expect(fns.some((n: string) => n.includes(bad))).to.equal(false, `found ${bad}`);
    }
  });

  it("refuses to mint against a short delivery from a fee-on-transfer constituent", async () => {
    const fx = await fixture();
    const { vault, alice, tokens, addrs } = fx;
    const before: bigint = await vault.reserveOf(addrs[0]);
    const supplyBefore: bigint = await vault.totalSupply();

    await tokens[0].setFeeBps(500); // 5% burned on every transfer

    // Balancer STA (Jun 2020) in two halves. The first half is crediting the
    // ACTUAL delta rather than the nominal amount — necessary, but on this
    // path not sufficient, because mintProRata mints a FIXED share count: a
    // short delivery would mint full shares against a partial deposit and
    // dilute every existing holder by the transfer fee. So the mint is
    // refused outright. (This was found by the randomized suite, not by
    // inspection; the pre-fix build silently diluted here.)
    await expect(
      vault.connect(alice).mintProRata(100n * WAD, maxIn(3))
    ).to.be.revertedWithCustomError(vault, "ShortDelivery");
    expect(await vault.reserveOf(addrs[0])).to.equal(before, "reserve moved on a refused mint");
    expect(await vault.totalSupply()).to.equal(supplyBefore, "shares minted on a refused mint");

    // The single-asset path DOES accept it, because there the share count is
    // derived from the credited delta rather than fixed in advance — so a
    // short delivery buys proportionally fewer shares and dilutes nobody.
    const vaultBalBefore: bigint = await tokens[0].balanceOf(fx.vaultAddr);
    await warmCheckpoints(fx, 3);
    await vault.connect(alice).mintSingleAsset(addrs[0], 100n * WAD, 0n);
    const credited = (await vault.reserveOf(addrs[0])) - before;
    const realDelta = (await tokens[0].balanceOf(fx.vaultAddr)) - vaultBalBefore;
    expect(credited).to.equal(realDelta, "credited the nominal amount, not the delta");
    expect(credited).to.be.lt(100n * WAD, "fee-on-transfer was not actually exercised");
  });

  // ══ §2.7 — concentration cap and weight curve ═══════════════════════════

  it("no operation may push a constituent further over the 40% concentration cap", async () => {
    const fx = await fixture();
    const { vault, alice, addrs } = fx;
    await warmCheckpoints(fx, 4);

    // Creep leg 2 upward in small single-asset mints. Each one is legal until
    // the one that would carry it past 40% of NAV, which must be refused.
    let reverted = false;
    for (let i = 0; i < 40; i++) {
      try {
        await vault.connect(alice).mintSingleAsset(addrs[2], 20n * WAD, 0n);
      } catch (e: any) {
        expect(String(e)).to.include("ConcentrationCapExceeded");
        reverted = true;
        break;
      }
    }
    expect(reverted, "cap never fired").to.equal(true);
    const w: bigint = await vault.weightBps(addrs[2]);
    expect(w, "cap fired far from the cap").to.be.gte(CONCENTRATION_CAP_BPS - 300n);
    expect(w, "cap let the breach through").to.be.lte(CONCENTRATION_CAP_BPS);

    // The cap is directional, not a freeze: reducing the breach is allowed.
    await expect(vault.connect(alice).redeemSingleAsset(10n * WAD, addrs[2], 0n)).to.not.be
      .reverted;
  });

  it("the sqrt weight curve dampens outsized constituents and the cap redistributes", async () => {
    const fx = await fixture();
    const { vault, admin, addrs } = fx;
    // A collection with 100x the metric of its peers.
    await vault.connect(admin).queueMetric(addrs[0], 1_000_000n);
    await vault.connect(admin).queueMetric(addrs[1], 10_000n);
    await vault.connect(admin).queueMetric(addrs[2], 10_000n);
    await time.increase(TIMELOCK + 1);
    for (const a of addrs) await vault.executeMetric(a);

    const [, bps] = await vault.targetWeightsBps();
    // Linear weighting would give leg 0 ~98%. sqrt gives ~83%, then the cap
    // clamps it to 40% and pushes the excess onto the other two.
    expect(bps[0]).to.be.lte(CONCENTRATION_CAP_BPS, "cap not applied");
    expect(bps[1]).to.be.gt(1_000n, "excess was not redistributed");
    expect(bps[1]).to.equal(bps[2], "redistribution was not pro-rata");
    const total = bps[0] + bps[1] + bps[2];
    expect(total).to.be.gte(9_900n).and.to.be.lte(10_100n);
  });

  // ══ §2.7 — gradual ramp-in ══════════════════════════════════════════════

  it("a newly added constituent ramps in over a real window, never in one block", async () => {
    const fx = await fixture();
    const { vault, admin } = fx;
    const d = await deployConstituent("cD", 100n * WAD, 100n * WAD);

    await vault.connect(admin).queueListing(d.addr, await d.source.getAddress(), 3_333, false);
    await expect(vault.executeListing(d.addr)).to.be.revertedWithCustomError(
      vault,
      "TimelockNotElapsed"
    );
    await time.increase(TIMELOCK + 1);
    await vault.executeListing(d.addr);

    const weightOf = async () => {
      // Checkpoint first: an un-checkpointed leg is stale, and a stale leg's
      // ramp is deliberately frozen (covered by the next test).
      await vault.checkpointAll();
      const [tokens, bps] = await vault.targetWeightsBps();
      return bps[tokens.findIndex((t: string) => t.toLowerCase() === d.addr.toLowerCase())];
    };

    expect(await weightOf()).to.equal(0n, "instant weight jump");
    await time.increase(RAMP_DURATION / 2);
    const half = await weightOf();
    expect(half).to.be.gt(0n);
    await time.increase(RAMP_DURATION / 2 + 10);
    const full = await weightOf();
    expect(full).to.be.gt(half, "ramp did not progress");
  });

  it("a stale constituent's ramp-in freezes (§2.9 silent-constituent breaker)", async () => {
    const fx = await fixture();
    const { vault, admin } = fx;
    const d = await deployConstituent("cD", 100n * WAD, 100n * WAD);
    await vault.connect(admin).queueListing(d.addr, await d.source.getAddress(), 3_333, false);
    await time.increase(TIMELOCK + 1);
    await vault.executeListing(d.addr);

    await time.increase(RAMP_DURATION); // ramp fully elapsed...
    const [tokens, bps] = await vault.targetWeightsBps();
    const i = tokens.findIndex((t: string) => t.toLowerCase() === d.addr.toLowerCase());
    // ...but nobody checkpointed it, so it is stale and its ramp is frozen at 0.
    expect(bps[i]).to.equal(0n);
  });

  // ══ §2/§5.3 — banded NAV, capped oracle, persistence ════════════════════

  it("NAV is a band, and the band is always strictly wider than a point", async () => {
    const fx = await fixture();
    await warmCheckpoints(fx, 3);
    const [low, high] = await fx.vault.nav();
    expect(low).to.be.gt(0n);
    expect(high).to.be.gt(low, "NAV collapsed to a point estimate");
  });

  it("a single-block price spike enters the oracle as at most one capped step", async () => {
    const fx = await fixture();
    const { vault, sources, addrs } = fx;
    await warmCheckpoints(fx, 4);
    const [, highBefore] = await vault.priceBand(addrs[0]);

    await sources[0].scalePrice(100_000); // 10x, in one block
    await time.increase(MIN_CHECKPOINT + 1);
    await vault.checkpoint(addrs[0]);

    const [, highAfter] = await vault.priceBand(addrs[0]);
    // priceCapBps is 5%: a 10x spot spike may move the band's high edge by at
    // most one 5% step, never by 10x.
    expect(highAfter).to.be.lte((highBefore * 10_600n) / BPS, "truncation failed");
  });

  it("a spike-and-revert round trip inside one checkpoint window is fully ignored", async () => {
    const fx = await fixture();
    const { vault, sources, addrs } = fx;
    await warmCheckpoints(fx, 4);
    const before = await vault.priceBand(addrs[0]);
    await sources[0].scalePrice(100_000);
    await sources[0].scalePrice(1_000); // back to where it started
    await time.increase(MIN_CHECKPOINT + 1);
    await vault.checkpoint(addrs[0]);
    const after = await vault.priceBand(addrs[0]);
    expect(after[0]).to.equal(before[0]);
    expect(after[1]).to.equal(before[1]);
  });

  it("the persistence check rejects a band that has not held across checkpoints", async () => {
    const fx = await fixture();
    const { vault, alice, sources, addrs } = fx;
    await warmCheckpoints(fx, 8); // buffer full and flat
    expect(await vault.persistenceHolds(addrs[0])).to.equal(true);

    // Sustained, capital-committed pressure: capped 5% steps, held.
    for (let i = 0; i < 3; i++) {
      await sources[0].scalePrice(20_000);
      await time.increase(MIN_CHECKPOINT + 1);
      await vault.checkpoint(addrs[0]);
    }
    expect(await vault.persistenceHolds(addrs[0])).to.equal(false);

    // A basket-moving operation against the unsettled leg is refused.
    await expect(
      vault.connect(alice).mintSingleAsset(addrs[0], 500n * WAD, 0n)
    ).to.be.revertedWithCustomError(vault, "PersistenceCheckFailed");
  });

  it("small operations stay instant — the persistence gate is size-keyed", async () => {
    const fx = await fixture();
    const { vault, alice, sources, addrs } = fx;
    await warmCheckpoints(fx, 8);
    for (let i = 0; i < 3; i++) {
      await sources[0].scalePrice(20_000);
      await time.increase(MIN_CHECKPOINT + 1);
      await vault.checkpoint(addrs[0]);
    }
    expect(await vault.persistenceHolds(addrs[0])).to.equal(false);
    // Under largeOpValueWei (10 ETH), the same call goes through.
    await expect(vault.connect(alice).mintSingleAsset(addrs[0], WAD / 2n, 0n)).to.not.be.reverted;
  });

  it("a checkpoint cannot be spammed inside the minimum interval", async () => {
    const fx = await fixture();
    await warmCheckpoints(fx, 1);
    await expect(fx.vault.checkpoint(fx.addrs[0])).to.be.revertedWithCustomError(
      fx.vault,
      "CheckpointTooSoon"
    );
  });

  // ══ §2.5 — PLANK is never priced by its own spot ════════════════════════

  it("PLANK gets exactly one price path, the same capped band as every other leg", async () => {
    // Constituent 0 stands in for PLANK here. The claim under test is a
    // structural one: there is NO function anywhere on this contract that sets,
    // overrides, or shortcuts a constituent price, for PLANK or anyone else.
    const fx = await fixture();
    const { vault, sources, addrs, alice } = fx;
    const fns = vault.interface.fragments
      .filter((f: any) => f.type === "function" && f.stateMutability !== "view")
      .map((f: any) => f.name.toLowerCase());
    for (const bad of ["setprice", "pushprice", "updateprice", "reportprice", "plank"]) {
      expect(fns.some((n: string) => n.includes(bad))).to.equal(false, `found ${bad}`);
    }

    // The 56.78% holder's move: dump/pump the PLANK/ETH pool and mint against
    // the spot. The capped band means the spot is simply not what gets used.
    await warmCheckpoints(fx, 4);
    const quoteBefore: bigint = await vault
      .connect(alice)
      .mintSingleAsset.staticCall(addrs[0], 100n * WAD, 0n);
    await sources[0].scalePrice(500_000); // 50x spot, one block
    const quoteAfter: bigint = await vault
      .connect(alice)
      .mintSingleAsset.staticCall(addrs[0], 100n * WAD, 0n);
    expect(quoteAfter).to.equal(quoteBefore, "spot leaked into the mint price");
  });

  it("NAV is ETH-denominated end to end — no PLANK exchange rate is a pricing input", async () => {
    const fx = await fixture();
    await warmCheckpoints(fx, 3);
    const [low, high] = await fx.vault.nav();
    // Reserves are 1000@1.0 + 2000@0.5 + 500@2.0 = 3000 ETH, band-widened.
    expect(low).to.be.gte(ethers.parseEther("2900"));
    expect(high).to.be.lte(ethers.parseEther("3100"));
  });

  // ══ §2.8 — the compromised-key anchor rule ══════════════════════════════

  it("ANCHOR RULE: no privileged function can reach reserves already pooled", async () => {
    const fx = await fixture();
    const { vault, vaultAddr, admin, seeder, alice, tokens, addrs } = fx;
    await vault.connect(alice).mintProRata(500n * WAD, maxIn(3));
    await warmCheckpoints(fx, 3);

    const before = await reservesOf(fx);
    const vaultBalBefore = await Promise.all(tokens.map((t) => t.balanceOf(vaultAddr)));

    // Every non-view function on the ABI, called by BOTH privileged roles,
    // with arguments chosen to be as favourable to the attacker as possible.
    const fns = vault.interface.fragments.filter(
      (f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)
    );
    expect(fns.length).to.be.greaterThan(10, "ABI enumeration found nothing");

    const argFor = (t: string): any => {
      if (t === "address") return addrs[0];
      if (t.startsWith("uint")) return 10n ** 24n;
      if (t === "bool") return true;
      if (t === "bytes32") return ethers.encodeBytes32String("concentrationCapBps");
      if (t === "address[]") return addrs;
      if (t.endsWith("[]")) return [0n, 0n, 0n];
      if (t === "string") return "x";
      return 0n;
    };

    for (const who of [admin, seeder]) {
      for (const f of fns as any[]) {
        const args = f.inputs.map((i: any) => argFor(i.type));
        try {
          await (vault.connect(who) as any)[f.format("sighash")](...args);
        } catch {
          /* a guard firing is correct behaviour */
        }
      }
    }

    // Neither role received a single unit of any constituent, and the pooled
    // reserves are exactly where they were.
    for (let i = 0; i < 3; i++) {
      expect(await tokens[i].balanceOf(admin.address)).to.equal(0n, `admin took leg ${i}`);
      expect(await tokens[i].balanceOf(seeder.address)).to.equal(0n, `seeder took leg ${i}`);
      expect(await vault.reserveOf(addrs[i])).to.equal(before[i], `reserve ${i} moved`);
      expect(await tokens[i].balanceOf(vaultAddr)).to.equal(
        vaultBalBefore[i],
        `vault balance ${i} moved`
      );
    }
  });

  it("the seeder has zero privilege the instant the index opens", async () => {
    const fx = await fixture();
    const { vault, seeder, addrs } = fx;
    await expect(
      vault.connect(seeder).seedDeposit(addrs[0], WAD)
    ).to.be.revertedWithCustomError(vault, "IndexAlreadyOpen");
    await expect(vault.connect(seeder).openIndex(10n ** 18n)).to.be.revertedWithCustomError(
      vault,
      "IndexAlreadyOpen"
    );
    await expect(
      vault.connect(seeder).queueParam(ethers.encodeBytes32String("bandBps"), 1n)
    ).to.be.revertedWithCustomError(vault, "NotAdmin");
  });

  it("the vault cannot hold ETH at all — there is no receive and no payable path", async () => {
    const fx = await fixture();
    await expect(
      fx.alice.sendTransaction({ to: fx.vaultAddr, value: WAD })
    ).to.be.reverted;
    const payable = fx.vault.interface.fragments.filter(
      (f: any) => f.type === "function" && f.stateMutability === "payable"
    );
    expect(payable.length).to.equal(0);
  });

  it("a deactivated constituent's reserves stay redeemable and cannot be stranded", async () => {
    const fx = await fixture();
    const { vault, admin, alice, addrs } = fx;
    await vault.connect(alice).mintProRata(200n * WAD, maxIn(3));
    await vault.connect(admin).queueListing(addrs[1], addrs[1], 0, true);
    await time.increase(TIMELOCK + 1);
    await vault.executeListing(addrs[1]);

    // Deactivation zeroes the TARGET weight but never removes the leg from the
    // pro-rata payout set while it still holds value.
    await expect(vault.delistEmpty(addrs[1])).to.be.revertedWithCustomError(
      vault,
      "ReservesOutstanding"
    );
    const [, out] = await vault.previewRedeemProRata(100n * WAD);
    expect(out[1]).to.be.gt(0n, "deactivated leg stopped paying out");
    await expect(vault.connect(alice).redeemProRata(100n * WAD, zeroOut(3))).to.not.be.reverted;
  });

  // ══ §2.7 — timelock ═════════════════════════════════════════════════════

  it("a parameter change is QUEUED, never applied instantly", async () => {
    const fx = await fixture();
    const { vault, admin } = fx;
    const key = ethers.encodeBytes32String("bandBps");
    const before = (await vault.params()).bandBps;

    await vault.connect(admin).queueParam(key, 250n);
    expect((await vault.params()).bandBps).to.equal(before, "applied on queue");
    await expect(vault.executeParam(key)).to.be.revertedWithCustomError(
      vault,
      "TimelockNotElapsed"
    );
    await time.increase(TIMELOCK - 60);
    await expect(vault.executeParam(key)).to.be.revertedWithCustomError(
      vault,
      "TimelockNotElapsed"
    );
    await time.increase(120);
    await vault.executeParam(key);
    expect((await vault.params()).bandBps).to.equal(250n);
  });

  it("the hard parameter ceilings hold even after the timelock elapses", async () => {
    const fx = await fixture();
    const { vault, admin } = fx;
    // Try to raise the concentration cap past its compile-time ceiling (50%)
    // and the imbalance fee past its 10% ceiling.
    for (const [name, value] of [
      ["concentrationCapBps", 9_000n],
      ["maxImbalanceFeeBps", 5_000n],
      ["bandBps", 9_000n],
      ["priceCapBps", 9_000n],
    ] as const) {
      const key = ethers.encodeBytes32String(name);
      await vault.connect(admin).queueParam(key, value);
      await time.increase(TIMELOCK + 1);
      await expect(vault.executeParam(key)).to.be.revertedWithCustomError(vault, "BadParam");
    }
    expect((await vault.params()).concentrationCapBps).to.equal(CONCENTRATION_CAP_BPS);
  });

  it("the timelock delay itself is immutable — it cannot be shortened to zero", async () => {
    const fx = await fixture();
    expect(await fx.vault.timelockDelay()).to.equal(BigInt(TIMELOCK));
    const setters = fx.vault.interface.fragments
      .filter((f: any) => f.type === "function" && f.stateMutability !== "view")
      .map((f: any) => f.name.toLowerCase());
    expect(setters.some((n: string) => n.includes("timelock"))).to.equal(false);
  });

  it("an admin handover is itself timelocked", async () => {
    const fx = await fixture();
    const { vault, admin, bob } = fx;
    await vault.connect(admin).queueAdmin(bob.address);
    expect(await vault.admin()).to.equal(admin.address);
    await expect(vault.executeAdmin()).to.be.revertedWithCustomError(vault, "TimelockNotElapsed");
    await time.increase(TIMELOCK + 1);
    await vault.executeAdmin();
    expect(await vault.admin()).to.equal(bob.address);
  });

  it("a below-floor timelock delay cannot be deployed at all", async () => {
    const [, admin, seeder] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("GlobalIndexVault");
    const { defaultParams, paramsTuple } = await import("./helpers/index-vault");
    await expect(
      Vault.deploy("x", "x", admin.address, seeder.address, 3_600, paramsTuple(defaultParams))
    ).to.be.revertedWithCustomError(Vault, "BadParam");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Interop with the live vault generation
// ══════════════════════════════════════════════════════════════════════════

describe("GlobalIndexVault — real MarketplankVaultV3 constituent", () => {

  // These suites advance the shared Hardhat clock by YEARS (four-year vePLANK
  // locks, month-long weight ramps). Mocha shares one network across files, so
  // without restoring the snapshot afterwards every later suite runs in the
  // future — which silently expires the fixed-endTime Seaport orders in
  // SeaportPerTokenApproval/SeaportCriteriaFulfill. Snapshot in, restore out.
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });
  /**
   * The index is specified to hold v-tokens from the existing N-vault registry
   * (lib/market/vault-registry.ts resolves vaults BY ADDRESS, never a
   * hardcoded pair, and this contract does the same). MarketplankVaultV3
   * already satisfies IIndexPriceSource with no adapter, no wrapper, and no
   * new approval surface — that claim is worth proving rather than asserting,
   * because §2.9's NFTX-zap lesson is precisely that every extra periphery
   * contract users approve is part of the threat model.
   */
  it("prices a real V3 v-token straight off the V3 vault's own reserves", async () => {
    const { deployBeaconMock } = await import("./helpers/beacon");
    const { paramsTuple, defaultParams } = await import("./helpers/index-vault");
    const [, admin, seeder, alice] = await ethers.getSigners();

    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    const beacon: any = await deployBeaconMock();
    const V3 = await ethers.getContractFactory("MarketplankVaultV3");
    const v3: any = await V3.deploy(
      await nft.getAddress(),
      "vROBIN",
      "vROBIN",
      0,
      0,
      0,
      30,
      seeder.address,
      await beacon.getAddress()
    );
    const v3Addr = await v3.getAddress();
    for (let id = 1; id <= 12; id++) {
      await nft.mint(seeder.address, id);
      await nft.connect(seeder).approve(v3Addr, id);
      await v3.connect(seeder).deposit(id);
    }
    await v3.connect(seeder).seedShares(3n * WAD, { value: ethers.parseEther("6") });
    await v3.connect(seeder).openPool();

    const Vault = await ethers.getContractFactory("GlobalIndexVault");
    const index: any = await Vault.deploy(
      "gPLNK",
      "gPLNK",
      admin.address,
      seeder.address,
      TIMELOCK,
      paramsTuple(defaultParams)
    );
    const indexAddr = await index.getAddress();

    // No adapter: the V3 vault IS the price source, and its v-token IS the
    // constituent ERC-20 — they are the same contract.
    await index.connect(seeder).seedConstituent(v3Addr, v3Addr, 10_000);
    await v3.connect(seeder).approve(indexAddr, ethers.MaxUint256);
    await index.connect(seeder).seedDeposit(v3Addr, 5n * WAD);
    await index.connect(seeder).openIndex(5n * WAD);

    const [low, high] = await index.priceBand(v3Addr);
    const spot = ((await v3.ethReserve()) * WAD) / (await v3.shareReserve());
    expect(low).to.be.gt(0n);
    expect(low).to.be.lte(spot);
    expect(high).to.be.gte(spot);

    // And a real basket round trip works end to end against it.
    await v3.connect(seeder).transfer(alice.address, WAD);
    await v3.connect(alice).approve(indexAddr, ethers.MaxUint256);
    const before: bigint = await v3.balanceOf(alice.address);
    await index.connect(alice).mintProRata(WAD, [ethers.MaxUint256]);
    await index.connect(alice).redeemProRata(WAD, [0n]);
    expect(await v3.balanceOf(alice.address)).to.be.lte(before);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  VePlank, and the wall between it and the basket
// ══════════════════════════════════════════════════════════════════════════

describe("VePlank", () => {

  // These suites advance the shared Hardhat clock by YEARS (four-year vePLANK
  // locks, month-long weight ramps). Mocha shares one network across files, so
  // without restoring the snapshot afterwards every later suite runs in the
  // future — which silently expires the fixed-endTime Seaport orders in
  // SeaportPerTokenApproval/SeaportCriteriaFulfill. Snapshot in, restore out.
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });
  const YEAR = 365 * 24 * 3_600;

  async function veFixture() {
    // Deliberately offset past the index fixture's signers (admin/seeder/
    // alice/bob/carol) so the whale can never coincidentally BE a privileged
    // role — that would make the privilege-separation test pass for the wrong
    // reason.
    const all = await ethers.getSigners();
    const [gaugeAdmin, whale, minnow] = [all[6], all[7], all[8]];
    const Plank = await ethers.getContractFactory("MockIndexToken");
    const plank: any = await Plank.deploy("PLANK", "PLANK");
    const Ve = await ethers.getContractFactory("VePlank");
    const ve: any = await Ve.deploy(await plank.getAddress(), gaugeAdmin.address);
    const veAddr = await ve.getAddress();

    // The real distribution: one wallet holds 56.78% of supply.
    await plank.mint(whale.address, 5_678_000n * WAD);
    await plank.mint(minnow.address, 100_000n * WAD);
    await plank.connect(whale).approve(veAddr, ethers.MaxUint256);
    await plank.connect(minnow).approve(veAddr, ethers.MaxUint256);
    return { gaugeAdmin, whale, minnow, plank, ve, veAddr };
  }

  it("voting power decays linearly to zero at unlock", async () => {
    const { ve, whale } = await veFixture();
    const now = await time.latest();
    await ve.connect(whale).createLock(1_000_000n * WAD, now + 4 * YEAR);

    const start: bigint = await ve.balanceOf(whale.address);
    expect(start).to.be.gt(0n);
    await time.increase(2 * YEAR);
    const mid: bigint = await ve.balanceOf(whale.address);
    expect(mid).to.be.lt(start);
    expect(mid).to.be.gt(start / 3n); // roughly half, not a cliff
    await time.increase(2 * YEAR + 10);
    expect(await ve.balanceOf(whale.address)).to.equal(0n);
  });

  it("locked PLANK only ever comes back to its own locker, and only at expiry", async () => {
    const { ve, whale, minnow, plank } = await veFixture();
    const now = await time.latest();
    await ve.connect(whale).createLock(1_000n * WAD, now + 2 * YEAR);
    await expect(ve.connect(whale).withdraw()).to.be.revertedWithCustomError(
      ve,
      "LockNotExpired"
    );
    await expect(ve.connect(minnow).withdraw()).to.be.revertedWithCustomError(ve, "NoLock");
    await time.increase(2 * YEAR + 10);
    const before: bigint = await plank.balanceOf(whale.address);
    await ve.connect(whale).withdraw();
    expect(await plank.balanceOf(whale.address)).to.equal(before + 1_000n * WAD);

    // And no admin path exists over locked PLANK.
    const fns = ve.interface.fragments
      .filter((f: any) => f.type === "function" && f.stateMutability !== "view")
      .map((f: any) => f.name.toLowerCase());
    for (const bad of ["sweep", "rescue", "emergency", "recover", "withdrawfor", "seize"]) {
      expect(fns.some((n: string) => n.includes(bad))).to.equal(false, `found ${bad}`);
    }
  });

  it("gauge weight is contestable: a longer lock out-votes a bigger unlocked one", async () => {
    const { ve, gaugeAdmin, whale, minnow } = await veFixture();
    const gauge = ethers.Wallet.createRandom().address;
    await ve.connect(gaugeAdmin).addGauge(gauge);
    const now = await time.latest();

    await ve.connect(whale).createLock(200_000n * WAD, now + 8 * 7 * 24 * 3_600); // 8 weeks
    await ve.connect(minnow).createLock(100_000n * WAD, now + 4 * YEAR);
    await ve.connect(whale).voteGaugeWeight(gauge, 10_000);
    await ve.connect(minnow).voteGaugeWeight(gauge, 10_000);

    const whaleNow: bigint = await ve.balanceOf(whale.address);
    const minnowNow: bigint = await ve.balanceOf(minnow.address);
    expect(minnowNow).to.be.gt(whaleNow, "a 4-year lock must out-weigh a 2x 8-week lock");
    expect(await ve.gaugeWeight(gauge)).to.be.gt(0n);
  });

  it("gauge weight decays as its voters' locks expire", async () => {
    const { ve, gaugeAdmin, whale } = await veFixture();
    const gauge = ethers.Wallet.createRandom().address;
    await ve.connect(gaugeAdmin).addGauge(gauge);
    const now = await time.latest();
    await ve.connect(whale).createLock(500_000n * WAD, now + YEAR);
    await ve.connect(whale).voteGaugeWeight(gauge, 10_000);

    const w0: bigint = await ve.gaugeWeight(gauge);
    expect(w0).to.be.gt(0n);
    await time.increase(YEAR / 2);
    const w1: bigint = await ve.gaugeWeight(gauge);
    expect(w1).to.be.lt(w0).and.to.be.gt(0n);
    await time.increase(YEAR);
    expect(await ve.gaugeWeight(gauge)).to.equal(0n);
  });

  it("a voter cannot allocate more than 100% of their power", async () => {
    const { ve, gaugeAdmin, whale } = await veFixture();
    const g1 = ethers.Wallet.createRandom().address;
    const g2 = ethers.Wallet.createRandom().address;
    await ve.connect(gaugeAdmin).addGauge(g1);
    await ve.connect(gaugeAdmin).addGauge(g2);
    const now = await time.latest();
    await ve.connect(whale).createLock(1_000n * WAD, now + YEAR);
    await ve.connect(whale).voteGaugeWeight(g1, 7_000);
    await expect(ve.connect(whale).voteGaugeWeight(g2, 4_000)).to.be.revertedWithCustomError(
      ve,
      "AllocationExceeded"
    );
    await ve.connect(whale).voteGaugeWeight(g2, 3_000);
    expect(await ve.userUsedBps(whale.address)).to.equal(10_000n);
  });

  it("re-voting replaces rather than stacks a previous allocation", async () => {
    const { ve, gaugeAdmin, whale } = await veFixture();
    const g = ethers.Wallet.createRandom().address;
    await ve.connect(gaugeAdmin).addGauge(g);
    const now = await time.latest();
    await ve.connect(whale).createLock(1_000n * WAD, now + YEAR);
    await ve.connect(whale).voteGaugeWeight(g, 10_000);
    const full: bigint = await ve.gaugeWeight(g);
    await ve.connect(whale).voteGaugeWeight(g, 5_000);
    const half: bigint = await ve.gaugeWeight(g);
    expect(half * 2n).to.be.closeTo(full, full / 100n);
  });

  // ══ §5.1 — THE closed gap ══════════════════════════════════════════════

  it("PRIVILEGE SEPARATION: a maximally-vePLANK'd whale has no power over the basket", async () => {
    const { ve, gaugeAdmin, whale } = await veFixture();
    const fx = await deployOpenIndex({}, [1000n * WAD, 2000n * WAD, 500n * WAD]);
    const { vault, addrs } = fx;

    // The whale locks its entire 56.78% for the maximum four years and votes
    // every gauge to 100% — the strongest position the ve system can produce.
    const now = await time.latest();
    await ve.connect(whale).createLock(5_678_000n * WAD, now + 4 * YEAR);
    for (const a of addrs) {
      await ve.connect(gaugeAdmin).addGauge(a);
    }
    await ve.connect(whale).voteGaugeWeight(addrs[0], 10_000);
    expect(await ve.balanceOf(whale.address)).to.be.gt(0n);
    expect(await ve.gaugeWeight(addrs[0])).to.be.gt(0n);

    // Now: every privileged basket function, called by that whale.
    const adminFns = [
      ["queueParam", [ethers.encodeBytes32String("bandBps"), 1n]],
      ["queueMetric", [addrs[0], 10n ** 24n]],
      ["queueListing", [addrs[0], addrs[0], 5_000n, true]],
      ["queueAdmin", [whale.address]],
    ] as const;
    for (const [name, args] of adminFns) {
      await expect(
        (vault.connect(whale) as any)[name](...args),
        name
      ).to.be.revertedWithCustomError(vault, "NotAdmin");
    }
    await expect(
      vault.connect(whale).seedConstituent(addrs[0], addrs[0], 1_000)
    ).to.be.revertedWithCustomError(vault, "NotSeeder");
    await expect(vault.connect(whale).openIndex(10n ** 18n)).to.be.revertedWithCustomError(
      vault,
      "NotSeeder"
    );

    // Nothing moved, and admin is still admin.
    expect(await vault.admin()).to.equal(fx.admin.address);
    expect((await vault.params()).concentrationCapBps).to.equal(CONCENTRATION_CAP_BPS);
  });

  it("STRUCTURAL: neither contract references the other, in either direction", async () => {
    const fx = await deployOpenIndex({}, [1000n * WAD, 2000n * WAD, 500n * WAD]);
    const { ve } = await veFixture();

    // No vault function names, or takes an argument named after, any ve/gauge
    // concept — there is no lever to reach, not merely a guard to pass.
    for (const f of fx.vault.interface.fragments.filter((x: any) => x.type === "function") as any[]) {
      const blob = (f.name + " " + f.inputs.map((i: any) => i.name).join(" ")).toLowerCase();
      for (const bad of ["gauge", "veplank", "escrow", "vote", "plank"]) {
        expect(blob.includes(bad)).to.equal(false, `vault.${f.name} mentions ${bad}`);
      }
    }
    // ...and symmetrically, VePlank knows nothing about the basket.
    for (const f of ve.interface.fragments.filter((x: any) => x.type === "function") as any[]) {
      const blob = (f.name + " " + f.inputs.map((i: any) => i.name).join(" ")).toLowerCase();
      for (const bad of ["index", "basket", "constituent", "reserve", "redeem"]) {
        expect(blob.includes(bad)).to.equal(false, `ve.${f.name} mentions ${bad}`);
      }
    }

    // The vault's deployed bytecode contains no reference to the VePlank
    // address, because it was never given one.
    const code = await ethers.provider.getCode(fx.vaultAddr);
    expect(code.toLowerCase()).to.not.include(
      (await ve.getAddress()).slice(2).toLowerCase()
    );
  });
});
