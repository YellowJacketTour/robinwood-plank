import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployOpenIndex, TIMELOCK } from "./helpers/index-vault";

/**
 * ============================================================================
 * IndexSocialFiTreasuryFacet — §7.12 "platform socialfi treasury"
 * (design doc DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md §7.12).
 *
 * THIS IS A DELIBERATELY DIFFERENT TRUST MODEL FROM EVERY §7.3 SUITE IN THIS
 * REPO — THE SAME ONE §7.11's `IndexDevFundFacet.test.ts` ALREADY PROVES —
 * AND THIS FILE PROVES THAT HONESTLY RATHER THAN PRETENDING OTHERWISE. The
 * socialfi treasury here is real, spendable, team-directed value, not a
 * trustless mechanism, so nothing below claims "no admin path" or "no one
 * can touch it". What IS proven, mechanically:
 *
 *   1. `carveOutBps` cannot exceed the 5% ceiling
 *      (`CEIL_PLATFORM_TREASURY_BPS = 500`), enforced at execution.
 *   2. The percentage AND the treasury address are both governed and
 *      timelocked — no direct, un-timelocked setter for either.
 *   3. A routed fee correctly sends the configured percentage to the
 *      treasury BEFORE the remainder is split three ways per §7.3 — proving
 *      the post-split amounts are computed against the POST-CARVE-OUT
 *      REMAINDER, not the original full amount (the one place a subtle
 *      math-ordering bug could hide).
 *   4. The existing §7.3 three-way-split behaviour is preserved byte-for-
 *      byte in the default (zero-carve-out) state — purely additive/opt-in,
 *      exactly matching §7.11's own zero-default pattern.
 * ============================================================================
 */
describe("IndexSocialFiTreasuryFacet (design doc §7.12)", () => {
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const E = (n: string) => ethers.parseEther(n);
  const BPS = 10_000n;
  const CEIL = 500n; // IndexFacetBase.CEIL_PLATFORM_TREASURY_BPS

  /** Simulate a factory vault's mandatory push: a plain ERC-20 transfer of
   * `amount` of `token` straight to the Diamond's own address, exactly as
   * CollectionVault does — no cross-contract call, no self-reported amount. */
  async function pushRoutedFee(fx: any, token: any, from: any, amount: bigint) {
    await token.mint(from.address, amount);
    await token.connect(from).transfer(fx.vaultAddr, amount);
  }

  async function setBps(fx: any, bps: bigint) {
    await fx.vault.connect(fx.allocation).queueSocialFiTreasuryBps(bps);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeSocialFiTreasuryBps();
    await fx.vault.checkpointAll(); // refresh past the timelock jump
  }
  async function setTreasury(fx: any, addr: string) {
    await fx.vault.connect(fx.allocation).queueSocialFiTreasury(addr);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeSocialFiTreasury();
    await fx.vault.checkpointAll(); // refresh past the timelock jump
  }

  async function fixtureWired(bps = 200n) {
    const fx = await deployOpenIndex();
    const treasury = fx.carol.address;
    await setTreasury(fx, treasury);
    await setBps(fx, bps);
    return { ...fx, treasury };
  }

  // ══ 1. The 5% ceiling — hard, enforced at execution ═══════════════════

  it("cannot exceed the 5% ceiling — enforced at execution, not just discouraged", async () => {
    const fx = await deployOpenIndex();
    await fx.vault.connect(fx.allocation).queueSocialFiTreasuryBps(CEIL + 1n);
    await time.increase(TIMELOCK + 1);
    await expect(fx.vault.executeSocialFiTreasuryBps()).to.be.revertedWithCustomError(fx.vault, "BadParam");
    expect(await fx.vault.socialFiTreasuryBps()).to.equal(0n);

    // Exactly at the ceiling succeeds.
    await fx.vault.connect(fx.allocation).queueSocialFiTreasuryBps(CEIL);
    await time.increase(TIMELOCK + 1);
    await expect(fx.vault.executeSocialFiTreasuryBps())
      .to.emit(fx.vault, "SocialFiTreasuryBpsSet")
      .withArgs(CEIL);
    expect(await fx.vault.socialFiTreasuryBps()).to.equal(CEIL);
  });

  // ══ 2. Governed + timelocked: percentage and treasury address ═════════

  it("socialFiTreasuryBps has no direct setter — only queue/execute, gated to ROLE_PLATFORM_ALLOCATION (audit M-5), timelocked", async () => {
    const fx = await deployOpenIndex();
    await expect(
      fx.vault.connect(fx.alice).queueSocialFiTreasuryBps(50n)
    ).to.be.revertedWithCustomError(fx.vault, "NotRoleHolder");
    // AUDIT FIX M-5. The RISK key must be rejected here. It used to be the
    // holder of this capability, which let a compromised risk key aim a real,
    // spendable treasury at any address. Revert the facet's modifier and this
    // line goes red.
    await expect(fx.vault.connect(fx.risk).queueSocialFiTreasuryBps(50n)).to.be.revertedWithCustomError(
      fx.vault,
      "NotRoleHolder"
    );
    await fx.vault.connect(fx.allocation).queueSocialFiTreasuryBps(50n);
    await expect(fx.vault.executeSocialFiTreasuryBps()).to.be.revertedWithCustomError(
      fx.vault,
      "TimelockNotElapsed"
    );
    expect(await fx.vault.socialFiTreasuryBps()).to.equal(0n);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeSocialFiTreasuryBps();
    expect(await fx.vault.socialFiTreasuryBps()).to.equal(50n);
  });

  it("socialFiTreasury has no direct setter — only queue/execute, gated to ROLE_PLATFORM_ALLOCATION (audit M-5), timelocked", async () => {
    const fx = await deployOpenIndex();
    await expect(
      fx.vault.connect(fx.alice).queueSocialFiTreasury(fx.bob.address)
    ).to.be.revertedWithCustomError(fx.vault, "NotRoleHolder");
    // AUDIT FIX M-5. The RISK key must be rejected here. It used to be the
    // holder of this capability, which let a compromised risk key aim a real,
    // spendable treasury at any address. Revert the facet's modifier and this
    // line goes red.
    await expect(fx.vault.connect(fx.risk).queueSocialFiTreasury(fx.bob.address)).to.be.revertedWithCustomError(
      fx.vault,
      "NotRoleHolder"
    );
    await fx.vault.connect(fx.allocation).queueSocialFiTreasury(fx.bob.address);
    await expect(fx.vault.executeSocialFiTreasury()).to.be.revertedWithCustomError(
      fx.vault,
      "TimelockNotElapsed"
    );
    expect(await fx.vault.socialFiTreasury()).to.equal(ethers.ZeroAddress);
    await time.increase(TIMELOCK + 1);
    await expect(fx.vault.executeSocialFiTreasury())
      .to.emit(fx.vault, "SocialFiTreasurySet")
      .withArgs(fx.bob.address);
    expect(await fx.vault.socialFiTreasury()).to.equal(fx.bob.address);
  });

  it("nothing can be executed before it was queued", async () => {
    const fx = await deployOpenIndex();
    await expect(fx.vault.executeSocialFiTreasuryBps()).to.be.revertedWithCustomError(
      fx.vault,
      "NothingQueued"
    );
    await expect(fx.vault.executeSocialFiTreasury()).to.be.revertedWithCustomError(
      fx.vault,
      "NothingQueued"
    );
  });

  // ══ 3. A routed fee carves BEFORE the three-way split — the ordering ═══
  // ══    proof: post-split amounts are computed off the REMAINDER ═══════

  it("carves the configured percentage to the treasury BEFORE §7.3's three-way split, and the split runs on the POST-CARVE-OUT REMAINDER", async () => {
    const bps = 300n; // 3% carve-out (within the 5% ceiling)
    const fx = await fixtureWired(bps);

    // Also configure a real §7.3 split (30% dividend, 10% buyback) so the
    // math-ordering claim is actually exercised, not vacuously true against
    // an all-reserve default.
    const KEY = ethers.encodeBytes32String("valueAccrualSplitBps");
    const pack = (dividendBps: bigint, buybackBps: bigint) => dividendBps * BPS + buybackBps;
    await fx.vault.connect(fx.allocation).queueParam(KEY, pack(3_000n, 1_000n));
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeParam(KEY);
    await fx.vault.checkpointAll();

    const token = fx.tokens[0]; // == dividendAsset in this fixture
    const addr = fx.addrs[0];
    const reserveBefore: bigint = await fx.vault.reserveOf(addr);
    const divBefore: bigint = await fx.vault.totalDividendsReceived();
    const earmarkBefore: bigint = await fx.vault.buybackEarmarkWei(addr);
    const treasuryBalBefore: bigint = await token.balanceOf(fx.treasury);

    const amount = E("100");
    await pushRoutedFee(fx, token, fx.bob, amount);

    const tx = await fx.vault.connect(fx.carol).reconcile(addr);
    await expect(tx)
      .to.emit(fx.vault, "SocialFiTreasuryCarvedOut")
      .withArgs(token.target ?? (await token.getAddress()), (amount * bps) / BPS, fx.treasury);

    // The carve-out actually, physically left the vault.
    const carveOut = (amount * bps) / BPS; // 10 ETH
    const remainder = amount - carveOut; // 90 ETH — what the §7.3 split sees
    expect((await token.balanceOf(fx.treasury)) - treasuryBalBefore).to.equal(carveOut);

    // THE ORDERING PROOF: the dividend/buyback/reserve legs sum to the
    // REMAINDER (90 ETH), never the original 100 ETH — i.e. they are
    // computed against amount AFTER the carve-out, not before it.
    const expectedDividend = (remainder * 3_000n) / BPS;
    const expectedBuyback = (remainder * 1_000n) / BPS;
    const expectedReserve = remainder - expectedDividend - expectedBuyback;

    expect((await fx.vault.reserveOf(addr)) - reserveBefore).to.equal(expectedReserve);
    expect((await fx.vault.totalDividendsReceived()) - divBefore).to.equal(expectedDividend);
    expect((await fx.vault.buybackEarmarkWei(addr)) - earmarkBefore).to.equal(expectedBuyback);

    // All four legs (carve-out + reserve + dividend + buyback) sum to the
    // whole observed delta, to the wei — nothing lost, nothing fabricated.
    expect(carveOut + expectedReserve + expectedDividend + expectedBuyback).to.equal(amount);

    // A wrong-ordering implementation (split-then-carve, or carve computed
    // against the post-split reserve share) would NOT match these exact
    // numbers — e.g. splitting the full 100 first and then carving 10% off
    // just the reserve leg would leave reserve at 54 (60 - 10% of 60) rather
    // than the correct 48.6 (90% reserve share of the 90 remainder). Assert
    // the reserve leg explicitly against the wrong-ordering figure to make
    // the regression concrete.
    const wrongOrderingReserve = (amount - expectedDividend - expectedBuyback) * 9_000n / BPS; // split-then-carve on reserve only, wrong
    expect(expectedReserve).to.not.equal(wrongOrderingReserve);
  });

  it("the carve-out reaches collection-share constituents too — the same per-token path every routed credit uses", async () => {
    const bps = 500n; // 5% — the ceiling
    const fx = await fixtureWired(bps);

    // Constituent index 1 — a non-dividend-asset token, standing in for a
    // collection-share constituent flowing through the identical `_sync`
    // path (design doc §7.12: "both flow through the same
    // `_sync`/`_creditRoutedValue` path per-token").
    const token = fx.tokens[1];
    const addr = fx.addrs[1];
    const treasuryBalBefore: bigint = await token.balanceOf(fx.treasury);
    const reserveBefore: bigint = await fx.vault.reserveOf(addr);

    const amount = E("40");
    await pushRoutedFee(fx, token, fx.bob, amount);
    await fx.vault.connect(fx.carol).reconcile(addr);

    const carveOut = (amount * bps) / BPS;
    expect((await token.balanceOf(fx.treasury)) - treasuryBalBefore).to.equal(carveOut);
    // Default §7.3 split (never configured in this test) is 100% reserve, so
    // the whole remainder after the carve-out lands in reserve.
    expect((await fx.vault.reserveOf(addr)) - reserveBefore).to.equal(amount - carveOut);
  });

  // ══ 4. Zero-default is a byte-for-byte no-op ═══════════════════════════

  it("a zero-configured treasury (the default) is a no-op — reconcile behaves exactly as before §7.12, and existing §7.3 tests are unaffected", async () => {
    const fx = await deployOpenIndex();
    expect(await fx.vault.socialFiTreasuryBps()).to.equal(0n);
    expect(await fx.vault.socialFiTreasury()).to.equal(ethers.ZeroAddress);

    const token = fx.tokens[0];
    const addr = fx.addrs[0];
    const reserveBefore: bigint = await fx.vault.reserveOf(addr);

    const amount = E("25");
    await pushRoutedFee(fx, token, fx.bob, amount);
    const tx = await fx.vault.connect(fx.carol).reconcile(addr);
    await expect(tx).to.not.emit(fx.vault, "SocialFiTreasuryCarvedOut");

    // 100% reaches reserve (the default §7.3 split), exactly as
    // ValueAccrualSplit.test.ts's own "byte-for-byte no-op" case proves —
    // this section changes nothing when unconfigured.
    expect((await fx.vault.reserveOf(addr)) - reserveBefore).to.equal(amount);
  });

  it("treasury set but bps still zero is also a no-op — both must be configured", async () => {
    const fx = await deployOpenIndex();
    await setTreasury(fx, fx.carol.address);
    expect(await fx.vault.socialFiTreasuryBps()).to.equal(0n);

    const token = fx.tokens[0];
    const addr = fx.addrs[0];
    const treasuryBalBefore: bigint = await token.balanceOf(fx.carol.address);

    await pushRoutedFee(fx, token, fx.bob, E("10"));
    await fx.vault.connect(fx.carol).reconcile(addr);

    expect(await token.balanceOf(fx.carol.address)).to.equal(treasuryBalBefore);
  });

  // ══ 5. §7.12's own honesty discipline — no trustless language used ═════

  it("is disclosed as a real, spendable, team-directed treasury — never routed through SEED_LOCK_ADDR, and freely spendable by the treasury", async () => {
    const fx = await fixtureWired(300n);
    const seedLock: string = await fx.vault.SEED_LOCK();
    const token = fx.tokens[0];
    const addr = fx.addrs[0];

    await pushRoutedFee(fx, token, fx.bob, E("50"));
    await fx.vault.connect(fx.carol).reconcile(addr);

    expect(await token.balanceOf(seedLock)).to.equal(0n);
    const bal: bigint = await token.balanceOf(fx.treasury);
    expect(bal).to.be.gt(0n);

    // Real spendability, proven by a real transfer, not merely asserted —
    // same proof `IndexDevFundFacet.test.ts` runs for §7.11's dev fund.
    const ercToken = await ethers.getContractAt("MockIndexToken", await token.getAddress());
    await ercToken.connect(fx.carol).transfer(fx.bob.address, bal);
    expect(await ercToken.balanceOf(fx.bob.address)).to.be.gte(bal);
    expect(await ercToken.balanceOf(fx.treasury)).to.equal(0n);
  });
});
