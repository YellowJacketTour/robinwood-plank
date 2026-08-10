import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { time, takeSnapshot, type SnapshotRestorer } from "./helpers/network-helpers.js";

import { WAD, TIMELOCK, deployOpenIndex, maxIn } from "./helpers/index-vault.js";

/**
 * ==========================================================================
 *  AUDIT M-2 — 1-WEI STREAM-SLOT PINNING, ON THE DIAMOND FACET
 *
 *  `RedTeam.StreamSlotGrief.poc.test.ts` proves this grief on the PREDECESSOR
 *  contract (`WrappedIndexShare`). The diamond's `IndexStreamFacet` was
 *  structurally identical and NO TEST EXERCISED THE GRIEF ON THE FACET — the
 *  finding lived on unproven in the code that actually ships.
 *
 *  THE GRIEF: `pruneStream` is permissionless and is the ONLY way a delisted
 *  stream frees its slot, out of a hard `MAX_STREAMS = 32`. It required
 *  `_probeStreamBalance(token) == 0` exactly. A raw ERC-20 `transfer` into
 *  the diamond needs no approval, no role and no function call on the
 *  diamond, and the wei can never leave, because every exit leg pays
 *  `mulDiv(sharesIn, held, totalSupply + VIRTUAL_SHARES)`, which floors to
 *  zero. One wei pinned a slot forever, on a contract with no upgrade path.
 *
 *  THE FIX: the prune threshold is DERIVED from the exit formula rather than
 *  chosen as a dust constant — a residual is prunable iff the LARGEST
 *  redemption anybody could possibly make (the entire supply) would pay ZERO
 *  of it. Pruning therefore strands nothing anyone could ever have received.
 * ==========================================================================
 */
describe("AUDIT M-2 — stream-slot pinning on IndexStreamFacet", () => {
  // This suite warps the shared clock by the timelock repeatedly; snapshot so
  // no later suite inherits the drift.
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  async function fixture() {
    const fx = await deployOpenIndex();
    const griefer = (await ethers.getSigners())[14];
    // Real supply, so the exit denominator is realistic rather than degenerate.
    await fx.vault.connect(fx.alice).mintProRata(3_000n * WAD, maxIn(3));
    return { ...fx, griefer };
  }

  /** List + delist a fresh mock token as a stream on the diamond. */
  async function delistedStream(fx: any, symbol: string) {
    const T = await ethers.getContractFactory("MockIndexToken");
    const tok: any = await T.deploy(symbol, symbol);
    const addr = await tok.getAddress();
    await fx.vault.connect(fx.admission).queueStream(addr);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeStream(addr);
    await fx.vault.connect(fx.admission).delistStream(addr);
    return { tok, addr };
  }

  /**
   * THE REPRODUCTION, INVERTED INTO A REGRESSION TEST.
   *
   * GOES RED WITHOUT THE FIX: with the old `_probeStreamBalance(token) != 0`
   * rule, the `pruneStream` call reverts `StreamNotEmpty` and the
   * `streamCount() == 0` assertion fails. Both halves fail on the buggy
   * branch, so this cannot pass on both.
   */
  it("a 1-wei donation no longer pins a delisted, drained slot", async () => {
    const fx = await fixture();
    const { tok, addr } = await delistedStream(fx, "PIN");
    expect(await fx.vault.streamCount()).to.equal(1n);

    // The whole attack: 1 wei, by raw transfer. No approval, no role, no
    // function on the diamond, no relationship to the protocol at all.
    await tok.mint(fx.griefer.address, 1n);
    await tok.connect(fx.griefer).transfer(fx.vaultAddr, 1n);
    expect(await fx.vault.streamHeld(addr), "the wei did not land").to.equal(1n);

    // Before the fix this reverted StreamNotEmpty, forever.
    await expect(fx.vault.pruneStream(addr)).to.emit(fx.vault, "StreamPruned").withArgs(addr);
    expect(await fx.vault.streamCount(), "slot not freed").to.equal(0n);
    expect(await fx.vault.streamHeld(addr)).to.equal(0n); // untracked reads as 0
  });

  /**
   * The registry-closing consequence, which is the reason the finding is
   * MEDIUM rather than cosmetic: 32 wei permanently closed the stream
   * registry on an unupgradeable contract.
   *
   * GOES RED WITHOUT THE FIX: the loop's `pruneStream` reverts on the first
   * iteration; with the reverts swallowed, `streamCount()` stays at 32 and
   * the final `queueStream` reverts `StreamCapReached`.
   */
  it("32 pinned slots can be cleared, so the registry cannot be closed for 32 wei", async () => {
    const fx = await fixture();
    const T = await ethers.getContractFactory("MockIndexToken");
    const pinned: string[] = [];
    for (let i = 0; i < 32; i++) {
      const tok: any = await T.deploy("P" + i, "P" + i);
      const a = await tok.getAddress();
      await fx.vault.connect(fx.admission).queueStream(a);
      await time.increase(TIMELOCK + 1);
      await fx.vault.executeStream(a);
      await fx.vault.connect(fx.admission).delistStream(a);
      await tok.mint(fx.griefer.address, 1n);
      await tok.connect(fx.griefer).transfer(fx.vaultAddr, 1n);
      pinned.push(a);
    }
    expect(await fx.vault.streamCount()).to.equal(32n);

    // The cap really is closed while they are pinned — the grief is real.
    const fresh: any = await T.deploy("REAL", "REAL");
    await expect(
      fx.vault.connect(fx.admission).queueStream(await fresh.getAddress())
    ).to.be.revertedWithCustomError(fx.vault, "StreamCapReached");

    // ...and anybody at all can now clear them. Permissionless recovery.
    for (const a of pinned) await fx.vault.connect(fx.griefer).pruneStream(a);
    expect(await fx.vault.streamCount()).to.equal(0n);
    await expect(fx.vault.connect(fx.admission).queueStream(await fresh.getAddress())).to.not.be
      .revert(ethers);
  });

  /**
   * ══ THE FIX MUST NOT BECOME AN ATTACK ══════════════════════════════════
   *
   * The danger of relaxing a prune rule is pruning something LIVE. Three
   * independent locks are asserted, not assumed.
   *
   * GOES RED IF: the `isStream` check is dropped (case 1 succeeds), or the
   * threshold is widened to a fixed dust constant large enough to swallow
   * real backing (case 2 succeeds), or the reserved/carry/vest terms are
   * folded into the relaxation (case 3 succeeds).
   */
  it("cannot prune a LIVE stream, a stream with real backing, or one that owes a claim", async () => {
    const fx = await fixture();

    // 1. LIVE stream: not prunable at any balance, including zero.
    const T = await ethers.getContractFactory("MockIndexToken");
    const live: any = await T.deploy("LIVE", "LIVE");
    const liveAddr = await live.getAddress();
    await fx.vault.connect(fx.admission).queueStream(liveAddr);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeStream(liveAddr);
    expect(await fx.vault.streamHeld(liveAddr)).to.equal(0n);
    await expect(fx.vault.pruneStream(liveAddr)).to.be.revertedWithCustomError(
      fx.vault,
      "StreamStillListed"
    );

    // 2. DELISTED but genuinely funded: the derived threshold refuses it by
    //    many orders of magnitude. 1 WAD is payable, so it is not dust.
    await live.mint(fx.alice.address, 10n * WAD);
    await live.connect(fx.alice).approve(fx.vaultAddr, ethers.MaxUint256);
    await fx.vault.connect(fx.alice).depositStream(liveAddr, WAD);
    await fx.vault.connect(fx.admission).delistStream(liveAddr);
    expect(await fx.vault.streamHeld(liveAddr)).to.be.gt(0n);
    await expect(fx.vault.pruneStream(liveAddr)).to.be.revertedWithCustomError(
      fx.vault,
      "StreamNotEmpty"
    );

    // 3. A residual small enough to be unpayable but with a DEFERRED CLAIM
    //    outstanding is still refused — the relaxation is confined to the one
    //    term a griefer can write to from outside.
    //    (`reservedClaims` is created by a redemption crediting a stream leg.)
    const owed: any = await T.deploy("OWED", "OWED");
    const owedAddr = await owed.getAddress();
    await fx.vault.connect(fx.admission).queueStream(owedAddr);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeStream(owedAddr);
    await owed.mint(fx.alice.address, 10n * WAD);
    await owed.connect(fx.alice).approve(fx.vaultAddr, ethers.MaxUint256);
    await fx.vault.connect(fx.alice).depositStream(owedAddr, WAD);
    // Redeem everything: the stream leg is credited to the deferred ledger,
    // leaving reservedClaims > 0 against a near-zero net balance.
    await fx.vault.connect(fx.alice).redeemProRata(3_000n * WAD, [0n, 0n, 0n]);
    await fx.vault.connect(fx.admission).delistStream(owedAddr);
    expect(await fx.vault.reservedClaims(owedAddr), "no claim outstanding — test is vacuous").to.be.gt(
      0n
    );
    await expect(fx.vault.pruneStream(owedAddr)).to.be.revertedWithCustomError(
      fx.vault,
      "StreamNotEmpty"
    );
  });

  /**
   * THE HONESTY CLAIM behind the threshold: pruning a 1-wei residual takes
   * nothing away from anybody, because nobody could ever have received it.
   * Proven by measurement rather than by argument — the largest redemption
   * possible (the whole supply) pays zero of the residual.
   *
   * GOES RED IF the threshold is ever widened to a value a real redemption
   * could pay: the balance-delta assertion catches the stranded value.
   */
  it("the pruned residual was provably unpayable — a full-supply exit pays zero of it", async () => {
    const fx = await fixture();
    const { tok, addr } = await delistedStream(fx, "DUST");
    await tok.mint(fx.griefer.address, 1n);
    await tok.connect(fx.griefer).transfer(fx.vaultAddr, 1n);

    // The maximum claim anybody can make: burn the entire held supply.
    const held = await fx.vault.balanceOf(fx.alice.address);
    const before = await tok.balanceOf(fx.alice.address);
    await fx.vault.connect(fx.alice).redeemProRata(held, [0n, 0n, 0n]);
    // Nothing credited, nothing claimable — the wei was never anyone's.
    expect(await fx.vault.pendingClaim(fx.alice.address, addr)).to.equal(0n);
    expect(await tok.balanceOf(fx.alice.address)).to.equal(before);

    // Supply is now zero, and in THAT state the relaxation is deliberately
    // withheld: with no supply the residual is not unpayable, it is value
    // waiting for the next minter.
    expect(await fx.vault.totalSupply()).to.be.gt(0n); // the locked seed remains
    await expect(fx.vault.pruneStream(addr)).to.not.be.revert(ethers);
  });
});
