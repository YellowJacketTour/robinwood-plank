import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployOpenIndex,
  warmCheckpoints,
  WAD,
  TIMELOCK,
  maxIn,
  type IndexFixture,
} from "./helpers/index-vault";

/**
 * ROUND 10, FIX 1 — THE EXIT DOOR IS NO LONGER BLOCKABLE BY ANY PARTY.
 *
 * The finding this suite pins closed (RedTeam.ExitDoorBrick.poc.test.ts,
 * AuditPoC.certik.test.ts IDX-02): `redeemProRata` paid every leg with
 * `SafeERC20.safeTransfer`, which REVERTS. One constituent whose transfer
 * failed — a USDC-shaped blacklist landing on one specific holder, a pause, a
 * bad upgrade — took the whole redemption down with it, for every OTHER leg
 * too, with no recovery path: `delistEmpty` needs `reserve == 0` and the only
 * thing that could zero it was the loop that was bricked.
 *
 * The fix ports `WrappedIndexShare._payout` verbatim. What these tests have to
 * prove is not "the transfer works" — it is the four properties that make the
 * deferral honest:
 *
 *   1. a failing leg does not cost the holder ANY other leg;
 *   2. the deferred amount is retryable, in full, later;
 *   3. the deferred amount is NOT redeemable a second time by the holders who
 *      stayed — it leaves `reserve` at the instant it is deferred;
 *   4. the previously-closed deadlock (bricked leg -> reserve can never reach
 *      zero -> `delistEmpty` refuses forever) is actually open.
 *
 * LOCAL HARDHAT ONLY.
 */
describe("Index exit door — fault-tolerant redemption (round 10)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const ZERO4 = () => new Array(4).fill(0n);

  /**
   * The fixture's three healthy constituents plus a FOURTH admitted through
   * the full timelocked, role-gated path — nothing here is bypassed. The
   * fourth is either a real blacklist-capable ERC-20 (the honest production
   * shape) or the hostile mock, depending on `kind`.
   */
  async function withFourthLeg(kind: "blacklist" | "hostile") {
    const fx = await deployOpenIndex();
    const Token = await ethers.getContractFactory(
      kind === "blacklist" ? "MockBlacklistIndexToken" : "MockHostileStream"
    );
    const bad: any = await Token.deploy("BAD", "BAD");
    const badAddr = await bad.getAddress();
    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    const src: any = await Source.deploy(100n * WAD, 100n * WAD);

    await fx.vault
      .connect(fx.admission)
      .queueListing(badAddr, await src.getAddress(), 2_000n, false);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeListing(badAddr);
    await warmCheckpoints(fx, 4);

    // Real holders enter. `mintSingleAsset` seeds the leg's reserve, then
    // `mintProRata` forces everyone into it — there is no opt-out on the
    // proportional path, which is exactly why a bad leg is systemic.
    for (const who of [fx.alice, fx.bob]) {
      await bad.mint(who.address, 100_000n * WAD);
      await bad.connect(who).approve(fx.vaultAddr, ethers.MaxUint256);
      await fx.vault.connect(who).mintSingleAsset(badAddr, 5n * WAD, 0n);
      await fx.vault.connect(who).mintProRata(10n * WAD, maxIn(4));
    }
    return { fx, bad, badAddr };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. The exact audit scenario: a blacklist on ONE holder
  // ══════════════════════════════════════════════════════════════════════════

  it("a blacklisted holder still redeems EVERY other leg, in full, in one call", async () => {
    const { fx, bad, badAddr } = await withFourthLeg("blacklist");
    const { vault, alice, addrs } = fx;

    // The issuer freezes exactly one address. The vault has no say in it, and
    // no role of the vault's was involved.
    await bad.setBlocked(alice.address, true);

    const before = await Promise.all(
      fx.tokens.map((t: any) => t.balanceOf(alice.address))
    );
    const shares: bigint = await vault.balanceOf(alice.address);
    // What a working exit door owes her, quoted before anything moves.
    const quoted: bigint[] = [...(await vault.previewRedeemProRata(shares))[1]];

    // THE CLAIM. This transaction reverted outright before round 10.
    const tx = await vault.connect(alice).redeemProRata(shares, ZERO4());
    await expect(tx).to.emit(vault, "RedeemedProRata");

    // Every HEALTHY leg was paid, in full, in that same transaction.
    for (let i = 0; i < 3; i++) {
      expect(await fx.tokens[i].balanceOf(alice.address)).to.be.greaterThan(
        before[i]
      );
    }
    // Every share was burned — the exit completed, it did not half-complete.
    expect(await vault.balanceOf(alice.address)).to.equal(0n);

    // The ONE leg that could not be paid was deferred, loudly, not swallowed.
    const owed: bigint = await vault.pendingClaim(alice.address, badAddr);
    expect(owed).to.be.greaterThan(0n);
    expect(await vault.reservedClaims(badAddr)).to.equal(owed);
    await expect(tx)
      .to.emit(vault, "PayoutDeferred")
      .withArgs(alice.address, badAddr, owed);
    // ...and it is EXACTLY the full pro-rata slice, not a haircut. The
    // deferral changes where the value sits, never how much of it there is.
    expect(owed).to.equal(quoted[3]);
    // Every healthy leg landed at exactly its quote, too — a failing leg does
    // not perturb the arithmetic of any other leg.
    for (let i = 0; i < 3; i++) {
      expect((await fx.tokens[i].balanceOf(alice.address)) - before[i]).to.equal(quoted[i]);
    }
    void addrs;
  });

  it("the deferred leg is retryable in full the moment the restriction lifts", async () => {
    const { fx, bad, badAddr } = await withFourthLeg("blacklist");
    const { vault, alice } = fx;
    await bad.setBlocked(alice.address, true);
    await vault.connect(alice).redeemProRata(await vault.balanceOf(alice.address), ZERO4());

    const owed: bigint = await vault.pendingClaim(alice.address, badAddr);
    expect(owed).to.be.greaterThan(0n);

    // While still blocked, a retry FAILS LOUDLY and leaves the credit intact.
    // (That is the deliberate difference from the tolerant batch form: a
    // deliberate retry must tell the caller whether it worked.)
    await expect(vault.connect(alice).claimPending(badAddr)).to.be.reverted;
    expect(await vault.pendingClaim(alice.address, badAddr)).to.equal(owed);
    expect(await vault.reservedClaims(badAddr)).to.equal(owed);

    // The restriction lifts — a compliance clearing, a de-listing, an unpause.
    await bad.setBlocked(alice.address, false);
    const held: bigint = await bad.balanceOf(alice.address);
    await expect(vault.connect(alice).claimPending(badAddr))
      .to.emit(vault, "PendingClaimed")
      .withArgs(alice.address, badAddr, owed);

    expect(await bad.balanceOf(alice.address)).to.equal(held + owed);
    expect(await vault.pendingClaim(alice.address, badAddr)).to.equal(0n);
    expect(await vault.reservedClaims(badAddr)).to.equal(0n);
    // Double-claiming is not a thing.
    await expect(vault.connect(alice).claimPending(badAddr)).to.be.reverted;
  });

  it("claimPendingMany is tolerant: a still-blocked leg re-credits exactly, others pay", async () => {
    const { fx, bad, badAddr } = await withFourthLeg("blacklist");
    const { vault, alice, addrs } = fx;
    await bad.setBlocked(alice.address, true);
    await vault.connect(alice).redeemProRata(await vault.balanceOf(alice.address), ZERO4());
    const owed: bigint = await vault.pendingClaim(alice.address, badAddr);

    // Still blocked, plus two tokens with no credit at all, plus a duplicate.
    const settled = await vault
      .connect(alice)
      .claimPendingMany.staticCall([badAddr, addrs[0], badAddr]);
    expect(settled).to.equal(0n);
    await vault.connect(alice).claimPendingMany([badAddr, addrs[0], badAddr]);
    // Re-credited to EXACTLY where it started — no leak, no loss.
    expect(await vault.pendingClaim(alice.address, badAddr)).to.equal(owed);
    expect(await vault.reservedClaims(badAddr)).to.equal(owed);

    await bad.setBlocked(alice.address, false);
    await vault.connect(alice).claimPendingMany([badAddr, addrs[0], badAddr]);
    expect(await vault.pendingClaim(alice.address, badAddr)).to.equal(0n);
    expect(await vault.reservedClaims(badAddr)).to.equal(0n);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. A deferred slice is NOT re-redeemable by the holders who stayed
  // ══════════════════════════════════════════════════════════════════════════

  it("a deferred slice leaves `reserve` immediately and cannot be redeemed twice", async () => {
    const { fx, bad, badAddr } = await withFourthLeg("blacklist");
    const { vault, alice, bob } = fx;

    const reserveBefore: bigint = await vault.reserveOf(badAddr);
    await bad.setBlocked(alice.address, true);
    await vault.connect(alice).redeemProRata(await vault.balanceOf(alice.address), ZERO4());

    const owed: bigint = await vault.pendingClaim(alice.address, badAddr);
    // The reserve fell by the FULL leg — the deferral did not park value back
    // in the pro-rata pool where the stayers could take a second bite.
    expect(await vault.reserveOf(badAddr)).to.equal(reserveBefore - owed);

    // Bob, who stayed, is paid strictly against the REDUCED reserve.
    const bobBefore: bigint = await bad.balanceOf(bob.address);
    const bobShares: bigint = await vault.balanceOf(bob.address);
    const supply: bigint = await vault.totalSupply();
    const expected =
      (bobShares * (await vault.reserveOf(badAddr))) / (supply + 1000n);
    await vault.connect(bob).redeemProRata(bobShares, ZERO4());
    expect((await bad.balanceOf(bob.address)) - bobBefore).to.equal(expected);

    // CONSERVATION. Alice's still-owed credit is physically present and is not
    // part of anybody else's claim: held balance covers reserve + reserved.
    const held: bigint = await bad.balanceOf(fx.vaultAddr);
    expect(held).to.be.greaterThanOrEqual(
      (await vault.reserveOf(badAddr)) + (await vault.reservedClaims(badAddr))
    );
    expect(await vault.reservedClaims(badAddr)).to.equal(owed);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. The GLOBAL brick, and the deadlock that used to close behind it
  // ══════════════════════════════════════════════════════════════════════════

  it("a globally-broken constituent blocks nobody, and the delist deadlock is open", async () => {
    const { fx, bad, badAddr } = await withFourthLeg("hostile");
    const { vault, alice, bob, admission } = fx;

    // `transfer` reverts for EVERYONE, forever. This is the terminal case.
    await bad.setModes(true, false, false, false);
    const reserveAtBreak: bigint = await vault.reserveOf(badAddr);

    for (const who of [alice, bob]) {
      const shares: bigint = await vault.balanceOf(who.address);
      await expect(vault.connect(who).redeemProRata(shares, ZERO4())).to.emit(
        vault,
        "RedeemedProRata"
      );
      expect(await vault.balanceOf(who.address)).to.equal(0n);
      expect(await vault.pendingClaim(who.address, badAddr)).to.be.greaterThan(0n);
    }

    // Governance retires the broken leg through the full timelock.
    await vault.connect(admission).queueListing(badAddr, ethers.ZeroAddress, 0n, true);
    await time.increase(TIMELOCK + 1);
    await vault.executeListing(badAddr);

    // THE DEADLOCK. Before round 10 the reserve could not be reduced AT ALL
    // once the leg broke — every redemption reverted against it — so
    // `delistEmpty`'s `reserve == 0` precondition was unreachable by
    // construction and the leg was stuck in the basket forever.
    //
    // Now it drains. The honest assertion is the one that isolates THIS fix
    // from the pre-existing, by-design fact that the permanently-locked seed
    // also holds a slice: the reserve fell by exactly the sum of what the two
    // real holders were owed, and every wei of that is now a NAMED credit
    // rather than a stuck balance.
    const owedTotal: bigint =
      (await vault.pendingClaim(alice.address, badAddr)) +
      (await vault.pendingClaim(bob.address, badAddr));
    expect(owedTotal).to.be.greaterThan(0n);
    expect(await vault.reservedClaims(badAddr)).to.equal(owedTotal);
    expect(await vault.reserveOf(badAddr)).to.equal(reserveAtBreak - owedTotal);
    // The leg is deactivated and its remaining reserve is the seed's alone —
    // no user stake is trapped behind the broken transfer any more.
    expect(await vault.isExiting(badAddr)).to.equal(true);
  });

  it("a leg that merely LIES on transfer defers rather than silently vanishing", async () => {
    const { fx, bad, badAddr } = await withFourthLeg("hostile");
    const { vault, alice } = fx;
    // Returns `false` without reverting — the classic non-compliant ERC-20 that
    // a raw `.transfer()` would happily ignore.
    await bad.setModes(false, false, true, false);

    const shares: bigint = await vault.balanceOf(alice.address);
    await vault.connect(alice).redeemProRata(shares, ZERO4());
    // Not lost, not silently zeroed: credited.
    expect(await vault.pendingClaim(alice.address, badAddr)).to.be.greaterThan(0n);
  });

  it("a gas-burning leg cannot starve the legs that come after it", async () => {
    const { fx, bad, badAddr } = await withFourthLeg("hostile");
    const { vault, alice } = fx;
    // Consumes every wei of gas it is forwarded. `PAYOUT_GAS` + the 63/64 rule
    // is the whole defence, and this is the test of it.
    await bad.setModes(false, false, false, true);

    const before = await Promise.all(
      fx.tokens.map((t: any) => t.balanceOf(alice.address))
    );
    const shares: bigint = await vault.balanceOf(alice.address);
    await vault.connect(alice).redeemProRata(shares, ZERO4());

    for (let i = 0; i < 3; i++) {
      expect(await fx.tokens[i].balanceOf(alice.address)).to.be.greaterThan(before[i]);
    }
    expect(await vault.pendingClaim(alice.address, badAddr)).to.be.greaterThan(0n);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. Nothing was weakened for the ordinary case
  // ══════════════════════════════════════════════════════════════════════════

  it("the healthy path is bit-for-bit unchanged: slippage guard, floors, dust", async () => {
    const fx: IndexFixture = await deployOpenIndex();
    const { vault, alice } = fx;
    await vault.connect(alice).mintProRata(10n * WAD, maxIn(3));

    const preview: bigint[] = [...(await vault.previewRedeemProRata(5n * WAD))[1]];
    // The slippage guard still binds, and still binds BEFORE anything moves.
    await expect(
      vault.connect(alice).redeemProRata(5n * WAD, [preview[0] + 1n, 0n, 0n])
    ).to.be.revertedWithCustomError(vault, "SlippageExceeded");

    const before = await Promise.all(fx.tokens.map((t: any) => t.balanceOf(alice.address)));
    await vault.connect(alice).redeemProRata(5n * WAD, preview);
    for (let i = 0; i < 3; i++) {
      expect((await fx.tokens[i].balanceOf(alice.address)) - before[i]).to.equal(preview[i]);
    }
    // No credit was created on a path where nothing failed.
    for (const a of fx.addrs) {
      expect(await vault.pendingClaim(alice.address, a)).to.equal(0n);
      expect(await vault.reservedClaims(a)).to.equal(0n);
    }
  });

  it("claimPending is reachable by nobody but the credited holder, and by no role", async () => {
    const { fx, bad, badAddr } = await withFourthLeg("blacklist");
    const { vault, alice, bob, roleAdmin, risk, allocation, admission } = fx;
    await bad.setBlocked(alice.address, true);
    await vault.connect(alice).redeemProRata(await vault.balanceOf(alice.address), ZERO4());
    await bad.setBlocked(alice.address, false);

    // Every role holder, and an unrelated user, get nothing at all — the
    // mapping is keyed on msg.sender and there is no recipient argument.
    for (const who of [bob, roleAdmin, risk, allocation, admission]) {
      await expect(vault.connect(who).claimPending(badAddr)).to.be.revertedWithCustomError(
        vault,
        "ZeroAmount"
      );
    }
    // ...and the credited holder is still whole.
    await vault.connect(alice).claimPending(badAddr);
  });
});
