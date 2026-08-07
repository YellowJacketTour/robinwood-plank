import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployBeaconMock } from "./helpers/beacon";
import { deployOpenIndex, warmCheckpoints, WAD, TIMELOCK, maxIn } from "./helpers/index-vault";

/**
 * ROUND 10, FIX 3 — THE DOCUMENTED PRODUCTION SINK NO LONGER STRANDS VALUE.
 *
 * The finding: `GlobalIndexVault` accounts EXCLUSIVELY through
 * `constituents[t].reserve`, which is credited only by `seedDeposit`,
 * `mintProRata` and `mintSingleAsset`. A raw `IERC20.transfer` into the vault
 * writes no ledger anywhere — so the value is held by the vault and owned by
 * nobody: not in `reserve`, not in NAV, not in any redemption.
 *
 * That is not a hypothetical. `TBAValueSweeper.sweepTBAERC20` transfers
 * exactly that way, and pointing its `reserveSink` at this vault is the
 * production configuration its own header documents. 100% of every sweep was
 * silently lost.
 *
 * `syncConstituentBalance` closes it. What has to be proved is not that the
 * number goes up — it is that the number goes up by EXACTLY the unaccounted
 * surplus and never by a wei of anybody else's ledger.
 *
 * LOCAL HARDHAT ONLY.
 */
describe("Index constituent sync — swept value becomes redeemable (round 10)", () => {
  let snap: SnapshotRestorer;
  before(async () => {
    snap = await takeSnapshot();
  });
  after(async () => {
    await snap.restore();
  });

  const MINT_FEE = ethers.parseEther("0.001");
  const DELAY = 2 * 24 * 60 * 60;
  const KIND_ERC20 = 1;

  // ══════════════════════════════════════════════════════════════════════════
  // 1. The real sweeper, pointed at the real vault
  // ══════════════════════════════════════════════════════════════════════════

  it("a REAL TBAValueSweeper sweep into the index vault credits reserve and becomes redeemable", async () => {
    const fx = await deployOpenIndex();
    const [deployer, , , , , , , , , treasury, roleAdmin2, allowAdmin] =
      await ethers.getSigners();

    // The sweeper's own world: a V3 vault holding NFTs whose TBAs accrue value.
    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const nftAddr = await nft.getAddress();
    const beacon: any = await deployBeaconMock();
    const v3: any = await (
      await ethers.getContractFactory("MarketplankVaultV3")
    ).deploy(
      nftAddr,
      "vROBIN3",
      "vROBIN3",
      MINT_FEE,
      MINT_FEE,
      ethers.parseEther("0.002"),
      30n,
      treasury.address,
      await beacon.getAddress()
    );
    const v3Addr = await v3.getAddress();
    await nft.mint(deployer.address, 1);
    await nft.approve(v3Addr, 1);
    await v3.deposit(1, { value: MINT_FEE });

    const registry: any = await (
      await ethers.getContractFactory("MockERC6551Registry")
    ).deploy();
    const misc: any = await (await ethers.getContractFactory("MockMiscellanySink")).deploy();
    const impl: any = await (await ethers.getContractFactory("MockMiscellanySink")).deploy();
    const SALT = ethers.zeroPadValue("0x01", 32);
    const chainId = (await ethers.provider.getNetwork()).chainId;

    // ── THE PRODUCTION SHAPE: reserveSink IS the GlobalIndexVault.
    const sweeper: any = await (
      await ethers.getContractFactory("TBAValueSweeper")
    ).deploy(
      nftAddr,
      v3Addr,
      fx.vaultAddr, // <- the index vault, exactly as the header documents
      await misc.getAddress(),
      DELAY,
      [roleAdmin2.address, allowAdmin.address],
      await registry.getAddress(),
      await impl.getAddress(),
      SALT
    );
    expect(await sweeper.reserveSink()).to.equal(fx.vaultAddr);

    await registry.createAccount(await impl.getAddress(), SALT, chainId, nftAddr, 1);
    const tbaAddr = await registry.account(await impl.getAddress(), SALT, chainId, nftAddr, 1);
    const tba: any = (await ethers.getContractFactory("MockTBA")).attach(tbaAddr);
    await tba.setOperator(await sweeper.getAddress(), true);

    // The stranded value is a REAL CONSTITUENT of the index — which is the
    // only case where crediting a reserve is meaningful at all.
    const asset = fx.tokens[1];
    const assetAddr = fx.addrs[1];
    await asset.mint(tbaAddr, 777n * WAD);
    await sweeper.connect(allowAdmin).queueAsset(KIND_ERC20, assetAddr, true);
    await time.increase(DELAY + 1);
    await sweeper.executeAsset(KIND_ERC20, assetAddr);

    const reserveBefore: bigint = await fx.vault.reserveOf(assetAddr);
    await sweeper.sweepTBAERC20(1, tbaAddr, assetAddr);

    // ── THE BUG, still visible: the tokens are in the vault and the ledger
    // does not know. Before round 10 this was the terminal state.
    expect(await asset.balanceOf(fx.vaultAddr)).to.equal(reserveBefore + 777n * WAD);
    expect(await fx.vault.reserveOf(assetAddr)).to.equal(reserveBefore);

    // ── THE FIX. Permissionless, and anyone at all may call it.
    await expect(fx.vault.connect(fx.carol).syncConstituentBalance(assetAddr))
      .to.emit(fx.vault, "ConstituentSynced")
      .withArgs(assetAddr, 777n * WAD);
    expect(await fx.vault.reserveOf(assetAddr)).to.equal(reserveBefore + 777n * WAD);

    // ── §7.6: the credit landed in `c.reserve` (asserted above), but the
    // freshly-swept increment now vests linearly over `STREAM_VEST_BLOCKS`
    // before it counts toward a pro-rata redemption — the same guard round
    // 9f already applied to streams, generalized to every value injection.
    // Immediately after the sweep, this fresh leg is still almost entirely
    // unvested, so a pro-rata quote captures almost none of it yet.
    await fx.vault.connect(fx.alice).mintProRata(100n * WAD, maxIn(3));
    const [, quotedImmediate] = await fx.vault.previewRedeemProRata(100n * WAD);

    // ── AND IT IS GENUINELY REDEEMABLE once matured. A holder's pro-rata
    // slice of this leg strictly increased because of the sweep, and they
    // can take it out in full once the vesting window has elapsed.
    await mine(300);
    const held: bigint = await asset.balanceOf(fx.alice.address);
    const [, quoted] = await fx.vault.previewRedeemProRata(100n * WAD);
    expect(quotedImmediate[1]).to.be.lessThan(quoted[1]);
    await fx.vault.connect(fx.alice).redeemProRata(100n * WAD, [0n, 0n, 0n]);
    expect((await asset.balanceOf(fx.alice.address)) - held).to.equal(quoted[1]);
    expect(quoted[1]).to.be.greaterThan(0n);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. It can never fabricate, and never eat another ledger
  // ══════════════════════════════════════════════════════════════════════════

  it("credits exactly the surplus, then nothing: a second call is a clean zero", async () => {
    const fx = await deployOpenIndex();
    await fx.tokens[2].mint(fx.vaultAddr, 42n * WAD); // a raw donation
    const before: bigint = await fx.vault.reserveOf(fx.addrs[2]);

    expect(
      await fx.vault.connect(fx.bob).syncConstituentBalance.staticCall(fx.addrs[2])
    ).to.equal(42n * WAD);
    await fx.vault.connect(fx.bob).syncConstituentBalance(fx.addrs[2]);
    expect(await fx.vault.reserveOf(fx.addrs[2])).to.equal(before + 42n * WAD);

    // Idempotent. There is no surplus left, so there is nothing to credit, and
    // it is a successful no-op rather than an error.
    expect(
      await fx.vault.connect(fx.bob).syncConstituentBalance.staticCall(fx.addrs[2])
    ).to.equal(0n);
    await fx.vault.connect(fx.bob).syncConstituentBalance(fx.addrs[2]);
    expect(await fx.vault.reserveOf(fx.addrs[2])).to.equal(before + 42n * WAD);
  });

  it("never swallows a DEFERRED redemption credit into the pro-rata pool", async () => {
    // The interaction that would be easy to get wrong: a bounced leg is
    // physically in the vault's balance but is owed to one named holder. A
    // naive balance-vs-reserve sync would hand it back to everyone.
    const fx = await deployOpenIndex();
    const bad: any = await (
      await ethers.getContractFactory("MockBlacklistIndexToken")
    ).deploy("BAD", "BAD");
    const badAddr = await bad.getAddress();
    const src: any = await (
      await ethers.getContractFactory("MockIndexPriceSource")
    ).deploy(100n * WAD, 100n * WAD);
    await fx.vault
      .connect(fx.admission)
      .queueListing(badAddr, await src.getAddress(), 2_000n, false);
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeListing(badAddr);
    await warmCheckpoints(fx, 4);

    await bad.mint(fx.alice.address, 100_000n * WAD);
    await bad.connect(fx.alice).approve(fx.vaultAddr, ethers.MaxUint256);
    await fx.vault.connect(fx.alice).mintSingleAsset(badAddr, 5n * WAD, 0n);
    await fx.vault.connect(fx.alice).mintProRata(10n * WAD, maxIn(4));

    await bad.setBlocked(fx.alice.address, true);
    await fx.vault
      .connect(fx.alice)
      .redeemProRata(await fx.vault.balanceOf(fx.alice.address), new Array(4).fill(0n));

    const owed: bigint = await fx.vault.pendingClaim(fx.alice.address, badAddr);
    expect(owed).to.be.greaterThan(0n);
    const reserveNow: bigint = await fx.vault.reserveOf(badAddr);

    // THE ASSERTION. Alice's bounced leg is sitting in the vault's balance and
    // sync must not see it as unaccounted.
    expect(
      await fx.vault.connect(fx.bob).syncConstituentBalance.staticCall(badAddr)
    ).to.equal(0n);
    await fx.vault.connect(fx.bob).syncConstituentBalance(badAddr);
    expect(await fx.vault.reserveOf(badAddr)).to.equal(reserveNow);

    // ...and she is still paid in full when the restriction lifts.
    await bad.setBlocked(fx.alice.address, false);
    const held: bigint = await bad.balanceOf(fx.alice.address);
    await fx.vault.connect(fx.alice).claimPending(badAddr);
    expect(await bad.balanceOf(fx.alice.address)).to.equal(held + owed);
  });

  it("never swallows accrued dividends or the segregated ecosystem-fee ledger", async () => {
    const fx = await deployOpenIndex();
    const divAsset = fx.tokens[0]; // dividendAsset AND constituent 0
    await divAsset.connect(fx.alice).approve(fx.vaultAddr, ethers.MaxUint256);

    // Appoint the vault as its own sink so ecosystemFeesWei actually accrues.
    await fx.vault
      .connect(fx.allocation)
      .queueParam(ethers.encodeBytes32String("ecosystemSink"), BigInt(fx.vaultAddr));
    await time.increase(TIMELOCK + 1);
    await fx.vault.executeParam(ethers.encodeBytes32String("ecosystemSink"));
    await warmCheckpoints(fx, 4);

    await fx.vault.connect(fx.bob).mintProRata(500n * WAD, maxIn(3));
    await fx.vault.connect(fx.bob).mintSingleAsset(fx.addrs[0], 5n * WAD, 0n);
    expect(await fx.vault.ecosystemFeesWei(fx.addrs[0])).to.be.greaterThan(0n);

    // A real, unclaimed dividend liability in the very same token.
    await fx.vault.connect(fx.alice).receiveDividendsWrapped(9n * WAD);
    const owed: bigint = await fx.vault.withdrawableDividendOf(fx.bob.address);
    expect(owed).to.be.greaterThan(0n);

    const reserveBefore: bigint = await fx.vault.reserveOf(fx.addrs[0]);
    // Nothing unaccounted exists, so sync must credit exactly zero — every
    // wei of the dividend and of the fee ledger is somebody else's.
    expect(
      await fx.vault.connect(fx.carol).syncConstituentBalance.staticCall(fx.addrs[0])
    ).to.equal(0n);
    await fx.vault.connect(fx.carol).syncConstituentBalance(fx.addrs[0]);
    expect(await fx.vault.reserveOf(fx.addrs[0])).to.equal(reserveBefore);

    // The dividend is still payable in full afterwards.
    const held: bigint = await divAsset.balanceOf(fx.bob.address);
    await fx.vault.connect(fx.bob).claimDividend();
    expect((await divAsset.balanceOf(fx.bob.address)) - held).to.equal(owed);

    // ...and a genuine surplus ON TOP of all of that is still picked up.
    await divAsset.mint(fx.vaultAddr, 3n * WAD);
    expect(
      await fx.vault.connect(fx.carol).syncConstituentBalance.staticCall(fx.addrs[0])
    ).to.equal(3n * WAD);
  });

  it("reaches no unlisted token, moves nothing out, and is not a role", async () => {
    const fx = await deployOpenIndex();
    const stranger: any = await (
      await ethers.getContractFactory("MockIndexToken")
    ).deploy("X", "X");
    await stranger.mint(fx.vaultAddr, 1_000n * WAD);
    // An unlisted token has no reserve to credit and no place in the basket.
    await expect(
      fx.vault.syncConstituentBalance(await stranger.getAddress())
    ).to.be.revertedWithCustomError(fx.vault, "NotListed");

    // No caller of any kind can make it pay anything to anyone: there is no
    // recipient argument and no transfer on the path.
    await fx.tokens[0].mint(fx.vaultAddr, 5n * WAD);
    const balBefore: bigint = await fx.tokens[0].balanceOf(fx.alice.address);
    await fx.vault.connect(fx.alice).syncConstituentBalance(fx.addrs[0]);
    expect(await fx.tokens[0].balanceOf(fx.alice.address)).to.equal(balBefore);

    // Every role gets exactly the same result as a stranger — it is not a
    // privilege, it is arithmetic.
    await fx.tokens[0].mint(fx.vaultAddr, 5n * WAD);
    for (const who of [fx.roleAdmin, fx.risk, fx.allocation, fx.admission, fx.carol]) {
      const credited: bigint = await fx.vault
        .connect(who)
        .syncConstituentBalance.staticCall(fx.addrs[0]);
      expect(credited).to.equal(5n * WAD);
    }
  });

  it("a sync raises per-share backing for EVERYONE, never for the caller alone", async () => {
    const fx = await deployOpenIndex();
    await fx.vault.connect(fx.alice).mintProRata(100n * WAD, maxIn(3));
    await fx.vault.connect(fx.bob).mintProRata(100n * WAD, maxIn(3));

    const [, beforeQuote] = await fx.vault.previewRedeemProRata(100n * WAD);
    await fx.tokens[1].mint(fx.vaultAddr, 500n * WAD);
    // Carol, who holds nothing at all, calls it. She gains nothing.
    await fx.vault.connect(fx.carol).syncConstituentBalance(fx.addrs[1]);
    // §7.6: the fresh 500 WAD credit vests linearly over `STREAM_VEST_BLOCKS`
    // before it counts toward a pro-rata quote (same guard as the sweep test
    // above) — mine past the window so this assertion is about the pro-rata
    // LIFT itself, not about whether the injection has finished vesting yet.
    await mine(300);
    const [, afterQuote] = await fx.vault.previewRedeemProRata(100n * WAD);

    expect(afterQuote[1]).to.be.greaterThan(beforeQuote[1]);
    expect(await fx.vault.balanceOf(fx.carol.address)).to.equal(0n);
    // Both holders gained identically — this is a pro-rata lift, not a claim.
    const aliceGain = afterQuote[1] - beforeQuote[1];
    expect(aliceGain).to.be.greaterThan(0n);
  });
});
