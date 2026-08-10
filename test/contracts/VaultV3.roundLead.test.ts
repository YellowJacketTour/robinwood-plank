import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployBeaconMock } from "./helpers/beacon";

/**
 * ==========================================================================
 *  MarketplankVaultV3 — round-selection hardening (audit H-7, HIGH).
 *
 *  THE ATTACK. `ROUND_LEAD = 1` put the target drand round only 3-6 seconds
 *  ahead of `block.timestamp`. Skew the reported timestamp backward by six
 *  seconds — inside every sequencer's and every client's tolerated drift —
 *  and the "future" round the request targets is ALREADY PUBLISHED. The draw
 *  is then `keccak256(seed, requester) % frozenLen` with `seed` known and
 *  `requester` fully attacker-chosen, so the attacker grinds an address for
 *  the token they want. And the forfeit-burn never fires as a deterrent,
 *  because a losing request is simply never broadcast. Cost: zero.
 *
 *  The in-code justification was that a sequencer "can only shift WHICH
 *  FUTURE round is targeted" — true forward, false backward.
 *
 *  WHAT IS ASSERTED HERE, and how each would go red:
 *   1. a request whose target round the beacon ALREADY holds is refused.
 *      Delete the `isRoundAvailable` guard -> the request succeeds -> red.
 *   2. an ordinary request, with nothing pre-published, still succeeds.
 *      The anti-vacuity control for (1).
 *   3. the target sits >= 100 rounds ahead of the chain's own clock.
 *      Lower ROUND_LEAD -> red.
 *
 *  THE CRYPTOGRAPHY IS NOT UNDER TEST and is not touched. The audit found
 *  DrandBeacon/BLSBN254 sound (RFC 9380 §5.3.1, correct pairing, complete G1
 *  validation, fails closed). The defect was round SELECTION only.
 *
 *  LOCAL HARDHAT ONLY.
 * ==========================================================================
 */

describe("MarketplankVaultV3 — drand round selection (audit H-7)", () => {
  // This file jumps `block.timestamp` ~10,000s to exercise the round-lead
  // window. Without a restore that jump LEAKS into every later suite sharing
  // this chain — which is exactly how the audit PoCs pushed time past the
  // Seaport fixtures' order `endTime` and produced four phantom
  // `InvalidTime` failures that passed 12/12 in isolation. Snapshot/restore
  // keeps a time-warping suite from being charged to its neighbours.
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  async function deploy() {
    const [, treasury, alice] = await ethers.getSigners();
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    const beacon: any = await deployBeaconMock();
    const Vault = await ethers.getContractFactory("MarketplankVaultV3");
    const vault: any = await Vault.deploy(
      await nft.getAddress(),
      "V3",
      "V3",
      0,
      0,
      0,
      0,
      treasury.address,
      await beacon.getAddress()
    );
    const vaultAddr = await vault.getAddress();
    for (let id = 1; id <= 5; id++) {
      await nft.mint(alice.address, id);
      await nft.connect(alice).approve(vaultAddr, id);
      await vault.connect(alice).deposit(id);
    }
    return { treasury, alice, nft, beacon, vault, vaultAddr };
  }

  it("REFUSES a request whose target drand round is ALREADY published", async () => {
    const { alice, beacon, vault } = await deploy();

    // Pin the timestamp the request will observe, so the round it targets is
    // computable EXACTLY rather than bracketed. (Bracketing is what a
    // clock-skewing attacker has to do; the test does not need to.)
    const requestAt = (await time.latest()) + 10_000;
    const target = (await beacon.currentRoundAt(requestAt)) + 1n + 100n; // nextRoundAfter + ROUND_LEAD

    // Publish it. In production this state is reached by reporting a
    // `block.timestamp` far enough in the past that the "future" target has
    // in fact already been emitted; here we reach the same state directly,
    // which exercises the same guard for the same reason.
    await beacon.setRandomness(target, ethers.keccak256(ethers.toUtf8Bytes("published")));

    await time.setNextBlockTimestamp(requestAt);
    await expect(vault.connect(alice).requestRandomRedeem()).to.be.revertedWithCustomError(
      vault,
      "TargetRoundAlreadyPublished"
    );

    // The request left no trace: no share was burned, nothing is pending.
    expect(await vault.balanceOf(alice.address)).to.equal(5n * 10n ** 18n);
    const [round] = await vault.pendingRound();
    expect(round).to.equal(0n);
  });

  it("CONTROL: an ordinary request, with nothing pre-published, still succeeds", async () => {
    const { alice, vault } = await deploy();
    await vault.connect(alice).requestRandomRedeem();
    const [round] = await vault.pendingRound();
    expect(round).to.be.greaterThan(0n);
    expect(await vault.balanceOf(alice.address)).to.equal(4n * 10n ** 18n);
  });

  it("LEAD: the target round sits at least 100 rounds ahead of the chain's own clock", async () => {
    const { alice, beacon, vault } = await deploy();
    const tx = await vault.connect(alice).requestRandomRedeem();
    const rcpt = await tx.wait();
    const t = BigInt((await ethers.provider.getBlock(rcpt!.blockNumber))!.timestamp);

    const [target] = await vault.pendingRound();
    const nowRound = await beacon.currentRoundAt(t);

    // ROUND_LEAD = 100 on top of nextRoundAfter's own +1.
    expect(target - nowRound).to.be.greaterThanOrEqual(
      101n,
      "the target round no longer carries the 100-round lead H-7 requires"
    );
  });
});
