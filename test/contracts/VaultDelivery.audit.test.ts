import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { deployBeaconMock, relayPendingRound, expireRounds } from "./helpers/beacon.js";

/**
 * F-2 — a requester that cannot receive an ERC-721 must not be able to brick
 * random redemption for everybody.
 *
 * The pre-fix shape of the bug, in order:
 *   1. a contract with no onERC721Received acquires one share and requests;
 *   2. the target round is relayed and ANYONE calls pinPendingDraw() — a
 *      standalone transaction that commits pinned=true to storage on its own,
 *      with no NFT transfer involved, so it always succeeds;
 *   3. _settle then tries collection.safeTransferFrom(this, requester, id),
 *      which reverts forever because the requester has no receiver hook. The
 *      already-committed pin is NOT undone — it was written in an earlier,
 *      separate transaction;
 *   4. forfeitExpiredRedeem requires !pinned, so it reverts RequestPending
 *      forever, even past the full expiry window;
 *   5. pendingRequester is a single vault-wide slot cleared only inside a
 *      successful _settle, so every other user's requestRandomRedeem reverts
 *      RequestPending. Permanently. For the price of one share.
 */
describe("MarketplankVault — undeliverable requester cannot brick the vault (F-2)", () => {
  const SHARE_UNIT = 10n ** 18n;

  async function deploy() {
    const [deployer, treasury, alice, bob] = await ethers.getSigners();
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    const beacon: any = await deployBeaconMock();
    const Vault = await ethers.getContractFactory("MarketplankVault");
    const vault: any = await Vault.deploy(
      await nft.getAddress(),
      "V",
      "V",
      0,
      0,
      0,
      treasury.address,
      await beacon.getAddress()
    );
    return { deployer, treasury, alice, bob, nft, vault, beacon };
  }

  async function depositOne(nft: any, vault: any, who: any, tokenId: number) {
    await nft.mint(who.address, tokenId);
    await nft.connect(who).approve(await vault.getAddress(), tokenId);
    await vault.connect(who).deposit(tokenId);
  }

  async function assertSolvent(vault: any) {
    const total: bigint = await vault.totalSupply();
    const pending: bigint = await vault.pendingRedeemCount();
    const held: bigint = await vault.heldTokenCount();
    expect(total + pending * SHARE_UNIT).to.equal(
      held * SHARE_UNIT,
      "solvency invariant broken"
    );
  }

  it("a pinned-but-undeliverable request still settles, and never strands the single vault-wide slot", async () => {
    const { alice, bob, nft, vault, beacon } = await deploy();
    for (const id of [1, 2, 3, 4]) await depositOne(nft, vault, alice, id);

    // The attacker/plain-contract-wallet: no onERC721Received anywhere.
    const NonReceiver = await ethers.getContractFactory("MockNonReceiver");
    const bad: any = await NonReceiver.deploy(await vault.getAddress());
    const badAddr = await bad.getAddress();
    // It is genuinely unable to receive: a direct safeTransferFrom reverts.
    await nft.mint(alice.address, 99);
    await expect(
      nft
        .connect(alice)
        ["safeTransferFrom(address,address,uint256)"](alice.address, badAddr, 99)
    ).to.be.revert(ethers);

    // Fund it with exactly one share and let it request.
    await vault.connect(alice).transfer(badAddr, SHARE_UNIT);
    await bad.request();
    expect(await vault.pendingRequester()).to.equal(badAddr);

    // The round lands and a passer-by pins the draw in its OWN transaction —
    // no transfer attempted, so this cannot fail.
    await relayPendingRound(vault, beacon);
    await vault.connect(bob).pinPendingDraw();
    const [pinned, drawn] = await vault.pendingDraw();
    expect(pinned).to.equal(true);

    // THE FIX: delivery is unconditional. Anyone can push it through, the NFT
    // lands with the requester (which chose to request it), and the vault-wide
    // slot is released in the same transaction.
    await expect(vault.connect(bob).claimRandomRedeemFor(badAddr)).to.not.be.revert(ethers);
    expect(await nft.ownerOf(drawn)).to.equal(badAddr);
    expect(await vault.pendingRequester()).to.equal(ethers.ZeroAddress);
    expect(await vault.pendingRedeemCount()).to.equal(0n);
    const [stillPinned] = await vault.pendingDraw();
    expect(stillPinned).to.equal(false);
    await assertSolvent(vault);

    // And random redemption still works for everybody else afterwards.
    await depositOne(nft, vault, bob, 500);
    await vault.connect(bob).requestRandomRedeem();
    await relayPendingRound(vault, beacon, 3);
    await vault.connect(bob).claimRandomRedeem();
    await assertSolvent(vault);
  });

  it("the request cannot instead be left pinned-and-unforfeitable forever", async () => {
    const { alice, bob, nft, vault, beacon } = await deploy();
    for (const id of [1, 2, 3, 4]) await depositOne(nft, vault, alice, id);

    const NonReceiver = await ethers.getContractFactory("MockNonReceiver");
    const bad: any = await NonReceiver.deploy(await vault.getAddress());
    const badAddr = await bad.getAddress();
    await vault.connect(alice).transfer(badAddr, SHARE_UNIT);
    await bad.request();
    await relayPendingRound(vault, beacon);
    await vault.pinPendingDraw();

    // Ride out the whole expiry window with the draw pinned. Pre-fix this is
    // the terminal brick: claim reverts on the transfer, forfeit reverts
    // RequestPending, and no third party can do anything about either.
    await expireRounds();
    await networkHelpers.mine(1);

    // At least one terminal path must exist. Settling is the one the fix
    // keeps; if it ever stops working, forfeit must take over. Asserting the
    // disjunction pins the property (the slot ALWAYS has an exit) rather than
    // one particular implementation of it.
    let released = false;
    try {
      await vault.connect(bob).claimRandomRedeemFor(badAddr);
      released = true;
    } catch {
      await vault.connect(bob).forfeitExpiredRedeem(badAddr);
      released = true;
    }
    expect(released).to.equal(true);
    expect(await vault.pendingRequester()).to.equal(ethers.ZeroAddress);
    expect(await vault.pendingRedeemCount()).to.equal(0n);
    await assertSolvent(vault);

    // The slot is genuinely reusable, not merely reported clear.
    await depositOne(nft, vault, bob, 501);
    await expect(vault.connect(bob).requestRandomRedeem()).to.not.be.revert(ethers);
  });

  it("an EOA requester is entirely unaffected — normal delivery still works", async () => {
    const { alice, nft, vault, beacon } = await deploy();
    for (const id of [1, 2, 3, 4]) await depositOne(nft, vault, alice, id);
    await vault.connect(alice).requestRandomRedeem();
    await relayPendingRound(vault, beacon);
    const got: bigint = await vault.connect(alice).claimRandomRedeem.staticCall();
    await vault.connect(alice).claimRandomRedeem();
    expect(await nft.ownerOf(got)).to.equal(alice.address);
    await assertSolvent(vault);
  });
});
