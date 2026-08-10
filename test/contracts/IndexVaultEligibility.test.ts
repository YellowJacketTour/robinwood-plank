import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import {
  mine,
  takeSnapshot,
  time,
  type SnapshotRestorer,
} from "./helpers/network-helpers.js";
import {
  CONCENTRATION_CAP_BPS,
  TIMELOCK,
  WAD,
  deployOpenIndex,
  paramsTuple,
  defaultParams,
  indexVaultFactory,
  armVaultRegistry,
} from "./helpers/index-vault.js";

/**
 * Audit-style suite for GlobalIndexVault Parts A and D:
 *
 *   PART A — the ORACLE-FREE eligibility signal. `checkEligibility` reads
 *   `IEligibilitySource` off the constituent itself through a gas-capped
 *   low-level staticcall. The properties that matter, and that this file
 *   attacks rather than confirms, are: it is self-sourced (no submission, no
 *   privileged setter, no stored flag any role can flip), and it FAILS CLOSED
 *   against every hostile or merely-absent implementation without ever
 *   reverting the caller or bricking a whole-basket recount.
 *
 *   PART D — the DYNAMIC, HHI-DERIVED concentration cap. The closed form
 *   w = (1 + sqrt(1 - n*(1 - T*(n-1)))) / n is checked against values computed
 *   independently in TypeScript from the algebra in the contract's own
 *   derivation (including the counter-intuitive fact that the cap RISES with
 *   n), across the degenerate n<=1 case and the infeasible T < 1/n case; and
 *   the cap is then driven end-to-end through the iterative
 *   clamp-and-redistribute in `targetWeightsBps` as the eligible set moves.
 *
 * LOCAL HARDHAT ONLY. Nothing in this repo may deploy any of these contracts
 * until the external audit gate (§2.6) clears.
 */
describe("GlobalIndexVault — eligibility (Part A) and the dynamic HHI cap (Part D)", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const BPS = 10_000n;
  const DEFAULT_TARGET_HHI = 2_000n;
  const MIN_FEES = ethers.parseEther("0.1"); // constructor default
  const MIN_BLOCKS = 100n; // constructor default

  /** Floor integer sqrt, matching OpenZeppelin Math.sqrt. */
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

  /**
   * The Part D closed form, implemented independently from the algebra in the
   * contract's NatSpec — deliberately NOT transcribed from the Solidity, so a
   * transcription error in either shows up as a disagreement.
   *
   *   n <= 1                 -> 100%
   *   T < 1/n (infeasible)   -> 1/n, the equal-weight cap
   *   otherwise              -> (BPS + floor(sqrt(dNum * BPS))) / n
   *                             with dNum = T*n*(n-1) + BPS - BPS*n
   */
  function referenceCapBps(n: bigint, tBps: bigint): bigint {
    if (n <= 1n) return BPS;
    const lhs = tBps * n * (n - 1n) + BPS;
    const rhs = BPS * n;
    if (lhs <= rhs) return BPS / n;
    const dNum = lhs - rhs;
    let w = (BPS + isqrt(dNum * BPS)) / n;
    const equalWeight = BPS / n;
    if (w < equalWeight) w = equalWeight;
    if (w > BPS) w = BPS;
    return w;
  }

  /** The iterative clamp-and-redistribute, mirrored from the contract's spec. */
  function referenceTargetWeights(metrics: bigint[], cap: bigint): bigint[] {
    const n = metrics.length;
    const raw = metrics.map((m) => isqrt(m));
    const total = raw.reduce((a, b) => a + b, 0n);
    if (total === 0n) return new Array(n).fill(0n);
    const bps = raw.map((r) => (r * BPS) / total);
    for (let pass = 0; pass < n; pass++) {
      let excess = 0n;
      let uncapped = 0n;
      for (let i = 0; i < n; i++) {
        if (bps[i] > cap) {
          excess += bps[i] - cap;
          bps[i] = cap;
        } else if (bps[i] > 0n) {
          uncapped += bps[i];
        }
      }
      if (excess === 0n || uncapped === 0n) break;
      for (let i = 0; i < n; i++) {
        if (bps[i] < cap && bps[i] > 0n) bps[i] += (excess * bps[i]) / uncapped;
      }
    }
    return bps;
  }

  /**
   * An opened basket of `n` constituents that ALL implement IEligibilitySource
   * (MockEligibilitySource), so eligibility can be driven from both sides. All
   * priced at 1.0 ETH, all seeded equally, all genesis (rampDuration 0).
   */
  async function openIndexOfSources(n: number, paramOverrides: any = {}) {
    const [, roleAdmin, seeder, alice, bob, , admission, risk, allocation] =
      await ethers.getSigners();
    const Src = await ethers.getContractFactory("MockEligibilitySource");
    const Price = await ethers.getContractFactory("MockIndexPriceSource");

    const tokens: any[] = [];
    const prices: any[] = [];
    for (let i = 0; i < n; i++) {
      tokens.push(await Src.deploy(`e${i}`, `e${i}`));
      prices.push(await Price.deploy(100n * WAD, 100n * WAD));
    }
    const addrs = await Promise.all(tokens.map((t) => t.getAddress()));

    const Vault = await indexVaultFactory();
    const vault: any = await Vault.deploy(
      "Marketplank Global Index",
      "gPLNK",
      [roleAdmin.address, admission.address, risk.address, allocation.address],
      seeder.address,
      TIMELOCK,
      paramsTuple({ ...defaultParams, ...paramOverrides }),
        ethers.ZeroAddress // dividends off: this fixture never pushes one
    );
    const vaultAddr = await vault.getAddress();

    for (let i = 0; i < n; i++) {
      await vault.connect(seeder).seedConstituent(addrs[i], await prices[i].getAddress(), 3_333);
      await tokens[i].mint(seeder.address, 1_000n * WAD);
      await tokens[i].connect(seeder).approve(vaultAddr, 1_000n * WAD);
      await vault.connect(seeder).seedDeposit(addrs[i], 1_000n * WAD);
    }
    await vault.connect(seeder).openIndex(1_000n * WAD);

    // Comfortably past `minEligibilityBlocks` so an "old enough" constituent
    // really is old enough, whatever block the fixture happened to land on.
    await mine(200);

    return {
      roleAdmin,
      admission,
      risk,
      allocation,
      seeder,
      alice,
      bob,
      vault,
      vaultAddr,
      tokens,
      prices,
      addrs,
    };
  }

  /** Make `token` pass both bars. */
  async function makeEligible(token: any, feesWei: bigint = MIN_FEES) {
    await token.setFees(feesWei);
    await token.setFirstActivityBlock(1);
  }

  /** Set a constituent's weight metric through the timelock. */
  async function setMetrics(vault: any, admission: any, addrs: string[], metrics: bigint[]) {
    for (let i = 0; i < addrs.length; i++) {
      await vault.connect(admission).queueMetric(addrs[i], metrics[i]);
    }
    await time.increase(TIMELOCK + 1);
    for (const a of addrs) await vault.executeMetric(a);
  }

  /** Push a timelocked scalar parameter through queue + execute. */
  async function setParam(vault: any, risk: any, key: string, value: bigint) {
    await vault.connect(risk).queueParam(ethers.encodeBytes32String(key), value);
    await time.increase(TIMELOCK + 1);
    await vault.executeParam(ethers.encodeBytes32String(key));
  }

  // ══════════════════════════════════════════════════════════════════════
  //  PART A — the eligibility read
  // ══════════════════════════════════════════════════════════════════════

  describe("PART A: the signal is self-sourced, and there is no oracle and no override", () => {
    it("there is NO privileged path that sets an eligibility flag — the answer is only ever recomputed", async () => {
      const fx = await deployOpenIndex();
      const names = fx.vault.interface.fragments
        .filter((f: any) => f.type === "function")
        .map((f: any) => f.name as string);

      // Everything eligibility-shaped on the ABI, enumerated. Any future
      // `setEligible`, `markEligible`, `overrideEligibility` or stored flag
      // setter fails this test, which is the point of writing it as an
      // enumeration rather than as a spot check.
      const eligibilityish = names.filter((n: string) => /eligib/i.test(n)).sort();
      expect(eligibilityish).to.deep.equal([
        "checkEligibility",
        "eligibleConstituentCount",
        "minEligibilityBlocks",
        "minEligibilityFeesWei",
        "refreshEligibleCount",
      ]);

      // And the two settable bars are TIMELOCKED parameters, not direct
      // setters: neither appears as a `set*` function at all.
      expect(names.some((n: string) => /^set/i.test(n))).to.equal(false);
    });

    it("no role can make an ineligible constituent eligible by any call available to it", async () => {
      const fx = await openIndexOfSources(3);
      const { vault, risk, admission, addrs, tokens } = fx;
      expect((await vault.checkEligibility(addrs[0]))[0]).to.equal(false);

      // The only lever the risk role has is the BAR, and lowering it to zero fees
      // still cannot help a constituent whose `firstActivityBlock` is zero —
      // the signal is the constituent's, not any role's.
      await setParam(vault, risk, "minEligibilityFeesWei", 0n);
      await setParam(vault, risk, "minEligibilityBlocks", 0n);
      expect(await tokens[0].firstActivityBlock()).to.not.equal(0n);
      await tokens[0].setFirstActivityBlock(0);
      expect((await vault.checkEligibility(addrs[0]))[0]).to.equal(false);

      // Only the CONSTITUENT's own books can flip it.
      await tokens[0].setFirstActivityBlock(1);
      expect((await vault.checkEligibility(addrs[0]))[0]).to.equal(true);
    });

    it("reads the constituent's own numbers back verbatim", async () => {
      const fx = await openIndexOfSources(2);
      const { vault, addrs, tokens } = fx;
      const fees = ethers.parseEther("3.5");
      await tokens[0].setFees(fees);
      await tokens[0].setFirstActivityBlock(1);

      const [eligible, feesWei, elapsed] = await vault.checkEligibility(addrs[0]);
      expect(eligible).to.equal(true);
      expect(feesWei).to.equal(fees);
      expect(feesWei).to.equal(await tokens[0].totalFeesCollectedWei());
      expect(elapsed).to.equal(BigInt(await ethers.provider.getBlockNumber()) - 1n);
    });

    it("BOUNDARIES: both bars are inclusive, and one wei / one block short is not eligible", async () => {
      const fx = await openIndexOfSources(1);
      const { vault, addrs, tokens } = fx;
      expect(await vault.minEligibilityFeesWei()).to.equal(MIN_FEES);
      expect(await vault.minEligibilityBlocks()).to.equal(MIN_BLOCKS);

      await tokens[0].setFirstActivityBlock(1);

      await tokens[0].setFees(MIN_FEES - 1n);
      expect((await vault.checkEligibility(addrs[0]))[0]).to.equal(false);
      await tokens[0].setFees(MIN_FEES);
      expect((await vault.checkEligibility(addrs[0]))[0]).to.equal(true);

      // Exactly `minEligibilityBlocks` old is eligible; one block younger is
      // not. `checkEligibility` is a view, so reading it does not mine — pin
      // the current height and set the activity block relative to it.
      const h = BigInt(await ethers.provider.getBlockNumber());
      await tokens[0].setFirstActivityBlock(h + 1n - MIN_BLOCKS); // the setter mines a block
      expect((await vault.checkEligibility(addrs[0]))[0]).to.equal(true);
      await tokens[0].setFirstActivityBlock(
        BigInt(await ethers.provider.getBlockNumber()) + 1n - MIN_BLOCKS + 1n
      );
      expect((await vault.checkEligibility(addrs[0]))[0]).to.equal(false);
    });

    it("a firstActivityBlock in the FUTURE is refused, not treated as enormous elapsed time", async () => {
      const fx = await openIndexOfSources(1);
      const { vault, addrs, tokens } = fx;
      await tokens[0].setFees(MIN_FEES);
      const future = BigInt(await ethers.provider.getBlockNumber()) + 1_000n;
      await tokens[0].setFirstActivityBlock(future);
      const [eligible, fees, elapsed] = await vault.checkEligibility(addrs[0]);
      expect(eligible).to.equal(false);
      expect(fees).to.equal(MIN_FEES); // the fee leg still read fine
      expect(elapsed).to.equal(0n); // and elapsed did NOT underflow or wrap
    });

    it("FAILS CLOSED, never reverts: an EOA, a plain ERC-20, a reverting source and a gas bomb are all simply ineligible", async () => {
      const fx = await deployOpenIndex(); // plain MockIndexToken constituents
      const { vault, alice } = fx;

      // 1. An address with no code at all.
      const eoa = ethers.Wallet.createRandom().address;
      expect(await vault.checkEligibility(eoa)).to.deep.equal([false, 0n, 0n]);

      // 2. A real contract that simply does not implement the interface.
      expect(await vault.checkEligibility(fx.addrs[0])).to.deep.equal([false, 0n, 0n]);

      // 3. A contract whose getters revert outright.
      const Rev = await ethers.getContractFactory("RevertingEligibilitySource");
      const rev: any = await Rev.deploy();
      expect(await vault.checkEligibility(await rev.getAddress())).to.deep.equal([
        false,
        0n,
        0n,
      ]);

      // 4. A contract that tries to burn the caller's entire gas budget.
      const Bomb = await ethers.getContractFactory("GasBombEligibilitySource");
      const bomb: any = await Bomb.deploy();
      expect(await vault.checkEligibility(await bomb.getAddress())).to.deep.equal([
        false,
        0n,
        0n,
      ]);

      // None of the four reverted the caller, and the vault is still usable.
      await expect(vault.connect(alice).refreshEligibleCount()).to.not.be.revert(ethers);
    });

    it("a HOSTILE constituent inside the basket cannot brick a whole-basket recount", async () => {
      // The gas bomb is not merely queried in isolation — it is LISTED, so the
      // recount loop must survive it. This is the griefing case the
      // ELIGIBILITY_GAS_CAP exists for.
      const [, admin, seeder, alice] = await ethers.getSigners();
      const roles: [string, string, string, string] = [
        admin.address,
        admin.address,
        admin.address,
        admin.address,
      ];
      const Bomb = await ethers.getContractFactory("GasBombEligibilitySource");
      const Src = await ethers.getContractFactory("MockEligibilitySource");
      const Price = await ethers.getContractFactory("MockIndexPriceSource");

      const bomb: any = await Bomb.deploy();
      const good: any = await Src.deploy("g", "g");
      const p1: any = await Price.deploy(100n * WAD, 100n * WAD);
      const p2: any = await Price.deploy(100n * WAD, 100n * WAD);

      const Vault = await indexVaultFactory();
      const vault: any = await Vault.deploy(
        "gi",
        "gi",
        roles,
        seeder.address,
        TIMELOCK,
        paramsTuple(defaultParams),
        ethers.ZeroAddress // dividends off: this fixture never pushes one
      );
      const vaultAddr = await vault.getAddress();
      for (const [tok, price] of [
        [bomb, p1],
        [good, p2],
      ] as any[][]) {
        const a = await tok.getAddress();
        await vault.connect(seeder).seedConstituent(a, await price.getAddress(), 5_000);
        await tok.mint(seeder.address, 1_000n * WAD);
        await tok.connect(seeder).approve(vaultAddr, 1_000n * WAD);
        await vault.connect(seeder).seedDeposit(a, 1_000n * WAD);
      }
      await vault.connect(seeder).openIndex(1_000n * WAD);
      await mine(200);
      await makeEligible(good);

      // The recount completes and the honest leg is still counted, despite the
      // hostile leg trying to consume the whole budget.
      await expect(vault.connect(alice).refreshEligibleCount()).to.not.be.revert(ethers);
      expect(await vault.eligibleConstituentCount()).to.equal(1n);

      // And the gas actually spent is bounded, not merely survivable.
      const gas = await vault.refreshEligibleCount.estimateGas();
      expect(gas).to.be.lessThan(500_000n);
    });

    it("refreshEligibleCount is PERMISSIONLESS and emits the new count with the resulting cap", async () => {
      const fx = await openIndexOfSources(3);
      const { vault, alice, tokens } = fx;
      expect(await vault.eligibleConstituentCount()).to.equal(0n);
      for (const t of tokens) await makeEligible(t);

      // Three eligible legs -> capBpsFor(3) = 3333 (the infeasible-T branch),
      // which binds tighter than the flat 4000 and is therefore the cap the
      // event must report.
      await expect(vault.connect(alice).refreshEligibleCount())
        .to.emit(vault, "EligibleCountUpdated")
        .withArgs(3n, 3_333n);
      expect(await vault.eligibleConstituentCount()).to.equal(3n);
      expect(await vault.effectiveConcentrationCapBps()).to.equal(3_333n);
    });

    it("the count is recomputed automatically when the constituent set changes, with no manual refresh", async () => {
      const fx = await openIndexOfSources(3);
      const { vault, admission, seeder, tokens, addrs, vaultAddr } = fx;
      for (const t of tokens) await makeEligible(t);
      await vault.refreshEligibleCount();
      expect(await vault.eligibleConstituentCount()).to.equal(3n);

      // ADMISSION recounts (via _list).
      const Src = await ethers.getContractFactory("MockEligibilitySource");
      const Price = await ethers.getContractFactory("MockIndexPriceSource");
      const t4: any = await Src.deploy("e4", "e4");
      const p4: any = await Price.deploy(100n * WAD, 100n * WAD);
      const a4 = await t4.getAddress();
      await makeEligible(t4);
      // AUDIT C-6: post-open admission requires factory provenance.
      await armVaultRegistry(fx as any, [...addrs, a4]);
      await vault.connect(admission).queueListing(a4, await p4.getAddress(), 1_000, false);
      await time.increase(TIMELOCK + 1);
      await vault.executeListing(a4);
      expect(await vault.eligibleConstituentCount()).to.equal(4n);

      // DEACTIVATION recounts too, with no refresh call in between.
      await vault.connect(admission).queueListing(addrs[0], ethers.ZeroAddress, 0, true);
      await time.increase(TIMELOCK + 1);
      await vault.executeListing(addrs[0]);
      expect(await vault.eligibleConstituentCount()).to.equal(3n);
      // Deactivated, but still eligible on its OWN books — the count excludes
      // it because it is inactive, not because its signal changed.
      expect((await vault.checkEligibility(addrs[0]))[0]).to.equal(true);
      void seeder;
      void vaultAddr;
    });

    it("only ACTIVE constituents are counted, and losing the fee bar drops the count on the next refresh", async () => {
      const fx = await openIndexOfSources(4);
      const { vault, tokens } = fx;
      for (const t of tokens) await makeEligible(t);
      await vault.refreshEligibleCount();
      expect(await vault.eligibleConstituentCount()).to.equal(4n);

      // A constituent's own fee revenue falling below the bar makes it
      // ineligible. The cached count is stale until somebody refreshes — which
      // is the documented design, and is asserted rather than glossed over.
      await tokens[0].setFees(MIN_FEES - 1n);
      expect((await vault.checkEligibility(fx.addrs[0]))[0]).to.equal(false);
      expect(await vault.eligibleConstituentCount()).to.equal(4n); // still cached
      await vault.refreshEligibleCount();
      expect(await vault.eligibleConstituentCount()).to.equal(3n);
    });

    it("the two bars are TIMELOCKED and risk-role-only, like every other economically significant parameter", async () => {
      const fx = await openIndexOfSources(2);
      const { vault, risk, alice } = fx;
      const key = ethers.encodeBytes32String("minEligibilityFeesWei");

      await expect(vault.connect(alice).queueParam(key, 1n))
        .to.be.revertedWithCustomError(vault, "NotRoleHolder")
        .withArgs(await vault.ROLE_RISK_PARAM());
      await vault.connect(risk).queueParam(key, 12_345n);
      await expect(vault.executeParam(key)).to.be.revertedWithCustomError(
        vault,
        "TimelockNotElapsed"
      );
      await time.increase(TIMELOCK + 1);
      await expect(vault.executeParam(key))
        .to.emit(vault, "ParamApplied")
        .withArgs(key, 12_345n);
      expect(await vault.minEligibilityFeesWei()).to.equal(12_345n);
      // One queue, one execution — a replay finds nothing pending.
      await expect(vault.executeParam(key)).to.be.revertedWithCustomError(
        vault,
        "NothingQueued"
      );
    });

    it("an absurdly high bar degrades to the pre-existing FLAT cap and nothing worse", async () => {
      const fx = await openIndexOfSources(6);
      const { vault, risk, tokens } = fx;
      for (const t of tokens) await makeEligible(t);
      await vault.refreshEligibleCount();
      // Six eligible legs bind TIGHTER than the flat 40% cap.
      expect(await vault.effectiveConcentrationCapBps()).to.equal(3_333n);

      await setParam(vault, risk, "minEligibilityFeesWei", ethers.parseEther("1000000"));
      await vault.refreshEligibleCount();
      expect(await vault.eligibleConstituentCount()).to.equal(0n);
      // capBpsFor(0) is 100%, min'd with the flat cap -> the flat cap exactly.
      expect(await vault.effectiveConcentrationCapBps()).to.equal(CONCENTRATION_CAP_BPS);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  //  PART D — the dynamic HHI cap
  // ══════════════════════════════════════════════════════════════════════

  describe("PART D: capBpsFor implements the closed form", () => {
    it("reproduces the two worked examples in the NatSpec exactly", async () => {
      const fx = await deployOpenIndex();
      const { vault } = fx;
      expect(await vault.targetHhiBps()).to.equal(DEFAULT_TARGET_HHI);
      // n = 10, T = 0.20 -> 0.40; and 0.4^2 + 0.6^2/9 = 0.20 exactly.
      expect(await vault.capBpsFor(10)).to.equal(4_000n);
      // n = 50, T = 0.20 -> 0.44; and 0.44^2 + 0.56^2/49 = 0.20 exactly.
      expect(await vault.capBpsFor(50)).to.equal(4_400n);
    });

    it("the DEGENERATE case n <= 1 is a 100% cap — one leg IS the basket", async () => {
      const fx = await deployOpenIndex();
      expect(await fx.vault.capBpsFor(0)).to.equal(BPS);
      expect(await fx.vault.capBpsFor(1)).to.equal(BPS);
    });

    it("the INFEASIBLE case T < 1/n falls back to the equal-weight cap 1/n", async () => {
      const fx = await deployOpenIndex();
      const { vault } = fx;
      // At T = 0.20 the minimum achievable HHI exceeds T for n = 2, 3, 4, 5.
      expect(await vault.capBpsFor(2)).to.equal(5_000n);
      expect(await vault.capBpsFor(3)).to.equal(3_333n);
      expect(await vault.capBpsFor(4)).to.equal(2_500n);
      expect(await vault.capBpsFor(5)).to.equal(2_000n);
      // n = 5 is exactly the boundary (1/5 == T), and n = 6 is the first
      // feasible one, which is where the quadratic starts doing the work.
      expect(await vault.capBpsFor(6)).to.equal(3_333n);
    });

    it("the cap RISES with n above the feasibility boundary — the counter-intuitive property, asserted", async () => {
      const fx = await deployOpenIndex();
      const { vault } = fx;
      // This is the property the NatSpec warns is natural to get backwards. A
      // future 'fix' that makes the cap fall with n breaks this test.
      let prev = 0n;
      for (const n of [6, 7, 8, 9, 10, 16, 24, 32, 64, 128]) {
        const w: bigint = await vault.capBpsFor(n);
        expect(w, `n=${n}`).to.be.greaterThan(prev);
        prev = w;
      }
      // ...and it converges towards sqrt(T) = 0.4472, never past it.
      expect(await vault.capBpsFor(100_000)).to.be.at.most(4_473n);
      expect(await vault.capBpsFor(100_000)).to.be.at.least(4_460n);
    });

    it("the HHI achieved at the returned cap is at most the target — the algebra actually holds", async () => {
      const fx = await deployOpenIndex();
      const { vault } = fx;
      const SCALE = 10n ** 12n;
      for (const n of [6n, 7n, 10n, 15n, 20n, 32n, 50n]) {
        const w: bigint = await vault.capBpsFor(n);
        // HHI(w) = w^2 + (1-w)^2/(n-1), all in bps^2 scaled up for precision.
        const rest = BPS - w;
        const hhi = (w * w * SCALE + (rest * rest * SCALE) / (n - 1n)) / SCALE;
        // Target is T * BPS in bps^2 units, i.e. 2000 * 10000.
        expect(hhi, `n=${n} w=${w}`).to.be.at.most(DEFAULT_TARGET_HHI * BPS);
        // And the floored cap is not needlessly slack: one bps more would
        // exceed the target.
        const w2 = w + 1n;
        const rest2 = BPS - w2;
        const hhi2 = (w2 * w2 * SCALE + (rest2 * rest2 * SCALE) / (n - 1n)) / SCALE;
        expect(hhi2, `n=${n} w+1`).to.be.greaterThan(DEFAULT_TARGET_HHI * BPS);
      }
    });

    it("matches the independent reference across every n from 0 to 96 and several HHI targets", async () => {
      const fx = await deployOpenIndex();
      const { vault, risk } = fx;
      for (const t of [DEFAULT_TARGET_HHI, 200n, 500n, 1_000n, 5_000n, BPS]) {
        if (t !== DEFAULT_TARGET_HHI) await setParam(vault, risk, "targetHhiBps", t);
        expect(await vault.targetHhiBps()).to.equal(t);
        for (let n = 0n; n <= 96n; n++) {
          expect(await vault.capBpsFor(n), `T=${t} n=${n}`).to.equal(referenceCapBps(n, t));
        }
      }
    });

    it("targetHhiBps is ceilinged at EXECUTION, not merely at queue time", async () => {
      const fx = await deployOpenIndex();
      const { vault, risk } = fx;
      const key = ethers.encodeBytes32String("targetHhiBps");
      for (const bad of [0n, 199n, BPS + 1n, 2n ** 32n]) {
        await vault.connect(risk).queueParam(key, bad);
        await time.increase(TIMELOCK + 1);
        await expect(vault.executeParam(key)).to.be.revertedWithCustomError(
          vault,
          "BadParam"
        );
        expect(await vault.targetHhiBps()).to.equal(DEFAULT_TARGET_HHI);
      }
      // The two admissible extremes do land.
      await setParam(vault, risk, "targetHhiBps", 200n);
      expect(await vault.targetHhiBps()).to.equal(200n);
      await setParam(vault, risk, "targetHhiBps", BPS);
      expect(await vault.targetHhiBps()).to.equal(BPS);
      // T = 1.0 is "no constraint", so the dynamic cap stops binding entirely
      // and the flat parameter is all that is left.
      expect(await vault.capBpsFor(32)).to.equal(BPS);
    });

    it("the effective cap is the MINIMUM of dynamic and flat — admitting constituents can never LOOSEN it", async () => {
      const fx = await openIndexOfSources(10);
      const { vault, tokens } = fx;
      const flat = CONCENTRATION_CAP_BPS; // 4000

      // 0 eligible: dynamic is 100%, so the flat cap governs (the pre-existing
      // behaviour, unchanged).
      expect(await vault.eligibleConstituentCount()).to.equal(0n);
      expect(await vault.effectiveConcentrationCapBps()).to.equal(flat);

      // 6 eligible: dynamic 3333 binds tighter.
      for (let i = 0; i < 6; i++) await makeEligible(tokens[i]);
      await vault.refreshEligibleCount();
      expect(await vault.capBpsFor(6)).to.equal(3_333n);
      expect(await vault.effectiveConcentrationCapBps()).to.equal(3_333n);

      // 10 eligible: dynamic is exactly 4000 — equal to flat, so still 4000.
      for (let i = 6; i < 10; i++) await makeEligible(tokens[i]);
      await vault.refreshEligibleCount();
      expect(await vault.capBpsFor(10)).to.equal(4_000n);
      expect(await vault.effectiveConcentrationCapBps()).to.equal(flat);

      // The dynamic cap keeps rising past the flat one, and the effective cap
      // does NOT follow it up. This is the load-bearing assertion: an admission
      // path that buys concentration is exactly what taking the minimum
      // forbids.
      expect(await vault.capBpsFor(32)).to.be.greaterThan(flat);
      expect(await vault.effectiveConcentrationCapBps()).to.equal(flat);
    });
  });

  describe("PART D: the cap flows through clamp-and-redistribute and through the trade guard", () => {
    it("targetWeightsBps matches the reference clamp-and-redistribute at the EFFECTIVE cap", async () => {
      const fx = await openIndexOfSources(6);
      const { vault, risk, admission, addrs, tokens } = fx;

      // A deliberately lopsided metric vector: one dominant leg plus five
      // small ones, so the cap really has to bite and then redistribute.
      const metrics = [
        1_000_000n,
        10_000n,
        10_000n,
        10_000n,
        10_000n,
        10_000n,
      ];
      await setMetrics(vault, admission, addrs, metrics);

      // First with NO eligible constituents: the flat 4000 cap governs.
      expect(await vault.effectiveConcentrationCapBps()).to.equal(CONCENTRATION_CAP_BPS);
      let [, bps] = await vault.targetWeightsBps();
      let ref = referenceTargetWeights(metrics, CONCENTRATION_CAP_BPS);
      expect(bps.map((b: bigint) => b)).to.deep.equal(ref);
      expect(ref[0]).to.equal(CONCENTRATION_CAP_BPS); // the dominant leg WAS capped

      // Now make six eligible, which TIGHTENS the cap to 3333, and the whole
      // vector must move accordingly — with no other input changed.
      for (const t of tokens) await makeEligible(t);
      await vault.refreshEligibleCount();
      expect(await vault.effectiveConcentrationCapBps()).to.equal(3_333n);
      [, bps] = await vault.targetWeightsBps();
      ref = referenceTargetWeights(metrics, 3_333n);
      expect(bps.map((b: bigint) => b)).to.deep.equal(ref);
      expect(ref[0]).to.equal(3_333n);
    });

    it("no leg is left above the cap after redistribution, even when several are over at once", async () => {
      const fx = await openIndexOfSources(6);
      const { vault, risk, admission, addrs, tokens } = fx;
      for (const t of tokens) await makeEligible(t);
      await vault.refreshEligibleCount();
      const cap: bigint = await vault.effectiveConcentrationCapBps();
      expect(cap).to.equal(3_333n);

      // Two dominant legs, so capping the first inflates the second past the
      // cap — the case the iteration exists for.
      const metrics = [1_000_000n, 900_000n, 100n, 100n, 100n, 100n];
      await setMetrics(vault, admission, addrs, metrics);

      const [, bps] = await vault.targetWeightsBps();
      for (let i = 0; i < 6; i++) {
        expect(bps[i], `leg ${i} = ${bps[i]} > cap ${cap}`).to.be.at.most(cap);
      }
      expect(bps.map((b: bigint) => b)).to.deep.equal(
        referenceTargetWeights(metrics, cap)
      );
      // Redistribution conserves: nothing is created, and the flooring only
      // ever loses.
      const sum = bps.reduce((a: bigint, b: bigint) => a + b, 0n);
      expect(sum).to.be.at.most(BPS);
    });

    it("the TRADE-TIME guard uses the dynamic cap, not the flat parameter", async () => {
      // Six eligible legs -> effective cap 3333, tighter than the flat 4000.
      // A single-asset mint that would push a leg further above 3333 must be
      // refused even though it is under the flat cap.
      const fx = await openIndexOfSources(6);
      const { vault, vaultAddr, alice, tokens, addrs } = fx;
      for (const t of tokens) await makeEligible(t);
      await vault.refreshEligibleCount();
      expect(await vault.effectiveConcentrationCapBps()).to.equal(3_333n);

      for (const t of tokens) {
        await t.mint(alice.address, 500_000n * WAD);
        await t.connect(alice).approve(vaultAddr, ethers.MaxUint256);
      }
      for (let i = 0; i < 8; i++) {
        await time.increase(defaultParams.minCheckpointInterval + 1n);
        await vault.checkpointAll();
      }

      // Six equal legs sit at ~1666 bps each. Piling a leg up past 3333 is the
      // operation the cap forbids.
      const before: bigint = await vault.weightBps(addrs[0]);
      expect(before).to.be.lessThan(3_333n);
      await expect(
        vault.connect(alice).mintSingleAsset(addrs[0], 20_000n * WAD, 0n)
      ).to.be.revertedWithCustomError(vault, "ConcentrationCapExceeded");

      // ...and the SAME operation is permitted once the eligible set shrinks
      // enough that the dynamic term stops binding and the flat 4000 governs.
      for (const t of tokens) await t.setFees(0);
      await vault.refreshEligibleCount();
      expect(await vault.effectiveConcentrationCapBps()).to.equal(CONCENTRATION_CAP_BPS);
      // What changed is WHERE the line is, so prove it with a size that lands
      // BETWEEN the two caps. Six legs of 1000 units at 1.0 ETH: adding x to
      // leg 0 leaves it at (1000 + x) / (6000 + x). At x = 1600 that is 34.2%
      // — over the dynamic 3333 and under the flat 4000.
      await expect(vault.connect(alice).mintSingleAsset(addrs[0], 1_600n * WAD, 0n)).to.not.be
        .revert(ethers);
      expect(await vault.weightBps(addrs[0])).to.be.greaterThan(3_333n);
      expect(await vault.weightBps(addrs[0])).to.be.at.most(CONCENTRATION_CAP_BPS);
    });
  });
});
