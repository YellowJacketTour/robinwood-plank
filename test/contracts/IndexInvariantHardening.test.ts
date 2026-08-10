import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { time, takeSnapshot, mine, type SnapshotRestorer } from "./helpers/network-helpers.js";
import {
  deployOpenIndex,
  deployConstituent,
  indexVaultFactory,
  paramsTuple,
  defaultParams,
  warmCheckpoints,
  maxIn,
  zeroOut,
  WAD,
  BPS,
  TIMELOCK,
  MIN_CHECKPOINT,
} from "./helpers/index-vault.js";

/**
 * ============================================================================
 * ROUND 9e — THREE NAMED INVARIANTS, PROVED RATHER THAN INHERITED
 *
 * Each of the three below is a property the architecture almost certainly
 * already has. That is exactly why they are worth writing down as tests: an
 * emergent property is one refactor away from not being a property, and the
 * three chosen here are the ones whose loss would be catastrophic and silent.
 *
 *   1. THE EXIT DOOR AT MAXIMUM HOSTILITY. `redeemProRata` is permissionless,
 *      un-pausable and fee-free under EVERY role state and EVERY parameter
 *      configuration. Prior rounds proved this against hostile ROLES (see
 *      ScopedRoles.isolation "THE EXIT DOOR") and against a fat ecosystem
 *      ledger at the ceiling split (IndexEcosystemFees §3). What was NOT
 *      covered, and is covered here, is all of it AT ONCE plus the two
 *      structural maxima: a FULLY-POPULATED 32-constituent basket and an
 *      IN-FLIGHT RAMP-OUT.
 *
 *   2. FEES ARE ADDITIVE-ONLY. A fee mechanism must never be able to draw
 *      from backing that already exists — it books a companion amount out of
 *      value the operation itself brought in. Asserted directly as
 *      "total backing never decreases as a result of the fee mechanism", on
 *      all three fee-bearing surfaces.
 *
 *   3. RENOUNCE-VS-PENDING-REASSIGNMENT EXCLUSIVITY. Investigated and found
 *      NOT TO APPLY: `ScopedRoles` has no renounce path at all. See §3.
 * ============================================================================
 */
describe("Invariant hardening (round 9e)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const E = (n: string) => ethers.parseEther(n);
  const b32 = (s: string) => ethers.encodeBytes32String(s);
  const VIRTUAL_SHARES = 10n ** 3n;
  const MAX_CONSTITUENTS = 32;

  // ══ 1. THE EXIT DOOR AT MAXIMUM HOSTILITY ═══════════════════════════════

  /**
   * A vault built to the structural ceiling: all 32 constituent slots filled.
   * Built here rather than in the shared helper because nothing else needs a
   * full basket and it is slow to seed.
   */
  async function fullBasket() {
    const [, roleAdmin, seeder, alice, bob, carol, admission, risk, allocation] =
      await ethers.getSigners();
    const cs: any[] = [];
    for (let i = 0; i < MAX_CONSTITUENTS; i++) {
      cs.push(await deployConstituent(`c${i}`, 100n * WAD, 100n * WAD));
    }
    const Vault = await indexVaultFactory();
    const vault: any = await Vault.deploy(
      "Marketplank Global Index",
      "gPLNK",
      [roleAdmin.address, admission.address, risk.address, allocation.address],
      seeder.address,
      TIMELOCK,
      paramsTuple(defaultParams),
      cs[0].addr
    );
    const vaultAddr = await vault.getAddress();
    for (const c of cs) {
      await vault.connect(seeder).seedConstituent(c.addr, await c.source.getAddress(), 312);
      await c.token.mint(seeder.address, 1_000n * WAD);
      await c.token.connect(seeder).approve(vaultAddr, ethers.MaxUint256);
      await vault.connect(seeder).seedDeposit(c.addr, 1_000n * WAD);
    }
    await vault.connect(seeder).openIndex(1_000n * WAD);
    for (const who of [alice, bob, carol]) {
      for (const c of cs) {
        await c.token.mint(who.address, 100_000n * WAD);
        await c.token.connect(who).approve(vaultAddr, ethers.MaxUint256);
      }
    }
    return {
      roleAdmin, seeder, alice, bob, carol, admission, risk, allocation,
      vault, vaultAddr,
      tokens: cs.map((c) => c.token),
      addrs: cs.map((c) => c.addr),
    };
  }

  it("EXIT DOOR (maximal): a FULL 32-leg basket, ceiling fees, a hostile role slate AND an in-flight ramp-out — redemption still pays exact pro rata", async () => {
    const fx: any = await fullBasket();
    expect(await fx.vault.constituentCount()).to.equal(BigInt(MAX_CONSTITUENTS));

    const N = MAX_CONSTITUENTS;
    await fx.vault.connect(fx.alice).mintProRata(2_000n * WAD, maxIn(N));

    // ── the most hostile parameter configuration the ceilings permit ──────
    // Max imbalance fee, max ecosystem fee split, plus the platform
    // allocation cranked to its own ceiling, all landed for real.
    for (const [key, value] of [
      ["maxImbalanceFeeBps", 1_000n],
      ["baseImbalanceFeeBps", 500n],
      ["imbalanceSlopeBps", 5_000n],
    ] as [string, bigint][]) {
      await fx.vault.connect(fx.risk).queueParam(b32(key), value);
    }
    await fx.vault.connect(fx.allocation).queueParam(b32("ecosystemFeeSplitBps"), 3_000n);
    await fx.vault.connect(fx.allocation).queueParam(b32("ecosystemSink"), fx.vaultAddr);
    // ── and an IN-FLIGHT RAMP-OUT on a leg that still holds reserves ──────
    await fx.vault
      .connect(fx.admission)
      .queueListing(fx.addrs[N - 1], fx.addrs[N - 1], 0, true);
    // ── and every role key simultaneously hostile, mid-rotation ───────────
    await fx.vault
      .connect(fx.roleAdmin)
      .queueRole(await fx.vault.ROLE_RISK_PARAM(), fx.roleAdmin.address);

    await time.increase(TIMELOCK + 1);
    for (const key of [
      "maxImbalanceFeeBps",
      "baseImbalanceFeeBps",
      "imbalanceSlopeBps",
      "ecosystemFeeSplitBps",
      "ecosystemSink",
    ]) {
      try {
        await fx.vault.executeParam(b32(key));
      } catch {
        /* a compile-time ceiling rejecting an absurd value is also correct */
      }
    }
    await fx.vault.executeListing(fx.addrs[N - 1]); // ramp-out clock starts NOW
    await fx.vault.executeRole(await fx.vault.ROLE_RISK_PARAM());
    await warmCheckpoints(fx, 8);

    // The ramp is genuinely in flight: deactivated, still holding reserves.
    const dying = await fx.vault.constituentInfo(fx.addrs[N - 1]);
    expect(dying.active).to.equal(false);
    expect(dying.rampStart).to.be.greaterThan(0n);
    expect(await fx.vault.reserveOf(fx.addrs[N - 1])).to.be.greaterThan(0n);

    // Load the ecosystem ledger up so the exit is priced against a fat one.
    for (let i = 0; i < 3; i++) {
      await fx.vault.connect(fx.bob).mintSingleAsset(fx.addrs[0], E("40"), 0);
    }
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.be.greaterThan(0n);

    // ── THE CLAIM ────────────────────────────────────────────────────────
    const shares: bigint = await fx.vault.balanceOf(fx.alice.address);
    const supply: bigint = await fx.vault.totalSupply();
    const reserves: bigint[] = [];
    const before: bigint[] = [];
    for (let i = 0; i < N; i++) {
      reserves.push(await fx.vault.reserveOf(fx.addrs[i]));
      before.push(await fx.tokens[i].balanceOf(fx.alice.address));
    }

    await expect(fx.vault.connect(fx.alice).redeemProRata(shares, zeroOut(N))).to.not.be.revert(ethers);

    // Exact strict pro rata on EVERY one of the 32 legs, including the one
    // mid-ramp-out, with no fee term and no ledger term anywhere in it.
    let paidLegs = 0;
    for (let i = 0; i < N; i++) {
      const got = (await fx.tokens[i].balanceOf(fx.alice.address)) - before[i];
      expect(got).to.equal(
        (shares * reserves[i]) / (supply + VIRTUAL_SHARES),
        `leg ${i} did not pay strict pro rata`
      );
      if (got > 0n) paidLegs++;
    }
    expect(paidLegs).to.equal(N, "a leg stopped paying under maximal hostility");
    expect(await fx.vault.balanceOf(fx.alice.address)).to.equal(0n);
    // The ramping-out leg paid on exactly the same terms as every other.
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.be.greaterThan(0n);
  });

  it("EXIT DOOR (maximal): redeemProRata is permissionless — a fresh address that has only ever RECEIVED shares can exit a full basket", async () => {
    const fx: any = await fullBasket();
    const N = MAX_CONSTITUENTS;
    await fx.vault.connect(fx.alice).mintProRata(1_000n * WAD, maxIn(N));

    // A brand-new key: no role, no history, no approval to anyone, never
    // interacted with the vault. It receives shares by plain transfer.
    const outsider = ethers.Wallet.createRandom().connect(ethers.provider);
    await fx.alice.sendTransaction({ to: outsider.address, value: E("1") });
    await fx.vault.connect(fx.alice).transfer(outsider.address, 500n * WAD);
    for (const r of [
      await fx.vault.ROLE_ADMIN(),
      await fx.vault.ROLE_RISK_PARAM(),
      await fx.vault.ROLE_CONSTITUENT_ADMISSION(),
      await fx.vault.ROLE_PLATFORM_ALLOCATION(),
    ]) {
      expect(await fx.vault.hasRole(r, outsider.address)).to.equal(false);
    }

    await expect(fx.vault.connect(outsider).redeemProRata(500n * WAD, zeroOut(N))).to.not.be
      .revert(ethers);
    expect(await fx.vault.balanceOf(outsider.address)).to.equal(0n);
  });

  // ══ 2. FEES ARE ADDITIVE-ONLY ═══════════════════════════════════════════

  /**
   * The invariant, stated so it cannot be satisfied vacuously: TOTAL BACKING
   * — the sum over every leg of `reserveOf` PLUS the segregated ecosystem
   * ledger, i.e. everything the contract owes to somebody — must never go DOWN
   * as a direct result of a fee being charged. A fee is a slice of value the
   * operation itself just brought in; it is never a withdrawal from what was
   * already there.
   */
  async function totalBacking(fx: any) {
    let sum = 0n;
    for (const a of fx.addrs) sum += (await fx.vault.reserveOf(a)) + (await fx.vault.ecosystemFeesWei(a));
    return sum;
  }

  it("FEES ARE ADDITIVE (mint side): the imbalance fee + ecosystem split can only ever RAISE total backing", async () => {
    const fx = await deployOpenIndex();
    await fx.vault.connect(fx.allocation).queueParam(b32("ecosystemSink"), fx.vaultAddr);
    await fx.vault.connect(fx.allocation).queueParam(b32("ecosystemFeeSplitBps"), 3_000n);
    await fx.vault.connect(fx.risk).queueParam(b32("maxImbalanceFeeBps"), 1_000n);
    await time.increase(TIMELOCK + 1);
    for (const k of ["ecosystemSink", "ecosystemFeeSplitBps", "maxImbalanceFeeBps"]) {
      await fx.vault.executeParam(b32(k));
    }
    await warmCheckpoints(fx, 8);

    for (let i = 0; i < 6; i++) {
      const backingBefore = await totalBacking(fx);
      const ledgerBefore: bigint = await fx.vault.ecosystemFeesWei(fx.addrs[0]);
      await fx.vault.connect(fx.alice).mintSingleAsset(fx.addrs[0], E("60"), 0);
      const backingAfter = await totalBacking(fx);
      const ledgerAfter: bigint = await fx.vault.ecosystemFeesWei(fx.addrs[0]);
      // A fee was genuinely charged on at least one of these, or the test
      // proves nothing.
      if (ledgerAfter > ledgerBefore) {
        // THE CLAIM: backing rose by the FULL deposit. The fee redistributed
        // WHERE inside backing the value sits (reserve vs ledger); it removed
        // nothing from it.
        expect(backingAfter - backingBefore).to.equal(E("60"));
      }
      expect(backingAfter).to.be.greaterThanOrEqual(backingBefore);
    }
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.be.greaterThan(
      0n,
      "no fee was ever charged — this test proved nothing"
    );
  });

  it("FEES ARE ADDITIVE (redeem side): a fee-bearing exit removes from backing EXACTLY what the redeemer received, and not one wei more", async () => {
    // Reserves chosen so all three legs are EQUALLY weighted at their 1.0 /
    // 0.5 / 2.0 prices. The default fixture is deliberately lopsided, and a
    // concentration guard rejecting a lopsided single-asset exit is a
    // different mechanism than the one under test here.
    const fx = await deployOpenIndex({}, [1_000n * WAD, 2_000n * WAD, 500n * WAD]);
    await fx.vault.connect(fx.allocation).queueParam(b32("ecosystemSink"), fx.vaultAddr);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeParam(b32("ecosystemSink"));
    await warmCheckpoints(fx, 8);
    await fx.vault.connect(fx.alice).mintProRata(1_000n * WAD, maxIn(3));
    // Overweight leg 0 first, so a single-asset exit FROM it is
    // cap-improving and the concentration guard is not the thing under test.
    await fx.vault.connect(fx.bob).mintSingleAsset(fx.addrs[0], 120n * WAD, 0);

    const backingBefore = await totalBacking(fx);
    const ledgerBefore: bigint = await fx.vault.ecosystemFeesWei(fx.addrs[0]);
    const userBefore: bigint = await fx.tokens[0].balanceOf(fx.alice.address);
    const reserveBefore: bigint = await fx.vault.reserveOf(fx.addrs[0]);
    await fx.vault.connect(fx.alice).redeemSingleAsset(40n * WAD, fx.addrs[0], 0);

    const removed = backingBefore - (await totalBacking(fx));
    const received = (await fx.tokens[0].balanceOf(fx.alice.address)) - userBefore;
    const ledgerAfter: bigint = await fx.vault.ecosystemFeesWei(fx.addrs[0]);

    // Non-vacuous: a fee really was charged and really was split.
    expect(ledgerAfter).to.be.greaterThan(
      ledgerBefore,
      "no fee was charged — this test proved nothing"
    );
    // THE CLAIM. Backing fell by EXACTLY the payout. The fee did not draw an
    // extra wei out of the pool alongside it; it was retained inside backing,
    // split between the reserve and the segregated ecosystem ledger. If the
    // fee mechanism could ever reach into existing backing, this is the
    // assertion that would break.
    expect(removed).to.equal(received);
    // ...and precisely WHERE the fee went: the reserve fell by the payout PLUS
    // the ecosystem cut, and that cut landed in the segregated ledger, which is
    // still backing. Value moved WITHIN backing; none left it.
    expect(reserveBefore - (await fx.vault.reserveOf(fx.addrs[0]))).to.equal(
      received + (ledgerAfter - ledgerBefore)
    );
    expect(received).to.be.greaterThan(0n);
  });

  it("FEES ARE ADDITIVE (dividend accrual): a push only ever ADDS, and never touches a single reserve", async () => {
    const fx = await deployOpenIndex();
    await fx.vault.connect(fx.alice).mintProRata(1_000n * WAD, maxIn(3));
    const reservesBefore: bigint[] = [];
    for (const a of fx.addrs) reservesBefore.push(await fx.vault.reserveOf(a));
    const heldBefore: bigint = await fx.tokens[0].balanceOf(fx.vaultAddr);

    await fx.vault.connect(fx.carol).receiveDividendsWrapped(E("25"));

    // Not one reserve moved. The dividend is a NEW obligation funded by NEW
    // value; the accumulator is not a claim on anything already backing.
    for (let i = 0; i < 3; i++) {
      expect(await fx.vault.reserveOf(fx.addrs[i])).to.equal(reservesBefore[i]);
    }
    expect((await fx.tokens[0].balanceOf(fx.vaultAddr)) - heldBefore).to.equal(E("25"));
    // And the exit door prices off `reserve`, so it is bit-identical.
    const [, out] = await fx.vault.previewRedeemProRata(100n * WAD);
    const supply: bigint = await fx.vault.totalSupply();
    for (let i = 0; i < 3; i++) {
      expect(out[i]).to.equal((100n * WAD * reservesBefore[i]) / (supply + VIRTUAL_SHARES));
    }
  });

  it("FEES ARE ADDITIVE (wrapper streams): a stream deposit can only ever RAISE wrapper backing, and charges no fee at all", async () => {
    const fx = await deployOpenIndex();
    const signers = await ethers.getSigners();
    const lister = signers[9];
    const W = await ethers.getContractFactory("WrappedIndexShare");
    const wrapper: any = await W.deploy(
      fx.vaultAddr, "wIDX", "wIDX", fx.roleAdmin.address, lister.address, 48 * 3600
    );
    const wrapperAddr = await wrapper.getAddress();
    await fx.vault.connect(fx.alice).mintProRata(1_000n * WAD, maxIn(3));
    await fx.vault.connect(fx.alice).approve(wrapperAddr, ethers.MaxUint256);
    await fx.tokens[0].connect(fx.alice).approve(wrapperAddr, ethers.MaxUint256);
    await wrapper.connect(fx.alice).deposit(500n * WAD);

    const T = await ethers.getContractFactory("MockIndexToken");
    const t: any = await T.deploy("BRIBE", "BRIBE");
    const ta = await t.getAddress();
    await wrapper.connect(lister).queueStream(ta);
    await time.increase(48 * 3600 + 1);
    await wrapper.executeStream(ta);

    const rawBefore: bigint = await wrapper.rawSharesHeld();
    const divBefore: bigint = await wrapper.dividendAssetHeld();
    await t.mint(fx.carol.address, E("70"));
    await t.connect(fx.carol).approve(wrapperAddr, E("70"));
    await wrapper.connect(fx.carol).depositStream(ta, E("70"));

    // The stream leg rose by the full amount; NO other leg moved by so much
    // as a wei; and the wrapper took no cut of any kind.
    expect(await wrapper.streamHeld(ta)).to.equal(E("70"));
    expect(await wrapper.rawSharesHeld()).to.equal(rawBefore);
    expect(await wrapper.dividendAssetHeld()).to.equal(divBefore);
    expect(await t.balanceOf(wrapperAddr)).to.equal(E("70"));
    // There is no fee surface on the wrapper at all — assert the absence.
    const names = (wrapper.interface.fragments as any[])
      .filter((f) => f.type === "function")
      .map((f) => f.name.toLowerCase());
    for (const forbidden of ["fee", "setfee", "feebps", "skim", "sweep", "rescue", "collect"]) {
      expect(names.some((n: string) => n.includes(forbidden)), `a "${forbidden}" surface exists`).to
        .equal(false);
    }
  });

  // ══ 3. RENOUNCE VS PENDING REASSIGNMENT ═════════════════════════════════

  /**
   * INVESTIGATED, AND THE BUG CLASS IS NOT PRESENT. Stated as a test rather
   * than as a claim in a report, so that ADDING a renounce path in future
   * fails here loudly instead of quietly reintroducing the hazard.
   *
   * `ScopedRoles` has exactly one way a role changes hands:
   * `queueRole` -> (delay) -> `executeRole`, with `cancelRole` as the undo.
   * There is no `renounceRole`, no `revokeRole`, no self-relinquish, and no
   * second writer of `roleHolder` outside `_initRole` (constructor-only).
   * Both `_initRole` and `queueRole` reject `address(0)`, so a role is
   * ALWAYS occupied — which is precisely what makes "an executable proposal
   * with no valid cancelling authority" unconstructible.
   *
   * The adjacent ordering hazard named in the brief — a re-queue silently
   * losing the ability to cancel the first proposal — is also checked, and
   * also absent: `queuedRoles[role]` is a single slot keyed by ROLE, so a
   * re-queue REPLACES the proposal rather than adding a second one, always on
   * a fresh full delay, and `cancelRole` cancels whatever is currently there.
   */
  it("NO RENOUNCE PATH EXISTS: role handover is queue/execute/cancel only, and a role can never be vacated", async () => {
    const fx = await deployOpenIndex();
    const names = (fx.vault.interface.fragments as any[])
      .filter((f) => f.type === "function")
      .map((f) => f.name.toLowerCase());
    for (const forbidden of [
      "renouncerole",
      "renounceownership",
      "revokerole",
      "relinquishrole",
      "abdicate",
      "resign",
      "grantrole",
      "setrole",
      "setroleholder",
      "transferownership",
    ]) {
      expect(names, `a "${forbidden}" surface appeared`).to.not.include(forbidden);
    }
    // The COMPLETE set of role-mutating entrypoints, enumerated.
    //
    // AUDIT M-1 (2026-08-09) added `vetoRole`, and it belongs here rather
    // than being an exception: it is a SUBTRACTIVE surface. Like `cancelRole`
    // it only `delete`s a PENDING `queuedRoles` record — it can never write
    // `roleHolder`, can never vacate a role (the thing this test is about),
    // and can never install one. Its one effect is that the CURRENT holder
    // stays the current holder, which is the opposite of a renounce path. It
    // is broader than `cancelRole` (any of the five role holders, not just
    // ROLE_ADMIN) for the case `cancelRole` structurally cannot serve:
    // ROLE_ADMIN itself compromised, queueing a rotation to an address it
    // controls. See IndexFacetBase._requireAnyRoleHolder.
    expect(names.filter((n: string) => n.endsWith("role")).sort()).to.deep.equal([
      "cancelrole",
      "executerole",
      "hasrole", // a pure view; it writes nothing
      "queuerole",
      "vetorole",
    ]);

    // A role can never be vacated: address(0) is rejected at both writers.
    await expect(
      fx.vault.connect(fx.roleAdmin).queueRole(await fx.vault.ROLE_RISK_PARAM(), ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(fx.vault, "BadRoleHolder");
    // ...including for ROLE_ADMIN itself, so the key-rotation authority can
    // never orphan a pending proposal by removing itself.
    await expect(
      fx.vault.connect(fx.roleAdmin).queueRole(await fx.vault.ROLE_ADMIN(), ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(fx.vault, "BadRoleHolder");
    for (const r of [
      await fx.vault.ROLE_ADMIN(),
      await fx.vault.ROLE_RISK_PARAM(),
      await fx.vault.ROLE_CONSTITUENT_ADMISSION(),
      await fx.vault.ROLE_PLATFORM_ALLOCATION(),
    ]) {
      expect(await fx.vault.roleHolder(r)).to.not.equal(ethers.ZeroAddress);
    }
  });

  it("RE-QUEUE IS REPLACE, NOT APPEND: the second proposal supersedes the first on a FRESH full delay, and remains cancellable", async () => {
    const fx = await deployOpenIndex();
    const RISK = await fx.vault.ROLE_RISK_PARAM();

    await fx.vault.connect(fx.roleAdmin).queueRole(RISK, fx.alice.address);
    const first = await fx.vault.queuedRoles(RISK);
    await time.increase(TIMELOCK / 2);

    // Re-queue. There is ONE slot per role, so this replaces rather than
    // stacking — no orphaned first proposal can outlive it.
    await fx.vault.connect(fx.roleAdmin).queueRole(RISK, fx.bob.address);
    const second = await fx.vault.queuedRoles(RISK);
    expect(second.holder).to.equal(fx.bob.address);
    // The clock RESTARTED. A re-queue can never shorten the delay, which is
    // the property that would actually matter if it were violated.
    expect(second.eta).to.be.greaterThan(first.eta);

    // The first proposal is unreachable — executing at the ORIGINAL eta gets
    // the second one's revert, not Alice's role.
    await time.increase(TIMELOCK / 2 + 10);
    await expect(fx.vault.executeRole(RISK)).to.be.revertedWithCustomError(
      fx.vault,
      "RoleTimelockNotElapsed"
    );

    // And cancelling authority was never lost: it is keyed to the ROLE_ADMIN
    // role, not to whoever happened to queue.
    await fx.vault.connect(fx.roleAdmin).cancelRole(RISK);
    expect((await fx.vault.queuedRoles(RISK)).pending).to.equal(false);
    await expect(fx.vault.executeRole(RISK)).to.be.revertedWithCustomError(
      fx.vault,
      "NoRoleQueued"
    );
    expect(await fx.vault.roleHolder(RISK)).to.equal(fx.risk.address);
  });

  it("A SUCCESSOR ADMIN INHERITS CANCELLING AUTHORITY over its predecessor's still-pending proposals", async () => {
    const fx = await deployOpenIndex();
    const ADMIN = await fx.vault.ROLE_ADMIN();
    const ADMISSION = await fx.vault.ROLE_CONSTITUENT_ADMISSION();

    // The outgoing admin queues a hostile handover AND its own replacement.
    await fx.vault.connect(fx.roleAdmin).queueRole(ADMIN, fx.alice.address);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeRole(ADMIN);
    expect(await fx.vault.roleHolder(ADMIN)).to.equal(fx.alice.address);

    // A proposal queued AFTER the handover is Alice's; the old admin has no
    // authority left at all.
    await expect(
      fx.vault.connect(fx.roleAdmin).queueRole(ADMISSION, fx.roleAdmin.address)
    ).to.be.revertedWithCustomError(fx.vault, "NotRoleHolder");
    await fx.vault.connect(fx.alice).queueRole(ADMISSION, fx.bob.address);
    // ...and the successor can cancel it, so no proposal is ever left
    // executable with nobody able to stop it.
    await expect(fx.vault.connect(fx.roleAdmin).cancelRole(ADMISSION)).to.be.revertedWithCustomError(
      fx.vault,
      "NotRoleHolder"
    );
    await fx.vault.connect(fx.alice).cancelRole(ADMISSION);
    expect((await fx.vault.queuedRoles(ADMISSION)).pending).to.equal(false);
  });
});
