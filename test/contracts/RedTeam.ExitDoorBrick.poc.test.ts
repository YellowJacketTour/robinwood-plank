import { expect } from "chai";
import { ethers } from "hardhat";
import { takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import {
  indexVaultFactory,
  paramsTuple,
  defaultParams,
  WAD,
  TIMELOCK,
  maxIn,
  zeroOut,
} from "./helpers/index-vault";

/**
 * RED TEAM PoC — THE EXIT DOOR IS ONLY AS STRONG AS THE WEAKEST CONSTITUENT.
 *
 * ScopedRoles.sol's header states the system's single most important claimed
 * invariant:
 *
 *   "NO ROLE CAN BLOCK AN EXIT ... GlobalIndexVault's `redeemProRata` carries
 *    no role modifier and no state flag on any branch it takes, so it works
 *    while a change is queued, works with every role key simultaneously
 *    malicious, and works if every role holder is a dead address."
 *
 * All of that is true, and none of it is sufficient. `redeemProRata` loops
 * EVERY constituent and pays each leg with `SafeERC20.safeTransfer`, which
 * REVERTS. It burns the caller's shares BEFORE the loop, so one reverting leg
 * unwinds the entire transaction: the redeemer keeps their shares and cannot
 * exit at all, on ANY leg, ever.
 *
 * No role is needed. A single issuer of a single constituent — a USDC-shaped
 * blacklist, the most common token design in production — can do it, per user,
 * unilaterally, from outside the system.
 *
 * WrappedIndexShare already defends exactly this ("_payout is bounded-gas and
 * cannot revert the caller, so a reverting `transfer` cannot brick the other
 * legs"). The vault it wraps does not.
 */
/**
 * ── ROUND 10 STATUS: BOTH FINDINGS CLOSED ──────────────────────────────────
 * The attack SETUPS below are preserved verbatim, because they are what makes
 * this a regression test rather than a story. Only the ASSERTIONS changed:
 * where they used to pin the brick, they now pin the fault-tolerant deferral
 * that replaced it. See IndexExitDoorFaultTolerance.test.ts for the primary
 * proof and contracts/GlobalIndexVault.sol's `pendingClaim` header for the
 * mechanism.
 */
describe("RED TEAM — one constituent bricks the whole exit door (CLOSED, round 10)", () => {
  let __snap: SnapshotRestorer;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  const E = (n: string) => ethers.parseEther(n);

  async function deployWithBlacklistLeg() {
    const [, roleAdmin, seeder, alice, bob, , admission, risk, allocation] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockIndexToken");
    const Bad = await ethers.getContractFactory("MockBlacklistIndexToken");
    const Source = await ethers.getContractFactory("MockIndexPriceSource");

    const t0: any = await Token.deploy("cA", "cA");
    const t1: any = await Token.deploy("cB", "cB");
    // Leg 2 is the USDC-shaped one. Everything else about it is ordinary.
    const t2: any = await Bad.deploy("cUSD", "cUSD");
    const tokens = [t0, t1, t2];
    const sources = [
      await Source.deploy(100n * WAD, 100n * WAD),
      await Source.deploy(50n * WAD, 100n * WAD),
      await Source.deploy(200n * WAD, 100n * WAD),
    ];
    const addrs = await Promise.all(tokens.map((t) => t.getAddress()));

    const Vault = await indexVaultFactory();
    const vault: any = await Vault.deploy(
      "Marketplank Global Index",
      "gPLNK",
      [roleAdmin.address, admission.address, risk.address, allocation.address],
      seeder.address,
      TIMELOCK,
      paramsTuple(defaultParams),
      addrs[0]
    );
    const vaultAddr = await vault.getAddress();

    for (let i = 0; i < 3; i++) {
      await vault
        .connect(seeder)
        .seedConstituent(addrs[i], await sources[i].getAddress(), 3_333);
      await tokens[i].mint(seeder.address, 1000n * WAD);
      await tokens[i].connect(seeder).approve(vaultAddr, 1000n * WAD);
      await vault.connect(seeder).seedDeposit(addrs[i], 1000n * WAD);
    }
    await vault.connect(seeder).openIndex(1000n * WAD);

    for (const who of [alice, bob]) {
      for (const t of tokens) {
        await t.mint(who.address, 500_000n * WAD);
        await t.connect(who).approve(vaultAddr, ethers.MaxUint256);
      }
    }
    return { vault, vaultAddr, tokens, addrs, alice, bob, t2 };
  }

  it("PoC-C (CLOSED): a blacklisted holder now redeems every OTHER leg, and keeps a credit for the blocked one", async () => {
    const fx = await deployWithBlacklistLeg();

    await fx.vault.connect(fx.alice).mintProRata(E("1000"), maxIn(3));
    const shares = await fx.vault.balanceOf(fx.alice.address);
    expect(shares).to.be.gt(0n);

    // Baseline: the exit door works.
    await fx.vault.connect(fx.alice).redeemProRata(E("1"), zeroOut(3));

    // The issuer of ONE constituent freezes Alice. It has nothing to do with
    // the vault, needs no role, and the vault cannot appeal it.
    await fx.t2.setBlocked(fx.alice.address, true);

    const before = [
      await fx.tokens[0].balanceOf(fx.alice.address),
      await fx.tokens[1].balanceOf(fx.alice.address),
    ];
    const sharesBefore = await fx.vault.balanceOf(fx.alice.address);

    // THE FIX. This reverted before round 10; it now completes, and the two
    // perfectly healthy legs she owns outright are no longer trapped behind
    // leg 2's issuer.
    await fx.vault.connect(fx.alice).redeemProRata(E("1"), zeroOut(3));

    expect(await fx.tokens[0].balanceOf(fx.alice.address)).to.be.gt(before[0]);
    expect(await fx.tokens[1].balanceOf(fx.alice.address)).to.be.gt(before[1]);
    // The shares really were burned — this is a completed exit, not a no-op.
    expect(await fx.vault.balanceOf(fx.alice.address)).to.equal(sharesBefore - E("1"));

    // The blocked leg is held FOR HER, not lost and not left in the pool.
    const owed = await fx.vault.pendingClaim(fx.alice.address, fx.addrs[2]);
    expect(owed).to.be.gt(0n);
    expect(await fx.vault.reservedClaims(fx.addrs[2])).to.equal(owed);

    // ...and it is retryable the instant the issuer relents.
    await fx.t2.setBlocked(fx.alice.address, false);
    const held = await fx.tokens[2].balanceOf(fx.alice.address);
    await fx.vault.connect(fx.alice).claimPending(fx.addrs[2]);
    expect(await fx.tokens[2].balanceOf(fx.alice.address)).to.equal(held + owed);

    // An unblocked holder was never affected either way.
    await fx.vault.connect(fx.bob).mintProRata(E("10"), maxIn(3));
    await fx.vault.connect(fx.bob).redeemProRata(E("1"), zeroOut(3));
  });

  it("PoC-D (CLOSED): a vault-level freeze no longer closes the exit door for anyone", async () => {
    const fx = await deployWithBlacklistLeg();
    await fx.vault.connect(fx.alice).mintProRata(E("1000"), maxIn(3));
    await fx.vault.connect(fx.bob).mintProRata(E("1000"), maxIn(3));

    // The issuer freezes the VAULT itself (a real event: Tornado-sanction-era
    // USDC froze contract addresses, not just EOAs). This is the terminal,
    // systemic version of the attack — every holder at once.
    await fx.t2.setBlocked(fx.vaultAddr, true);

    const reserveAtFreeze = await fx.vault.reserveOf(fx.addrs[2]);
    for (const who of [fx.alice, fx.bob]) {
      const b0 = await fx.tokens[0].balanceOf(who.address);
      await fx.vault.connect(who).redeemProRata(E("1"), zeroOut(3));
      // The healthy legs pay, in the same transaction, to every holder.
      expect(await fx.tokens[0].balanceOf(who.address)).to.be.gt(b0);
      expect(await fx.vault.pendingClaim(who.address, fx.addrs[2])).to.be.gt(0n);
    }

    // THE DEADLOCK IS OPEN. The frozen leg's reserve can now be drawn DOWN —
    // by exactly the sum of what the holders were owed — where before it could
    // not move at all, which is what made `delistEmpty`'s `reserve == 0`
    // precondition unreachable by construction.
    const owedTotal =
      (await fx.vault.pendingClaim(fx.alice.address, fx.addrs[2])) +
      (await fx.vault.pendingClaim(fx.bob.address, fx.addrs[2]));
    expect(owedTotal).to.be.gt(0n);
    expect(await fx.vault.reserveOf(fx.addrs[2])).to.equal(reserveAtFreeze - owedTotal);
    expect(await fx.vault.reservedClaims(fx.addrs[2])).to.equal(owedTotal);

    // And the credits survive the freeze being lifted, at full value.
    await fx.t2.setBlocked(fx.vaultAddr, false);
    for (const who of [fx.alice, fx.bob]) {
      const owed = await fx.vault.pendingClaim(who.address, fx.addrs[2]);
      const held = await fx.tokens[2].balanceOf(who.address);
      await fx.vault.connect(who).claimPending(fx.addrs[2]);
      expect(await fx.tokens[2].balanceOf(who.address)).to.equal(held + owed);
    }
    expect(await fx.vault.reservedClaims(fx.addrs[2])).to.equal(0n);
  });
});
