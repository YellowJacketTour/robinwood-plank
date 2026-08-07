import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hardhat.js";
import { deployBeaconMock, relayPendingRound } from "./helpers/beacon.js";

/**
 * V3 is the fix for the V2 LP drain (audit held privately).
 * These tests prove the drain is dead and the new surface — proportional LP,
 * ETH fees, the 30 bps swap fee, the locked seed, and batch redemption —
 * behaves. The drand random-redeem machinery is byte-identical to V2 and is
 * covered by the ported V2 suites; here we exercise what changed.
 */
describe("MarketplankVaultV3", () => {
  const SHARE_UNIT = 10n ** 18n;
  const MINT_FEE = ethers.parseEther("0.001");
  const REDEEM_FEE = ethers.parseEther("0.001");
  const PREMIUM = ethers.parseEther("0.002");
  const SWAP_BPS = 30n;

  /**
   * Live-V2-shaped pool: 8 NFTs deposited, 3 shares + 4 ETH seeded, opened.
   * Alice keeps the other 5 shares to fund attackers/LPs.
   */
  async function seededVault() {
    const [, treasury, alice, bob] = await ethers.getSigners();
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    const beacon: any = await deployBeaconMock();
    const Vault = await ethers.getContractFactory("MarketplankVaultV3");
    const vault: any = await Vault.deploy(
      await nft.getAddress(),
      "vROBIN3",
      "vROBIN3",
      MINT_FEE,
      REDEEM_FEE,
      PREMIUM,
      SWAP_BPS,
      treasury.address,
      await beacon.getAddress()
    );
    const addr = await vault.getAddress();

    for (let id = 1; id <= 8; id++) {
      await nft.mint(alice.address, id);
      await nft.connect(alice).approve(addr, id);
      await vault.connect(alice).deposit(id, { value: MINT_FEE });
    }
    // Treasury seeds 3 shares + 4 ETH, then opens.
    await vault.connect(alice).transfer(treasury.address, SHARE_UNIT * 3n);
    await vault.connect(treasury).seedShares(SHARE_UNIT * 3n, { value: ethers.parseEther("4") });
    await vault.connect(treasury).openPool();

    return { treasury, alice, bob, nft, vault, addr };
  }

  const k = (e: bigint, s: bigint) => e * s;

  // ── The V2 drain is dead ────────────────────────────────────────────────

  it("the one-sided contribution primitive no longer exists", async () => {
    // The V2 attack began with a one-sided ETH contribution. V3's addLiquidity
    // pulls the matching shares, so adding 20 ETH demands ~15 shares; capping
    // maxSharesIn low makes it revert instead of donating price impact.
    const { alice, vault } = await seededVault();
    await expect(
      vault.connect(alice).addLiquidity(SHARE_UNIT, 0n, { value: ethers.parseEther("20") })
    ).to.be.revertedWithCustomError(vault, "InsufficientOutput");
  });

  it("EXPLOIT REPLAY: atomic add -> sell -> remove cannot drain the pool", async () => {
    const { alice, vault, addr } = await seededVault();
    const Drainer = await ethers.getContractFactory("MockLpDrainerV3");
    const drainer: any = await Drainer.deploy(addr);
    const drainerAddr = await drainer.getAddress();

    // Fund the attacker generously: 4 shares (3 to add + 1 to sell) and 4 ETH.
    await vault.connect(alice).transfer(drainerAddr, SHARE_UNIT * 4n);

    const eBefore: bigint = await vault.ethReserve();
    const sBefore: bigint = await vault.shareReserve();
    const kBefore = k(eBefore, sBefore);

    await alice.sendTransaction({ to: drainerAddr, value: ethers.parseEther("4") });
    await drainer.attack(ethers.parseEther("4"), SHARE_UNIT * 3n, SHARE_UNIT);

    const eAfter: bigint = await vault.ethReserve();
    const sAfter: bigint = await vault.shareReserve();

    expect(eAfter).to.be.gt(0n, "ETH reserve not drained");
    expect(sAfter).to.be.gt(0n, "share reserve not drained");
    // Constant product is preserved or grown — in V2 this collapsed to ~0.
    expect(k(eAfter, sAfter)).to.be.gte(kBefore, "k must not fall");
  });

  it("EXPLOIT REPLAY: the share-side mirror cannot drain the pool either", async () => {
    const { alice, vault, addr } = await seededVault();
    const Drainer = await ethers.getContractFactory("MockLpDrainerV3");
    const drainer: any = await Drainer.deploy(addr);
    const drainerAddr = await drainer.getAddress();

    await vault.connect(alice).transfer(drainerAddr, SHARE_UNIT * 3n);
    const eBefore: bigint = await vault.ethReserve();
    const sBefore: bigint = await vault.shareReserve();
    const kBefore = k(eBefore, sBefore);

    await alice.sendTransaction({ to: drainerAddr, value: ethers.parseEther("8") });
    await drainer.attackBuy(ethers.parseEther("4"), SHARE_UNIT * 3n, ethers.parseEther("2"));

    const eAfter: bigint = await vault.ethReserve();
    const sAfter: bigint = await vault.shareReserve();
    expect(eAfter).to.be.gt(0n);
    expect(sAfter).to.be.gt(0n);
    expect(k(eAfter, sAfter)).to.be.gte(kBefore);
  });

  it("a bare add -> remove round trip returns no more than was put in", async () => {
    const { alice, vault } = await seededVault();
    const ethIn = ethers.parseEther("1");
    const before = await ethers.provider.getBalance(alice.address);

    const tx = await vault.connect(alice).addLiquidity(SHARE_UNIT * 2n, 0n, { value: ethIn });
    const rc = await tx.wait();
    const lp: bigint = await vault.lpBalance(alice.address);
    const tx2 = await vault.connect(alice).removeLiquidity(lp, 0n, 0n);
    const rc2 = await tx2.wait();

    const after = await ethers.provider.getBalance(alice.address);
    const gas: bigint =
      (rc.gasUsed as bigint) * (rc.gasPrice as bigint) +
      (rc2.gasUsed as bigint) * (rc2.gasPrice as bigint);
    // Ignoring gas, an untraded round trip cannot create ETH.
    expect(after + gas).to.be.lte(before, "LP round trip must not mint ETH");
  });

  // ── Proportional LP + locked seed ───────────────────────────────────────

  it("openPool mints sqrt(E*S) locked LP that nobody can withdraw", async () => {
    const { vault } = await seededVault();
    const e: bigint = await vault.ethReserve();
    const s: bigint = await vault.shareReserve();
    const expected = bigintSqrt(e * s);

    const total: bigint = await vault.totalLpSupply();
    const locked: bigint = await vault.lpBalance(ethers.ZeroAddress);
    expect(total).to.equal(expected);
    expect(locked).to.equal(expected);
    expect(locked).to.be.gt(1000n);

    // The locked units keep totalLpSupply > burnable, so a full removal by the
    // only real LP still leaves both reserves strictly positive (no brick).
    const [, , alice] = await ethers.getSigners();
    await vault.connect(alice).addLiquidity(SHARE_UNIT * 2n, 0n, { value: ethers.parseEther("1") });
    const lp: bigint = await vault.lpBalance(alice.address);
    await vault.connect(alice).removeLiquidity(lp, 0n, 0n);
    expect(await vault.ethReserve()).to.be.gt(0n);
    expect(await vault.shareReserve()).to.be.gt(0n);
  });

  it("proportional mint rounds in the pool's favour on both sides", async () => {
    const { alice, vault } = await seededVault();
    const e: bigint = await vault.ethReserve();
    const s: bigint = await vault.shareReserve();
    const l: bigint = await vault.totalLpSupply();
    const ethIn = ethers.parseEther("0.777");

    const [lpMinted, sharesUsed] = await vault
      .connect(alice)
      .addLiquidity.staticCall(SHARE_UNIT * 5n, 0n, { value: ethIn });

    // The exact integer statements the contract asserts.
    expect(ethIn * l).to.be.gte(e * lpMinted);
    expect(sharesUsed * l).to.be.gte(s * lpMinted);
  });

  // ── ETH fees ────────────────────────────────────────────────────────────

  it("fees accrue in ETH, isolated from ethReserve, and only the treasury is paid", async () => {
    const { treasury, alice, bob, nft, vault, addr } = await seededVault();

    const reserveBefore: bigint = await vault.ethReserve();
    const feesBefore: bigint = await vault.accruedFees();

    await nft.mint(bob.address, 101);
    await nft.connect(bob).approve(addr, 101);
    await vault.connect(bob).deposit(101, { value: MINT_FEE });

    expect(await vault.ethReserve()).to.equal(reserveBefore, "fee must not touch the reserve");
    expect(await vault.accruedFees()).to.equal(feesBefore + MINT_FEE);

    const tBefore = await ethers.provider.getBalance(treasury.address);
    const acc: bigint = await vault.accruedFees();
    await vault.connect(bob).withdrawFees(); // permissionless
    expect(await ethers.provider.getBalance(treasury.address)).to.equal(tBefore + acc);
    expect(await vault.accruedFees()).to.equal(0n);
  });

  it("deposit and redeem demand the exact fee", async () => {
    const { bob, nft, vault, addr } = await seededVault();
    await nft.mint(bob.address, 102);
    await nft.connect(bob).approve(addr, 102);
    await expect(vault.connect(bob).deposit(102, { value: MINT_FEE - 1n })).to.be.revertedWithCustomError(
      vault,
      "IncorrectFee"
    );
    await expect(vault.connect(bob).deposit(102, { value: MINT_FEE + 1n })).to.be.revertedWithCustomError(
      vault,
      "IncorrectFee"
    );
    await vault.connect(bob).deposit(102, { value: MINT_FEE });
    // A single deposit yields a full share and can redeem it — no dust trap.
    await expect(
      vault.connect(bob).redeemTarget(102, { value: REDEEM_FEE + PREMIUM })
    ).to.emit(vault, "Redeemed");
  });

  it("a reverting treasury bricks only withdrawFees, never deposits or the redeem slot", async () => {
    const [, , alice] = await ethers.getSigners();
    const Nft = await ethers.getContractFactory("MockRobinWoodNft");
    const nft: any = await Nft.deploy();
    const beacon: any = await deployBeaconMock();
    const T = await ethers.getContractFactory("MockRevertingTreasury");
    const badTreasury: any = await T.deploy();
    const Vault = await ethers.getContractFactory("MarketplankVaultV3");
    const vault: any = await Vault.deploy(
      await nft.getAddress(),
      "v",
      "v",
      MINT_FEE,
      REDEEM_FEE,
      PREMIUM,
      SWAP_BPS,
      await badTreasury.getAddress(),
      await beacon.getAddress()
    );
    const addr = await vault.getAddress();

    // Deposits and redeems work fine despite the treasury rejecting ETH...
    await nft.mint(alice.address, 1);
    await nft.connect(alice).approve(addr, 1);
    await vault.connect(alice).deposit(1, { value: MINT_FEE });
    await nft.mint(alice.address, 2);
    await nft.connect(alice).approve(addr, 2);
    await vault.connect(alice).deposit(2, { value: MINT_FEE });
    await expect(vault.connect(alice).requestRandomRedeem({ value: REDEEM_FEE })).to.emit(
      vault,
      "RedeemRequested"
    );
    // ...only the fee withdrawal reverts, harmlessly.
    await expect(vault.connect(alice).withdrawFees()).to.be.revertedWithCustomError(vault, "TransferFailed");
  });

  // ── Swap fee ────────────────────────────────────────────────────────────

  it("the swap fee grows k on every trade", async () => {
    const { alice, vault } = await seededVault();
    const k0 = k(await vault.ethReserve(), await vault.shareReserve());
    await vault.connect(alice).buyShares(0n, { value: ethers.parseEther("0.3") });
    const k1 = k(await vault.ethReserve(), await vault.shareReserve());
    expect(k1).to.be.gt(k0, "buy must grow k");
    await vault.connect(alice).sellShares(SHARE_UNIT / 2n, 0n);
    const k2 = k(await vault.ethReserve(), await vault.shareReserve());
    expect(k2).to.be.gt(k1, "sell must grow k");
  });

  it("the audited AMM guards still fire", async () => {
    const { alice, vault } = await seededVault();
    // Zero-output dust buy reverts rather than keeping the ETH.
    await expect(vault.connect(alice).buyShares(0n, { value: 1n })).to.be.revert(ethers);
    // Slippage floor holds.
    await expect(
      vault.connect(alice).buyShares(ethers.parseEther("1000"), { value: ethers.parseEther("0.1") })
    ).to.be.revertedWithCustomError(vault, "InsufficientOutput");
  });

  // ── drand random redeem (payable-signature port; logic byte-identical) ───

  it("a random redeem burns exactly one share, draws, and delivers", async () => {
    const { alice, vault, nft } = await seededVault();
    const beacon = await ethers.getContractAt("DrandBeaconMock", await vault.beacon());
    const supplyBefore: bigint = await vault.totalSupply();

    await vault.connect(alice).requestRandomRedeem({ value: REDEEM_FEE });
    expect(await vault.totalSupply()).to.equal(supplyBefore - SHARE_UNIT, "exactly one share burned");
    expect(await vault.pendingRedeemCount()).to.equal(1n);

    await relayPendingRound(vault, beacon);
    await vault.connect(alice).claimRandomRedeem();
    const [drawn] = [await vault.pendingRedeemCount()];
    expect(drawn).to.equal(0n, "slot released after claim");
    expect(await vault.pendingRequester()).to.equal(ethers.ZeroAddress);
    // Alice received an NFT back (one of the held tokens).
    expect(await nft.balanceOf(alice.address)).to.be.gt(0n);
  });

  it("an undeliverable requester never strands the vault-wide slot", async () => {
    const { treasury, alice, bob, nft, vault, addr } = await seededVault();
    const beacon = await ethers.getContractAt("DrandBeaconMock", await vault.beacon());

    const NonRecv = await ethers.getContractFactory("MockNonReceiverV3");
    const bad: any = await NonRecv.deploy(addr);
    const badAddr = await bad.getAddress();

    await vault.connect(alice).transfer(badAddr, SHARE_UNIT);
    await bad.request({ value: REDEEM_FEE });
    expect(await vault.pendingRequester()).to.equal(badAddr);

    await relayPendingRound(vault, beacon);
    await vault.connect(bob).pinPendingDraw();
    const [pinned, drawn] = await vault.pendingDraw();
    expect(pinned).to.equal(true);

    // Unconditional delivery: anyone can push it, the NFT lands, slot frees.
    await expect(vault.connect(bob).claimRandomRedeemFor(badAddr)).to.not.be.revert(ethers);
    expect(await nft.ownerOf(drawn)).to.equal(badAddr);
    expect(await vault.pendingRequester()).to.equal(ethers.ZeroAddress);
    expect(await vault.pendingRedeemCount()).to.equal(0n);
  });

  it("forfeit burns the requester's share to the treasury — the bond that blocks a free reroll", async () => {
    // drand rounds are public before they are relayed on-chain, so a requester
    // can predict their draw off-chain and decline it by never relaying. The
    // share-burn on forfeit is what makes declining cost a full share, so this
    // MUST stay: the requester does not get it back. (An independent review
    // caught an earlier version that refunded the requester and enabled a
    // near-free rare-sniping reroll.)
    const { treasury, alice, bob, vault } = await seededVault();
    const aliceBefore: bigint = await vault.balanceOf(alice.address);
    const treasuryBefore: bigint = await vault.balanceOf(treasury.address);

    await vault.connect(alice).requestRandomRedeem({ value: REDEEM_FEE });
    expect(await vault.balanceOf(alice.address)).to.equal(aliceBefore - SHARE_UNIT);
    await networkHelpers.time.increase(30_000); // overshoot ROUND_EXPIRY at the 1s mock period

    await vault.connect(bob).forfeitExpiredRedeem(alice.address);
    expect(await vault.balanceOf(alice.address)).to.equal(
      aliceBefore - SHARE_UNIT,
      "requester loses the share — declining a draw is costly"
    );
    expect(await vault.balanceOf(treasury.address)).to.equal(
      treasuryBefore + SHARE_UNIT,
      "the forfeited share goes to the treasury"
    );
    expect(await vault.pendingRequester()).to.equal(ethers.ZeroAddress, "slot freed");
  });

  // ── Batch ───────────────────────────────────────────────────────────────

  it("depositMany and redeemTargetMany move n NFTs for exactly n fees", async () => {
    const { bob, nft, vault, addr } = await seededVault();
    const ids = [201, 202, 203];
    for (const id of ids) {
      await nft.mint(bob.address, id);
      await nft.connect(bob).approve(addr, id);
    }
    await expect(
      vault.connect(bob).depositMany(ids, { value: MINT_FEE * BigInt(ids.length - 1) })
    ).to.be.revertedWithCustomError(vault, "IncorrectFee");

    await vault.connect(bob).depositMany(ids, { value: MINT_FEE * BigInt(ids.length) });
    expect(await vault.balanceOf(bob.address)).to.equal(SHARE_UNIT * BigInt(ids.length));

    await vault.connect(bob).redeemTargetMany(ids, {
      value: (REDEEM_FEE + PREMIUM) * BigInt(ids.length),
    });
    expect(await vault.balanceOf(bob.address)).to.equal(0n);
    for (const id of ids) expect(await nft.ownerOf(id)).to.equal(bob.address);
  });

  it("redeemTargetMany rejects an empty/oversized batch and duplicates", async () => {
    const { bob, nft, vault, addr } = await seededVault();
    for (const id of [301, 302]) {
      await nft.mint(bob.address, id);
      await nft.connect(bob).approve(addr, id);
      await vault.connect(bob).deposit(id, { value: MINT_FEE });
    }
    await expect(vault.connect(bob).redeemTargetMany([], { value: 0n })).to.be.revertedWithCustomError(
      vault,
      "BadBatch"
    );
    // Duplicate in the batch: bob holds 2 shares so the burn clears, then the
    // second occurrence of 301 is no longer held.
    await expect(
      vault.connect(bob).redeemTargetMany([301, 301], { value: (REDEEM_FEE + PREMIUM) * 2n })
    ).to.be.revertedWithCustomError(vault, "TokenNotHeld");
  });
});

// Integer sqrt matching OZ Math.sqrt (floor).
function bigintSqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("neg");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
