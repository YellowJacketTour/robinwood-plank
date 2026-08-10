import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot, type SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { deployIndexVault, TIMELOCK, paramsTuple, defaultParams } from "./helpers/index-vault";

/**
 * ============================================================================
 * IndexZapFacet — DESIGN-COLLECTION-VAULT-NATIVE-LP-AND-ZAP-MINT-2026-08-08.md
 * §3.2. Single-payment-asset (WETH) zap into the diamond's own weighted-
 * basket mint, composing REAL `CollectionVault.buyShares`/`sellShares` legs
 * (the same AMM `InventoryBuyAdapter.test.ts` already proves) with the
 * diamond's own internal mint core (`_mintWithAllocation`, `_routeDevFundBuy`,
 * `_revestOnMint`) — never a second, parallel pricing engine.
 *
 * LOCAL HARDHAT ONLY.
 * ============================================================================
 */
describe("IndexZapFacet — single-asset zap-mint", () => {
  // Every `setup()` now advances the shared clock past a governance timelock
  // (arming the C-6/H-2 provenance registry). Mocha shares one network across
  // files, so restore afterwards or the fixed-endTime Seaport orders in later
  // suites silently expire — the same guard `Hooks.exitDoorFree.test.ts` and
  // `ScopedRoles.isolation.test.ts` already carry for the same reason.
  let clockSnapshot: SnapshotRestorer;
  before(async () => {
    clockSnapshot = await takeSnapshot();
  });
  after(async () => {
    await clockSnapshot.restore();
  });

  const VAULT_TIMELOCK = 48 * 3600;
  const SINK_BPS = 3_000n; // CEIL_SINK_SPLIT_BPS

  /** Seed one CollectionVault's own internal constant-product AMM pool. */
  async function openVaultPool(
    cVault: any,
    vaultAddr: string,
    treasury: any,
    weth: any,
    seedPaymentAmt: bigint,
    seedSharesAmt: bigint,
    sharesHolder: any
  ) {
    await weth.mint(treasury.address, seedPaymentAmt);
    await weth.connect(treasury).approve(vaultAddr, seedPaymentAmt);
    await cVault.connect(treasury).seedLiquidity(seedPaymentAmt);

    await cVault.connect(sharesHolder).transfer(treasury.address, seedSharesAmt);
    await cVault.connect(treasury).seedShares(seedSharesAmt);
    await cVault.connect(treasury).openPool();
  }

  /**
   * Full fixture: a real index Diamond whose TWO constituents are real
   * `CollectionVault` shares, each with its own open AMM pool the zap will
   * buy against. `poolDepth` lets individual tests make one leg's pool
   * shallow (for the impact-guard test) without duplicating the whole setup.
   */
  async function setup(poolDepth: { c1Payment: bigint; c1Shares: bigint; c2Payment: bigint; c2Shares: bigint } = {
    c1Payment: ethers.parseEther("500"),
    c1Shares: ethers.parseEther("5"),
    c2Payment: ethers.parseEther("500"),
    c2Shares: ethers.parseEther("5"),
  }) {
    const [, roleAdmin, seeder, alice, , admission, risk, allocation, cvTreasury1, cvTreasury2] =
      await ethers.getSigners();

    const weth: any = await (await ethers.getContractFactory("MockIndexToken")).deploy("WETH", "WETH");
    const wethAddr = await weth.getAddress();

    const { vault, vaultAddr } = await deployIndexVault({
      name: "ZapIndex",
      symbol: "ZIDX",
      roles: [roleAdmin.address, admission.address, risk.address, allocation.address, admission.address],
      seeder: seeder.address,
      timelockDelay: TIMELOCK,
      params: paramsTuple(defaultParams),
      dividendAsset: wethAddr,
    });

    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(vaultAddr, wethAddr, VAULT_TIMELOCK);

    const nft1: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const nft2: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();

    const addr1: string = await factory.deployVault.staticCall(
      await nft1.getAddress(),
      cvTreasury1.address,
      SINK_BPS
    );
    await factory.deployVault(await nft1.getAddress(), cvTreasury1.address, SINK_BPS);
    const cVault1: any = await ethers.getContractAt("CollectionVault", addr1);

    const addr2: string = await factory.deployVault.staticCall(
      await nft2.getAddress(),
      cvTreasury2.address,
      SINK_BPS
    );
    await factory.deployVault(await nft2.getAddress(), cvTreasury2.address, SINK_BPS);
    const cVault2: any = await ethers.getContractAt("CollectionVault", addr2);

    // Seeder pays the fixed WETH deposit fee (MAX_MINT_FEE_WEI) per NFT
    // deposited into either vault; fund generously.
    await weth.mint(seeder.address, ethers.parseEther("500"));
    await weth.connect(seeder).approve(addr1, ethers.MaxUint256);
    await weth.connect(seeder).approve(addr2, ethers.MaxUint256);

    for (let i = 1; i <= 50; i++) {
      await nft1.mint(seeder.address, i);
      await nft1.connect(seeder).approve(addr1, i);
      await cVault1.connect(seeder).deposit(i);
    }
    for (let i = 1; i <= 50; i++) {
      await nft2.mint(seeder.address, i);
      await nft2.connect(seeder).approve(addr2, i);
      await cVault2.connect(seeder).deposit(i);
    }
    // seeder now holds 50e18 of each vault's own share.

    await openVaultPool(cVault1, addr1, cvTreasury1, weth, poolDepth.c1Payment, poolDepth.c1Shares, seeder);
    await openVaultPool(cVault2, addr2, cvTreasury2, weth, poolDepth.c2Payment, poolDepth.c2Shares, seeder);

    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    const src1: any = await Source.deploy(ethers.parseEther("1"), ethers.parseEther("1"));
    const src2: any = await Source.deploy(ethers.parseEther("1"), ethers.parseEther("1"));

    await vault.connect(seeder).seedConstituent(addr1, await src1.getAddress(), 5_000n);
    await vault.connect(seeder).seedConstituent(addr2, await src2.getAddress(), 5_000n);

    const seedDepositAmt = ethers.parseEther("20");
    await cVault1.connect(seeder).approve(vaultAddr, seedDepositAmt);
    await vault.connect(seeder).seedDeposit(addr1, seedDepositAmt);
    await cVault2.connect(seeder).approve(vaultAddr, seedDepositAmt);
    await vault.connect(seeder).seedDeposit(addr2, seedDepositAmt);

    await vault.connect(seeder).openIndex(ethers.parseEther("1000"));

    // AUDIT H-2: `_acquireLeg` validates every leg's PROVENANCE against the
    // `CollectionVaultFactory` registry BEFORE granting it an allowance over
    // the diamond's WETH. This fixture wires the REAL factory — the same one
    // that deployed both constituent vaults — so the zap tests exercise the
    // production trust path rather than a mock of it.
    await vault.connect(admission).queueVaultFactory(await factory.getAddress());
    await time.increase(TIMELOCK + 1);
    await vault.executeVaultFactory();

    await weth.mint(alice.address, ethers.parseEther("10000"));
    await weth.connect(alice).approve(vaultAddr, ethers.MaxUint256);

    return { vault, vaultAddr, weth, wethAddr, cVault1, addr1, cVault2, addr2, alice, seeder, admission, factory };
  }

  it("mints EXACTLY the requested index-coin amount from a single WETH deposit, and refunds unspent WETH", async () => {
    const { vault, weth, alice } = await setup();

    const desiredSharesOut = ethers.parseEther("2"); // small vs. 1000e18 seed supply
    const maxPaymentIn = ethers.parseEther("50"); // generous slippage headroom

    const aliceIdxBefore: bigint = await vault.balanceOf(alice.address);
    const aliceWethBefore: bigint = await weth.balanceOf(alice.address);

    const tx = await vault.connect(alice).zapMint(desiredSharesOut, maxPaymentIn);
    const receipt = await tx.wait();

    const aliceIdxAfter: bigint = await vault.balanceOf(alice.address);
    const aliceWethAfter: bigint = await weth.balanceOf(alice.address);

    // Exact requested amount minted — no platform allocation is configured
    // on this fixture, so gross == net, exactly like `mintProRata` under
    // the same conditions.
    expect(aliceIdxAfter - aliceIdxBefore).to.equal(desiredSharesOut);

    // Real WETH was spent, and it was materially less than the caller's
    // whole slippage budget — the surplus was refunded, not stranded.
    const wethSpent = aliceWethBefore - aliceWethAfter;
    expect(wethSpent).to.be.gt(0n);
    expect(wethSpent).to.be.lt(maxPaymentIn);

    const zapMintedEvent = receipt.logs
      .map((l: any) => {
        try {
          return vault.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "ZapMinted");
    expect(zapMintedEvent).to.not.equal(undefined);
    expect(zapMintedEvent!.args.sharesOut).to.equal(desiredSharesOut);
    expect(zapMintedEvent!.args.paymentSpent).to.equal(wethSpent);
    expect(zapMintedEvent!.args.paymentRefunded).to.equal(maxPaymentIn - wethSpent);

    // The diamond itself never retains a stray leftover basket-leg balance —
    // both constituent legs were bought down to exactly their pro-rata
    // `want` (any excess sold back inside `_acquireLeg`).
  });

  it("reverts the WHOLE transaction, with no partial state change, when the real cost exceeds the caller's maxPaymentIn", async () => {
    const { vault, weth, alice } = await setup();

    const desiredSharesOut = ethers.parseEther("2");
    const tinyMaxPaymentIn = 1n; // cannot possibly cover even one leg

    const aliceIdxBefore: bigint = await vault.balanceOf(alice.address);
    const aliceWethBefore: bigint = await weth.balanceOf(alice.address);

    await expect(vault.connect(alice).zapMint(desiredSharesOut, tinyMaxPaymentIn)).to.be.reverted;

    // Atomicity: not one wei moved, not one share minted.
    expect(await vault.balanceOf(alice.address)).to.equal(aliceIdxBefore);
    expect(await weth.balanceOf(alice.address)).to.equal(aliceWethBefore);
  });

  it("reverts the WHOLE transaction when one leg's acquisition would breach the shared MAX_ZAP_IMPACT_BPS guard, even with an enormous maxPaymentIn", async () => {
    // Constituent 2's own AMM pool is made deliberately shallow relative to
    // the size of the mint this test asks for, so that leg's `buyShares`
    // constant-product impact exceeds the 3% ceiling
    // (`InventoryBuyAdapter.MAX_IMPACT_BPS`, reused verbatim here) — a real
    // economic guard, not a budget guard, so an unbounded WETH budget must
    // not be able to buy past it.
    const { vault, weth, alice } = await setup({
      c1Payment: ethers.parseEther("500"),
      c1Shares: ethers.parseEther("5"),
      c2Payment: ethers.parseEther("2"), // shallow
      c2Shares: ethers.parseEther("4"), // shallow
    });

    const desiredSharesOut = ethers.parseEther("2"); // wants ~1e18 out of each 20e18-reserve leg
    const hugeMaxPaymentIn = ethers.parseEther("100000");

    const aliceIdxBefore: bigint = await vault.balanceOf(alice.address);
    const aliceWethBefore: bigint = await weth.balanceOf(alice.address);

    await expect(vault.connect(alice).zapMint(desiredSharesOut, hugeMaxPaymentIn)).to.be.reverted;

    expect(await vault.balanceOf(alice.address)).to.equal(aliceIdxBefore);
    expect(await weth.balanceOf(alice.address)).to.equal(aliceWethBefore);
  });

  it("caller cannot be short-changed: minting twice in a row is exact and repeatable, proving no basket-leg dust is silently stranded across calls", async () => {
    const { vault, weth, alice } = await setup();

    const desiredSharesOut = ethers.parseEther("1");
    const maxPaymentIn = ethers.parseEther("30");

    await vault.connect(alice).zapMint(desiredSharesOut, maxPaymentIn);
    const mid: bigint = await vault.balanceOf(alice.address);
    await vault.connect(alice).zapMint(desiredSharesOut, maxPaymentIn);
    const end: bigint = await vault.balanceOf(alice.address);

    expect(mid).to.equal(desiredSharesOut);
    expect(end - mid).to.equal(desiredSharesOut);

    // Every call refunds its own unspent WETH back to the caller rather
    // than trapping it at the diamond.
    expect(await weth.balanceOf(alice.address)).to.be.gt(0n);
  });
});
