import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { time, takeSnapshot, type SnapshotRestorer } from "./helpers/network-helpers.js";
import { deployOpenIndex, TIMELOCK } from "./helpers/index-vault.js";

/**
 * ============================================================================
 * §7.3 — THE THREE-STREAM VALUE-ACCRUAL HYBRID
 *
 * Proves design doc DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md
 * §7.3 against a REAL Diamond: every fee surplus reconciled into a
 * constituent (§7.2/§3.2's push-then-opportunistic-reconcile,
 * `IndexBootstrapFacet.reconcile` / `syncConstituentBalance`) now splits
 * three ways —
 *
 *   (a) direct `c.reserve` growth        — the NAV-appreciation stream
 *   (b) the existing EIP-2222 accumulator — the real-cash-claim stream
 *   (c) a reserved accounting earmark    — §7.7's not-yet-built buyback
 *
 * — governed by a single timelocked parameter (`valueAccrualSplitBps`), with
 * the pre-existing dividend mechanism (`claimDividend` / `receiveDividendsWrapped`
 * / `harvestEcosystemFees`) proved UNCHANGED: this section adds a new credit
 * path into the accumulator, it does not touch the accumulator itself.
 * ============================================================================
 */
describe("§7.3 — three-stream value-accrual hybrid", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const E = (n: string) => ethers.parseEther(n);
  const BPS = 10_000n;
  const KEY = ethers.encodeBytes32String("valueAccrualSplitBps");

  /** Pack (dividendBps, buybackBps) into the single queued value. */
  function pack(dividendBps: bigint, buybackBps: bigint): bigint {
    return dividendBps * BPS + buybackBps;
  }

  async function queueSplit(fx: any, dividendBps: bigint, buybackBps: bigint) {
    await fx.vault.connect(fx.allocation).queueParam(KEY, pack(dividendBps, buybackBps));
  }

  async function executeSplit(fx: any) {
    await time.increase(TIMELOCK + 1);
    return fx.vault.executeParam(KEY);
  }

  /** Simulate a factory vault's mandatory push: a plain ERC-20 transfer of
   * `amount` of `token` straight to the Diamond's own address, exactly as
   * CollectionVault does — no cross-contract call, no self-reported amount. */
  async function pushRoutedFee(fx: any, token: any, from: any, amount: bigint) {
    await token.mint(from.address, amount);
    await token.connect(from).transfer(fx.vaultAddr, amount);
  }

  // ══ 1. The default is a no-op — old behavior preserved until configured ═

  it("defaults to 100% reserve growth (0% dividend, 0% buyback) — unconfigured is a byte-for-byte no-op", async () => {
    const fx = await deployOpenIndex();
    expect(await fx.vault.valueAccrualDividendBps()).to.equal(0n);
    expect(await fx.vault.valueAccrualBuybackBps()).to.equal(0n);
    expect(await fx.vault.valueAccrualReserveBps()).to.equal(BPS);

    const token = fx.tokens[0];
    const before = await fx.vault.reserveOf(fx.addrs[0]);
    const beforeDiv = await fx.vault.totalDividendsReceived();
    await pushRoutedFee(fx, token, fx.bob, E("5"));
    await fx.vault.connect(fx.carol).reconcile(fx.addrs[0]);

    expect(await fx.vault.reserveOf(fx.addrs[0])).to.equal(before + E("5"));
    expect(await fx.vault.totalDividendsReceived()).to.equal(beforeDiv);
    expect(await fx.vault.buybackEarmarkWei(fx.addrs[0])).to.equal(0n);
  });

  // ══ 2. The split is timelocked ═══════════════════════════════════════════

  it("the split cannot change instantly — queue then execute-too-early reverts, only the delayed execute applies it", async () => {
    const fx = await deployOpenIndex();
    await queueSplit(fx, 3_000n, 1_000n);

    // Still zero before the delay elapses.
    expect(await fx.vault.valueAccrualDividendBps()).to.equal(0n);
    await expect(fx.vault.executeParam(KEY)).to.be.revertedWithCustomError(
      fx.vault,
      "TimelockNotElapsed"
    );
    expect(await fx.vault.valueAccrualDividendBps()).to.equal(0n);

    await expect(executeSplit(fx)).to.emit(fx.vault, "ValueAccrualSplitApplied").withArgs(3_000n, 1_000n);
    expect(await fx.vault.valueAccrualDividendBps()).to.equal(3_000n);
    expect(await fx.vault.valueAccrualBuybackBps()).to.equal(1_000n);
    expect(await fx.vault.valueAccrualReserveBps()).to.equal(6_000n);
  });

  it("only the allocation role may queue the split", async () => {
    const fx = await deployOpenIndex();
    await expect(
      fx.vault.connect(fx.risk).queueParam(KEY, pack(3_000n, 1_000n))
    ).to.be.revertedWithCustomError(fx.vault, "NotRoleHolder");
  });

  it("a split whose two shares would sum past 100% is rejected at execution, not merely at queue time", async () => {
    const fx = await deployOpenIndex();
    // 6000 + 6000 = 12000 bps > BPS. Queuing is unconditional (same doctrine
    // as every other risk parameter in this suite); the ceiling is enforced
    // at EXECUTE, exactly like AllocationCapExceeded / targetHhiBps above it.
    await queueSplit(fx, 6_000n, 6_000n);
    await time.increase(TIMELOCK + 1);
    await expect(fx.vault.executeParam(KEY)).to.be.revertedWithCustomError(fx.vault, "BadParam");
    // Nothing applied.
    expect(await fx.vault.valueAccrualDividendBps()).to.equal(0n);
  });

  // ══ 3. The three-way split divides an incoming fee EXACTLY at the ═══════
  // ══    configured ratio ═══════════════════════════════════════════════

  it("splits a routed fee across all three destinations at the configured ratio", async () => {
    const fx = await deployOpenIndex();
    await queueSplit(fx, 3_000n, 1_000n); // 30% dividend, 10% buyback, 60% reserve
    await executeSplit(fx);

    const token = fx.tokens[0]; // == dividendAsset in this fixture
    const addr = fx.addrs[0];
    const reserveBefore = await fx.vault.reserveOf(addr);
    const divBefore = await fx.vault.totalDividendsReceived();
    const earmarkBefore = await fx.vault.buybackEarmarkWei(addr);

    const amount = E("100");
    await pushRoutedFee(fx, token, fx.bob, amount);
    const credited: bigint = await fx.vault.reconcile.staticCall(addr);
    expect(credited).to.equal(amount); // the OBSERVED delta, undivided
    await fx.vault.connect(fx.carol).reconcile(addr);

    const expectedDividend = (amount * 3_000n) / BPS;
    const expectedBuyback = (amount * 1_000n) / BPS;
    const expectedReserve = amount - expectedDividend - expectedBuyback;

    expect((await fx.vault.reserveOf(addr)) - reserveBefore).to.equal(expectedReserve);
    expect((await fx.vault.totalDividendsReceived()) - divBefore).to.equal(expectedDividend);
    expect((await fx.vault.buybackEarmarkWei(addr)) - earmarkBefore).to.equal(expectedBuyback);

    // Nothing lost, nothing double-counted: the three shares sum to the
    // whole observed delta, to the wei.
    expect(expectedReserve + expectedDividend + expectedBuyback).to.equal(amount);

    // Not one physical token left the vault — this is pure re-labeling of an
    // already-held balance, never a transfer.
    const held: bigint = await token.balanceOf(fx.vaultAddr);
    expect(held).to.be.greaterThanOrEqual(
      (await fx.vault.reserveOf(addr)) +
        (await fx.vault.buybackEarmarkWei(addr)) +
        ((await fx.vault.totalDividendsReceived()) - (await fx.vault.totalDividendsWithdrawn()))
    );
  });

  it("the dividend leg falls back to reserve growth for a constituent that is NOT the dividend asset — never stranded", async () => {
    const fx = await deployOpenIndex();
    await queueSplit(fx, 3_000n, 1_000n);
    await executeSplit(fx);

    // Constituent index 1 is NOT fx.tokens[0] == dividendAsset.
    const token = fx.tokens[1];
    const addr = fx.addrs[1];
    const reserveBefore = await fx.vault.reserveOf(addr);
    const divBefore = await fx.vault.totalDividendsReceived();
    const earmarkBefore = await fx.vault.buybackEarmarkWei(addr);

    const amount = E("50");
    await pushRoutedFee(fx, token, fx.bob, amount);
    await fx.vault.connect(fx.carol).reconcile(addr);

    // Buyback still carves its 10% out (it is token-agnostic, a pure
    // accounting slot). The dividend's 30% cannot apply (wrong asset), so it
    // falls back into reserve rather than vanishing: reserve gets 90%, not
    // the configured 60%.
    const expectedBuyback = (amount * 1_000n) / BPS;
    const expectedReserve = amount - expectedBuyback;

    expect((await fx.vault.totalDividendsReceived()) - divBefore).to.equal(0n);
    expect((await fx.vault.reserveOf(addr)) - reserveBefore).to.equal(expectedReserve);
    expect((await fx.vault.buybackEarmarkWei(addr)) - earmarkBefore).to.equal(expectedBuyback);
  });

  // ══ 4. The existing dividend accumulator behaves exactly as before ══════

  it("REGRESSION: receiveDividendsWrapped and claimDividend are byte-for-byte unaffected by any configured split", async () => {
    const fx = await deployOpenIndex();
    await queueSplit(fx, 5_000n, 5_000n); // 0% reserve left over, extreme config
    await executeSplit(fx);

    const token = fx.tokens[0];
    await token.connect(fx.alice).approve(fx.vaultAddr, ethers.MaxUint256);
    await token.mint(fx.alice.address, E("1000"));
    await fx.vault.connect(fx.alice).mintProRata(E("100"), [ethers.MaxUint256, ethers.MaxUint256, ethers.MaxUint256]);

    // The direct-push dividend path is untouched by the split: 100% of a
    // `receiveDividendsWrapped` push still lands in the accumulator, exactly
    // as IndexDividendAccrual.test.ts already proves in isolation.
    const before = await fx.vault.totalDividendsReceived();
    await fx.vault.connect(fx.alice).receiveDividendsWrapped(E("10"));
    expect((await fx.vault.totalDividendsReceived()) - before).to.equal(E("10"));

    const owed: bigint = await fx.vault.withdrawableDividendOf(fx.alice.address);
    expect(owed).to.be.greaterThan(0n);
    const balBefore: bigint = await token.balanceOf(fx.alice.address);
    await fx.vault.connect(fx.alice).claimDividend();
    expect((await token.balanceOf(fx.alice.address)) - balBefore).to.equal(owed);
  });

  it("CAPPED-ACCRUAL INVARIANT PRESERVED: total withdrawable never exceeds total received across mixed routed-fee and direct-push activity", async () => {
    const fx = await deployOpenIndex();
    await queueSplit(fx, 4_000n, 1_000n);
    await executeSplit(fx);

    const token = fx.tokens[0];
    const addr = fx.addrs[0];
    await token.connect(fx.alice).approve(fx.vaultAddr, ethers.MaxUint256);
    await token.mint(fx.alice.address, E("1000"));
    await fx.vault.connect(fx.alice).mintProRata(E("100"), [ethers.MaxUint256, ethers.MaxUint256, ethers.MaxUint256]);

    // Mix a routed-fee push (splits three ways) with a direct dividend push
    // (100% to the accumulator, unaffected).
    await pushRoutedFee(fx, token, fx.bob, E("30"));
    await fx.vault.connect(fx.carol).reconcile(addr);
    await token.mint(fx.carol.address, E("10"));
    await token.connect(fx.carol).approve(fx.vaultAddr, E("10"));
    await fx.vault.connect(fx.carol).receiveDividendsWrapped(E("10"));

    await fx.vault.connect(fx.alice).claimDividend();

    const received: bigint = await fx.vault.totalDividendsReceived();
    const withdrawn: bigint = await fx.vault.totalDividendsWithdrawn();
    let outstanding = 0n;
    const seedLock = await fx.vault.SEED_LOCK();
    for (const a of [fx.alice.address, fx.bob.address, fx.carol.address, seedLock]) {
      outstanding += await fx.vault.withdrawableDividendOf(a);
    }
    expect(withdrawn + outstanding).to.be.lessThanOrEqual(received);

    // No-overpromise-past-backing: the vault always holds at least
    // reserve + undrawn dividends + the buyback earmark, of that token.
    const held: bigint = await token.balanceOf(fx.vaultAddr);
    const reserve: bigint = await fx.vault.reserveOf(addr);
    const earmark: bigint = await fx.vault.buybackEarmarkWei(addr);
    expect(held).to.be.greaterThanOrEqual(reserve + (received - withdrawn) + earmark);
  });

  // ══ 5. Reserve-growth-only holders benefit without ever claiming ════════

  it("a holder who never claims still sees redemption value (NAV) rise from the reserve-growth share alone", async () => {
    const fx = await deployOpenIndex();
    await queueSplit(fx, 3_000n, 2_000n); // only 50% of a routed fee reaches reserve
    await executeSplit(fx);

    // Alice mints and then simply holds — she is standing in for "coin
    // parked in an external pool, no claim step ever taken": her balance
    // never moves again after this mint, and she calls nothing else.
    const token = fx.tokens[0];
    await token.connect(fx.alice).approve(fx.vaultAddr, ethers.MaxUint256);
    await token.mint(fx.alice.address, E("1000"));
    await fx.vault.connect(fx.alice).mintProRata(E("100"), [ethers.MaxUint256, ethers.MaxUint256, ethers.MaxUint256]);

    // NOTE: `executeSplit` above advances the clock past the timelock delay
    // (48h), which pushes every constituent's price observation past
    // `staleAfter` and pins `navLow` at zero (IndexOracle.band's documented
    // stale behavior) independent of anything under test here. `navHigh` is
    // unaffected by that staleness zeroing and moves one-for-one with
    // `c.reserve`, so it is the correct, uncontaminated probe for "did NAV
    // rise from reserve growth alone" in this fixture.
    const [, navHighBefore] = await fx.vault.nav();
    const supplyBefore: bigint = await fx.vault.totalSupply();

    // A routed fee lands and is reconciled by an unrelated third party —
    // Alice does nothing.
    await pushRoutedFee(fx, token, fx.bob, E("200"));
    await fx.vault.connect(fx.carol).reconcile(fx.addrs[0]);

    const [, navHighAfter] = await fx.vault.nav();
    const supplyAfter: bigint = await fx.vault.totalSupply();

    // Supply is unchanged (no mint/redeem happened), so any NAV increase is
    // purely the reserve-growth stream, and it is strictly positive even
    // though only 50% of the routed fee reached the reserve and Alice took
    // no action whatsoever.
    expect(supplyAfter).to.equal(supplyBefore);
    expect(navHighAfter).to.be.greaterThan(navHighBefore);
    expect(navHighAfter - navHighBefore).to.be.greaterThanOrEqual(E("99")); // >= the 50% reserve share, minus band/pricing slack
  });
});
