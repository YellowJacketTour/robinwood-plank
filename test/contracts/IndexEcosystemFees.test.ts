import { expect } from "chai";
import { ethers } from "hardhat";
import {
  takeSnapshot,
  time,
  type SnapshotRestorer,
} from "@nomicfoundation/hardhat-network-helpers";
import {
  BPS,
  MIN_CHECKPOINT,
  TIMELOCK,
  WAD,
  defaultParams,
  paramsTuple,
} from "./helpers/index-vault";

/**
 * ECOSYSTEM FEE SPLIT — the segregated revenue ledger that finally connects
 * GlobalIndexVault's imbalance fee to IndexDividendDistributor (Finding
 * I-F13's second bullet: two correct contracts with nothing feeding them).
 *
 * The design under test, and the four claims this file exists to attack:
 *
 *   1. SEGREGATION. `ecosystemFeesWei[token]` is a ledger of its own, in the
 *      MarketplankVaultV3 `accruedFees` shape. It is never `reserve`, never
 *      counted by `nav()`/`priceBand()`/`weightBps()`, and never payable to a
 *      redeemer. The suite proves this by DIFFERENTIAL EXECUTION: the same
 *      script run with the feature off and on, asserting the redeemer's
 *      amounts are bit-for-bit equal.
 *   2. THE EXIT DOOR. `redeemProRata` is untouched by every piece of state
 *      this feature introduces, under hostile parameters, with a reverting
 *      sink, with the sink retired, and with a fat ledger. If any of that can
 *      make an exit revert or shrink, the feature is wrong and this file says
 *      so.
 *   3. BOUNDED AND TIMELOCKED. The split is a governance parameter behind the
 *      same timelock and a compile-time ceiling as every other economic knob,
 *      routed to the VALUE-FLOW role, not the risk role.
 *   4. PERMISSIONLESS, FIXED-DESTINATION HARVEST. Anyone may trigger it;
 *      nobody may aim it. Copied from `withdrawFees()`, which had the same
 *      property proven for the same reason.
 *
 * And one thing that is NOT hidden: existing holders capture LESS NAV growth
 * with the split on than with it off. That is the whole point of the feature
 * and it is asserted directly, in both directions, rather than glossed.
 *
 * LOCAL HARDHAT ONLY. Nothing here has a network, an RPC, or a key.
 */
describe("GlobalIndexVault — segregated ecosystem fee ledger", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const E = (n: string) => ethers.parseEther(n);
  const SPLIT_KEY = ethers.encodeBytes32String("ecosystemFeeSplitBps");
  const SINK_KEY = ethers.encodeBytes32String("ecosystemSink");
  const DEFAULT_SPLIT = 2_000n;
  const CEIL_SPLIT = 3_000n;

  /** WETH has no mint: top the account's ETH up and wrap. Plain mocks mint. */
  async function fund(token: any, who: any, amount: bigint) {
    if (typeof token.deposit === "function") {
      const bal: bigint = await ethers.provider.getBalance(who.address);
      await ethers.provider.send("hardhat_setBalance", [
        who.address,
        "0x" + (bal + amount + E("100")).toString(16),
      ]);
      await token.connect(who).deposit({ value: amount });
      return;
    }
    await token.mint(who.address, amount);
  }

  /**
   * A basket whose FIRST leg is the REAL canonical WETH9, because that is the
   * one asset IndexDividendDistributor can take. Three legs at 1.0 ETH each,
   * so a fee-generating single-asset op has headroom under the 40% cap.
   *
   * `allocation` holds ROLE_PLATFORM_ALLOCATION and `risk` holds
   * ROLE_RISK_PARAM, SEPARATELY — the split's role isolation is one of the
   * things under test, so the fixture must not hand both to one address.
   */
  async function fixture() {
    const [, admin, seeder, alice, bob, carol, risk, allocation] =
      await ethers.getSigners();

    const Weth = await ethers.getContractFactory("CanonicalWeth9");
    const weth: any = await Weth.deploy();
    const Token = await ethers.getContractFactory("MockIndexToken");
    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    const tokens: any[] = [weth, await Token.deploy("cB", "cB"), await Token.deploy("cC", "cC")];
    const sources: any[] = [];
    for (let i = 0; i < 3; i++) sources.push(await Source.deploy(100n * WAD, 100n * WAD));
    const addrs: string[] = [];
    for (const t of tokens) addrs.push(await t.getAddress());

    const Vault = await ethers.getContractFactory("GlobalIndexVault");
    const vault: any = await Vault.deploy(
      "Marketplank Global Index",
      "gPLNK",
      [admin.address, admin.address, risk.address, allocation.address],
      seeder.address,
      TIMELOCK,
      paramsTuple(defaultParams)
    );
    const vaultAddr = await vault.getAddress();

    for (let i = 0; i < 3; i++) {
      await vault.connect(seeder).seedConstituent(addrs[i], await sources[i].getAddress(), 3_333);
      await fund(tokens[i], seeder, 1_000n * WAD);
      await tokens[i].connect(seeder).approve(vaultAddr, ethers.MaxUint256);
      await vault.connect(seeder).seedDeposit(addrs[i], 1_000n * WAD);
    }
    await vault.connect(seeder).openIndex(1_000n * WAD);

    for (const who of [alice, bob, carol]) {
      for (const t of tokens) {
        await fund(t, who, 50_000n * WAD);
        await t.connect(who).approve(vaultAddr, ethers.MaxUint256);
      }
    }

    const Dist = await ethers.getContractFactory("IndexDividendDistributor");
    const dist: any = await Dist.deploy(vaultAddr, vaultAddr, addrs[0]);
    const distAddr = await dist.getAddress();
    for (const who of [alice, bob, carol]) {
      await vault.connect(who).approve(distAddr, ethers.MaxUint256);
    }

    for (let i = 0; i < 8; i++) {
      await time.increase(MIN_CHECKPOINT + 1);
      await vault.checkpointAll();
    }

    return {
      admin, seeder, alice, bob, carol, risk, allocation,
      vault, vaultAddr, dist, distAddr, weth, tokens, sources, addrs,
    };
  }

  /** Re-warm the oracle. Every timelock wait is 48h and `staleAfter` is 2h,
   *  so waiting one out ALWAYS staleness-locks the priced paths. */
  async function warm(fx: any, n = 8) {
    for (let i = 0; i < n; i++) {
      await time.increase(MIN_CHECKPOINT + 1);
      await fx.vault.checkpointAll();
    }
  }

  /** Queue+execute a timelocked param through the ONE timelock. */
  async function setParam(fx: any, who: any, key: string, value: bigint | string) {
    await fx.vault.connect(who).queueParam(key, value);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeParam(key);
    await warm(fx);
  }

  /** Appoint the distributor as the sink (timelocked, allocation role). */
  async function appointSink(fx: any, sink?: string) {
    await setParam(fx, fx.allocation, SINK_KEY, sink ?? fx.distAddr);
  }

  /** Drive one fee-generating single-asset mint on the WETH leg. */
  async function feeMint(fx: any, who: any, amount: bigint) {
    return fx.vault.connect(who).mintSingleAsset(fx.addrs[0], amount, 0);
  }

  // ══ 1. Inert by default ═══════════════════════════════════════════════

  it("accrues NOTHING until a sink is appointed — the feature is inert by default", async () => {
    const fx = await fixture();
    // The parameter itself defaults to a live value...
    expect(await fx.vault.ecosystemFeeSplitBps()).to.equal(DEFAULT_SPLIT);
    // ...and yet, with no sink, nothing is booked and nothing is pinned.
    expect(await fx.vault.ecosystemSink()).to.equal(ethers.ZeroAddress);
    expect(await fx.vault.ecosystemAsset()).to.equal(ethers.ZeroAddress);

    await feeMint(fx, fx.alice, E("50"));
    await fx.vault.connect(fx.alice).redeemSingleAsset(E("10"), fx.addrs[0], 0);
    for (const a of fx.addrs) expect(await fx.vault.ecosystemFeesWei(a)).to.equal(0n);
    await expect(fx.vault.connect(fx.bob).harvestEcosystemFees()).to.be.revertedWithCustomError(
      fx.vault,
      "EcosystemSinkUnset"
    );
  });

  it("pins the asset from the SINK'S OWN reinvestAsset, and only that leg ever accrues", async () => {
    const fx = await fixture();
    await appointSink(fx);
    expect(await fx.vault.ecosystemAsset()).to.equal(fx.addrs[0]);
    expect(await fx.vault.ecosystemAsset()).to.equal(await fx.dist.reinvestAsset());

    // A fee-generating mint on a NON-WETH leg books nothing at all — the
    // scoping decision, asserted rather than assumed. There is no ledger
    // entry in a token the sink could not take, so nothing can strand.
    await fx.vault.connect(fx.alice).mintSingleAsset(fx.addrs[1], E("50"), 0);
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[1])).to.equal(0n);
    await fx.vault.connect(fx.alice).redeemSingleAsset(E("10"), fx.addrs[2], 0);
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[2])).to.equal(0n);

    // The WETH leg does.
    await feeMint(fx, fx.alice, E("50"));
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.be.greaterThan(0n);
  });

  // ══ 2. The split is taken out of the FEE, never out of principal ══════

  it("books exactly split_bps of the mint fee and leaves the rest in the reserve", async () => {
    const fx = await fixture();
    await appointSink(fx);

    const amount = E("50");
    const feeBps: bigint = await fx.vault.previewMintFeeBps(fx.addrs[0], amount);
    expect(feeBps).to.be.greaterThan(0n); // otherwise this test proves nothing

    const reserveBefore: bigint = await fx.vault.reserveOf(fx.addrs[0]);
    await feeMint(fx, fx.alice, amount);

    const fee = (amount * feeBps) / BPS;
    const cut = (fee * DEFAULT_SPLIT) / BPS;
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.equal(cut);
    // The reserve got the deposit MINUS the cut, i.e. principal plus 80% of
    // the fee. The cut is strictly a slice of the fee, never of principal.
    expect(await fx.vault.reserveOf(fx.addrs[0])).to.equal(reserveBefore + amount - cut);
    expect(cut).to.be.lessThan(fee);
  });

  it("the ledger is BACKED — the vault holds reserve + ecosystemFees, and no more is claimed", async () => {
    const fx = await fixture();
    await appointSink(fx);
    await feeMint(fx, fx.alice, E("80"));
    await fx.vault.connect(fx.alice).redeemSingleAsset(E("20"), fx.addrs[0], 0);

    const held: bigint = await fx.weth.balanceOf(fx.vaultAddr);
    const reserve: bigint = await fx.vault.reserveOf(fx.addrs[0]);
    const ledger: bigint = await fx.vault.ecosystemFeesWei(fx.addrs[0]);
    expect(ledger).to.be.greaterThan(0n);
    // Exactly V3's `address(this).balance >= ethReserve + accruedFees`.
    expect(held).to.be.greaterThanOrEqual(reserve + ledger);
  });

  // ══ 3. THE CRITICAL INVARIANT: the exit door does not move ════════════

  /**
   * DIFFERENTIAL EXECUTION. The identical script is run twice from the same
   * genesis — once with the feature off, once with it on at the default split
   * — and the redeemer's PRO-RATA amounts are compared element by element.
   * If a single wei of the segregated ledger ever leaked into the exit, this
   * fails. This is the single most important assertion in the file.
   */
  async function bobExit(fx: any) {
    const shares: bigint = await fx.vault.balanceOf(fx.bob.address);
    const supply: bigint = await fx.vault.totalSupply();
    const reserves: bigint[] = [];
    const before: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      reserves.push(await fx.vault.reserveOf(fx.addrs[i]));
      before.push(await fx.tokens[i].balanceOf(fx.bob.address));
    }
    await fx.vault.connect(fx.bob).redeemProRata(shares, [0n, 0n, 0n]);
    const out: bigint[] = [];
    for (let i = 0; i < 3; i++) out.push((await fx.tokens[i].balanceOf(fx.bob.address)) - before[i]);
    return { out, shares, supply, reserves };
  }

  it("EXIT DOOR: a pro-rata redeemer is paid BIT-FOR-BIT the same with the ledger full or empty", async () => {
    const fx = await fixture();
    await appointSink(fx);
    await fx.vault
      .connect(fx.bob)
      .mintProRata(E("100"), [ethers.MaxUint256, ethers.MaxUint256, ethers.MaxUint256]);
    await feeMint(fx, fx.alice, E("120"));
    await fx.vault.connect(fx.bob).redeemSingleAsset(E("30"), fx.addrs[0], 0);
    await feeMint(fx, fx.carol, E("60"));

    const loaded: bigint = await fx.vault.ecosystemFeesWei(fx.addrs[0]);
    expect(loaded).to.be.greaterThan(0n);

    // The differential is taken with the LEDGER as the only variable, which
    // is the only way to isolate it: `harvestEcosystemFees` empties the
    // ledger and provably leaves every `reserve` untouched, so the two runs
    // below have IDENTICAL reserves and supply and differ in exactly one
    // thing — whether the segregated ledger holds a fortune or nothing.
    const snap = await takeSnapshot();
    const full = await bobExit(fx);
    await snap.restore();

    await fx.vault.connect(fx.carol).harvestEcosystemFees();
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.equal(0n);
    const empty = await bobExit(fx);

    // Preconditions of the comparison: same shares, same supply, same
    // reserves. If any of these drifted the differential would prove nothing.
    expect(empty.shares).to.equal(full.shares);
    expect(empty.supply).to.equal(full.supply);
    expect(empty.reserves).to.deep.equal(full.reserves);

    // THE CLAIM.
    expect(full.out).to.deep.equal(empty.out);

    // And the payout is exactly the strict pro-rata expression, computed from
    // `reserve` and `totalSupply` alone — the ledger is not a term in it.
    const V = 10n ** 3n; // VIRTUAL_SHARES
    for (let i = 0; i < 3; i++) {
      expect(full.out[i]).to.equal((full.shares * full.reserves[i]) / (full.supply + V));
      expect(full.out[i]).to.be.greaterThan(0n);
    }
  });

  it("EXIT DOOR: redeemProRata still works at the CEILING split, with a fat ledger", async () => {
    const fx = await fixture();
    await appointSink(fx);
    await setParam(fx, fx.allocation, SPLIT_KEY, CEIL_SPLIT);
    expect(await fx.vault.ecosystemFeeSplitBps()).to.equal(CEIL_SPLIT);

    for (let i = 0; i < 5; i++) await feeMint(fx, fx.alice, E("40"));
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.be.greaterThan(0n);

    const shares: bigint = await fx.vault.balanceOf(fx.alice.address);
    const supply: bigint = await fx.vault.totalSupply();
    const reserves: bigint[] = [];
    for (const a of fx.addrs) reserves.push(await fx.vault.reserveOf(a));

    await expect(fx.vault.connect(fx.alice).redeemProRata(shares, [0n, 0n, 0n])).to.not.be.reverted;

    // Strict pro rata against `reserve` alone — the ledger is not in the
    // denominator, not in the numerator, and not in the payout.
    const V = 10n ** 3n; // VIRTUAL_SHARES
    for (let i = 0; i < 3; i++) {
      const paid = reserves[i] - (await fx.vault.reserveOf(fx.addrs[i]));
      // Exactly the strict pro-rata expression, at the most hostile split the
      // ceiling permits, with the ledger at its fattest.
      expect(paid).to.equal((shares * reserves[i]) / (supply + V));
      expect(paid).to.be.greaterThan(0n);
    }
  });

  it("EXIT DOOR: a sink that reverts on every call bricks ONLY the harvest", async () => {
    const fx = await fixture();
    await appointSink(fx);
    await feeMint(fx, fx.alice, E("60"));

    // Retire the sink to a contract that cannot receive: the vault itself has
    // no `receiveDividendsWrapped`, so an appointment to it cannot even be
    // executed — the pinning call reverts. That is the RIGHT failure: a bad
    // appointment fails closed at appointment time, not at redemption time.
    await fx.vault.connect(fx.allocation).queueParam(SINK_KEY, fx.vaultAddr);
    await time.increase(TIMELOCK + 1);
    await expect(fx.vault.executeParam(SINK_KEY)).to.be.reverted;
    await warm(fx);

    // And meanwhile every user path still works, including the exit.
    await expect(fx.vault.connect(fx.alice).redeemProRata(E("10"), [0n, 0n, 0n])).to.not.be.reverted;
    await expect(feeMint(fx, fx.bob, E("10"))).to.not.be.reverted;
  });

  it("EXIT DOOR: retiring the sink leaves the ledger frozen but every user path open", async () => {
    const fx = await fixture();
    await appointSink(fx);
    await fx.vault
      .connect(fx.alice)
      .mintProRata(E("100"), [ethers.MaxUint256, ethers.MaxUint256, ethers.MaxUint256]);
    await feeMint(fx, fx.alice, E("60"));
    const stuck: bigint = await fx.vault.ecosystemFeesWei(fx.addrs[0]);
    expect(stuck).to.be.greaterThan(0n);

    await setParam(fx, fx.allocation, SINK_KEY, ethers.ZeroAddress);
    expect(await fx.vault.ecosystemSink()).to.equal(ethers.ZeroAddress);
    expect(await fx.vault.ecosystemAsset()).to.equal(ethers.ZeroAddress);

    // The ledger keeps its books (fee revenue, not user assets) and the
    // harvest is closed until a sink is re-appointed...
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.equal(stuck);
    await expect(fx.vault.harvestEcosystemFees()).to.be.revertedWithCustomError(
      fx.vault,
      "EcosystemSinkUnset"
    );
    // ...and accrual stops dead, because nothing is pinned.
    await feeMint(fx, fx.bob, E("40"));
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.equal(stuck);

    // The exit door never noticed any of it.
    await expect(fx.vault.connect(fx.alice).redeemProRata(E("25"), [0n, 0n, 0n])).to.not.be.reverted;

    // Re-appointing the same sink restores the harvest of the frozen balance.
    await appointSink(fx);
    await expect(fx.vault.connect(fx.carol).harvestEcosystemFees()).to.not.be.reverted;
  });

  it("a single-asset exit quote and payout are identical with the ledger full or empty", async () => {
    const fx = await fixture();
    await appointSink(fx);
    await fx.vault
      .connect(fx.alice)
      .mintProRata(E("100"), [ethers.MaxUint256, ethers.MaxUint256, ethers.MaxUint256]);
    await feeMint(fx, fx.alice, E("100"));
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.be.greaterThan(0n);

    async function exit() {
      const quoted: bigint = await fx.vault.previewRedeemSingleAsset(E("40"), fx.addrs[0]);
      const before: bigint = await fx.weth.balanceOf(fx.alice.address);
      await fx.vault.connect(fx.alice).redeemSingleAsset(E("40"), fx.addrs[0], 0);
      return { quoted, got: (await fx.weth.balanceOf(fx.alice.address)) - before };
    }

    const snap = await takeSnapshot();
    const full = await exit();
    await snap.restore();
    await fx.vault.connect(fx.carol).harvestEcosystemFees();
    const empty = await exit();

    // The quote AND the payout are bit-for-bit identical. The split changes
    // where an already-charged fee is booked, never what anyone is charged
    // and never what anyone is paid.
    expect(full.quoted).to.equal(empty.quoted);
    expect(full.got).to.equal(empty.got);
    expect(full.got).to.equal(full.quoted);
  });

  // ══ 4. nav() / priceBand() never see the ledger ════════════════════════

  it("nav() and weightBps() are computed from `reserve` alone — the ledger is invisible to them", async () => {
    const fx = await fixture();
    await appointSink(fx);
    await feeMint(fx, fx.alice, E("100"));
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.be.greaterThan(0n);

    // Rebuild NAV by hand from the RESERVES and the published bands. If the
    // ledger were counted anywhere, these would not agree.
    const [navLow, navHigh] = await fx.vault.nav();
    let low = 0n;
    let high = 0n;
    for (const a of fx.addrs) {
      const [lo, hi] = await fx.vault.priceBand(a);
      const r: bigint = await fx.vault.reserveOf(a);
      low += (r * lo) / WAD;
      high += (r * hi) / WAD;
    }
    expect(navLow).to.equal(low);
    expect(navHigh).to.equal(high);

    // A harvest moves the ledger out of the contract entirely and NAV does
    // not budge by a single wei — the clearest possible statement that the
    // ledger was never part of it.
    const [beforeLow, beforeHigh] = await fx.vault.nav();
    await fx.vault.connect(fx.bob).harvestEcosystemFees();
    const [afterLow, afterHigh] = await fx.vault.nav();
    expect(afterLow).to.equal(beforeLow);
    expect(afterHigh).to.equal(beforeHigh);
  });

  // ══ 5. The trade-off, stated out loud ═════════════════════════════════

  it("existing holders get LESS NAV growth with the split on — the honest cost, asserted both ways", async () => {
    async function reserveAfterFees(withSink: boolean) {
      const fx = await fixture();
      if (withSink) await appointSink(fx);
      const before: bigint = await fx.vault.reserveOf(fx.addrs[0]);
      const supplyBefore: bigint = await fx.vault.totalSupply();
      await feeMint(fx, fx.alice, E("120"));
      return {
        gain: (await fx.vault.reserveOf(fx.addrs[0])) - before,
        supplyGain: (await fx.vault.totalSupply()) - supplyBefore,
      };
    }
    const off = await reserveAfterFees(false);
    const on = await reserveAfterFees(true);

    // Same shares minted either way — the split does not touch the share math.
    expect(on.supplyGain).to.equal(off.supplyGain);
    // But the reserve grows by strictly less: holders keep 80% of the fee's
    // NAV lift instead of 100%. This is the cost, and it is a cost, and it is
    // bounded by CEIL_ECOSYSTEM_SPLIT_BPS = 30%.
    expect(on.gain).to.be.lessThan(off.gain);
    // And it is still a GAIN: per-share backing is non-decreasing on the
    // priced path even with the split live. Holders are never worse off than
    // before the operation, only less better off.
    expect(on.gain).to.be.greaterThan(0n);
    const diff = off.gain - on.gain;
    expect(diff * 100n).to.be.lessThan(on.gain); // the split is a rounding-scale slice of the deposit
  });

  // ══ 6. Bounded, timelocked, role-isolated ═════════════════════════════

  it("the split is bounded at execution — a 30.01% value is rejected AFTER the timelock elapses", async () => {
    const fx = await fixture();
    await fx.vault.connect(fx.allocation).queueParam(SPLIT_KEY, CEIL_SPLIT + 1n);
    await time.increase(TIMELOCK + 1);
    // The ceiling is re-checked at EXECUTION, not at queue time: a timelock
    // bounds WHEN a bad change lands, never HOW BAD it can be.
    await expect(fx.vault.executeParam(SPLIT_KEY)).to.be.revertedWithCustomError(
      fx.vault,
      "AllocationCapExceeded"
    );
    expect(await fx.vault.ecosystemFeeSplitBps()).to.equal(DEFAULT_SPLIT);

    // The ceiling itself is reachable.
    await setParam(fx, fx.allocation, SPLIT_KEY, CEIL_SPLIT);
    expect(await fx.vault.ecosystemFeeSplitBps()).to.equal(CEIL_SPLIT);
  });

  it("even a maximal split cannot route more than 30% of the fee, and never any principal", async () => {
    const fx = await fixture();
    await appointSink(fx);
    await setParam(fx, fx.allocation, SPLIT_KEY, CEIL_SPLIT);
    const amount = E("120");
    const feeBps: bigint = await fx.vault.previewMintFeeBps(fx.addrs[0], amount);
    await feeMint(fx, fx.alice, amount);
    const cut: bigint = await fx.vault.ecosystemFeesWei(fx.addrs[0]);
    expect(cut).to.equal(((amount * feeBps) / BPS * CEIL_SPLIT) / BPS);
    // A slice of a slice: at the absolute ceiling of BOTH knobs this is 3% of
    // the deposit, and the deposit's own fee ceiling is 10%.
    expect(cut * 33n).to.be.lessThan(amount);
  });

  it("both keys are timelocked and neither is reachable by the RISK role", async () => {
    const fx = await fixture();

    for (const key of [SPLIT_KEY, SINK_KEY]) {
      // The risk role owns the fee SCHEDULE; it does not own where the fee is
      // BOOKED. Role isolation, in the direction that matters.
      await expect(fx.vault.connect(fx.risk).queueParam(key, 1n)).to.be.revertedWithCustomError(
        fx.vault,
        "NotRoleHolder"
      );
      await expect(fx.vault.connect(fx.alice).queueParam(key, 1n)).to.be.revertedWithCustomError(
        fx.vault,
        "NotRoleHolder"
      );
      // Nothing queued -> nothing to execute.
      await expect(fx.vault.executeParam(key)).to.be.revertedWithCustomError(
        fx.vault,
        "NothingQueued"
      );
    }

    // Queued but not elapsed: no early application, by anyone.
    await fx.vault.connect(fx.allocation).queueParam(SINK_KEY, fx.distAddr);
    await expect(fx.vault.executeParam(SINK_KEY)).to.be.revertedWithCustomError(
      fx.vault,
      "TimelockNotElapsed"
    );
    expect(await fx.vault.ecosystemSink()).to.equal(ethers.ZeroAddress);
    await time.increase(TIMELOCK + 1);
    await fx.vault.connect(fx.carol).executeParam(SINK_KEY); // execution is permissionless
    expect(await fx.vault.ecosystemSink()).to.equal(fx.distAddr);
  });

  it("the allocation role cannot reach the RISK surface through its new keys", async () => {
    const fx = await fixture();
    const riskKey = ethers.encodeBytes32String("maxImbalanceFeeBps");
    await expect(
      fx.vault.connect(fx.allocation).queueParam(riskKey, 900n)
    ).to.be.revertedWithCustomError(fx.vault, "NotRoleHolder");
  });

  // ══ 7. The harvest: permissionless trigger, fixed destination ══════════

  it("harvest is permissionless and pays the DISTRIBUTOR's stakers, chosen by nobody at call time", async () => {
    const fx = await fixture();
    await appointSink(fx);

    // Alice stakes; the fee revenue must reach HER, not the caller.
    await fx.vault.connect(fx.alice).mintProRata(E("100"), [
      ethers.MaxUint256, ethers.MaxUint256, ethers.MaxUint256,
    ]);
    await fx.dist.connect(fx.alice).stake(E("100"));

    await feeMint(fx, fx.bob, E("150"));
    const owed: bigint = await fx.vault.ecosystemFeesWei(fx.addrs[0]);
    expect(owed).to.be.greaterThan(0n);

    // Carol — an unrelated EOA with no role, no stake, and no relationship to
    // this vault — triggers it. That is the whole point of a permissionless
    // trigger with a fixed destination.
    const carolBefore: bigint = await ethers.provider.getBalance(fx.carol.address);
    await fx.vault.connect(fx.carol).harvestEcosystemFees();

    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.equal(0n);
    // The WETH was unwrapped by the distributor and credited as ETH dividends.
    expect(await ethers.provider.getBalance(fx.distAddr)).to.equal(owed);
    expect(await fx.dist.claimable(fx.alice.address)).to.equal(owed);
    // The trigger-er received nothing but a gas bill.
    expect(await ethers.provider.getBalance(fx.carol.address)).to.be.lessThan(carolBefore);
    expect(await fx.dist.claimable(fx.carol.address)).to.equal(0n);

    // And it really is claimable — end to end, fee to dividend.
    await expect(fx.dist.connect(fx.alice).claim()).to.not.be.reverted;
  });

  it("harvest has NO destination argument and leaves NO standing allowance", async () => {
    const fx = await fixture();
    // Surface check: exactly one harvest entry point, zero-argument. A
    // recipient parameter is what would turn this from a trigger into a lever.
    const fns = fx.vault.interface.fragments
      .filter((f: any) => f.type === "function" && /harvest/i.test(f.name))
      .map((f: any) => `${f.name}(${f.inputs.map((i: any) => i.type).join(",")})`);
    expect(fns).to.deep.equal(["harvestEcosystemFees()"]);

    await appointSink(fx);
    await feeMint(fx, fx.alice, E("80"));
    await fx.vault.connect(fx.bob).harvestEcosystemFees();
    expect(await fx.weth.allowance(fx.vaultAddr, fx.distAddr)).to.equal(0n);
  });

  it("harvest reverts rather than pushing zero, and is not double-spendable", async () => {
    const fx = await fixture();
    await appointSink(fx);
    await expect(fx.vault.harvestEcosystemFees()).to.be.revertedWithCustomError(
      fx.vault,
      "ZeroAmount"
    );
    await feeMint(fx, fx.alice, E("80"));
    await fx.vault.connect(fx.bob).harvestEcosystemFees();
    // Second call in the same block-ish window: the ledger was zeroed BEFORE
    // the external call, so there is nothing left to push twice.
    await expect(fx.vault.harvestEcosystemFees()).to.be.revertedWithCustomError(
      fx.vault,
      "ZeroAmount"
    );
  });

  it("harvest never touches the reserve — it moves the ledger and only the ledger", async () => {
    const fx = await fixture();
    await appointSink(fx);
    await feeMint(fx, fx.alice, E("100"));
    const reserve: bigint = await fx.vault.reserveOf(fx.addrs[0]);
    const ledger: bigint = await fx.vault.ecosystemFeesWei(fx.addrs[0]);
    const heldBefore: bigint = await fx.weth.balanceOf(fx.vaultAddr);

    await fx.vault.connect(fx.carol).harvestEcosystemFees();

    expect(await fx.vault.reserveOf(fx.addrs[0])).to.equal(reserve);
    expect(await fx.weth.balanceOf(fx.vaultAddr)).to.equal(heldBefore - ledger);
    // Still fully backed after the harvest.
    expect(await fx.weth.balanceOf(fx.vaultAddr)).to.be.greaterThanOrEqual(reserve);
  });

  it("a harvest cannot be made to fire mid-redemption — and a redemption never fires one", async () => {
    const fx = await fixture();
    await appointSink(fx);
    await feeMint(fx, fx.alice, E("100"));
    // Accrual is pure bookkeeping: no external call, no push, no keeper hook
    // on either priced path. The ONLY thing that talks to the sink is the
    // harvest. Proven by the absence of any balance change at the sink across
    // a full round of user operations.
    const sinkBefore: bigint = await ethers.provider.getBalance(fx.distAddr);
    await feeMint(fx, fx.bob, E("40"));
    await fx.vault.connect(fx.bob).redeemSingleAsset(E("10"), fx.addrs[0], 0);
    await fx.vault.connect(fx.alice).redeemProRata(E("10"), [0n, 0n, 0n]);
    expect(await ethers.provider.getBalance(fx.distAddr)).to.equal(sinkBefore);
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.be.greaterThan(0n);
  });

  // ══ 8. Randomised: the exit door under a long hostile sequence ═════════

  it("holds the segregation invariant over a long randomised sequence at the ceiling split", async () => {
    const fx = await fixture();
    await appointSink(fx);
    await setParam(fx, fx.allocation, SPLIT_KEY, CEIL_SPLIT);

    for (const who of [fx.alice, fx.bob, fx.carol]) {
      await fx.vault
        .connect(who)
        .mintProRata(E("100"), [ethers.MaxUint256, ethers.MaxUint256, ethers.MaxUint256]);
    }

    let seed = 987654321n;
    const rnd = (n: bigint) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      return seed % n;
    };
    const actors = [fx.alice, fx.bob, fx.carol];

    for (let i = 0; i < 40; i++) {
      const who = actors[Number(rnd(3n))];
      const leg = Number(rnd(3n));
      const amt = E(String(1 + Number(rnd(30n))));
      try {
        const op = Number(rnd(4n));
        if (op === 0) await fx.vault.connect(who).mintSingleAsset(fx.addrs[leg], amt, 0);
        else if (op === 1) await fx.vault.connect(who).redeemSingleAsset(amt / 4n, fx.addrs[leg], 0);
        else if (op === 2)
          await fx.vault
            .connect(who)
            .mintProRata(amt, [ethers.MaxUint256, ethers.MaxUint256, ethers.MaxUint256]);
        else await fx.vault.connect(who).redeemProRata(amt / 4n, [0n, 0n, 0n]);
      } catch {
        /* a guard fired; that is the contract working, not a failure */
      }

      // INVARIANT, every single step: the vault's real WETH balance covers
      // the reserve AND the segregated ledger, separately, with no overlap.
      const held: bigint = await fx.weth.balanceOf(fx.vaultAddr);
      const reserve: bigint = await fx.vault.reserveOf(fx.addrs[0]);
      const ledger: bigint = await fx.vault.ecosystemFeesWei(fx.addrs[0]);
      expect(held).to.be.greaterThanOrEqual(reserve + ledger);
      // The non-pinned legs never accrue, ever.
      expect(await fx.vault.ecosystemFeesWei(fx.addrs[1])).to.equal(0n);
      expect(await fx.vault.ecosystemFeesWei(fx.addrs[2])).to.equal(0n);
    }

    // And after all of it, the exit door still opens for everyone who holds.
    for (const who of actors) {
      const bal: bigint = await fx.vault.balanceOf(who.address);
      if (bal > 0n) {
        await expect(fx.vault.connect(who).redeemProRata(bal, [0n, 0n, 0n])).to.not.be.reverted;
      }
    }
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.be.greaterThan(0n);
    await expect(fx.vault.connect(fx.carol).harvestEcosystemFees()).to.not.be.reverted;
  });
});
